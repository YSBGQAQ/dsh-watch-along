// 两个 python 服务的管家（票：设置界面里能启动、没起来要提示）。
//
// 为什么需要它：服务没起时插件**不报错**，只是少两类事件。用户看到的是
// "AI 不听声音 / 不读字幕"，查半天才发现是服务没开。这是典型的静默降级，
// 必须让它可见、并且能在设置里一键起。
//
// 设计取舍：
//   · 状态与启动走一个**只绑 127.0.0.1** 的小 HTTP 口（默认 8790），因为设置面板
//     跑在渲染进程里，拿不到主进程的模块；本机回环是唯一不依赖宿主内部 API 的通路。
//   · python 路径与模型目录必须来自配置（机器相关，不能写死）；缺了就明说缺什么。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const DEFAULT_PORTS = { ocr: 8765, asr: 8766, panel: 8790 }

/**
 * 从环境变量解析配置。缺什么就返回 null，由调用方给出"缺 XX"的提示，
 * **不要**猜一个默认值 —— 猜错的结果是服务起不来还看不出原因。
 */
export function resolveConfig(env = process.env, { rootDir = process.cwd() } = {}) {
  // 机器相关的路径不该写进仓库，也不该逼用户去改系统环境变量。
  // 三级来源：环境变量 → `.scratch/run/services.json`（本地、已 gitignore）→ 缺失即报。
  let fileCfg = {}
  try {
    const f = path.join(rootDir, '.scratch', 'run', 'services.json')
    if (fs.existsSync(f)) fileCfg = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    fileCfg = {}
  }
  const python = env.WATCH_ALONG_PY || fileCfg.python || null
  const whisperDir = env.WATCH_ALONG_WHISPER_DIR || fileCfg.whisperDir || null
  const ports = {
    ocr: Number(env.WATCH_ALONG_PORT_OCR || fileCfg.ocrPort || DEFAULT_PORTS.ocr),
    asr: Number(env.WATCH_ALONG_PORT_ASR || fileCfg.asrPort || DEFAULT_PORTS.asr),
    panel: Number(env.WATCH_ALONG_PORT_PANEL || fileCfg.panelPort || DEFAULT_PORTS.panel),
  }
  const missing = []
  if (!python) missing.push('WATCH_ALONG_PY（venv 的 python.exe）')
  if (!whisperDir) missing.push('WATCH_ALONG_WHISPER_DIR（含 model.bin 的目录）')
  // 给了路径但文件不存在，比没给更坑：服务会起不来且报错在另一个窗口里
  if (python && !safeExists(python)) missing.push(`WATCH_ALONG_PY 指向的文件不存在：${python}`)
  if (whisperDir && !safeExists(path.join(whisperDir, 'model.bin'))) {
    missing.push(`WATCH_ALONG_WHISPER_DIR 里没有 model.bin：${whisperDir}`)
  }
  return { python, whisperDir, ports, rootDir, missing, ready: missing.length === 0 }
}

function safeExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

async function probe(port, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return { up: false, error: 'no-fetch' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: ctl.signal })
    if (!r.ok) return { up: false, error: `HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    return { up: true, ready: j.ready !== false, detail: j.device ?? null, raw: j }
  } catch (e) {
    return { up: false, error: String(e?.name === 'AbortError' ? '超时' : (e?.message ?? e)) }
  } finally {
    clearTimeout(timer)
  }
}

export function createSupervisor({
  config,
  rootDir,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  log = () => {},
} = {}) {
  // rootDir 必须显式传插件目录：宿主进程的 cwd 不是仓库根，读不到 services.json
  const cfg = config ?? resolveConfig(process.env, { rootDir: rootDir ?? process.cwd() })

  async function status() {
    const [ocr, asr] = await Promise.all([probe(cfg.ports.ocr, { fetchImpl }), probe(cfg.ports.asr, { fetchImpl })])
    return {
      ok: true,
      configured: cfg.ready,
      missing: cfg.missing,
      ports: cfg.ports,
      services: [
        { id: 'ocr', name: '画面字幕（OCR）', port: cfg.ports.ocr, ...ocr },
        { id: 'asr', name: '声音转写（Whisper）', port: cfg.ports.asr, ...asr },
      ],
    }
  }

  function launch(which) {
    const script = path.join(cfg.rootDir, 'python', which === 'ocr' ? 'ocr_service.py' : 'asr_service.py')
    const port = which === 'ocr' ? cfg.ports.ocr : cfg.ports.asr
    const child = spawnImpl(cfg.python, [script, '--port', String(port)], {
      cwd: cfg.rootDir,
      env: { ...process.env, WATCH_ALONG_WHISPER_DIR: cfg.whisperDir },
      detached: true, // 插件退出后服务继续活着：它是宿主之外的东西
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    return { id: which, pid: child.pid ?? null, port }
  }

  async function start() {
    if (!cfg.ready) {
      return { ok: false, error: `还缺配置：${cfg.missing.join('；')}`, started: [] }
    }
    const cur = await status()
    const started = []
    for (const s of cur.services) {
      if (s.up) continue
      try {
        started.push(launch(s.id))
      } catch (e) {
        return { ok: false, error: `启动 ${s.id} 失败：${String(e?.message ?? e)}`, started }
      }
    }
    log(`服务启动请求：${started.map((s) => `${s.id}@${s.port}`).join(',') || '（都已在跑）'}`)
    return { ok: true, started, note: started.length ? '已拉起，模型加载约 10–30 秒' : '' }
  }

  /** 只绑 127.0.0.1 的面板接口：GET /status、POST /start。 */
  function serve(port = cfg.ports.panel) {
    const server = http.createServer(async (req, res) => {
      // 面板在渲染进程里，跨源必须放开；但只绑回环，外部访问不到
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method === 'OPTIONS') return res.end('{}')
      try {
        if (req.url?.startsWith('/status')) return res.end(JSON.stringify(await status()))
        if (req.url?.startsWith('/start')) return res.end(JSON.stringify(await start()))
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'not found' }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
      }
    })
    server.on('error', (e) => log(`面板接口起不来（${port}）：${e?.message ?? e}`))
    server.listen(port, '127.0.0.1')
    try {
      server.unref?.()
    } catch {
      /* 不是 Node server 就算了 */
    }
    return server
  }

  return { status, start, serve, config: cfg }
}
