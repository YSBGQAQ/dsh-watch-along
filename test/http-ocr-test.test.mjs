import test from 'node:test'
import assert from 'node:assert/strict'
import { createMobileServer } from '../src/http.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function fakeService() {
  return {
    status: () => ({ state: 'running', window: '直播', frames: 12 }),
    events: async () => ({ events: [], nextId: 0, quiet: true, timedOut: false }),
    frame: async ({ sheetId }) => {
      if (sheetId === 'sheet-1') return { png: PNG, width: 100, height: 50, cached: true }
      throw new Error(`没有这张拼图：${sheetId}`)
    },
  }
}

async function boot(extra = {}) {
  const m = createMobileServer({
    service: fakeService(),
    token: 't0ken',
    host: '127.0.0.1',
    ...extra,
  })
  const info = await m.listen()
  return { m, info }
}

const post = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

// 与 index.js 里 ocrTestRoute 的返回形状一致的最小替身：只验"手机这一面确实转发到它"。
const okOcrTest = async ({ body }) => {
  const p = JSON.parse(body || '{}')
  const expect = String(p.expect ?? '').trim()
  if (!expect) return { ok: false, error: '先填「要识别的文字」再点「看一次」（不能为空）' }
  return {
    ok: true,
    matched: true,
    expect,
    source: 'live',
    band: '画面下方 34%（66%–100%）',
    size: '798×153',
    lines: [expect],
    best: { line: expect, similarity: 1 },
    ms: 12,
  }
}

test('POST /api/ocr-test 不带 token 一律 401', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await post(`${info.url}/api/ocr-test`, { expect: '你好' })
  assert.equal(r.status, 401)
  assert.match(r.body.error, /token/)
  await m.close()
})

test('POST /api/ocr-test 带 ?token= 走同一个处理函数，字段原样返回', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await post(`${info.url}/api/ocr-test?token=t0ken`, { expect: '你好' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.matched, true)
  assert.equal(r.body.expect, '你好')
  assert.equal(r.body.source, 'live')
  assert.match(r.body.band, /34%/)
  assert.equal(r.body.size, '798×153')
  assert.deepEqual(r.body.lines, ['你好'])
  assert.equal(r.body.best.similarity, 1)
  assert.equal(typeof r.body.ms, 'number')
  await m.close()
})

test('Authorization: Bearer 也能过鉴权', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await fetch(`${info.url}/api/ocr-test`, {
    method: 'POST',
    headers: { Authorization: 'Bearer t0ken', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect: '字幕' }),
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.expect, '字幕')
  await m.close()
})

test('空参回 200 + ok:false + 中文原因（不是 4xx）', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await post(`${info.url}/api/ocr-test?token=t0ken`, { expect: '   ' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /不能为空/)
  await m.close()
})

test('GET 只接受 POST', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await fetch(`${info.url}/api/ocr-test?token=t0ken`)
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, false)
  assert.match(j.error, /只接受 POST/)
  await m.close()
})

test('没接 ocrTest 时回「未启用」，不崩', async () => {
  const { m, info } = await boot()
  const r = await post(`${info.url}/api/ocr-test?token=t0ken`, { expect: '你好' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /未启用/)
  await m.close()
})

test('处理函数抛错时包成 200 + ok:false，不泄漏 500', async () => {
  const { m, info } = await boot({
    ocrTest: async () => {
      throw new Error('OCR 服务没响应：ECONNREFUSED')
    },
  })
  const r = await post(`${info.url}/api/ocr-test?token=t0ken`, { expect: '你好' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /OCR 服务没响应/)
  await m.close()
})

test('请求体超限直接说太清楚，不把半截 JSON 传下去', async () => {
  const calls = []
  const { m, info } = await boot({
    ocrTest: async ({ body }) => {
      calls.push(body)
      return { ok: true, matched: false, expect: '', source: 'live', band: '', size: '', lines: [], best: null, ms: 1 }
    },
    maxBody: 32,
  })
  const r = await post(`${info.url}/api/ocr-test?token=t0ken`, 'x'.repeat(200))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /请求体太大/)
  assert.equal(calls.length, 0, '超限的请求体不该被传到处理函数')
  await m.close()
})

// ---- 回归：sheetId 分支与 live 分支必须原样不动 ----
const get = async (url) => {
  const r = await fetch(url)
  const type = r.headers.get('content-type') ?? ''
  return {
    status: r.status,
    body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()),
    type,
  }
}

test('sheetId 分支仍返回 PNG 字节', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await get(`${info.url}/api/frame?token=t0ken&sheetId=sheet-1`)
  assert.equal(r.status, 200)
  assert.match(r.type, /image\/png/)
  assert.deepEqual(r.body, PNG)
  await m.close()
})

test('sheetId 取不到时回 500 + 原因（老行为）', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await get(`${info.url}/api/frame?token=t0ken&sheetId=sheet-9`)
  assert.equal(r.status, 500)
  assert.match(r.body.error, /没有这张拼图/)
  await m.close()
})

test('sheetId 与 live 都不给仍是 400', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await get(`${info.url}/api/frame?token=t0ken`)
  assert.equal(r.status, 400)
  assert.match(r.body.error, /缺参数/)
  await m.close()
})

// ---- 窗口列表：手机端要"点一条选中"，得先列得出来 ----
test('GET /api/windows 返回窗口标题列表', async () => {
  const { m, info } = await boot({ windows: async () => ({ ok: true, count: 2, windows: ['直播 - Chrome', '记事本'] }) })
  const r = await get(`${info.url}/api/windows?token=t0ken`)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 2)
  assert.deepEqual(r.body.windows, ['直播 - Chrome', '记事本'])
  await m.close()
})

test('GET /api/windows 不带 token 也是 401；POST 打它只接受 GET', async () => {
  const { m, info } = await boot({ windows: async () => ({ ok: true, count: 0, windows: [] }) })
  const noToken = await get(`${info.url}/api/windows`)
  assert.equal(noToken.status, 401)

  const asPost = await post(`${info.url}/api/windows?token=t0ken`, {})
  assert.equal(asPost.status, 200)
  assert.match(asPost.body.error, /只接受 GET/)
  await m.close()
})

test('没接 windows 时回「未启用」，不崩', async () => {
  const { m, info } = await boot({ ocrTest: okOcrTest })
  const r = await get(`${info.url}/api/windows?token=t0ken`)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /未启用/)
  await m.close()
})
