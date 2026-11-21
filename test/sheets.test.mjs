import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchService } from '../src/service.mjs'

const encode = () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function capture() {
  return (arg) => {
    const timer = setInterval(() => arg.onFrame({ t: 0, buf: Buffer.alloc(32 * 18 * 3, 1) }), 2)
    timer.unref?.()
    return { params: { region: arg.region, width: 32, height: 18, fps: 8 }, stop: () => clearInterval(timer) }
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])

function svcWith(over = {}) {
  return createWatchService({
    listWindows: () => ['直播'],
    lookupWindow: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    encode,
    startCapture: capture(),
    createPipeline: () => ({
      push() {},
      flushNow() {},
      drainChanges: () => [{ peak: 10, n: 5, cut: true, from: 0, to: 1, box: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.7 } }],
      take: () => ({ png: PNG, w: 100, h: 50, at: 1.5 }),
    }),
    ...over,
  })
}

test('出图时事件带 sheetId，且能按 id 原样取回（cached）', async () => {
  const svc = svcWith()
  await svc.start({ window: '直播' })
  await sleep(40)

  const ev = (await svc.events({ sinceId: 0 })).events[0]
  assert.ok(String(ev.sheetId).length >= 10, 'sheetId 必须是随机串，不能是序号')
  assert.doesNotMatch(String(ev.sheetId), /^sheet-\d+$/, '不能再用递增序号（可被遍历）')

  const shot = await svc.frame({ sheetId: ev.sheetId })
  assert.equal(shot.cached, true)
  assert.equal(shot.width, 100)
  assert.ok(shot.png.equals(PNG), '取回的应当是同一张图')
  await svc.stop()
})

test('事件体里只有 id，不带像素', async () => {
  const svc = svcWith()
  await svc.start({ window: '直播' })
  await sleep(40)
  const ev = (await svc.events({ sinceId: 0 })).events[0]
  assert.equal(ev.png, undefined)
  assert.ok(JSON.stringify(ev).length < 400, '事件体不该被像素撑大')
  await svc.stop()
})

test('取不存在的拼图会明确报错，不是静默给张新图', async () => {
  const svc = svcWith()
  await svc.start({ window: '直播' })
  await assert.rejects(() => svc.frame({ sheetId: 'sheet-999' }), /没有这张拼图/)
  await svc.stop()
})

test('拼图会过期：超过 TTL 后取回明确报错', async () => {
  // TTL 在创建服务时从环境变量读，所以先设再建 —— 比等 10 分钟快
  process.env.WATCH_ALONG_SHEET_TTL_MS = '50'
  const svc = svcWith()
  await svc.start({ window: '直播' })
  await sleep(40)
  const ev = (await svc.events({ sinceId: 0 })).events[0]
  await sleep(120) // 越过 50ms 的 TTL
  await assert.rejects(() => svc.frame({ sheetId: ev.sheetId }), /已过期/)
  delete process.env.WATCH_ALONG_SHEET_TTL_MS
  await svc.stop()
})
