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
import { spawn, execFile, execFileSync } from 'node:child_process'
import { DEFAULTS, loadSettings, saveSettings } from './settings.mjs'
import { defaultStartupLogFile } from './startup-log.mjs'
import { runChecks, defaultProbes } from './doctor.mjs'

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

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 64 * 1024) req.destroy() // 设置体不该这么大
    })
    req.on('end', () => resolve(buf))
    req.on('error', () => resolve(''))
  })
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

/**
 * 设置接口的纯函数部分（可单测）：GET 返回当前值 + 默认值 + 预设；POST 校验后落盘。
 * 非法值一律 200 + rejected —— 界面要能指出"哪一项、为什么"（票 07 的刻意设计）。
 */
export function handleSettings({ file, method = 'GET', body = null } = {}) {
  if (!file) return { status: 500, body: { ok: false, error: '没有 settings 文件路径' } }
  if (method === 'GET') {
    const loaded = loadSettings(file)
    return {
      status: 200,
      body: {
        ok: true,
        value: loaded.value,
        source: loaded.source,
        error: loaded.error ?? null,
        rejected: loaded.rejected,
        defaults: DEFAULTS,
      },
    }
  }
  if (method === 'POST') {
    let patch = body
    if (typeof patch === 'string') {
      try {
        patch = JSON.parse(patch)
      } catch {
        return { status: 200, body: { ok: false, rejected: [{ field: '(整体)', reason: '不是合法 JSON' }] } }
      }
    }
    if (!patch || typeof patch !== 'object') {
      return { status: 200, body: { ok: false, rejected: [{ field: '(整体)', reason: '需要对象' }] } }
    }
    const r = saveSettings(file, patch)
    return { status: 200, body: { ok: r.ok, rejected: r.rejected, value: r.value } }
  }
  return { status: 405, body: { ok: false, error: 'method not allowed' } }
}

/**
 * 选解释器：有 pythonw.exe 就用它。
 * 为什么：python.exe 是控制台版，即使 spawn 时 windowsHide + detached，
 * Windows 仍会给它开一个黑窗（用户每次启动服务都看到两个）。
 * pythonw 不带控制台，输出本来也是 stdio:'ignore'，信息量一点没少。
 */
export function quietPython(python) {
  try {
    if (!/python\.exe$/i.test(String(python))) return python
    const w = String(python).replace(/python\.exe$/i, 'pythonw.exe')
    return fs.existsSync(w) ? w : python
  } catch {
    return python
  }
}

export function createSupervisor({
  config,
  rootDir,
  settingsFile = null,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  log = () => {},
  // 采集状态（running / failed + 原因）。面板靠它报"采集中断了，请重启服务"。
  // 不传就是 null：单测和"只起服务不开陪看"的场景不需要它。
  watchStatus = null,
} = {}) {
  // rootDir 必须显式传插件目录：宿主进程的 cwd 不是仓库根，读不到 services.json
  const cfg = config ?? resolveConfig(process.env, { rootDir: rootDir ?? process.cwd() })

  async function status() {
    // 日志地址随状态一起发：面板拿不到文件系统，只能靠这里告诉它。
    // 位置跟着 defaultStartupLogFile 走（Documents 下），别再写死 .scratch ——
    // 2026-11-23 改了实际写入位置，面板这行漏改，会指到一个空的旧文件。
    const startupLog = defaultStartupLogFile()
    const [ocr, asr] = await Promise.all([probe(cfg.ports.ocr, { fetchImpl }), probe(cfg.ports.asr, { fetchImpl })])
    let watch = null
    try {
      watch = watchStatus ? watchStatus() : null
    } catch {
      watch = null
    }
    return {
      startupLog,
      watch,
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
    // pythonw：不起黑窗（见 quietPython 的注释）
    const child = spawnImpl(quietPython(cfg.python), [script, '--port', String(port)], {
      cwd: cfg.rootDir,
      env: { ...process.env, WATCH_ALONG_WHISPER_DIR: cfg.whisperDir },
      detached: true, // 插件退出后服务继续活着：它是宿主之外的东西
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    return { id: which, pid: child.pid ?? null, port }
  }

  // 同一时刻只允许一次启动：面板 2 秒一轮询、用户还可能连点两下，
  // 两个 start() 同时看到"没起来"就会各拉一份，最后四个进程抢两个端口。
  let startInFlight = null

  async function start() {
    if (startInFlight) return startInFlight
    startInFlight = startOnce().finally(() => {
      startInFlight = null
    })
    return startInFlight
  }

  async function startOnce() {
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

  /** 杀掉占用某端口的本机进程（重启服务用）。返回被杀掉的 pid 列表。 */
  function killPort(port) {
    const pids = new Set()
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
        for (const line of out.split('\n')) {
          if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue
          const pid = line.trim().split(/\s+/).pop()
          if (pid && pid !== '0') pids.add(pid)
        }
        for (const pid of pids) {
          try {
            execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' })
          } catch {
            /* 进程已经没了 */
          }
        }
      } else {
        const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
        for (const pid of out.split('\n').map((x) => x.trim()).filter(Boolean)) {
          pids.add(pid)
          try {
            process.kill(Number(pid), 'SIGTERM')
          } catch {
            /* 已经没了 */
          }
        }
      }
    } catch {
      /* netstat/lsof 不可用就跳过：不阻塞启动流程 */
    }
    return [...pids]
  }

  /** 重启：杀掉两个端口上的进程，等一下端口释放，再按正常流程起。 */
  async function restart() {
    const killed = []
    for (const port of [cfg.ports.ocr, cfg.ports.asr]) {
      const pids = killPort(port)
      if (pids.length) killed.push({ port, pids })
    }
    if (killed.length) {
      log(`重启服务：先结束 ${killed.map((k) => `${k.port}(${k.pids.join(',')})`).join(' ')}`)
      await new Promise((r) => setTimeout(r, 600))
    }
    const started = await start()
    return { ...started, killed }
  }

  /**
   * 环境检查（spec：设置页首项）。
   * 八项里能真查的就真查；探不到的标"黄 + 未探测"，不许假装绿。
   * 服务相关的两项直接问服务本身 —— 比查文件准（跑起来的才算数）。
   */
  async function doctor() {
    const [ocr, asr] = await Promise.all([
      probe(cfg.ports.ocr, { fetchImpl }),
      probe(cfg.ports.asr, { fetchImpl }),
    ])
    const sitePackages = path.resolve(path.dirname(cfg.python), '..', 'Lib', 'site-packages')
    const probes = defaultProbes({
      venvPython: cfg.python,
      whisperDir: cfg.whisperDir,
      modelDir: path.join(sitePackages, 'rapidocr', 'models'),
    })
    probes.python = () => ({ ok: fs.existsSync(cfg.python), detail: cfg.python })
    // 三个包**真导入**才算过：venv 存在不等于装对了（差一个 rapidocr 就白搭）。
    // 用异步 execFile，别把面板接口堵住。
    probes.pkgs = () =>
      new Promise((resolve) => {
        execFile(
          cfg.python,
          ['-c', 'import rapidocr, faster_whisper, soundcard'],
          { timeout: 20000, windowsHide: true },
          (err, _out, stderr) => {
            if (!err) return resolve({ ok: true, detail: 'rapidocr / faster-whisper / soundcard 都能导入' })
            resolve({
              ok: false,
              detail: `导入失败：${String(stderr || err.message || err).trim().split('\n').pop().slice(0, 160)}`,
            })
          },
        )
      })
    // 显卡：没有 NVIDIA 不是错（现在是 CPU 模式），只标黄
    const gpuName = () =>
      new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 4000, windowsHide: true }, (err, out) => {
          if (err) return resolve(null)
          resolve(String(out || '').trim().split('\n')[0] || null)
        })
      })
    probes.driver = async () => {
      const name = await gpuName()
      return name
        ? { ok: true, detail: name }
        : { ok: true, warn: true, detail: '没有 NVIDIA 显卡，走 CPU（功能一样，转写慢些）' }
    }
    // CUDA：**真去加载一次 cublas**，不再写"未探测（稍后补）"——
    // 那句话读起来像 bug（用户 2026-11-23 就问了）。加载不了也不是错，标黄说清原因。
    probes.cuda = () =>
      new Promise((resolve) => {
        execFile(
          cfg.python,
          ['-c', 'import ctypes; ctypes.WinDLL("cublas64_12.dll")'],
          { timeout: 8000, windowsHide: true },
          async (err) => {
            if (!err) return resolve({ ok: true, detail: 'cublas64_12.dll 能加载' })
            const name = await gpuName()
            resolve({
              ok: true,
              warn: true,
              detail: name ? '有显卡，但 cublas 加载不了（多半没装 CUDA 运行时）' : '没有 NVIDIA 显卡，走 CPU（功能一样，转写慢些）',
            })
          },
        )
      })
    probes.ffmpeg = () => {
      try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 3000 })
        return { ok: true, detail: 'ffmpeg 在 PATH 上' }
      } catch {
        return { ok: false, detail: 'ffmpeg 不在 PATH 上（只有合成素材/转码才用到）' }
      }
    }
    probes.ocrModel = () =>
      ocr.up ? { ok: true, detail: '服务在跑，模型已加载' } : { ok: false, detail: 'OCR 服务没起来，面板可一键启动' }
    probes.audioOut = () =>
      asr.up ? { ok: true, detail: asr.detail ?? '扬声器' } : { ok: false, detail: 'ASR 服务没起来，面板可一键启动' }
    return runChecks(probes)
  }

  /**
   * 只绑 127.0.0.1 的面板接口：GET /status、POST /start、POST /restart。
   *
   * routes 是插件自己加的路由（`{ 'POST /ocr-test': ({body}) => ({ok,...}) }`）。
   * 为什么不各起一个 server：面板端口在 client.js 里写死 8790，多开一个口就要
   * 再传一次端口号给它 —— 等于把"面板怎么连"这件事复制两遍。
   */
  function serve(portOrOpts = cfg.ports.panel) {
    const opts = typeof portOrOpts === 'number' ? { port: portOrOpts } : (portOrOpts ?? {})
    const port = opts.port ?? cfg.ports.panel
    const routes = opts.routes ?? {}
    const server = http.createServer(async (req, res) => {
      // 面板在渲染进程里，跨源必须放开；但只绑回环，外部访问不到。
      // **Allow-Headers 不能漏**：POST /settings 带 content-type: application/json，
      // 浏览器会先发 OPTIONS 预检；不声明这个头，预检就被拒 → 前端只看到 "Failed to fetch"。
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      res.setHeader('Access-Control-Max-Age', '600')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      try {
        if (req.url?.startsWith('/status')) return res.end(JSON.stringify(await status()))
        if (req.url?.startsWith('/doctor')) return res.end(JSON.stringify(await doctor()))
        if (req.url?.startsWith('/start')) return res.end(JSON.stringify(await start()))
        if (req.url?.startsWith('/restart')) return res.end(JSON.stringify(await restart()))
        if (req.url?.startsWith('/settings')) {
          const body = req.method === 'POST' ? await readBody(req) : null
          const r = handleSettings({ file: settingsFile, method: req.method, body })
          res.statusCode = r.status
          return res.end(JSON.stringify(r.body))
        }
        // 插件注入的路由（窗口识别测试）。放在 404 之前，pathname 要剥掉 query。
        const pathOnly = (req.url ?? '').split('?')[0]
        const route = routes[`${req.method} ${pathOnly}`]
        if (route) {
          const raw = req.method === 'POST' ? await readBody(req) : ''
          const r = (await route({ body: raw })) ?? {}
          res.statusCode = r.status ?? 200
          return res.end(JSON.stringify(r.body ?? r))
        }
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

  return { status, start, restart, serve, config: cfg }
}
