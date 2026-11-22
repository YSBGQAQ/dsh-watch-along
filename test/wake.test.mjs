// 票 11 的判定层测试。
//
// 这一层之所以值得全量单测：主动唤醒是**会打断用户**的功能，
// 判错的方向都是灾难 —— 该闭嘴时开口、该开口时永远闭嘴、用户睡着后被反复吵。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWaker, isTrigger, buildSummary, strengthRank } from '../src/wake.mjs'

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

test('最小间隔 120 秒：120 秒内不重复开口', async () => {
  const h = harness()
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
    events.push({ at: now - i * 1000, strength: i % 3 === 0 ? 'high' : 'low', text: `e${i}` })
  }
  events.push({ at: now - 600_000, strength: 'high', text: '旧事件' }) // 超出窗口
  const s = buildSummary(events, { now, windowMs: 180_000, max: 20, format: (e) => e.text })
  const lines = s.split('\n')
  assert.equal(lines.length, 20, `条数不对：${lines.length}`)
  assert.ok(!lines.includes('旧事件'), '窗口外的事件混进来了')
  // 选人按强度（票面要求），但输出按时间正序 —— 给模型看的是一段经过。
  // 所以 newest 的 e0 应当在最后，且它必须被选中（它是 high）
  assert.equal(lines[lines.length - 1], 'e0', `最新那条不在末尾，实际是 ${lines[lines.length - 1]}`)
  assert.ok(lines.includes('e0'), 'high 强度的事件没被选中')
})

test('摘要按强度优先挑：high 先占位，剩下的按时间取最近的', () => {
  const now = 1_000_000
  const events = [
    { at: now - 1000, strength: 'low', text: 'low1' },
    { at: now - 2000, strength: 'high', text: 'high1' },
    { at: now - 3000, strength: 'low', text: 'low2' },
  ]
  const s = buildSummary(events, { now, windowMs: 60_000, max: 2, format: (e) => e.text })
  // high1 凭强度先占一个位；剩下一个位给"最新的 low"，也就是 low1（不是更旧的 low2）
  assert.equal(s, 'high1\nlow1')
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

test('唤醒消息带上拼图编号，并要求先看一眼再开口', async () => {
  const sent = []
  const w = createWaker({
    enabled: true,
    minGapMs: 0,
    gapSec: 30,
    promptTemplate: '你是搭子',
    sheetId: () => 'SHEET_123',
    send: async (t) => sent.push(t),
    format: (e) => `- ${e.text}`,
  })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /sheetId=SHEET_123/)
  assert.match(sent[0], /先调 watch_frame/)
})

test('没有拼图时不硬塞那句提示', async () => {
  const sent = []
  const w = createWaker({ enabled: true, minGapMs: 0, promptTemplate: '你是搭子', sheetId: () => null, send: async (t) => sent.push(t) })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.doesNotMatch(sent[0], /watch_frame/)
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
  assert.ok(lines[0].includes('742.5s'), '缺相对秒数')
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
  assert.match(sent[0], /【观察】/)
  assert.match(sent[0], /一句话/, '要它用一句话总结')
  assert.match(sent[0], /代码块/, '要它写进代码块')
  assert.doesNotMatch(sent[0], /说两句/, '观察轮不该带陪聊指令，否则它又会开口')
  assert.match(sent[0], /sheetId:"S1"/, '用户要求保留拼图编号')
  assert.doesNotMatch(sent[0], /不要寒暄/, '这句已按用户要求删掉')
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
    format: (e) => `- ${e.text}`,
  })
  w.feed({ kind: 'ocr', text: '别开窗', t: 1, at: Date.now() - 1000 })
  await w.maybeWake({ kind: 'motion', strength: 'high', text: '切镜' })
  assert.match(sent[0], /必须有自己思考/, '说话那条没带提示词')
  assert.match(sent[0], /别开窗/, '数据没带上')
})

test('introText 仍是那段规则原文（保留给"想单独发一次"的用法）', () => {
  const w = createWaker({ enabled: true, promptTemplate: '规则 A', send: async () => {} })
  assert.match(w.introText(), /规则 A/)
})

test('observe() 只发增量，不重复整段摘要', async () => {
  const sent = []
  const w = createWaker({ enabled: true, gapSec: 30, promptTemplate: '规则', send: async (t) => sent.push(t), format: (e) => `- ${e.text}` })
  w.feed({ kind: 'ocr', text: '旧事件', at: Date.now() })
  await w.observe()
  await new Promise((r) => setTimeout(r, 30))
  sent.length = 0
  w.feed({ kind: 'ocr', text: '新台词', at: Date.now() })
  await w.observe()
  assert.match(sent[0], /新台词/)
  assert.doesNotMatch(sent[0], /旧事件/, '把上一轮已经发过的事件又发了一遍')
})
