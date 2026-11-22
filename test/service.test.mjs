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

test('停止时交出会话汇总：事件分三类、id 连续、RSS 有采样', async () => {
  let stopped = null
  const svc = createWatchService(base({ onWatchStop: (s) => (stopped = s) }))
  await svc.start({ window: '直播' })
  svc.emit('ocr', { text: '你好' })
  svc.emit('speech', { text: '说话' })
  const st = await svc.stop()

  assert.ok(stopped, 'watch_stop 没把汇总交出来 —— 那一行 [会话汇总] 就打不出来')
  assert.equal(stopped.events, 2)
  assert.deepEqual(stopped.byKind, { ocr: 1, speech: 1 })
  assert.equal(stopped.firstId, 1)
  assert.equal(stopped.lastId, 2)
  assert.equal(stopped.missing, 0)
  assert.ok(stopped.durationSec >= 0)
  assert.ok(stopped.rssMb.first > 0, 'RSS 没采到')
  assert.deepEqual(st.session, stopped, 'status 里也应该能拿到最近一次汇总')
})

test('会话快照是只读的：打完快照，最终汇总的数不变', async () => {
  const svc = createWatchService(base())
  await svc.start({ window: '直播' })
  svc.emit('ocr', { text: '一' })
  const snap = svc.snapshot()
  assert.equal(snap.events, 1)
  assert.equal(snap.firstId, 1)
  svc.emit('ocr', { text: '二' })
  const st = await svc.stop()
  assert.equal(st.session.events, 2, '快照把计数清掉了')
})

test('采集中途断掉也要把账结掉（失败注入要用）', async () => {
  let cap = null
  let stopped = null
  const svc = createWatchService(
    base({
      onWatchStop: (s) => (stopped = s),
      startCapture: (arg) => {
        cap = fakeCapture()(arg)
        return cap
      },
    }),
  )
  await svc.start({ window: '直播' })
  svc.emit('speech', { text: '说一句' })
  cap.endWith(new Error('ffmpeg 退出码 1'))

  assert.ok(stopped, '崩了却没交账 —— 那一轮只剩一句"它挂了"')
  assert.equal(stopped.failed, true)
  assert.match(stopped.reason, /ffmpeg/)
  assert.equal(stopped.events, 1)
})

test('画面事件也要记进汇总（motion 不走 emit，最容易漏）', async () => {
  let n = 0
  const svc = createWatchService(
    base({
      createPipeline: () => ({
        push: () => {},
        drainChanges: () => (n++ === 0 ? [{ n: 12, peak: 0.01, cut: false }] : []),
        take: () => null,
        flushNow: () => {},
      }),
    }),
  )
  await svc.start({ window: '直播' })
  await new Promise((r) => setTimeout(r, 40)) // 等假采集吐第一帧
  const st = await svc.stop()

  assert.equal(st.session.byKind.motion, 1, 'motion 没被记账')
  assert.equal(st.session.events, 1)
})
