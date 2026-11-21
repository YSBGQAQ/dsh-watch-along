// WatchService —— 这个插件的唯一门面。
//
// 工具（给 AI）与 HTTP（给手机）都只是它的薄适配器；测试也只打这里。
// 屏幕、窗口、时间、PNG 编码、pipeline 全是注入的 —— 所以测试不需要真屏幕，也不加载 koffi。
import { createEventQueue } from './events.mjs'

const DEFAULT_SIZE = { width: 798, height: 450 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 便宜差分：只用来决定"要不要立刻逼一张图"，真正的判定仍在 pipeline 里。 */
function cheapDiff(prev, cur) {
  if (!prev || prev.length !== cur.length) return 0
  const stride = Math.max(3, Math.floor(cur.length / 3000))
  let sum = 0
  let n = 0
  for (let i = 0; i + 2 < cur.length; i += stride) {
    sum += Math.abs(cur[i] - prev[i])
    n += 1
  }
  return n ? sum / n : 0
}

function classify(peak) {
  if (peak >= 18) return 'high'
  if (peak >= 10) return 'medium'
  return 'low'
}

function toMotion(change, sheetId) {
  // pipeline 给的是网格归一化后的四角 {x0,y0,x1,y1}（0..1），不是 {x,y,w,h}。
  const box = change?.box ?? null
  const where = box && Number.isFinite(box.x0)
    ? `${Math.round(((box.x0 + box.x1) / 2) * 100)}%,${Math.round(((box.y0 + box.y1) / 2) * 100)}%`
    : null
  // 注意：region 模式下 peak 常见量级是 1e-3，再被 toFixed(1) 抹成 0，
  // 所以分档用「切点 + 参与帧数」这两个可靠的量，peak 只原样透传供以后标定。
  const cells = change?.n ?? 0
  const strength = change?.cut ? 'high' : cells >= 12 ? 'high' : cells >= 4 ? 'medium' : 'low'
  return {
    strength,
    where,
    peak: change?.peak ?? 0,
    cells,
    cut: Boolean(change?.cut),
    from: change?.from ?? null,
    to: change?.to ?? null,
    sheetId: sheetId ?? null,
  }
}

export function createWatchService({
  listWindows,
  lookupWindow,
  startCapture,
  encode, // (frame:{width,height,rgb}) => Buffer
  createPipeline = null, // () => { push, take, flushNow, drainChanges }
  subtitle = null, // { feed({buf,width,height}) } —— 字幕通道，缺省不启
  speech = null, // { start(), stop() } —— 声音通道，缺省不启
  queue = null,
  spikeThreshold = 0,
  size = DEFAULT_SIZE,
  fps = 8,
  now = Date.now,
  onCaptureStderr = null,
} = {}) {
  if (typeof encode !== 'function') throw new Error('createWatchService 需要注入 encode（PNG 编码器）')

  const eventQueue = queue ?? createEventQueue({ now })
  let capture = null
  let pipe = null
  let latest = null // { t, at, buf }
  let latestSheet = null // 最近一张真拼出来的图（pipeline 出图时才更新）
  let prevBuf = null
  let title = null
  let startedAt = null
  let state = 'idle'
  let reason = null
  let frames = 0
  let spikes = 0
  // 拼图仓库：id → {png,width,height,t}。只留最近若干张，事件里只带 id，不带像素。
  const sheetStore = new Map()
  let sheetSeq = 0
  const SHEET_KEEP = 20

  function status() {
    return {
      state,
      window: title,
      reason,
      frames,
      since: startedAt,
      fps: capture ? capture.params.fps : null,
      region: capture ? capture.params.region : null,
      size: capture ? { width: capture.params.width, height: capture.params.height } : null,
    }
  }

  async function stop() {
    speech?.stop?.()
    try {
      capture?.stop?.()
    } catch {
      /* 停止失败不该阻止状态复位 */
    }
    capture = null
    latest = null
    latestSheet = null
    pipe = null
    prevBuf = null
    title = null
    startedAt = null
    frames = 0
    state = 'idle'
    reason = null
    return status()
  }

  /** 采集流断了就是故障：GLOSSARY 里写死「任何结束都按故障处理」。 */
  function onCaptureEnded(info) {
    if (!capture) return // 主动 stop 触发的，不算故障
    state = 'failed'
    reason = info instanceof Error ? String(info.message ?? info) : '采集结束'
  }

  async function start({ window: want, size: askSize } = {}) {
    if (!want) throw new Error('缺少 window 参数：要盯哪个窗口？')
    if (capture) {
      if (title === want) return status()
      await stop()
    }

    const rect = lookupWindow(want)
    if (!rect) {
      const list = (listWindows?.() ?? []).filter(Boolean)
      throw new Error(
        `找不到窗口「${want}」。当前可见窗口：${list.length ? list.join(' / ') : '（无）'}`,
      )
    }

    const dim = askSize ?? size
    state = 'starting'
    try {
      pipe = createPipeline ? createPipeline() : null
      prevBuf = null
      capture = startCapture({
        region: rect,
        width: dim.width,
        height: dim.height,
        fps,
        onStderr: onCaptureStderr ?? undefined,
        onClose: onCaptureEnded,
        onFrame: ({ t, buf }) => {
          latest = { t, at: now(), buf }
          frames += 1
          if (!pipe) return

          // 扳机默认关闭（spikeThreshold = 0）。它是给"平时不出图、但画面突然动了"提速用的，
          // 阈值没经过真实视频标定就先开着，会把批次切碎成 1–2 帧（实测 cells=2、where 为空）。
          const d = cheapDiff(prevBuf, buf)
          prevBuf = buf
          pipe.push({ t, buf })
          if (spikeThreshold > 0 && d >= spikeThreshold) {
            spikes += 1
            pipe.flushNow?.('spike')
          }

          // 变化摘要在「图被截走」和「图还在队列里等下一张」两种情况下都会产生。
          // 必须先读再 take()：没出图的那一帧攒下的摘要，会在下一次出图时被
          // take() + 后面的摘要一起挤掉，事件流就等于被本帧的 tick 节奏吃光（实测 30 秒 0 条）。
          // 字幕通道自己节流（默认 1.5 秒一次），这里每帧都喂，由它决定跑不跑。
          if (subtitle) {
            subtitle.feed({ buf, width: dim.width, height: dim.height }).catch(() => {})
          }

          const changeList = pipe.drainChanges?.() ?? []
          const sheet = pipe.take?.() ?? null
          // 这一帧真的吐了图：先入库，再把它挂到同一拍发出的事件上。
          // pipeline 的 sheet 没有 id（`take()` 出来的对象里没有这个字段），自己发号。
          let sheetId = null
          if (sheet?.png) {
            sheetSeq += 1
            sheetId = `sheet-${sheetSeq}`
            sheetStore.set(sheetId, {
              png: sheet.png, width: sheet.w ?? size.width, height: sheet.h ?? size.height, t: sheet.at,
            })
            while (sheetStore.size > SHEET_KEEP) sheetStore.delete(sheetStore.keys().next().value)
            latestSheet = { ...sheet, id: sheetId }
          }
          for (const change of changeList) {
            // 兜底图（silentFloorSec 到点发的"我还在看"）不是变化事件。
            // 判据是 change.floor —— 它来自帧上的 `via === 'floor'`，
            // **不能**用 sheet.why（那里没有这个值，我踩过一次），也不能用 peak
            // （region 模式下 peak 常被 toFixed(1) 抹成 0）。
            if (change?.floor) continue
            eventQueue.add('motion', toMotion(change, sheetId))
          }
        },
      })
    } catch (e) {
      state = 'failed'
      reason = String(e?.message ?? e)
      capture = null
      throw e
    }

    title = want
    startedAt = now()
    state = 'running'
    reason = null
    speech?.start?.()
    return status()
  }

  /**
   * 取一张画面。
   * `live: true` 会等一个「调用之后才到达」的帧 —— 否则拿到的可能是几百毫秒前的旧帧。
   * `live: false` 用手上最新的帧，立即返回。
   */
  async function frame({ sheetId = null, live = false, timeoutMs = 3000 } = {}) {
    if (sheetId) {
      const hit = sheetStore.get(sheetId)
      if (!hit) throw new Error(`没有这张拼图：${sheetId}（只留最近 ${SHEET_KEEP} 张）`)
      return { ...hit, cached: true }
    }
    if (!capture) throw new Error('还没开始采集：先调用 watch_start')

    const cutoff = now()
    const deadline = cutoff + timeoutMs
    while (!latest || (live && latest.at < cutoff)) {
      if (now() > deadline) {
        state = 'failed'
        reason = '采不到帧'
        throw new Error(`采不到帧（等了 ${timeoutMs}ms）`)
      }
      await sleep(10)
    }

    const { buf, t, at } = latest
    const { width, height } = capture.params
    // t = 相对采集开始的秒数；at = 墙上时间(epoch ms)。两个都要：前者对齐音频，
    // 后者跨进程可读（见 ADR 0003 关于时间码的决定）。
    return { png: encode({ width, height, rgb: buf }), width, height, t, at }
  }

  /** 读事件。`waitMs > 0` 走长轮询，没事件就等到点返回 timedOut。 */
  async function events({ sinceId = null, waitMs = 0, limit = 100 } = {}) {
    if (waitMs > 0) return eventQueue.wait({ sinceId, waitMs, limit })
    return { ...eventQueue.read({ sinceId, limit }), timedOut: false }
  }

  /** 原始帧（rgb24）直出：保留「此刻屏幕上是什么」的全部信息，给合成图之类的下游用。 */
  async function rawFrame({ live = false, timeoutMs = 3000 } = {}) {
    if (!capture) throw new Error('还没开始采集：先调用 watch_start')
    const cutoff = now()
    const deadline = cutoff + timeoutMs
    while (!latest || (live && latest.at < cutoff)) {
      if (now() > deadline) {
        state = 'failed'
        reason = '采不到帧'
        throw new Error(`采不到帧（等了 ${timeoutMs}ms）`)
      }
      await sleep(10)
    }
    const { width, height } = capture.params
    return { ...latest, width, height }
  }

  /** pipeline 最近一张拼图（可能为 null：还没攒够一箱）。 */
  function sheet() {
    return latestSheet
  }

  /** 给外部通道（字幕/声音）往同一条队列里投事件。 */
  function emit(kind, payload) {
    return eventQueue.add(kind, payload)
  }

  return { start, stop, frame, rawFrame, sheet, status, events, emit }
}
