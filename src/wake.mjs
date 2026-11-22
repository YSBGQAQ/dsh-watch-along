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
export function buildSummary(events, { now, windowMs, max, format = formatEvent }) {
  const fresh = (events ?? []).filter(
    (e) => e && typeof e.at === 'number' && now - e.at <= windowMs,
  )
  if (!fresh.length) return ''
  const picked = fresh
    .slice()
    // 选人按强度（票面要求保留哪些事件），**输出按时间正序** ——
    // 给模型看的是一段经过，乱序会让它把因果说反（把"别开窗"当成切镜之后的话）。
    // 选人：强度高的先占位，同强度取**最近**的
    .sort((a, b) => strengthRank(b.strength) - strengthRank(a.strength) || b.at - a.at)
    .slice(0, max)
    // 输出：按时间正序 —— 给模型看的是一段经过，乱序会把因果说反
    .sort((a, b) => a.at - b.at)
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

/**
 * 一条事件怎么变成一行字：带绝对时刻、相对秒数，并标出是画面/字幕/声音。
 *
 * 没有时间戳，模型分不清"刚发生"还是"三分钟前"，评价就会把早就不在画面上的人当成主角。
 */
export function formatEvent(e) {
  const t = typeof e?.t === 'number' ? `${e.t.toFixed(1)}s` : ''
  const clock = typeof e?.at === 'number' ? new Date(e.at).toTimeString().slice(0, 8) : ''
  const when = [clock, t].filter(Boolean).join(' / ')
  const label = { motion: '画面', ocr: '字幕', speech: '声音', cut: '切镜' }[e?.kind] ?? e?.kind ?? '事件'
  return `- ${when ? `[${when}] ` : ''}${label}：${e?.text ?? ''}`.trim()
}

export function createWaker({
  send, // async (text: string) => void —— 真正往会话塞消息的那一步
  now = Date.now,
  minGapMs = 120_000,
  promptTemplate = DEFAULT_COMMENT_PROMPT, // 设置里的「陪聊提示词」
  gapSec = 30, // 用于把模板里的 {n} 换成实际秒数
  sheetId = () => null, // 最近一张拼图的编号（可能没有）
  composeSec = 3, // 这张拼图覆盖多少秒（只用于文案）
  maxMisses = 5,
  summaryWindowMs = 180_000,
  summaryMax = 20,
  enabled = false,
  log = () => {},
  hasUserMessageSince = null, // async (ts) => boolean；拿不到就传 null
  format = formatEvent,
} = {}) {
  let events = []
  let introSent = false
  let lastObserveAt = 0
  let lastWakeAt = 0
  let misses = 0
  let exhausted = false

  /**
   * 静默观察轮：叫醒它更新理解，但**明确要求不输出任何文字**。
   *
   * 为什么要说"不要调用工具之外的任何东西"：模型不说的话，界面上就不会出现聊天气泡；
   * 一旦它写了一个字，那一条就会留在会话里，看起来像在刷屏。
   */
  /**
   * 一条事件压成 JSON 里的一项。
   *
   * 用**字段名**承载类型（说 / 字 / 画），不再单开 kind 字段：
   * 少一个键、少一对引号，模型读到的还是一个自解释的键。
   * strength 也去掉了 —— 它只用于本地挑事件，写进消息对模型没有用处。
   */
  function packEvent(e) {
    // 英文键名：say=台词（听写）、sub=字幕（OCR）、motion=画面变化。
    // 没有 cut：事件只有这三种 kind，切镜的信息本来就在 text 里（"切镜"）。
    const key = { speech: 'say', ocr: 'sub', motion: 'motion' }[e.kind] ?? 'event'
    const item = {}
    item.at = typeof e.at === 'number' ? new Date(e.at).toTimeString().slice(0, 8) : null
    // 画面事件常常没有 text（只有"变了多少"），空字符串模型读不懂。
    // cells 是参与变化的格数，比一个字都没有有用。
    if (e.text != null) item[key] = String(e.text)
    else if (key === 'motion') item[key] = e.cells ? `画面变化(${e.cells}格)` : '画面变化'
    else item[key] = ''
    if (e.sheetId) item.sheetId = e.sheetId
    return item
  }

  async function observe() {
    // 只发**上次观察之后新来的**事件：秒级调用发整段摘要等于每秒重复一遍。
    const floor = lastObserveAt || now() - 5000
    const fresh = events.filter((e) => e.at > floor)
    lastObserveAt = now()
    const sid = (() => {
      try {
        return sheetId?.() ?? null
      } catch {
        return null
      }
    })()
    const maxT = events.reduce((m, e) => (typeof e.t === 'number' && e.t > m ? e.t : m), 0)
    // **必须有上限**：万一模型落后很久，fresh 会把积压全带上，
    // 一条消息从几百字节涨到几万字节，反而拖慢它 —— 那才是恶性循环。
    const MAX_EVENTS = 12
    const shown = fresh.slice(-MAX_EVENTS)
    // **JSON 而不是散文**：模型读字段比读句子稳，prompt 也单独成字段，
    // 不会被当成"对这一帧的感叹"。
    const payload = {
      at: new Date(now()).toTimeString().slice(0, 8),
      windowSec: composeSec,
      image: sid ?? null,
      ...(fresh.length > MAX_EVENTS ? { omitted: fresh.length - MAX_EVENTS } : {}),
      events: shown.map(packEvent),
      prompt: '用简短的一句话总结有用信息，不要整段，一行即可，直接输出到一个代码块里。',
    }
    // **紧凑序列化**（不缩进）：缩进约占 25%，而模型不在乎好看。
    const prompt = JSON.stringify(payload)
    try {
      await send(prompt)
    } catch (e) {
      log(`静默观察发送失败：${e?.message ?? e}`)
      return { ok: false, reason: 'send-failed' }
    }
    return { ok: true }
  }

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
    // 说话那条**必带提示词**（用户明确要求）：它是这一轮该说什么的唯一依据，
    // 只放在秒级数据里会被淹没，只发一次又会被上下文挤掉。
    const sid = (() => {
      try {
        return sheetId?.() ?? null
      } catch {
        return null
      }
    })()
    const maxT = events.reduce((m, e) => (typeof e.t === 'number' && e.t > m ? e.t : m), 0)
    // 选人看强度、输出按时间正序（见 buildSummary 的注释）
    const picked = events
      .filter((e) => e && typeof e.at === 'number' && now() - e.at <= summaryWindowMs)
      .sort((a, b) => strengthRank(b.strength) - strengthRank(a.strength) || b.at - a.at)
      .slice(0, summaryMax)
      .sort((a, b) => a.at - b.at)
    const payload = {
      at: new Date(now()).toTimeString().slice(0, 8),
      windowSec: gapSec,
      image: sid ?? null,
      events: picked.map(packEvent),
      prompt: renderPrompt(promptTemplate, gapSec),
    }
    const prompt = JSON.stringify(payload)
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

  /** 提示词已经单独发过了：之后的唤醒只带数据。 */
  function markIntroSent(v = true) {
    introSent = v
  }

  function reset() {
    events = []
    introSent = false
    lastObserveAt = 0
    lastWakeAt = 0
    misses = 0
    exhausted = false
  }

  return {
    feed,
    maybeWake,
    observe,
    markIntroSent,
    /** 首条要发的那段"规则说明"（由调用方单独发出去）。 */
    introText: () => renderPrompt(promptTemplate, gapSec),
    reset,
    get state() {
      return { misses, exhausted, lastWakeAt, buffered: events.length }
    },
  }
}
