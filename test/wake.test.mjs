// 票 11 的判定层测试。
//
// 这一层之所以值得全量单测：主动唤醒是**会打断用户**的功能，
// 判错的方向都是灾难 —— 该闭嘴时开口、该开口时永远闭嘴、用户睡着后被反复吵。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWaker, isTrigger, buildSummary, strengthRank, wherePhrase, worthTelling, packEvent, observeFloor } from '../src/wake.mjs'

/** 可控时钟 + 记录发送。 */
function harness(opts = {}) {
  let t = 1_000_000
  const sent = []
  const logs = []
  const waker = createWaker({
    enabled: true,
    now: () => t,
    send: async (text) => {
      sent.push(text)
    },
    log: (m) => logs.push(String(m)),
    ...opts,
  })
  return {
    waker,
    sent,
    logs,
    advance: (ms) => {
      t += ms
    },
    get t() {
      return t
    },
  }
}

test('默认关：没开就一条都不发', async () => {
  const h = harness({ enabled: false })
  h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
  const r = await h.waker.maybeWake({ kind: 'motion', strength: 'high', at: h.t })
  assert.equal(r.woke, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(h.sent.length, 0)
})

test('触发条件：strength=high 或 cut=true，mid/low 不叫', async () => {
  const h = harness()
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'mid' })).woke, false)
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'low' })).woke, false)
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'high' })).woke, true)

  const h2 = harness()
  assert.equal((await h2.waker.maybeWake({ kind: 'motion', cut: true })).woke, true)
})

test('最小间隔：默认由 gapSec 决定（这里设成 120 秒）', async () => {
  const h = harness({ gapSec: 120 })
  h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'high' })).woke, true)

  h.advance(119_000)
  const r = await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(r.woke, false)
  assert.equal(r.reason, 'too-soon')

  h.advance(2_000)
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'high' })).woke, true)
  assert.equal(h.sent.length, 2)
})

test('连续 5 次没回应：本次陪看不再唤醒', async () => {
  const h = harness({ hasUserMessageSince: async () => false }) // 一次都没回
  for (let i = 0; i < 10; i++) {
    h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
    await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
    h.advance(130_000)
  }
  assert.ok(h.sent.length >= 1, '一次都没发出去，这条用例等于没验')
  assert.ok(h.sent.length <= 5, `发太多了：${h.sent.length} 条`)
  assert.equal(h.waker.state.exhausted, true)
  const r = await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(r.reason, 'exhausted')
})

test('用户回话后计数归零，可以继续说', async () => {
  let replied = false
  const h = harness({ hasUserMessageSince: async () => replied })
  for (let i = 0; i < 4; i++) {
    h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
    await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
    h.advance(130_000)
  }
  replied = true
  h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
  const r = await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(r.woke, true)
  assert.equal(h.waker.state.misses, 0, '回话后计数器没归零')
})

test('读不到会话历史时保守处理：不计数、不掐掉', async () => {
  const h = harness({
    hasUserMessageSince: async () => {
      throw new Error('读不到')
    },
  })
  for (let i = 0; i < 8; i++) {
    h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
    await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
    h.advance(130_000)
  }
  assert.equal(h.waker.state.exhausted, false, '读失败被当成"没回应"了')
  assert.ok(h.sent.length > 5, '读失败不该限制唤醒次数')
  assert.ok(h.logs.some((l) => l.includes('不计数')))
})

test('send 失败不能把主流程拖挂，也不许白占 120 秒窗口', async () => {
  let fail = true
  const h = harness({
    send: async () => {
      if (fail) throw new Error('宿主没响应')
    },
  })
  h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
  const r1 = await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(r1.woke, false)
  assert.equal(r1.reason, 'send-failed')
  assert.ok(h.logs.some((l) => l.includes('发送失败')))

  // 关键：上一拍发失败，不该让下一拍也发不出去
  fail = false
  h.advance(1_000)
  const r2 = await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(r2.woke, true, '一次发送失败把后面的 120 秒窗口白占了')
})

test('reset() 恢复：新一次 watch_start 后能重新唤醒', async () => {
  const h = harness({ hasUserMessageSince: async () => false })
  for (let i = 0; i < 6; i++) {
    h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
    await h.waker.maybeWake({ kind: 'motion', strength: 'high' })
    h.advance(130_000)
  }
  assert.equal(h.waker.state.exhausted, true)
  h.waker.reset()
  assert.equal(h.waker.state.exhausted, false)
  assert.equal(h.waker.state.misses, 0)
  h.waker.feed({ kind: 'motion', strength: 'high', at: h.t })
  assert.equal((await h.waker.maybeWake({ kind: 'motion', strength: 'high' })).woke, true)
})

test('摘要：只取最近 3 分钟、最多 20 条、按强度排序', () => {
  const now = 1_000_000
  const events = []
  for (let i = 0; i < 40; i++) {
    events.push({ at: now - i * 1000, strength: i % 3 === 0 ? 'high' : 'low', text: `台词第${i}句` })
  }
  events.push({ at: now - 600_000, strength: 'high', text: '很久以前的旧事件' }) // 超出窗口
  const s = buildSummary(events, { now, windowMs: 180_000, max: 20, format: (e) => e.text })
  const lines = s.split('\n')
  assert.equal(lines.length, 20, `条数不对：${lines.length}`)
  assert.ok(!lines.includes('很久以前的旧事件'), '窗口外的事件混进来了')
  // 选人按强度（票面要求），但输出按时间正序 —— 给模型看的是一段经过。
  // 所以 newest 的 e0 应当在最后，且它必须被选中（它是 high）
  assert.equal(lines[lines.length - 1], '台词第0句', `最新那条不在末尾，实际是 ${lines[lines.length - 1]}`)
  assert.ok(lines.includes('台词第0句'), 'high 强度的事件没被选中')
})

test('摘要按强度优先挑：high 先占位，剩下的按时间取最近的', () => {
  const now = 1_000_000
  const events = [
    { at: now - 1000, strength: 'low', text: '这是一句低强度台词' },
    { at: now - 2000, strength: 'high', text: '这句是高强度台词' },
    { at: now - 3000, strength: 'low', text: '另一句低强度台词' },
  ]
  const s = buildSummary(events, { now, windowMs: 60_000, max: 2, format: (e) => e.text })
  // high1 凭强度先占一个位；剩下一个位给"最新的 low"，也就是 low1（不是更旧的 low2）
  assert.equal(s, '这句是高强度台词\n这是一句低强度台词')
})

test('isTrigger / strengthRank 的边界', () => {
  assert.equal(isTrigger(null), false)
  assert.equal(isTrigger({}), false)
  assert.equal(isTrigger({ strength: 'HIGH' }), true) // 大小写不敏感
  assert.equal(strengthRank('high'), 3)
  assert.equal(strengthRank(undefined), 0)
})

test('strength 的真实取值 high/medium/low 都要认对（medium 不许排到 low 后面）', () => {
  assert.equal(strengthRank('medium'), 2, 'medium 没认出来 —— 摘要顺序会反')
  assert.equal(strengthRank('low'), 1)
  assert.ok(strengthRank('medium') > strengthRank('low'))
  assert.equal(isTrigger({ strength: 'medium' }), false, '中等强度不该叫醒人')
  // 采集侧真实形状：切镜直接给 high
  assert.equal(isTrigger({ kind: 'motion', strength: 'high', where: '50%,50%' }), true)
})

// ── 陪聊提示词：这次翻车就翻在这几句上 ──────────────────────────────
import { DEFAULT_COMMENT_PROMPT, renderPrompt } from '../src/wake.mjs'

test('默认提示词是"评价剧情"，不是"只说一句"', () => {
  assert.match(DEFAULT_COMMENT_PROMPT, /搭子/)
  assert.match(DEFAULT_COMMENT_PROMPT, /评价/)
  assert.match(DEFAULT_COMMENT_PROMPT, /见解|看法|疑问/)
  assert.doesNotMatch(DEFAULT_COMMENT_PROMPT, /只说了这一句就够/)
})

test('{n} 会被替换成实际秒数，且能换多次', () => {
  assert.equal(renderPrompt('过去 {n} 秒，再看这 {n} 秒', 30), '过去 30 秒，再看这 30 秒')
  assert.equal(renderPrompt('没有占位符', 15), '没有占位符')
  assert.equal(renderPrompt('', 30), DEFAULT_COMMENT_PROMPT.replace(/\{n\}/g, '30'), '空模板要回默认值')
})

test('主动说话只发提示词：不带图、不带事件、不带编号', async () => {
  const sent = []
  const opts = []
  const w = createWaker({
    enabled: true,
    minGapMs: 0,
    gapSec: 30,
    promptTemplate: '你是搭子',
    sheetId: () => 'SHEET_123',
    send: async (t, o) => { sent.push(t); opts.push(o) },
  })
  w.feed({ kind: 'ocr', text: '别开窗', at: Date.now() - 1000 })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0], '你是搭子', '只该是一句提示词')
  assert.equal(opts[0].withImage, false, '说话那轮不该再附图（观察轮已经给过）')
  assert.throws(() => JSON.parse(sent[0]), '不该再是 JSON 数据包')
})

test('没有拼图时也一样：只发提示词', async () => {
  const sent = []
  const w = createWaker({ enabled: true, minGapMs: 0, promptTemplate: '你是搭子', sheetId: () => null, send: async (t) => sent.push(t) })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(sent[0], '你是搭子')
})

test('摘要按时间正序、每条标来源、带时刻', () => {
  const now = Date.now()
  const text = buildSummary(
    [
      { kind: 'speech', text: '这风不对啊', strength: 'medium', t: 746, at: now - 1000 },
      { kind: 'motion', text: '切镜', strength: 'high', t: 742.5, at: now - 4000 },
    ],
    { now, windowMs: 60_000, max: 10, format: undefined },
  )
  const lines = text.split('\n')
  assert.match(lines[0], /画面：切镜/, '顺序或来源标错了')
  assert.match(lines[1], /声音：这风不对啊/)
  assert.match(lines[0], /\[\d{2}:\d{2}:\d{2}\]/, '缺时刻')
})

// ── 静默观察轮 ──────────────────────────────────────────────
test('observe() 只说"别说话"，不带陪聊提示词', async () => {
  const sent = []
  const w = createWaker({
    enabled: true,
    gapSec: 30,
    promptTemplate: '你是搭子，说两句',
    sheetId: () => 'S1',
    send: async (t) => sent.push(t),
  })
  await w.observe()
  assert.equal(sent.length, 1)
  const j = JSON.parse(sent[0])
  assert.equal(j.image, 'S1', '没带拼图编号')
  assert.equal(j.events.length >= 0, true)
  assert.equal(j.windowSec, 3)
  assert.match(j.prompt, /一句话/)
  assert.match(j.prompt, /代码块/)
  assert.doesNotMatch(JSON.stringify(j), /说两句/, '观察轮不该带陪聊提示词')
})

// ── 提示词只发一次：之后只带数据，避免"每条都像这一帧的回复" ──────────
test('说话那条必带提示词（每 30 秒一次，不是每条都带）', async () => {
  const sent = []
  const w = createWaker({
    enabled: true,
    minGapMs: 0,
    gapSec: 30,
    promptTemplate: '你是搭子，必须有自己思考',
    send: async (t) => sent.push(t),
  })
  w.feed({ kind: 'ocr', text: '别开窗', t: 1, at: Date.now() - 1000 })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(sent[0], '你是搭子，必须有自己思考', '说话那条没带提示词')
})

test('introText 仍是那段规则原文（保留给"想单独发一次"的用法）', () => {
  const w = createWaker({ enabled: true, promptTemplate: '规则 A', send: async () => {} })
  assert.match(w.introText(), /规则 A/)
})

test('observe() 只发增量，不重复整段摘要', async () => {
  let t = 1_000_000
  const sent = []
  const w = createWaker({
    enabled: true,
    gapSec: 30,
    promptTemplate: '规则',
    now: () => t,
    send: async (x) => sent.push(x),
    format: (e) => `- ${e.text}`,
  })
  w.feed({ kind: 'ocr', text: '旧事件', at: t })
  await w.observe()
  t += 6000 // 跨过 5 秒闸门
  sent.length = 0
  w.feed({ kind: 'ocr', text: '新台词', at: t })
  await w.observe()
  assert.match(sent[0], /新台词/)
  assert.doesNotMatch(sent[0], /旧事件/, '把上一轮已经发过的事件又发了一遍')
})

// ── 体量上限：落后时不能把积压全带上 ─────────────────────
test('观察轮最多带 12 条，多出来的只报数量', async () => {
  const sent = []
  const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: '规则', send: async (t) => sent.push(t) })
  const now = Date.now()
  for (let i = 0; i < 30; i++) w.feed({ kind: 'ocr', text: `第${i}句`, t: i, at: now - 2000 + i * 50 })
  await w.observe()
  const j = JSON.parse(sent[0])
  assert.equal(j.events.length, 12)
  assert.equal(j.omitted, 18)
  assert.equal(j.events.at(-1).sub, '第29句', '应该保留最新的，丢弃最旧的')
})

test('JSON 是紧凑的（不缩进），省掉约四分之一字节', async () => {
  const sent = []
  const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: '规则', sheetId: () => 'S1', send: async (t) => sent.push(t) })
  w.feed({ kind: 'ocr', text: '别开窗', at: Date.now() })
  await w.observe()
  assert.ok(!sent[0].includes('\n'), '还在缩进，白白多占 25% 体积')
})

test('事件键名是英文三选一：say / sub / motion（没有 cut）', () => {
  const now = Date.now()
  const items = [
    { kind: 'speech', text: 'a', at: now },
    { kind: 'ocr', text: 'b', at: now },
    { kind: 'motion', text: '切镜', at: now },
  ]
  // packEvent 不导出，从 observe 的消息里读回来
  return (async () => {
    const sent = []
    const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: 'r', send: async (t) => sent.push(t) })
    for (const it of items) w.feed(it)
    await w.observe()
    const j = JSON.parse(sent[0])
    const keys = j.events.map((e) => Object.keys(e).filter((k) => k !== 'at' && k !== 'sheetId')[0])
    assert.deepEqual(keys, ['say', 'sub', 'motion'])
    assert.equal(keys.includes('切'), false, 'cut 是死字段，不该出现')
  })()
})

// ── 限流在唯一发送点：调用方怎么叫都绕不过 ─────────────
test('observe 5 秒内第二次调用被挡（不用调用方自觉）', async () => {
  const sent = []
  const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: 'r', send: async (t) => sent.push(t) })
  const a = await w.observe()
  const b = await w.observe()
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'observe-too-soon')
  assert.equal(sent.length, 1, '还是发出去了两条')
})

test('说话那条的闸门默认跟随 gapSec，不传 minGapMs 也不会放行', async () => {
  const sent = []
  const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: 'r', send: async (t) => sent.push(t) })
  w.feed({ kind: 'motion', text: '切镜', at: Date.now() })
  const a = await w.maybeWake({ kind: 'motion', strength: 'high' })
  const b = await w.maybeWake({ kind: 'motion', strength: 'high' })
  assert.equal(a.woke, true)
  assert.equal(b.woke, false)
  assert.equal(b.reason, 'too-soon')
  assert.equal(sent.length, 1)
})

test('强制看图：上一轮没调 watch_frame 就不给新数据，只催它看', async () => {
  let looked = false
  const h = harness({ frameGate: () => looked, gapSec: 1 })
  const ev = { kind: 'motion', strength: 'high', at: h.t }
  h.waker.feed(ev)

  const first = await h.waker.maybeWake(ev)
  assert.equal(first.woke, true)
  assert.equal(first.nudged, undefined, '第一次叫醒不该直接催（还没有上一轮）')

  // 假装它没看图：第二拍应该被拦下来，且消息里没有 events
  h.advance(5000)
  const second = await h.waker.maybeWake({ ...ev, at: h.t })
  assert.equal(second.nudged, true, '没看图却没被拦')
  const payload = JSON.parse(h.sent.at(-1))
  assert.equal(payload.events, undefined, '催看图那条不许带事件数据')
  assert.match(payload.mustSee, /watch_frame/)

  // 看过之后恢复正常，数据回来
  looked = true
  h.advance(5000)
  const third = await h.waker.maybeWake({ ...ev, at: h.t })
  assert.equal(third.nudged, undefined)
  assert.equal(typeof h.sent.at(-1), 'string', '看过图之后应该恢复发提示词')
  assert.doesNotMatch(h.sent.at(-1), /mustSee/, '恢复后不该再是催看图那条')
})

test('强制看图：连续催满上限就放弃，别把陪看卡死', async () => {
  const h = harness({ frameGate: () => false, gapSec: 1, maxFrameNudges: 2 })
  const ev = { kind: 'motion', strength: 'high', at: h.t }
  h.waker.feed(ev)
  await h.waker.maybeWake(ev) // 第一次正常发
  h.advance(3000)
  await h.waker.maybeWake({ ...ev, at: h.t }) // 催 1
  h.advance(3000)
  await h.waker.maybeWake({ ...ev, at: h.t }) // 催 2
  h.advance(3000)
  const after = await h.waker.maybeWake({ ...ev, at: h.t }) // 达到上限，恢复发数据
  assert.equal(after.nudged, undefined)
  assert.equal(typeof h.sent.at(-1), 'string', '达到上限后应该恢复发提示词')
  assert.ok(h.logs.some((m) => /催看图/.test(m)), '催看图要留日志')
})

test('强制看图也管静默观察：没看图就不发观察数据，只催', async () => {
  let looked = true
  const h = harness({ frameGate: () => looked, gapSec: 1 })
  h.advance(10000)
  const first = await h.waker.observe()
  assert.equal(first.ok, true)
  assert.ok(JSON.parse(h.sent.at(-1)).events.length >= 0)

  looked = false
  h.advance(6000)
  const second = await h.waker.observe()
  assert.equal(second.nudged, true, '静默观察没被拦')
  const payload = JSON.parse(h.sent.at(-1))
  assert.equal(payload.events, undefined, '催看图那条不许带事件数据')
  assert.match(payload.mustSee, /watch_frame/)

  looked = true
  h.advance(6000)
  const third = await h.waker.observe()
  assert.equal(third.nudged, undefined, '看过之后应该恢复')
})

test('主动说话那轮永远不附图（观察轮已经给过画面）', async () => {
  const calls = []
  const w = createWaker({
    enabled: true,
    minGapMs: 0,
    promptTemplate: '你是搭子',
    send: async (t, o) => calls.push(o),
  })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(calls[0].withImage, false)
})

test('不传图时门闩根本不被问', async () => {
  let gateCalls = 0
  const sent = []
  const w = createWaker({
    enabled: true,
    minGapMs: 0,
    promptTemplate: '你是搭子',
    forceLook: false,
    frameGate: () => { gateCalls += 1; return false },
    send: async (t) => sent.push(t),
  })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(gateCalls, 0, '不传图时门闩不该被问')
  assert.equal(sent[0], '你是搭子')
})

test('画面事件转写带强度与方位（packEvent 直接测）', () => {
  const ev = { kind: 'motion', strength: 'high', where: '50%,40%', cells: 36 }
  const line = packEvent(ev).motion
  assert.match(line, /大变化/)
  assert.match(line, /中部/)
  assert.match(line, /36格/)
})

test('方位词：九宫格换算', () => {
  assert.equal(wherePhrase('50%,40%'), '中部')
  assert.equal(wherePhrase('10%,10%'), '上左')
  assert.equal(wherePhrase('90%,90%'), '下右')
  assert.equal(wherePhrase('50%,10%'), '上部')
  assert.equal(wherePhrase(null), '')
  assert.equal(wherePhrase('乱码'), '')
})

test('转写过滤：碎片、乱码、分辨率水印不进，画面事件永远进', () => {
  assert.equal(worthTelling({ kind: 'ocr', text: '是啊' }), false, '两字碎片该滤掉')
  assert.equal(worthTelling({ kind: 'ocr', text: 'LNPII MLIHL>,' }), false, '符号串该滤掉')
  assert.equal(worthTelling({ kind: 'ocr', text: '1080P 高河' }), false, '分辨率水印该滤掉')
  assert.equal(worthTelling({ kind: 'ocr', text: '消防柜是在前面吗' }), true, '正常台词要留')
  assert.equal(worthTelling({ kind: 'motion', text: '切镜' }), true, '画面事件不是 OCR 产物，永远留')
  assert.equal(worthTelling({ kind: 'speech', text: '通知我靠近' }), true)
})

test('同一秒同一类的几条合成一条（一帧读出的多行不是好几句台词）', () => {
  const now = 1_000_000
  const s = buildSummary(
    [
      { kind: 'ocr', text: '好像是吧', at: now - 1000 },
      { kind: 'ocr', text: '看不清', at: now - 900 },
    ],
    { now, windowMs: 60_000, max: 10, format: (e) => e.text },
  )
  assert.equal(s, '好像是吧；看不清')
})

test('观察节流下限：Infinity 必须当成 0，不能把通道卡死', () => {
  // 2026-11-23 07:52 的真实事故：lastTurnMs 被写成 Infinity，floor 变 Infinity，
  // 静默观察启动后就再也不发。这个用例就是钉住它。
  assert.equal(observeFloor(6, Infinity), 6000)
  assert.equal(observeFloor(6, Number.NaN), 6000)
  assert.equal(observeFloor(6, undefined), 6000)
  assert.equal(observeFloor(6, 20000), 20000, '真实轮时长要顶上来')
  assert.equal(observeFloor(2, 0), 6000, '地板是 6 秒')
  assert.equal(observeFloor(15, 0), 15000, '设置值大于地板时按设置来')
  assert.equal(observeFloor(6, 999999), 60000, '异常大值要被夹住')
})
