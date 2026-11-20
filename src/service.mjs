// WatchService —— 这个插件的唯一门面。
//
// 工具（给 AI）与 HTTP（给手机）都只是它的薄适配器；测试也只打这里。
// 屏幕、窗口、时间都是注入进来的，所以测试不需要真屏幕。
import { encodePng } from '../vendor/dsh-streamvision-main/lib/native.js'

const DEFAULT_SIZE = { width: 798, height: 450 }

export function createWatchService({
  listWindows,
  lookupWindow,
  startCapture,
  size = DEFAULT_SIZE,
  fps = 8,
  now = Date.now,
  onCaptureStderr = null,
} = {}) {
  let capture = null
  let latest = null
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
      region: capture?.arg?.region ?? null,
      size: capture?.arg ? { width: capture.arg.width, height: capture.arg.height } : null,
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
        onFrame: ({ t, buf }) => {
          latest = { t, buf, width: dim.width, height: dim.height, at: now() }
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

  async function frame({ live = false, timeoutMs = 3000 } = {}) {
    void live // 流式采集下「最新一帧」就是此刻，无需另行触发
    if (!capture) throw new Error('还没开始监听：先调用 watch_start')

    const deadline = now() + timeoutMs
    while (!latest && now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    if (!latest) {
      state = 'failed'
      reason = '采不到帧'
      throw new Error(`采不到帧（等了 ${timeoutMs}ms）`)
    }

    const { buf, width, height, t, at } = latest
    return { png: encodePng({ width, height, rgb: buf }), width, height, t, at }
  }

  return { start, stop, frame, status }
}
