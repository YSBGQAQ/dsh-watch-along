import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.mjs'

function fakeService(over = {}) {
  return {
    start: async (a) => ({ state: 'running', window: a.window, ...over.start }),
    stop: async () => ({ state: 'idle' }),
    frame: async () => ({ png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 798, height: 450, t: 1.5, at: 1700000000000 }),
    status: () => ({ state: 'idle', window: null, reason: null }),
    ...over,
  }
}

test('五个工具都注册出来，且带描述与参数', () => {
  const tools = createTools({ service: fakeService(), listWindows: () => ['A', 'B'] })
  const names = tools.map((t) => t.name)
  assert.deepEqual(names, ['watch_windows', 'watch_start', 'watch_frame', 'watch_status', 'watch_stop'])
  for (const t of tools) {
    assert.ok(t.description?.length > 5, `${t.name} 缺描述`)
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.execute, 'function')
  }
})

test('watch_windows 返回去重后的标题', async () => {
  const tools = createTools({ service: fakeService(), listWindows: () => ['A', 'B', 'A'] })
  const out = await tools.find((t) => t.name === 'watch_windows').execute({})
  assert.deepEqual(out.titles, ['A', 'B'])
  assert.equal(out.count, 2)
})

test('watch_start 把窗口名转给门面，失败时如实抛错', async () => {
  const ok = createTools({ service: fakeService(), listWindows: () => [] })
  const started = await ok.find((t) => t.name === 'watch_start').execute({ window: '直播' })
  assert.equal(started.state, 'running')
  assert.equal(started.window, '直播')

  const bad = createTools({
    service: fakeService({ start: () => { throw new Error('找不到窗口「X」') } }),
    listWindows: () => [],
  })
  await assert.rejects(
    () => bad.find((t) => t.name === 'watch_start').execute({ window: 'X' }),
    /找不到窗口/,
  )
})

test('watch_frame 返回尺寸与时间码，不把整张图塞进 JSON', async () => {
  const tools = createTools({ service: fakeService(), listWindows: () => [] })
  const out = await tools.find((t) => t.name === 'watch_frame').execute({ live: true })
  assert.equal(out.width, 798)
  assert.equal(out.height, 450)
  assert.equal(out.t, 1.5)
  assert.ok(!('png' in out), 'PNG 原始缓冲不该进 JSON')
  assert.ok(out.pngBytes > 0)
})
