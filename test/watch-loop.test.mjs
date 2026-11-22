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

test('一次只允许一条在飞：投递还没返回就不再叫（防重入）', async () => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const h = harness({
    wake: async () => {
      await gate
      return { ok: true, via: 'followup' }
    },
  })
  const first = h.loop.tick() // 投递卡住，还没返回
  const r = await h.loop.tick() // 同一时刻又 tick 一次
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'in-flight')
  release()
  await first
})

test('模型只回话、不调工具，也不会把循环卡死', async () => {
  // 2026-11-23 之前的判据要求"模型调过工具"才放行下一条，实测会死锁：
  // 模型常常只回一句话，于是 inFlight 永远为真 —— 循环活着但一句话不说，
  // 日志里连"收工"都没有，看起来像陪看突然哑了。
  const h = harness()
  await h.loop.tick()
  h.advance(31_000) // 期间一次 noteActivity 都没有
  const r = await h.loop.tick()
  assert.equal(r.fired, true, '没调工具就卡在 in-flight —— 表现为陪看突然哑了')
  assert.equal(h.woke.length, 2)
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


test('没人理也不再收工（默认关闭，2026-11-23 起）', async () => {
  const h = harness()
  h.advance(181_000) // 超过默认的 3 分钟
  const r = await h.loop.tick()
  assert.equal(r.fired, true, '空闲超时不该再停循环')
  assert.equal(h.loop.state.stopped, null)
  assert.equal(h.woke.length, 1)
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

test('没有次数上限：有人接就一直能叫（收工只由 idle 决定）', async () => {
  const h = harness({ idleMs: 60 * 60_000 })
  for (let i = 0; i < 50; i++) {
    await h.loop.tick()
    h.loop.noteActivity()
    h.advance(31_000)
  }
  assert.equal(h.loop.state.stopped, null)
  assert.equal(h.woke.length, 50)
})

test('循环还活着时 restart 不重置节奏（否则 30 秒会退化成 6 秒）', async () => {
  const h = harness()
  h.loop.start() // 生产里 start() 由 watch_start 触发；restart 的"活着"判据依赖它
  await h.loop.tick() // 叫一次，记下 lastWakeAt
  h.advance(10_000)
  h.loop.restart() // 模型又调了一次 watch_start
  const r = await h.loop.tick() // 才过 10 秒
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'too-soon', 'restart 把间隔清掉了 —— 每轮 watch_start 都会让它立刻再叫一次')
})
