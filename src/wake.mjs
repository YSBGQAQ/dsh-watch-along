// 主动唤醒（票 11）的判定层：什么时候该开口、说什么、什么时候该闭嘴。
//
// 这里**只管策略**，不碰宿主：把「发一条消息」做成注入的 `send`，
// 于是节流、次数上限、摘要挑选这些能全量单测，不必等真机会话。
//
// 票 11 敲定的规则（逐条对应）：
//   默认关；触发条件 strength=high 或 cut=true；最小间隔 120 秒；
//   连续 5 次没回应就本次陪看不再唤醒；用户一说话归零；重新 watch_start 恢复。

// 注意：采集侧给的是 high / medium / low（见 service.mjs 的 toMotion）。
// 这里把 mid 也认作 medium —— 早期文档写的是 mid，两种写法都可能出现，
// 但**不能漏掉 medium**：漏了会让「中等强度」排到 low 后面，摘要顺序整个反掉。
const STRENGTH_RANK = { high: 3, medium: 2, mid: 2, low: 1 }

/** 事件强度的排序权重。不认识的强度按最低算。 */
export function strengthRank(v) {
  return STRENGTH_RANK[String(v ?? '').toLowerCase()] ?? 0
}

/** 这条事件值不值得叫醒人。 */
export function isTrigger(event) {
  if (!event || typeof event !== 'object') return false
  if (event.cut === true) return true
  return String(event.strength ?? '').toLowerCase() === 'high'
}

/**
 * 把最近一段时间的事件压成一段摘要：先按强度降序，再按时间倒序，最多 `max` 条。
 * 口播原话是「给排序后的摘要，措辞交给模型」——所以这里只挑，不改写。
 */
export function buildSummary(events, { now, windowMs, max, format }) {
  const fresh = (events ?? []).filter(
    (e) => e && typeof e.at === 'number' && now - e.at <= windowMs,
  )
  if (!fresh.length) return ''
  const picked = fresh
    .slice()
    .sort((a, b) => strengthRank(b.strength) - strengthRank(a.strength) || b.at - a.at)
    // 票面验收写的是「按 strength 排序」，所以**不**再改回时间正序：
    // 选人靠强度，输出也得按强度，否则验收那条对不上。
    .slice(0, max)
  return picked.map((e) => format(e)).join('\n')
}

export function createWaker({
  send, // async (text: string) => void —— 真正往会话塞消息的那一步
  now = Date.now,
  minGapMs = 120_000,
  maxMisses = 5,
  summaryWindowMs = 180_000,
  summaryMax = 20,
  enabled = false,
  log = () => {},
  hasUserMessageSince = null, // async (ts) => boolean；拿不到就传 null
  format = (e) => `- ${e.text ?? e.kind ?? '事件'}`,
} = {}) {
  let events = []
  let lastWakeAt = 0
  let misses = 0
  let exhausted = false

  function feed(event) {
    if (!event || typeof event !== 'object') return
    events.push({ ...event, at: typeof event.at === 'number' ? event.at : now() })
    // 只留摘要窗口内的，别让数组无限长（两小时能攒上万条）
    const cutoff = now() - summaryWindowMs
    if (events.length > 200) events = events.filter((e) => e.at >= cutoff)
  }

  async function maybeWake(event) {
    if (!enabled) return { woke: false, reason: 'disabled' }
    if (exhausted) return { woke: false, reason: 'exhausted' }
    if (!isTrigger(event)) return { woke: false, reason: 'not-worth-it' }
    if (lastWakeAt && now() - lastWakeAt < minGapMs) return { woke: false, reason: 'too-soon' }

    // 上一次唤醒之后用户有没有说话 —— 只在要开口前查一次，不做实时订阅。
    if (lastWakeAt && hasUserMessageSince) {
      let replied = true
      try {
        replied = await hasUserMessageSince(lastWakeAt)
      } catch (e) {
        // 读不到就**保守处理**：不确定就算有人回过，不计数。
        // 否则一次读失败就会把「5 次上限」提前扣掉，等于把用户的陪看掐了。
        log(`读会话历史失败，本次不计数：${e?.message ?? e}`)
        replied = true
      }
      if (!replied) {
        misses += 1
        if (misses >= maxMisses) {
          exhausted = true
          log(`连续 ${misses} 次没回应，本次陪看不再主动唤醒`)
          return { woke: false, reason: 'exhausted-now' }
        }
      } else {
        misses = 0
      }
    }

    const text = buildSummary(events, { now: now(), windowMs: summaryWindowMs, max: summaryMax, format })
    const prompt = text
      ? `[陪看] 屏幕上有值得说的动静，只说了这一句就够，别复述整段：\n${text}`
      : '[陪看] 屏幕上有值得说的动静。'
    try {
      await send(prompt)
    } catch (e) {
      // 发不出去不是致命错：不能把陪看主流程拖挂。
      // 也**不要**记 lastWakeAt —— 这一拍根本没叫成，不该白占掉接下来的 120 秒。
      log(`唤醒发送失败：${e?.message ?? e}`)
      return { woke: false, reason: 'send-failed' }
    }
    lastWakeAt = now()
    return { woke: true, text: prompt }
  }

  function reset() {
    events = []
    lastWakeAt = 0
    misses = 0
    exhausted = false
  }

  return {
    feed,
    maybeWake,
    reset,
    get state() {
      return { misses, exhausted, lastWakeAt, buffered: events.length }
    },
  }
}
