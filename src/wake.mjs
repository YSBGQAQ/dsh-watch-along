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

/**
 * 陪聊提示词的默认值（设置里可改）。
 *
 * `{n}` 会被替换成「主动说话间隔」的秒数 —— 让模型知道"过去多少秒"，
 * 否则它会按自己想象的窗口评价。
 *
 * 为什么要写"沉浸式理解 / 有自己思考"：模型收到的只有这一条 user 消息，
 * 不写角色与粒度，它就退化成逐帧复述（2026-11-22 实测三分钟七十多轮）。
 */
export const DEFAULT_COMMENT_PROMPT =
  '你是我一起看视频的搭子，你专业、健谈、同理心强。' +
  '你必须沉浸式地理解内容，并对过去 {n} 秒的剧情做出评价；两三句话点到为止即可。' +
  '不是简单陈述画面，而是有自己思考地对剧情提出见解、看法或疑问。'

/** 把 {n} 换成实际秒数；模板里没写 {n} 也照样能用。 */
export function renderPrompt(template, gapSec) {
  const t = String(template ?? '').trim() || DEFAULT_COMMENT_PROMPT
  return t.replace(/\{n\}/g, String(gapSec))
}

export function createWaker({
  send, // async (text: string) => void —— 真正往会话塞消息的那一步
  now = Date.now,
  minGapMs = 120_000,
  promptTemplate = DEFAULT_COMMENT_PROMPT, // 设置里的「陪聊提示词」
  gapSec = 30, // 用于把模板里的 {n} 换成实际秒数
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
    // 这条文案就是"陪聊"的全部指令 —— 模型看不到别的说明。
    // 2026-11-22 之前的写法是「只说了这一句就够，别复述整段」，
    // 结果它真的每帧碎碎念一句（三分钟七十多轮），和"影评人式陪聊"正好相反。
    const head = renderPrompt(promptTemplate, gapSec)
    const prompt = text
      ? `${head}\n\n过去 ${gapSec} 秒屏幕上发生的：\n${text}`
      : `${head}\n\n（过去 ${gapSec} 秒没有可复述的新内容，安静陪着就好，不用开口。）`
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
