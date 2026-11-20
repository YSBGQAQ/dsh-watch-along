// WatchService —— 这个插件的唯一门面。
//
// 工具（给 AI）与 HTTP（给手机）都只是它的薄适配器；测试也只打这里。
// 屏幕、窗口、时间、PNG 编码全是注入的 —— 所以测试不需要真屏幕，也不加载 koffi。
const DEFAULT_SIZE = { width: 798, height: 450 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createWatchService({
  listWindows,
  lookupWindow,
  startCapture,
  encode, // (frame:{width,height,rgb}) => Buffer
  size = DEFAULT_SIZE,
  fps = 8,
  now = Date.now,
  onCaptureStderr = null,
} = {}) {
  if (typeof encode !== 'function') throw new Error('createWatchService 需要注入 encode（PNG 编码器）')

  let capture = null
  let latest = null // { t, at, buf }
  let title = null
  let startedAt = null
  let state = 'idle'
  let reason = null
  let frames = 0

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
    try {
      capture?.stop?.()
    } catch {
      /* 停止失败不该阻止状态复位 */
    }
    capture = null
    latest = null
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
    return status()
  }

  /**
   * 取一张画面。
   * `live: true` 会等一个「调用之后才到达」的帧 —— 否则拿到的可能是几百毫秒前的旧帧。
   * `live: false` 用手上最新的帧，立即返回。
   */
  async function frame({ live = false, timeoutMs = 3000 } = {}) {
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

  return { start, stop, frame, status }
}
