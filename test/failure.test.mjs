import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchService } from '../src/service.mjs'

const encode = () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
const WIN = { x: 0, y: 0, width: 1920, height: 1080 }

/** 假采集：能持续出帧，也能在测试里"被关掉"。 */
function capture({ frames = 40 } = {}) {
  return (arg) => {
    let i = 0
    const timer = setInterval(() => {
      arg.onFrame({ t: i / 8, buf: Buffer.alloc(32 * 18 * 3, i % 7) })
      i += 1
      if (i >= frames) clearInterval(timer)
    }, 1)
    timer.unref?.()
    return {
      params: { region: arg.region, width: 32, height: 18, fps: 8 },
      stop: () => clearInterval(timer),
      close: (info) => arg.onClose?.(info),
    }
  }
}

const base = (over = {}) => ({
  listWindows: () => ['直播'],
  lookupWindow: () => WIN,
  encode,
  ...over,
})

test('采集流断掉 → 状态 failed，且写明原因', async () => {
  let cap = null
  const svc = createWatchService(
    base({
      startCapture: (arg) => {
        cap = capture({ frames: 1 })(arg)
        return cap
      },
    }),
  )
  await svc.start({ window: '直播' })
  cap.close(new Error('ffmpeg 退出码 1'))

  const st = svc.status()
  assert.equal(st.state, 'failed')
  assert.match(st.reason, /ffmpeg/)
})

test('字幕通道抛错时，画面通道照常出事件', async () => {
  const svc = createWatchService(
    base({
      startCapture: capture(),
      subtitle: {
        feed: async () => {
          throw new Error('OCR 服务没起来')
        },
      },
      createPipeline: () => ({
        push() {},
        take: () => [],
        flushNow: () => {},
        drainChanges: () => [{ peak: 12, n: 6, cut: true, from: 0, to: 1, box: { x0: 0.2, y0: 0.3, x1: 0.4, y1: 0.5 } }],
      }),
    }),
  )
  await svc.start({ window: '直播' })
  await new Promise((r) => setTimeout(r, 40))

  const got = await svc.events({ sinceId: 0 })
  assert.ok(got.events.length > 0, '字幕坏了不该影响画面事件')
  assert.equal(got.events[0].kind, 'motion')
  assert.equal(svc.status().state, 'running', '字幕故障不算整体故障')
  await svc.stop()
})

test('watch_status 对每条通道给得出 state 与 reason', async () => {
  const svc = createWatchService(base({ startCapture: capture() }))
  const idle = svc.status()
  assert.equal(idle.state, 'idle')
  assert.equal(idle.reason, null)

  await svc.start({ window: '直播' })
  const run = svc.status()
  assert.equal(run.state, 'running')
  assert.equal(run.fps, 8)
  await svc.stop()
  assert.equal(svc.status().state, 'idle')
})

test('窗口找不到时是干净失败：不进 running、不留下采集', async () => {
  const svc = createWatchService(base({ lookupWindow: () => null }))
  await assert.rejects(() => svc.start({ window: '不存在的窗口' }), /找不到窗口/)
  const st = svc.status()
  assert.equal(st.state, 'idle')
  assert.equal(st.window, null)
  assert.equal(st.frames, 0)
})
