import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchService } from '../src/service.mjs'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
// 假编码器：单测不需要真的压 PNG，只要一段带 PNG 文件头的东西。
const fakeEncode = () => Buffer.concat([PNG_MAGIC, Buffer.alloc(16)])

/** 假帧源：启动后持续给帧，尺寸固定。用来把「真屏幕」从测试里拿掉。 */
function fakeCapture({ width = 798, height = 450, delayMs = 1 } = {}) {
  return (arg) => {
    const fps = arg.fps ?? 8
    let i = 0
    const timer = setInterval(() => {
      const buf = Buffer.alloc(width * height * 3, i % 255)
      arg.onFrame({ t: i / fps, buf })
      i += 1
    }, delayMs)
    timer.unref?.()
    return {
      params: { region: arg.region, width, height, fps },
      stop: () => clearInterval(timer),
      endWith: (info) => arg.onClose?.(info),
    }
  }
}

const base = (over = {}) => ({
  listWindows: () => ['直播'],
  lookupWindow: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  startCapture: fakeCapture(),
  encode: fakeEncode,
  ...over,
})

test('窗口找不到时，报错里带上当前可见的窗口标题', async () => {
  const svc = createWatchService(
    base({
      listWindows: () => ['哔哩哔哩直播 - Chrome', '记事本'],
      lookupWindow: () => null,
    }),
  )

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

test('开始采集后会报出窗口矩形与帧率', async () => {
  const svc = createWatchService(base())
  const st = await svc.start({ window: '直播' })

  assert.equal(st.state, 'running')
  assert.deepEqual(st.region, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.equal(st.fps, 8)
  await svc.stop()
})

test('按需取图能拿到一张合法 PNG，且带两个时间码', async () => {
  const svc = createWatchService(base())
  await svc.start({ window: '直播', size: { width: 798, height: 450 } })

  const shot = await svc.frame({ live: true })
  assert.equal(shot.width, 798)
  assert.equal(shot.height, 450)
  assert.ok(shot.png.subarray(0, 4).equals(PNG_MAGIC), 'PNG 文件头不对')
  assert.equal(typeof shot.t, 'number', '缺相对秒')
  assert.ok(shot.at > 1e12, '缺墙上时间')

  await svc.stop()
  assert.equal(svc.status().state, 'idle')
})

test('采集流断掉时状态变 failed，并写明原因', async () => {
  let cap = null
  const svc = createWatchService(
    base({
      startCapture: (arg) => {
        cap = fakeCapture()(arg)
        return cap
      },
    }),
  )
  await svc.start({ window: '直播' })
  cap.endWith(new Error('ffmpeg 退出码 1'))

  const st = svc.status()
  assert.equal(st.state, 'failed')
  assert.match(st.reason, /ffmpeg/)
})

test('重复 start 不会起第二个采集', async () => {
  const started = []
  const svc = createWatchService(
    base({
      startCapture: (arg) => {
        started.push(arg)
        const t = setInterval(() => {}, 1000)
        t.unref?.()
        return { params: { region: arg.region, width: 798, height: 450, fps: 8 }, stop: () => clearInterval(t) }
      },
    }),
  )

  await svc.start({ window: '直播' })
  await svc.start({ window: '直播' })
  assert.equal(started.length, 1, '应该复用已有采集，而不是再起一个')
  await svc.stop()
})
