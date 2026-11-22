// 投递层测试（票 11）：拿 agent 句柄 → steer / followup。
//
// 这一层之所以要测：它是"主动说话"唯一的出口。steer 抛错时如果直接放弃，
// 就是"该说话时一句话都没出去"，而且用户完全无感。
import test from 'node:test'
import assert from 'node:assert/strict'

import { userMessage, deliverToAgent } from '../src/agent-delivery.mjs'

/** 记账用的假 agent。 */
function fakeAgent({ steerThrows = false, followupThrows = false } = {}) {
  const got = []
  return {
    got,
    steer(msg) {
      if (steerThrows) throw new Error('轮次边界冲突')
      got.push({ via: 'steer', msg })
    },
    followup(msg) {
      if (followupThrows) throw new Error('队列满了')
      got.push({ via: 'followup', msg })
    },
  }
}

test('userMessage 的形状：user 角色 + text 块 + 自定义 source', () => {
  const m = userMessage('看看这里')
  assert.equal(m.role, 'user')
  assert.equal(m.content[0].type, 'text')
  assert.equal(m.content[0].text, '看看这里')
  assert.equal(m.source.kind, 'watch-along')
  assert.ok(m.id && m.id.length > 8)
})

test('userMessage 每次 id 都不同（否则宿主会当成同一条去重）', () => {
  assert.notEqual(userMessage('a').id, userMessage('b').id)
})

test('默认走 followup：机器自动叫不能抢用户正在跑的轮次', () => {
  const a = fakeAgent()
  const r = deliverToAgent(a, '有动静')
  assert.equal(r.ok, true)
  assert.equal(r.via, 'followup')
  assert.equal(a.got.length, 1)
  assert.equal(a.got[0].msg.content[0].text, '有动静')
})

test('显式给 mode:steer 才走 steer（那是"人插话"的通道）', () => {
  const a = fakeAgent()
  const r = deliverToAgent(a, '用户自己在窗口里说的话', { mode: 'steer' })
  assert.equal(r.via, 'steer')
})

test('steer 抛错要退回 followup，不能把话丢在手里', () => {
  const a = fakeAgent({ steerThrows: true })
  const r = deliverToAgent(a, '有动静', { mode: 'steer' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'followup')
  assert.match(r.fallback, /轮次边界冲突/)
  assert.equal(a.got[0].via, 'followup')
})

test('两条都抛错：如实返回失败，不假装成功', () => {
  const a = fakeAgent({ steerThrows: true, followupThrows: true })
  const r = deliverToAgent(a, '有动静')
  assert.equal(r.ok, false)
  assert.match(r.reason, /队列满了/)
})

test('没有 agent 时返回 no-agent（票 11「拿不到宿主能力」的降级路径）', () => {
  for (const bad of [null, undefined, 0]) {
    assert.deepEqual(deliverToAgent(bad, 'x'), { ok: false, reason: 'no-agent' })
  }
})

test('空文本不发（避免塞一条空消息把模型叫起来）', () => {
  const a = fakeAgent()
  assert.equal(deliverToAgent(a, '   ').reason, 'empty-text')
  assert.equal(deliverToAgent(a, '').reason, 'empty-text')
  assert.equal(a.got.length, 0)
})

test('只有 followup 的 agent 也能用', () => {
  const got = []
  const r = deliverToAgent({ followup: (m) => got.push(m) }, '有动静')
  assert.equal(r.ok, true)
  assert.equal(r.via, 'followup')
  assert.equal(got.length, 1)
})

test('图随消息走：content 里多一个 image 块，形状照抄宿主', () => {
  const msg = userMessage('看图', { images: [{ attachmentId: 'sha256:abc123', mediaType: 'image/png', width: 640, height: 360, bytes: 1234, name: 'a.png' }] })
  assert.equal(msg.content.length, 2)
  assert.deepEqual(msg.content[1], { type: 'image', attachment: { attachmentId: 'sha256:abc123', mediaType: 'image/png', width: 640, height: 360, bytes: 1234, name: 'a.png' } })
})

test('没有图时 content 只有文本，不多塞空块', () => {
  const msg = userMessage('纯文本')
  assert.equal(msg.content.length, 1)
  assert.equal(msg.content[0].type, 'text')
})

test('宿主不认 image 块：退回纯文本，不能让这一轮叫不醒', () => {
  let calls = 0
  const agent = {
    session: 's1',
    followup(msg) {
      calls += 1
      if (msg.content.some((c) => c.type === 'image')) throw new Error('unsupported content type')
    },
    status: 'idle',
  }
  const r = deliverToAgent(agent, '看图', { images: [{ attachmentId: 'sha256:abc', mediaType: 'image/png', width: 1, height: 1, bytes: 1, name: 'a.png' }] })
  assert.equal(r.ok, true, '应该退回文本并成功')
  assert.equal(calls, 2, '先带图失败，再发纯文本')
  assert.match(r.imageFallback, /unsupported/)
})
