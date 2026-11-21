import test from 'node:test'
import assert from 'node:assert/strict'
import { createMobileServer } from '../src/http.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function fakeService() {
  return {
    status: () => ({ state: 'running', window: '直播', frames: 12 }),
    events: async ({ sinceId }) => ({
      events: sinceId === 0 ? [{ id: 1, kind: 'motion' }] : [],
      nextId: 1, quiet: sinceId !== 0, timedOut: false,
    }),
    frame: async ({ sheetId }) => {
      if (sheetId !== 'sheet-1') throw new Error(`没有这张拼图：${sheetId}`)
      return { png: PNG, width: 100, height: 50, cached: true }
    },
  }
}

async function boot() {
  const m = createMobileServer({ service: fakeService(), token: 't0ken', host: '127.0.0.1' })
  const info = await m.listen()
  return { m, info }
}

const get = async (url) => {
  const r = await fetch(url)
  const type = r.headers.get('content-type') ?? ''
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type }
}

test('没有 token 一律 401（这个服务会绑 0.0.0.0）', async () => {
  const { m, info } = await boot()
  const r = await get(`${info.url}/api/status`)
  assert.equal(r.status, 401)
  assert.match(r.body.error, /token/)
  await m.close()
})

test('带 token 能读状态', async () => {
  const { m, info } = await boot()
  const r = await get(`${info.url}/api/status?token=t0ken`)
  assert.equal(r.status, 200)
  assert.equal(r.body.state, 'running')
  assert.equal(r.body.frames, 12)
  await m.close()
})

test('事件接口按 sinceId 增量给', async () => {
  const { m, info } = await boot()
  const first = await get(`${info.url}/api/events?token=t0ken&sinceId=0`)
  assert.equal(first.body.events.length, 1)
  const second = await get(`${info.url}/api/events?token=t0ken&sinceId=1`)
  assert.equal(second.body.events.length, 0)
  assert.equal(second.body.quiet, true)
  await m.close()
})

test('取图返回 PNG 字节，不给就说明原因', async () => {
  const { m, info } = await boot()
  const ok = await get(`${info.url}/api/frame?token=t0ken&sheetId=sheet-1`)
  assert.equal(ok.status, 200)
  assert.equal(ok.type, 'image/png')
  assert.ok(ok.body.equals(PNG))

  const bad = await get(`${info.url}/api/frame?token=t0ken&sheetId=sheet-9`)
  assert.equal(bad.status, 500)
  assert.match(bad.body.error, /没有这张拼图/)

  const missing = await get(`${info.url}/api/frame?token=t0ken`)
  assert.equal(missing.status, 400)
  await m.close()
})
