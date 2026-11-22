// 服务管家的判定测试：配置缺什么要说清、没起要报 up:false、启动不能瞎猜路径。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, createSupervisor, DEFAULT_PORTS } from '../src/service-supervisor.mjs'

test('配置缺失要逐条列出缺什么，不能猜默认值', () => {
  const c = resolveConfig({}, { rootDir: '/repo' })
  assert.equal(c.ready, false)
  assert.equal(c.missing.length, 2)
  assert.ok(c.missing.some((m) => m.includes('WATCH_ALONG_PY')))
  assert.ok(c.missing.some((m) => m.includes('WATCH_ALONG_WHISPER_DIR')))
})

test('路径存在但里面没有 model.bin 也要报（比不报更难查）', () => {
  const c = resolveConfig(
    { WATCH_ALONG_PY: process.execPath, WATCH_ALONG_WHISPER_DIR: '/definitely/not/here' },
    { rootDir: '/repo' },
  )
  assert.equal(c.ready, false)
  assert.ok(c.missing.some((m) => m.includes('model.bin')))
})

test('端口有默认值，环境变量能覆盖', () => {
  const a = resolveConfig({})
  assert.equal(a.ports.ocr, DEFAULT_PORTS.ocr)
  const b = resolveConfig({ WATCH_ALONG_PORT_OCR: '9001' })
  assert.equal(b.ports.ocr, 9001)
})

test('status：服务没起时 up=false，并带上原因', async () => {
  const sup = createSupervisor({
    config: { ready: true, missing: [], ports: { ocr: 1, asr: 2, panel: 3 }, rootDir: '/r', python: 'p', whisperDir: 'w' },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const s = await sup.status()
  assert.equal(s.services.length, 2)
  assert.equal(s.services[0].up, false)
  assert.match(s.services[0].error, /ECONNREFUSED/)
})

test('status：服务在跑就读出 ready 与设备名', async () => {
  const sup = createSupervisor({
    config: { ready: true, missing: [], ports: { ocr: 1, asr: 2, panel: 3 }, rootDir: '/r', python: 'p', whisperDir: 'w' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ready: true, device: '扬声器' }) }),
  })
  const s = await sup.status()
  assert.equal(s.services[0].up, true)
  assert.equal(s.services[0].detail, '扬声器')
})

test('配置不全时拒绝启动，并把缺的配置说出来', async () => {
  const sup = createSupervisor({
    config: { ready: false, missing: ['WATCH_ALONG_PY（venv 的 python.exe）'], ports: { ocr: 1, asr: 2, panel: 3 } },
    fetchImpl: async () => ({ ok: false, status: 502 }),
  })
  const r = await sup.start()
  assert.equal(r.ok, false)
  assert.match(r.error, /WATCH_ALONG_PY/)
})

test('只启动没起来的那个（已经在跑的不重复拉）', async () => {
  const launched = []
  const sup = createSupervisor({
    config: { ready: true, missing: [], ports: { ocr: 1, asr: 2, panel: 3 }, rootDir: '/r', python: 'p', whisperDir: 'w' },
    fetchImpl: async (url) => (String(url).includes(':1/') ? { ok: true, json: async () => ({}) } : { ok: false, status: 502 }),
    spawnImpl: (cmd, args) => {
      launched.push(args.join(' '))
      return { pid: 42, unref() {} }
    },
  })
  const r = await sup.start()
  assert.equal(r.ok, true)
  assert.equal(r.started.length, 1, `启动了 ${r.started.length} 个`)
  assert.match(launched[0], /asr_service\.py/)
})

// ── 设置接口（票 07）：非法值 200 + rejected，合法值落盘 ───────────────────
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleSettings } from '../src/service-supervisor.mjs'

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-settings-'))
  return path.join(dir, 'settings.json')
}

test('GET /settings 没文件时回默认值，不报错', () => {
  const r = handleSettings({ file: tmpFile(), method: 'GET' })
  assert.equal(r.status, 200)
  assert.equal(r.body.value.preset, 'cinema')
  assert.equal(r.body.source, 'default')
  assert.ok(r.body.presets.cinema)
})

test('POST /settings 合法值落盘并回读一致', () => {
  const file = tmpFile()
  const w = handleSettings({ file, method: 'POST', body: { quality: 'low', speechPerMin: 3 } })
  assert.equal(w.body.ok, true)
  const g = handleSettings({ file, method: 'GET' })
  assert.equal(g.body.value.quality, 'low')
  assert.equal(g.body.value.speechPerMin, 3)
  assert.equal(g.body.source, 'file')
})

test('POST 非法值是 200 + rejected，且**不落盘**', () => {
  const file = tmpFile()
  const w = handleSettings({ file, method: 'POST', body: { quality: 'ultra' } })
  assert.equal(w.status, 200)
  assert.equal(w.body.ok, false)
  assert.equal(w.body.rejected[0].field, 'quality')
  assert.match(w.body.rejected[0].reason, /low/)
  const g = handleSettings({ file, method: 'GET' })
  assert.equal(g.body.value.quality, 'high', '非法值把文件写坏了')
})

test('选预设会一次写入配套参数', () => {
  const file = tmpFile()
  handleSettings({ file, method: 'POST', body: { preset: 'game' } })
  const g = handleSettings({ file, method: 'GET' })
  assert.equal(g.body.value.preset, 'game')
  assert.equal(g.body.value.quality, g.body.presets.game.quality)
})

test('POST 体不是 JSON 也要给得出人话', () => {
  const r = handleSettings({ file: tmpFile(), method: 'POST', body: '{坏' })
  assert.equal(r.body.ok, false)
  assert.match(r.body.rejected[0].reason, /JSON/)
})

// ── 预检：带 content-type 的 POST 会先发 OPTIONS，不声明 Allow-Headers 就全废 ──
test('面板接口的 CORS 头要允许 content-type（否则 POST /settings 变 Failed to fetch）', async () => {
  const sup = createSupervisor({
    config: { ready: true, missing: [], ports: { ocr: 1, asr: 2, panel: 18791 }, rootDir: '/r', python: 'p', whisperDir: 'w' },
    fetchImpl: async () => ({ ok: false, status: 502 }),
    settingsFile: tmpFile(),
  })
  const server = sup.serve(18791)
  await new Promise((r) => setTimeout(r, 60))
  try {
    const res = await fetch('http://127.0.0.1:18791/settings', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(String(res.headers.get('access-control-allow-headers')), /content-type/i)
  } finally {
    server.close()
  }
})
