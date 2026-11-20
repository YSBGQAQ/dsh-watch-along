import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchService } from '../src/service.mjs'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/** 假帧源：启动后持续给帧，尺寸固定。用来把「真屏幕」从测试里拿掉。 */
function fakeCapture({ width = 798, height = 450, delayMs = 1 } = {}) {
  return (arg) => {
    const fps = arg.fps ?? 8
    let i = 0
    let timer = null
    const tick = () => {
      const buf = Buffer.alloc(width * height * 3, i % 255)
      arg.onFrame({ t: i / fps, buf })
      i += 1
    }
    timer = setInterval(tick, delayMs)
    timer.unref?.()
    return {
      stop: () => clearInterval(timer),
      get frames() { return i },
      arg,
    }
  }
}

test('窗口找不到时，报错里带上当前可见的窗口标题', async () => {
  const svc = createWatchService({
    listWindows: () => ['哔哩哔哩直播 - Chrome', '记事本'],
    lookupWindow: () => null,
    startCapture: fakeCapture(),
  })

  await assert.rejects(
    () => svc.start({ window: '不存在的窗口' }),
    (err) => {
      assert.match(err.message, /找不到窗口/)
      assert.match(err.message, /哔哩哔哩直播/)
      return true
    },
  )
  assert.equal(svc.status().state, 'idle')
})

test('开始监听后，按需取图能拿到一张合法 PNG', async () => {
  const svc = createWatchService({
    listWindows: () => ['直播'],
    lookupWindow: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    startCapture: fakeCapture(),
  })

  await svc.start({ window: '直播', size: { width: 798, height: 450 } })
  assert.equal(svc.status().state, 'running')

  const shot = await svc.frame({ live: true })
  assert.equal(shot.width, 798)
  assert.equal(shot.height, 450)
  assert.ok(Buffer.isBuffer(shot.png))
  assert.ok(shot.png.subarray(0, 4).equals(PNG_MAGIC), 'PNG 文件头不对')

  await svc.stop()
  assert.equal(svc.status().state, 'idle')
})

test('重复 start 不会起第二个采集', async () => {
  const started = []
  const svc = createWatchService({
    listWindows: () => ['直播'],
    lookupWindow: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    startCapture: (arg) => {
      started.push(arg)
      const t = setInterval(() => {}, 1000)
      t.unref?.()
      return { stop: () => clearInterval(t) }
    },
  })

  await svc.start({ window: '直播' })
  await svc.start({ window: '直播' })
  assert.equal(started.length, 1, '应该复用已有采集，而不是再起一个')
  await svc.stop()
})
