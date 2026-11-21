// 声音通道：定时问一次转写服务"刚才这几秒说了什么"，把句子变成 speech 事件。
//
// 与字幕通道的区别（这点决定了不能照抄）：
//   OCR 是"看一眼现在屏幕上是什么字"，可以随时重复看；
//   ASR 是"把这一段音频从头转一遍"，窗口之间必须有边界，
//   所以跨窗口的那半句会重复出现 —— 靠"跟上一句相同就跳过"来去重。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createSpeechReader({
  listen, // (seconds) => Promise<{lines:[{text,t0,t1}]}>
  onEvent,
  windowSec = 6,
  minChars = 2,
  similarity = 0.9,
  now = Date.now,
} = {}) {
  let busy = false
  let emitted = [] // 最近几条，用来挡住跨窗口的重复
  let stopped = false
  let timer = null

  const norm = (s) => String(s ?? '').replace(/[\s，。、,.!?！？…]+/g, '')

  function isDuplicate(text) {
    const a = norm(text)
    return emitted.some((prev) => {
      const b = norm(prev)
      if (!a || !b) return false
      if (a === b) return true
      // 跨窗口常见：一句被切成两半，后一次只多/少几个字
      const short = a.length < b.length ? a : b
      const long = a.length < b.length ? b : a
      return long.includes(short) && short.length / long.length >= similarity
    })
  }

  async function tick() {
    if (busy || stopped) return null
    busy = true
    try {
      const res = (await listen(windowSec)) ?? {}
      const lines = Array.isArray(res.lines) ? res.lines : []
      const fresh = []
      for (const line of lines) {
        const text = String(line.text ?? '').trim()
        if (text.length < minChars) continue
        if (isDuplicate(text)) continue
        emitted.push(text)
        if (emitted.length > 8) emitted.shift()
        const event = {
          text,
          t0: Number(line.t0 ?? 0),
          t1: Number(line.t1 ?? 0),
          at: now(),
        }
        fresh.push(event)
        onEvent?.(event)
      }
      return fresh
    } catch (e) {
      // 转写服务挂了不能拖垮画面：只报一条错误，下一拍继续试
      onEvent?.({ error: String(e?.message ?? e) })
      return null
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer) return
    stopped = false
    // 先把模型热起来（第一次请求慢），再按窗口节奏跑
    timer = setInterval(() => {
      void tick()
    }, Math.max(1, windowSec) * 1000)
    timer.unref?.()
    void tick()
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop }
}
