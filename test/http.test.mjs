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

test('/api/status 带窗口标题（最多 20 条），枚举失败也不影响状态', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `窗口${i}`)
  const m = createMobileServer({ service: fakeService(), token: 't0ken', host: '127.0.0.1', listTitles: () => many })
  const info = await m.listen()
  const r = await get(`${info.url}/api/status?token=t0ken`)
  assert.equal(r.status, 200)
  assert.equal(r.body.state, 'running', '老字段不能被挤掉')
  assert.equal(r.body.frames, 12)
  assert.equal(r.body.titles.length, 20, '最多 20 条')
  assert.equal(r.body.titles[0], '窗口0')
  await m.close()

  // 枚举炸了也不能让状态接口跟着炸
  const bad = createMobileServer({
    service: fakeService(),
    token: 't0ken',
    host: '127.0.0.1',
    listTitles: () => {
      throw new Error('枚举炸了')
    },
  })
  const info2 = await bad.listen()
  const r2 = await get(`${info2.url}/api/status?token=t0ken`)
  assert.equal(r2.status, 200)
  assert.equal(r2.body.state, 'running')
  assert.deepEqual(r2.body.titles, [])
  await bad.close()
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

function liveService({ state = 'running', calls = { n: 0 }, fail = null } = {}) {
  return {
    status: () => ({ state, window: '直播' }),
    events: async () => ({ events: [], nextId: 0 }),
    frame: async (args) => {
      calls.n += 1
      if (fail) throw new Error(fail)
      if (!args?.live) throw new Error('没有这张拼图：undefined')
      // 每张都不一样，才能断言"第二次拿到的是缓存而不是新抓的"
      return { png: Buffer.concat([PNG, Buffer.from([calls.n])]), width: 798, height: 450 }
    },
  }
}

async function bootLive(opts = {}) {
  const m = createMobileServer({ service: liveService(opts), token: 't0ken', host: '127.0.0.1', now: opts.now })
  const info = await m.listen()
  return { m, info }
}

test('live=1 现抓一帧返回 PNG，同一秒只抓一次', async () => {
  let t = 1_000_000
  const calls = { n: 0 }
  const { m, info } = await bootLive({ calls, now: () => t })

  const first = await get(`${info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(first.status, 200)
  assert.equal(first.type, 'image/png')
  assert.ok(Buffer.isBuffer(first.body))
  assert.equal(calls.n, 1)

  // 同一秒再点一次：拿到上一张，且不再抓
  const again = await get(`${info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(again.status, 200)
  assert.ok(again.body.equals(first.body), '同一秒应原样返回上一张')
  assert.equal(calls.n, 1, '同一秒不该抓第二次')

  // 跨到下一秒：重新抓
  t += 1000
  const next = await get(`${info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(next.status, 200)
  assert.equal(calls.n, 2, '跨秒应该重新抓')
  assert.ok(!next.body.equals(first.body))
  await m.close()
})

test('没在采时 live 直接说原因，不去等帧（也不把状态标红）', async () => {
  const calls = { n: 0 }
  const { m, info } = await bootLive({ state: 'idle', calls })

  const r = await get(`${info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.error, '现在没在采，抓不到画面')
  assert.equal(calls.n, 0, '没在采就不该调 service.frame')
  await m.close()
})

test('等不到新帧时说"窗口没了"，其他异常说"抓图失败"', async () => {
  const gone = await bootLive({ fail: '采不到帧（等了 800ms）' })
  const a = await get(`${gone.info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(a.status, 200)
  assert.match(a.body.error, /^窗口没了/)
  await gone.m.close()

  const broken = await bootLive({ fail: 'BitBlt 失败（窗口可能已销毁）' })
  const b = await get(`${broken.info.url}/api/frame?token=t0ken&live=1`)
  assert.equal(b.status, 200)
  assert.equal(b.body.error, '抓图失败：BitBlt 失败（窗口可能已销毁）')
  await broken.m.close()
})

test('sheetId 与 live 都不给还是 400', async () => {
  const { m, info } = await bootLive({})
  const r = await get(`${info.url}/api/frame?token=t0ken`)
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  await m.close()
})
