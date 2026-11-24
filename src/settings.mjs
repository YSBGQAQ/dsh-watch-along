// 设置模型：默认值与"非法值怎么拒"。
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_COMMENT_PROMPT, DEFAULT_OBSERVE_PROMPT } from './wake.mjs'
//
// 设置页只是它的壳子：界面读这里、写这里，校验也在这里。
// 放在 JS 而不是界面里，是因为"什么算合法"必须能单测。

export const DEFAULTS = Object.freeze({
  window: '', // 标题片段；空 = 还没选窗口
  quality: 'high', // low | medium | high
  // 每轮唤醒给模型传什么图（2026-11-23 加）：
  //   none  = 不传，纯文字（最便宜）
  //   low   = 640 宽缩图（默认：模型看图时间约为原尺寸的 64%）
  //   high  = 798 原尺寸（要读小字/表情时用）
  imageQuality: 'low',
  fps: 8, // 采集帧率 0–30；**0 = 关闭画面通道**（只剩声音）
  subtitle: true,
  speech: true,
  speechPerMin: 6, // 每分钟最多几条语音转写进事件队列；0 = 不限（关闭这条限制）
  // 唤醒节奏（对齐 see-now，但节奏用秒数直接填，比三档更好控制）
  wakeGapSec: 30,
  observeSec: 6, // 静默观察轮：每隔几秒叫醒它"只看不说"（2026-11-23 默认 6s；0 = 关闭）
  idleStopMin: 0, // 多久没人调工具就收工（分钟）。默认 0 = 收工机制停用（2026-11-23 用户决定）
  // 陪聊提示词。{n} 会被替换成「主动说话间隔」的秒数。
  // 唯一来源在 src/wake.mjs：两份文案会漂，而模型只看到发出去的那一份
  commentPrompt: DEFAULT_COMMENT_PROMPT,
  // 静默提示词：每 observeSec 秒一轮「只看不说」时随图发出去的那句话。
  // 默认值 = 2026-11-23 用户定的原文（必须包在代码块里），别改默认。
  observePrompt: DEFAULT_OBSERVE_PROMPT,
  host: '0.0.0.0',
  audioSource: 'system', // system = 整机混音；process:<pid|名字> = 只录某个进程（采集已实现，票 17）。注意：真正生效的是 asr_service 的环境变量 WATCH_ALONG_AUDIO_SOURCE，这个设置项还没接到那条线上 // 手机端监听地址：0.0.0.0 = 局域网可连，127.0.0.1 = 只本机
  // 高级（折叠）：裸阈值，正常不该改
  region: { top: 0, height: 1 },
  maxWaitSec: 15,
})

/** 三个预设。数值来自 spec 的场景表。 */

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
      case 'commentPrompt':
        if (typeof raw !== 'string') reject(key, '必须是字符串')
        else if (!raw.trim()) reject(key, '不能为空（留空就不知道该怎么说话了）')
        else if (raw.length > 600) reject(key, '太长了（最多 600 字），模型会当成正文去读')
        else value.commentPrompt = raw
        break
      case 'observePrompt':
        if (typeof raw !== 'string') reject(key, '必须是字符串')
        else if (!raw.trim()) reject(key, '不能为空（留空就不知道让它看什么）')
        else if (raw.length > 600) reject(key, '太长了（最多 600 字），模型会把它当成正文去读')
        else value.observePrompt = raw
        break
      case 'observeSec': {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 120) {
          reject(key, '必须是 0–120 的整数（秒；0 = 关闭）')
          break
        }
        // 低于 6 秒没有意义：模型一轮 3–4 秒，发得比它跑得快只会排队。
        // 用户填 2 也按 6 存 —— 与其让设置看着生效、实际排队，不如当场对齐。
        value.observeSec = n === 0 ? 0 : Math.max(6, n)
        break
      }
      case 'wakeGapSec': {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 300) reject(key, '必须是 0–300 的整数（秒；0 = 不说话）')
        else value.wakeGapSec = n
        break
      }
      case 'idleStopMin': {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 1440) reject(key, '必须是 0–1440 的整数（分钟，0 = 不因空闲收工）')
        else value.idleStopMin = n
        break
      }
      case 'fps': {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 30) reject(key, '必须是 0–30 的整数（0 = 关闭画面）')
        else value.fps = n
        break
      }
      case 'quality':
        if (!QUALITIES.includes(raw)) reject(key, `只能是 ${QUALITIES.join(' / ')}`)
        else value.quality = raw
        break
      case 'imageQuality':
        if (!['none', 'low', 'high'].includes(raw)) reject(key, '只能是 none / low / high')
        else value.imageQuality = raw
        break
      case 'subtitle':
      case 'speech':
        if (typeof raw !== 'boolean') reject(key, '必须是 true / false')
        else value[key] = raw
        break
      case 'audioSource': {
        const v = String(raw ?? '')
        if (v !== 'system' && !/^process:.+/.test(v)) reject(key, '只能是 system 或 process:<pid|进程名>')
        else value.audioSource = v
        break
      }
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
  { id: 'whisper', label: 'Whisper 模型文件' },
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
