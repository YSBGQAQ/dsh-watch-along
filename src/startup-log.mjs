// 每次 DSH 启动写一条"这次是什么环境"的记录。
//
// 为什么值得单独做：环境问题（显卡驱动、Python 包、模型缺失、CPU 降频）
// 出了事只能靠人回忆"当时装了什么"。写下来就能对比"上次能跑、这次不能"。
//
// 两条硬要求（用户定的）：
//   1. 单条**不限篇幅** —— 环境信息本来就长，截断就失去了对比价值
//   2. 最多 **50 条**，满了顶掉最老的一条
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const MAX_RECORDS = 50

/**
 * 环境日志的默认位置：`<用户>\Documents\DSH\watch-along\startup.jsonl`。
 *
 * 为什么不放仓库里：这份日志是"这台机器当时是什么环境"，跟代码版本无关 ——
 * 换分支、删仓库、重装插件都不该把它一起带走。放 Documents 下才能跨项目回看。
 * 想换地方就设环境变量 WATCH_ALONG_LOG_DIR。
 */
export function defaultStartupLogFile(env = process.env) {
  const dir = env?.WATCH_ALONG_LOG_DIR || path.join(os.homedir(), 'Documents', 'DSH', 'watch-along')
  return path.join(dir, 'startup.jsonl')
}

/** 安全执行一条命令，拿不到就返回 null（环境探测不能因为某个命令缺失就崩）。 */
function tryExec(cmd, args, timeoutMs = 4000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
    return String(out).trim()
  } catch {
    return null
  }
}

/** 显卡：优先 nvidia-smi，没有就说明"检测不到"，不猜。 */
function gpuInfo() {
  const raw = tryExec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
  if (raw) {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, mem, driver] = l.split(',').map((x) => x.trim())
        return `${name} · ${mem} · 驱动 ${driver}`
      })
  }
  // 没有 nvidia-smi 不代表没有显卡，只是查不到 —— 如实写
  return ['未检测到（没有 nvidia-smi，或无独显）']
}

/** 采集一份环境快照。所有字段都可能为 null，调用方不要假定有值。 */
/** OCR / ASR 相关包的版本。用 pip list 一次拿全，比逐个 import 快得多（import 要 5–10 秒）。 */
function pythonPackages(python = 'python') {
  const raw = tryExec(python, ['-m', 'pip', 'list', '--disable-pip-version-check', '--format=freeze'], 6000)
  if (!raw) return ['读不到（pip 不可用或超时）']
  const want = /^(paddle|paddleocr|paddlepaddle|whisper|faster-whisper|openai-whisper|torch|onnxruntime|numpy|soundfile|sounddevice|scipy)/i
  const hit = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => want.test(l))
  return hit.length ? hit : ['未装（没找到 paddle / whisper 相关包）']
}

export function collectEnv({ settings = null, python = null, extra = {} } = {}) {
  const cpus = os.cpus()
  return {
    at: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    host: os.hostname(),
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    cpu: cpus.length ? `${cpus[0].model.trim()} × ${cpus.length}` : '未知',
    memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemoryGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    gpu: gpuInfo(),
    python: tryExec(python || 'python', ['--version']),
    pythonExe: python || 'python',
    pythonPackages: pythonPackages(python || 'python'),
    ffmpeg: (tryExec('ffmpeg', ['-version']) ?? '').split('\n').slice(0, 2).join(' | ') || null,
    settings,
    ...extra,
  }
}

/**
 * 追加一条启动记录，保留最近 max 条。
 *
 * 文件是一行一条 JSON（JSONL）：这样单条再长也不会把格式弄乱，
 * 追加也不会重写整个文件。
 */
export function appendStartupLog(file, record, { max = MAX_RECORDS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const lines = []
  try {
    const old = fs.readFileSync(file, 'utf8')
    for (const line of old.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        JSON.parse(t) // 坏行直接丢，别让一条坏数据毁掉整份历史
        lines.push(t)
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 文件不存在：第一次启动 */
  }

  lines.push(JSON.stringify(record))
  const kept = lines.slice(-Math.max(1, max))

  // 临时文件 + 改名：写一半断电也不会留下半份日志
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return { file, kept: kept.length, dropped: Math.max(0, lines.length - kept.length) }
}

/** 读回全部记录（最新在最后）。给设置页和排障用。 */
export function readStartupLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
