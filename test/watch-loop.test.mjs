// 陪看循环的判定测试。
//
// 这几条对应三个真实翻车点：一次叫醒没被接住就接着叫（积一串"有新画面了"）、
// 没新东西也定时叫（刷屏）、叫个没完（用户睡着了还被反复吵）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWatchLoop } from '../src/watch-loop.mjs'

function harness(opts = {}) {
  let t = 1_000_000
  const woke = []
  const logs = []
  const loop = createWatchLoop({
    wake: async () => {
      woke.push(1)
      return { ok: true, via: 'followup', flushed: true }
    },
    hasNews: () => true,
    now: () => t,
    everyMs: 1000,
    gapMs: 30_000,
    maxWakes: 8,
    idleMs: 180_000,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    log: (m) => logs.push(String(m)),
    ...opts,
  })
  return { loop, woke, logs, advance: (ms) => { t += ms }, get t() { return t } }
}

test('有新闻 + 到点 → 叫一次', async () => {
  const h = harness()
  const r = await h.loop.tick()
  assert.equal(r.fired, true)
  assert.equal(h.woke.length, 1)
})

test('没有新东西就不叫（否则就是定时刷屏）', async () => {
  const h = harness({ hasNews: () => false })
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'no-news')
  assert.equal(h.woke.length, 0)
})

test('最小间隔：30 秒内不叫第二次', async () => {
  const h = harness()
  await h.loop.tick()
  h.loop.noteActivity()
  h.advance(29_000)
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'too-soon')
})

test('一次只允许一条在飞：没接住就不再叫', async () => {
  const h = harness()
  await h.loop.tick() // 叫了，等模型接
  h.advance(60_000)
  const r = await h.loop.tick() // 模型一直没调工具
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'in-flight')
  assert.equal(h.woke.length, 1, '没接住却又叫了一次 —— 会积一串消息')
})

test('模型调了工具 = 接住了，可以继续叫', async () => {
  const h = harness()
  await h.loop.tick()
  h.loop.noteActivity()
  h.advance(31_000)
  const r = await h.loop.tick()
  assert.equal(r.fired, true)
  assert.equal(h.woke.length, 2)
})

test('叫满 8 次就收工（不管有没有人接，硬上限）', async () => {
  // idleMs 放大：这条只验 maxWakes，别让 idle 先把它停掉
  const h = harness({ idleMs: 60 * 60_000 })
  for (let i = 0; i < 10; i++) {
    await h.loop.tick()
    h.loop.noteActivity() // 每次都接住，证明"接住也不清零这一项"
    h.advance(31_000)
  }
  assert.equal(h.loop.state.stopped, 'max-wakes')
  assert.equal(h.woke.length, 8, `叫了 ${h.woke.length} 次`)
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
})

test('一直没有任何工具调用 → 3 分钟收工（用户睡着别吵）', async () => {
  const h = harness()
  h.advance(181_000)
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'idle')
  assert.equal(h.loop.state.stopped, 'idle')
})

test('发送失败不算叫醒：不占间隔、不累计次数', async () => {
  let n = 0
  const h = harness({
    wake: async () => {
      n += 1
      return { ok: false, reason: 'no-agent' }
    },
  })
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.match(r.reason, /wake-failed/)
  assert.equal(h.loop.state.wakes, 0)
  assert.equal(h.loop.state.lastWakeAt, 0, '失败不该占掉间隔')
})

test('wake 抛异常也要接住，不能把循环带崩', async () => {
  const h = harness({
    wake: async () => {
      throw new Error('宿主炸了')
    },
  })
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.match(r.reason, /宿主炸了/)
})

test('收工之后 restart 能重新起跑（新一次 watch_start）', async () => {
  const h = harness()
  h.loop.stop('idle')
  assert.equal(h.loop.state.stopped, 'idle')
  h.loop.restart()
  assert.equal(h.loop.state.stopped, null)
  assert.equal(h.loop.state.wakes, 0, 'restart 没把计数清零')
  const r = await h.loop.tick()
  assert.equal(r.fired, true, 'restart 之后叫不醒了')
})

test('收工之后不再叫，且收工原因会回调出去', async () => {
  const reasons = []
  const h = harness({ onStop: (x) => reasons.push(x) })
  h.loop.stop('manual')
  const r = await h.loop.tick()
  assert.equal(r.fired, false)
  assert.match(r.reason, /stopped:manual/)
  assert.deepEqual(reasons, ['manual'])
})
