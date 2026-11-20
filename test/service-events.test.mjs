import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchService } from '../src/service.mjs'

const fakeEncode = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])

/** 假 pipeline：每次 push 恒定产出（或恒定不产出）一条变化摘要。 */
function fakePipeline({ change = null } = {}) {
  let pending = []
  return {
    push() {
      if (change) pending.push(change)
    },
    take: () => [],
    flushNow: () => {},
    drainChanges() {
      const out = pending
      pending = []
      return out
    },
  }
}

/** 假帧源：可以控制每一帧的内容，用来制造"静止"与"突变"。 */
function frameSource({ width = 32, height = 18, valueAt = () => 0, frames = 6, everyMs = 1 } = {}) {
  return (arg) => {
    let i = 0
    const timer = setInterval(() => {
      const buf = Buffer.alloc(width * height * 3, valueAt(i))
      arg.onFrame({ t: i / 8, buf })
      i += 1
      if (i >= frames) clearInterval(timer)
    }, everyMs)
    timer.unref?.()
    return {
      params: { region: arg.region, width, height, fps: 8 },
      stop: () => clearInterval(timer),
    }
  }
}

const base = (over = {}) => ({
  listWindows: () => ['直播'],
  lookupWindow: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  encode: fakeEncode,
  ...over,
})

test('画面一变，队列里就有一条 motion 事件，带强度/位置/变化格数', async () => {
  const svc = createWatchService(
    base({
      startCapture: frameSource({ valueAt: (i) => (i >= 2 ? 200 : 0) }),
      createPipeline: () =>
        fakePipeline({
          change: { peak: 21, n: 37, cut: true, from: 0.2, to: 0.5, box: { x0: 0.5, y0: 0.8, x1: 0.7, y1: 0.9 } },
        }),
    }),
  )
  await svc.start({ window: '直播' })
  await new Promise((r) => setTimeout(r, 80))

  const got = await svc.events({ sinceId: 0 })
  assert.ok(got.events.length > 0, '应该有事件')
  const e = got.events[0]
  assert.equal(e.kind, 'motion')
  assert.equal(e.strength, 'high')
  assert.equal(e.cells, 37)
  assert.equal(e.cut, true)
  assert.equal(e.where, "60%,85%")
  await svc.stop()
})

test('静止画面（pipeline 不吐变化）时队列保持为空', async () => {
  const svc = createWatchService(
    base({
      startCapture: frameSource({ valueAt: () => 7 }),
      createPipeline: () => fakePipeline({ change: null }),
    }),
  )
  await svc.start({ window: '直播' })
  await new Promise((r) => setTimeout(r, 60))

  const got = await svc.events({ sinceId: 0 })
  assert.equal(got.events.length, 0)
  assert.equal(got.timedOut, false)
  await svc.stop()
})

test('没事件时 events({waitMs}) 到点返回 timedOut，不抛错', async () => {
  const svc = createWatchService(
    base({ startCapture: frameSource({ frames: 1 }), createPipeline: () => fakePipeline() }),
  )
  await svc.start({ window: '直播' })
  const got = await svc.events({ sinceId: 0, waitMs: 60 })
  assert.equal(got.timedOut, true)
  assert.equal(got.events.length, 0)
  await svc.stop()
})
