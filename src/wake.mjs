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
    .filter(worthTelling) // 碎片和乱码不进转写（见 worthTelling 的实测）
    .sort((a, b) => strengthRank(b.strength) - strengthRank(a.strength) || b.at - a.at)
    .slice(0, max)
    // 输出：按时间正序 —— 给模型看的是一段经过，乱序会把因果说反
    .sort((a, b) => a.at - b.at)
  return mergeSameSecond(picked).map((e) => format(e)).join('\n')
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
/**
 * 把事件里的 "50%,40%" 换成方位词。
 *
 * 为什么值这一步：模型读"中部/左上"能直接对上画面，读"50%,40%"还要自己换算，
 * 而它每一轮只有一两秒。dsh-streamvision 的 eventize() 里的 where 也是这个用途。
 */
export function wherePhrase(where) {
  const m = /^(\d{1,3})%,\s*(\d{1,3})%$/.exec(String(where ?? '').trim())
  if (!m) return ''
  const x = Number(m[1])
  const y = Number(m[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return ''
  const v = y < 34 ? '上' : y > 66 ? '下' : ''
  const h = x < 34 ? '左' : x > 66 ? '右' : ''
  if (!v && !h) return '中部'
  if (v && h) return `${v}${h}`
  return v ? `${v}部` : `${h}部`
}

/**
 * 值不值得写进"人话转写"。
 *
 * 2026-11-23 实测：一轮 10 分钟的 OCR 里 20% 是垃圾 —— 10% 是「好像是」这种
 * 两字碎片，10% 是「LNPII MLIHL>」「信温」这种误读。结构化事件保留它们（
 * watch_events 要能查到原文），但**转写里必须滤掉**：模型会把垃圾当剧情。
 */
export function worthTelling(e) {
  if (!e) return false
  // 画面事件是我们自己写的标签（"切镜"/"变化"），不是 OCR 的产物 —— 永远留
  if (e.kind === 'motion') return true
  const t = String(e.text ?? '').trim()
  if (!t) return false
  const visible = t.replace(/[^\p{L}\p{N}]/gu, '')
  if (visible.length <= 2) return false // 「是啊」「嗯」——单独一行没有信息（三字的「看不清」不在此列）
  // OCR 从界面边缘/水印上抠下来的符号串（`LNPII MLIHL>,`）：正常台词不会长这样
  if (/[<>{}\[\]\\|_=~^]/.test(t)) return false
  if (/^\d{3,4}\s*[pPkK]\b/.test(t)) return false // 1080P / 4K 水印
  const hasCJK = /[\u4e00-\u9fa5]/.test(t)
  if (!hasCJK && visible.length < 8) return false // 短英文多半是水印
  return true
}

export function formatEvent(e) {
  const clock = typeof e?.at === 'number' ? new Date(e.at).toTimeString().slice(0, 8) : ''
  const label = { motion: '画面', ocr: '字幕', speech: '声音', cut: '切镜' }[e?.kind] ?? e?.kind ?? '事件'
  // 只留时刻，不留"第几秒"：同一句里两个时间轴，模型反而算不过来。
  return `- ${clock ? `[${clock}] ` : ''}${label}：${e?.text ?? ''}`.trim()
}

/** 同一秒、同一类的几条（一帧里读出好几行）合成一条，别让模型以为这是好几句台词。 */
function mergeSameSecond(list) {
  const out = []
  for (const e of list) {
    const sec = typeof e.at === 'number' ? Math.floor(e.at / 1000) : null
    const last = out[out.length - 1]
    const lastSec = last && typeof last.at === 'number' ? Math.floor(last.at / 1000) : null
    if (last && sec != null && sec === lastSec && last.kind === e.kind) {
      const parts = last.parts ?? [String(last.text)]
      const t = String(e.text ?? '')
      // 同一帧里「好像是」和「好像是吧」是同一次 OCR 的两次尝试，留长的就行
      if (parts.some((p) => p.includes(t))) continue
      const idx = parts.findIndex((p) => t.includes(p))
      if (idx >= 0) parts[idx] = t
      else parts.push(t)
      last.parts = parts
      continue
    }
    out.push({ ...e, parts: [String(e.text ?? '')] })
  }
  return out.map((e) => ({ ...e, text: (e.parts ?? []).join('；').slice(0, 120) }))
}

export function createWaker({
  send, // async (text: string) => void —— 真正往会话塞消息的那一步
  now = Date.now,
  minGapMs = null, // 不传就按 gapSec 算：说话间隔本身就是闸门
  promptTemplate = DEFAULT_COMMENT_PROMPT, // 设置里的「陪聊提示词」
  gapSec = 30, // 用于把模板里的 {n} 换成实际秒数
  sheetId = () => null, // 最近一张拼图的编号（可能没有）
  composeSec = 3, // 这张拼图覆盖多少秒（只用于文案）
  // 强制看图（2026-11-23）：传一个 (sinceWakeAt) => boolean 的判定，"上一轮叫醒之后有没有
  // 调过 watch_frame"。返回 false 时，这一拍**不发新数据**，只发一条"先看图"的指令 ——
  // 不给数据是关键，给了它照样能盲答。
  frameGate = null,
  // 图直接附在消息里（2026-11-23）：这种情况下不必再要求它调工具 ——
  // 它一睁眼就有画面，多一次工具往返纯属浪费 2 秒。
  attachImages = false,
  // 完全不传图时（imageQuality=none）连"强制看图"也一起关掉：
  // 否则它会为了看图去调工具，而工具最后还是要传一张图。
  forceLook = true,
  maxFrameNudges = 3, // 连续催几次还不动，就放弃强制，恢复发数据（防死锁）
  maxMisses = 5,
  summaryWindowMs = 180_000,
  summaryMax = 20,
  enabled = false,
  log = () => {},
  hasUserMessageSince = null, // async (ts) => boolean；拿不到就传 null
  format = formatEvent,
} = {}) {
  let events = []
  const speakGapMs = minGapMs == null ? gapSec * 1000 : minGapMs
  let introSent = false
  let lastObserveAt = 0
  let lastWakeAt = 0
  let misses = 0
  let exhausted = false
  let frameNudges = 0 // 连续催看图次数（看到图就归零）
  let observeNudges = 0 // 静默观察那条的同一本账

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
    if (e.text != null) item[key] = String(e.text)
    else if (key === 'motion') {
      // 光写"画面变化(36格)"模型读不出发生了什么。带上**强度**和**位置**：
      // 这是 dsh-streamvision 的 eventize() 教的（strength + where + 与上一事件的关系），
      // 我们之前只留了格数，等于把转写白写了。
      const how = e.strength === 'high' ? '大变化' : e.strength === 'medium' ? '中等变化' : e.strength ? '轻微变化' : '变化'
      const pos = wherePhrase(e.where)
      item[key] = `画面${how}${pos ? `（${pos}）` : ''}${e.cells ? `·${e.cells}格` : ''}`
    } else item[key] = ''
    if (e.sheetId) item.sheetId = e.sheetId
    return item
  }

  // **限流放在这里，而不是调用方**。
  // 2026-11-23 的教训：index.js 里有两处会发消息（循环 + 事件旁路），
  // 限流写在调用方时，只要漏掉一处就全废。放在唯一发送点才是真的闸。
  const MIN_OBSERVE_MS = 5000

  /** 强制看图的那句硬要求：有拼图给编号，没有就让它直接抓当前帧。 */
  function frameHint(sid) {
    if (attachImages) return '图已附在这条消息里（最后一张），直接看它，不要再调用 watch_frame。'
    return sid
      ? '先调用 watch_frame（sheetId 用 image 的值）看当前画面，再按 prompt 的要求回答。'
      : '先调用 watch_frame（不带参数，抓当前帧）看画面，再按 prompt 的要求回答。'
  }

  async function observe() {
    if (lastObserveAt && now() - lastObserveAt < MIN_OBSERVE_MS) {
      return { ok: false, reason: 'observe-too-soon' }
    }
    // 只发**上次观察之后新来的**事件：秒级调用发整段摘要等于每秒重复一遍。
    const floor = lastObserveAt || now() - 5000
    const fresh = events.filter((e) => e.at > floor)
    const sid = (() => {
      try {
        return sheetId?.() ?? null
      } catch {
        return null
      }
    })()

    // ── 强制看图（**所有轮次**，2026-11-23 用户要求）────────────────────────
    // 静默观察也要先看图：它才是最高频的那条（每 5 秒一次），不拦它等于没强制。
    if (typeof frameGate === 'function' && lastObserveAt && observeNudges < maxFrameNudges) {
      let looked = true
      try {
        looked = frameGate(lastObserveAt) !== false
      } catch {
        looked = true
      }
      if (!looked) {
        observeNudges += 1
        const nudge = JSON.stringify({
          at: new Date(now()).toTimeString().slice(0, 8),
          image: sid ?? null,
          ...(forceLook ? { mustSee: frameHint(sid) } : {}),
          why: '上一轮没有看图，这一轮不给新数据（静默观察）',
        })
        lastObserveAt = now()
        try {
          await send(nudge)
        } catch (e) {
          log(`催看图（静默观察）发送失败：${e?.message ?? e}`)
          return { ok: false, reason: 'send-failed' }
        }
        log(`催看图（静默观察，第 ${observeNudges} 次）`)
        return { ok: true, nudged: true }
      }
      observeNudges = 0
    }

    lastObserveAt = now() // 闸门与增量游标同一个值：这次发出去之后，下一拍才允许再发
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
      mustSee: frameHint(sid),
      ...(fresh.length > MAX_EVENTS ? { omitted: fresh.length - MAX_EVENTS } : {}),
      events: shown.map(packEvent),
      prompt: '看这一帧，用简短的一句话总结有用信息，一行即可。**只输出这一个代码块，块外不要写任何文字。**',
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
    if (lastWakeAt && now() - lastWakeAt < speakGapMs) return { woke: false, reason: 'too-soon' }

    const sid = (() => {
      try {
        return sheetId?.() ?? null
      } catch {
        return null
      }
    })()

    // ── 强制看图（2026-11-23）──────────────────────────────────────────────
    // 为什么是"不给数据"而不是"加一句请看图"：模型拿到事件就会直接总结，
    // 永远不会多花一轮去调工具。把数据扣住，它只有看图这一件事可做。
    // 上限 maxFrameNudges 次，防止模型死活不调把陪看卡死。
    if (typeof frameGate === 'function' && lastWakeAt) {
      let looked = true
      try {
        looked = frameGate(lastWakeAt) !== false
      } catch {
        looked = true // 判定本身出错就放行，不能让记账问题停掉陪看
      }
      if (looked) {
        frameNudges = 0
      } else if (frameNudges < maxFrameNudges) {
        frameNudges += 1
        const nudge = JSON.stringify({
          at: new Date(now()).toTimeString().slice(0, 8),
          image: sid ?? null,
          mustSee: '先调用 watch_frame（把 image 的值传给 sheetId）看当前画面，再用一句话说你看到了什么。',
          why: '上一轮没有看图，这一轮不给新数据',
        })
        try {
          await send(nudge)
        } catch (e) {
          log(`催看图发送失败：${e?.message ?? e}`)
          return { woke: false, reason: 'send-failed' }
        }
        lastWakeAt = now()
        log(`催看图（第 ${frameNudges} 次）：上一轮没调 watch_frame，这一轮只发指令`)
        return { woke: true, nudged: true, text: nudge }
      } else if (frameNudges === maxFrameNudges) {
        frameNudges += 1 // 只记一次，别每拍都刷
        log(`连续 ${maxFrameNudges} 次催看图无效，恢复发送数据（模型可能看不到工具）`)
      }
    }

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
    // sid 已在函数开头算好（强制看图那条也要用）
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
      // 强制看图：说话这一轮必须先把画面看一遍（所有轮次都要，见 observe 里的同一道闸）。
      ...(forceLook ? { mustSee: frameHint(sid) } : {}),
      // 这段"人话转写"一直在算（`const text = buildSummary(...)`），但 2026-11-23 改成
      // JSON payload 之后**被丢掉了** —— 用户一眼看出来"事件转写没用进去"。现在带上。
      ...(text ? { brief: text } : {}),
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
    frameNudges = 0
    observeNudges = 0
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
