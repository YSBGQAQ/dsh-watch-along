// 设置模型：默认值、三个场景预设、以及"非法值怎么拒"。
import fs from 'node:fs'
import path from 'node:path'
//
// 设置页只是它的壳子：界面读这里、写这里，校验也在这里。
// 放在 JS 而不是界面里，是因为"什么算合法"必须能单测。

export const DEFAULTS = Object.freeze({
  window: '', // 标题片段；空 = 还没选窗口
  preset: 'cinema',
  quality: 'high', // low | medium | high
  subtitle: true,
  speech: true,
  speechPerMin: 6,
  host: '0.0.0.0', // 手机端监听地址：0.0.0.0 = 局域网可连，127.0.0.1 = 只本机
  // 高级（折叠）：裸阈值，正常不该改
  region: { top: 0, height: 1 },
  maxWaitSec: 15,
})

/** 三个预设。数值来自 spec 的场景表。 */
export const PRESETS = Object.freeze({
  game: { quality: 'high', fps: 12, density: 'dense', speechPerMin: 4 },
  lecture: { quality: 'medium', fps: 8, density: 'normal', speechPerMin: 6 },
  cinema: { quality: 'high', fps: 8, density: 'calm', speechPerMin: 3 },
})

const QUALITIES = ['low', 'medium', 'high']

/**
 * 校验一批改动。
 * 返回 `{ ok, value, rejected }`：rejected 里逐条给出原因，界面把它显示在对应输入框下。
 * **不抛错** —— 非法值是"提交被拒"，不是"接口坏了"（spec：200 + rejected）。
 */
export function validate(patch, current = DEFAULTS) {
  const rejected = []
  const value = { ...current }

  const reject = (field, reason) => rejected.push({ field, reason })

  for (const [key, raw] of Object.entries(patch ?? {})) {
    switch (key) {
      case 'window':
        if (typeof raw !== 'string') reject(key, '必须是字符串')
        else value.window = raw.trim()
        break
      case 'preset':
        if (!PRESETS[raw]) reject(key, `未知预设，可选：${Object.keys(PRESETS).join(' / ')}`)
        else {
          value.preset = raw
          Object.assign(value, PRESETS[raw])
        }
        break
      case 'quality':
        if (!QUALITIES.includes(raw)) reject(key, `只能是 ${QUALITIES.join(' / ')}`)
        else value.quality = raw
        break
      case 'subtitle':
      case 'speech':
        if (typeof raw !== 'boolean') reject(key, '必须是 true / false')
        else value[key] = raw
        break
      case 'host':
        if (!['0.0.0.0', '127.0.0.1', 'localhost'].includes(raw)) reject(key, '只能是 0.0.0.0 / 127.0.0.1')
        else value.host = raw
        break
      case 'fps':
        if (!Number.isInteger(raw) || raw < 1 || raw > 30) reject(key, '必须是 1–30 的整数')
        else value.fps = raw
        break
      case 'density':
        if (!['dense', 'normal', 'calm'].includes(raw)) reject(key, '只能是 dense / normal / calm')
        else value.density = raw
        break
      case 'speechPerMin':
        if (!Number.isInteger(raw) || raw < 0 || raw > 30) reject(key, '必须是 0–30 的整数')
        else value.speechPerMin = raw
        break
      case 'region': {
        const r = raw ?? {}
        const bad = !Number.isFinite(r.top) || !Number.isFinite(r.height)
          || r.top < 0 || r.top > 1 || r.height <= 0 || r.height > 1 || r.top + r.height > 1.0001
        if (bad) reject(key, '需要 {top, height}，都在 0–1 之间且不越界')
        else value.region = { top: r.top, height: r.height }
        break
      }
      case 'maxWaitSec':
        if (!Number.isFinite(raw) || raw < 3 || raw > 60) reject(key, '必须在 3–60 秒之间')
        else value.maxWaitSec = raw
        break
      default:
        reject(key, '未知字段（设置页不认这个键）')
    }
  }

  return { ok: rejected.length === 0, value, rejected }
}

/** 环境检查的八项 —— 只做"该查什么"的清单，具体探测由 doctor 注入。 */
export const ENV_CHECKS = Object.freeze([
  { id: 'python', label: 'Python 解释器' },
  { id: 'pkgs', label: '三个 Python 包' },
  { id: 'ffmpeg', label: 'ffmpeg' },
  { id: 'driver', label: '显卡驱动' },
  { id: 'cuda', label: 'CUDA 运行时' },
  { id: 'ocrModel', label: 'OCR 模型' },
  { id: 'whisper', label: 'Whisper 五个文件' },
  { id: 'audioOut', label: '输出设备' },
])


/**
 * 读设置。文件不存在 = 用默认值（不是错误：第一次运行本来就没文件）。
 * 文件坏了也回默认值，但把原因带出来 —— 静默吞掉会让"设置没生效"无迹可查。
 */
export function loadSettings(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const raw = JSON.parse(text)
    const { value, rejected } = validate(raw, DEFAULTS)
    return { value, rejected, source: rejected.length ? 'partial' : 'file' }
  } catch (e) {
    const missing = e?.code === 'ENOENT'
    return { value: { ...DEFAULTS }, rejected: [], source: missing ? 'default' : 'broken', error: missing ? null : String(e?.message ?? e) }
  }
}

/**
 * 写设置。先校验再落盘：非法就不写，并把 rejected 原样返回。
 * 用 writeFileSync + 临时文件改名，避免写一半断电留个半截 JSON。
 */
export function saveSettings(file, patch) {
  const loaded = loadSettings(file)
  const { ok, value, rejected } = validate(patch, loaded.value)
  if (!ok) return { ok: false, rejected, value: loaded.value }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return { ok: true, rejected: [], value }
}
