import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventQueue } from '../src/events.mjs'

test('id 单调递增，带上相对秒与墙上时间', () => {
  let clock = 1_700_000_000_000
  const q = createEventQueue({ now: () => clock, startedAt: clock })
  clock += 1500
  const a = q.add('motion', { peak: 9 })
  clock += 500
  const b = q.add('ocr', { text: '你好' })

  assert.equal(a.id, 1)
  assert.equal(b.id, 2)
  assert.equal(a.t, 1.5)
  assert.equal(b.t, 2)
  assert.equal(typeof a.at, 'number')
  assert.equal(a.kind, 'motion')
})

test('按 sinceId 只给新的，nextId 指向上一条已给', () => {
  const q = createEventQueue()
  q.add('motion')
  q.add('motion')
  q.add('motion')

  const all = q.read()
  assert.equal(all.events.length, 3)
  assert.equal(all.nextId, 3)

  const after1 = q.read({ sinceId: 1 })
  assert.deepEqual(after1.events.map((e) => e.id), [2, 3])
  assert.equal(after1.nextId, 3)

  const none = q.read({ sinceId: 3 })
  assert.equal(none.events.length, 0)
  assert.equal(none.nextId, 3)
})

test('落后太多时标记 staleSince，并从最旧给起（不跳过中间）', () => {
  const q = createEventQueue({ capacity: 5 })
  for (let i = 0; i < 12; i += 1) q.add('motion')

  const got = q.read({ sinceId: 1 })
  assert.equal(got.staleSince, true)
  assert.equal(got.events[0].id, 8, '应该从内存里最旧的那条(8)开始')
  assert.equal(got.events.length, 5)
  assert.equal(got.dropped, 7)
})

test('超出容量丢最旧，但 highWater 不回收', () => {
  const q = createEventQueue({ capacity: 3 })
  for (let i = 0; i < 5; i += 1) q.add('motion')

  const s = q.size()
  assert.equal(s.count, 3)
  assert.equal(s.highWater, 5)
  assert.equal(q.read().events[0].id, 3)
})

test('长轮询：有事件立刻返回，没事件到点返回 timedOut 而不是报错', async () => {
  const q = createEventQueue()

  const quick = await q.wait({ sinceId: 0, waitMs: 1000 })
  assert.equal(quick.timedOut, true)
  assert.equal(quick.events.length, 0)

  setTimeout(() => q.add('speech', { text: '来了' }), 30)
  const got = await q.wait({ sinceId: 0, waitMs: 2000, pollMs: 10 })
  assert.equal(got.timedOut, false)
  assert.equal(got.events.length, 1)
  assert.equal(got.events[0].kind, 'speech')
})
