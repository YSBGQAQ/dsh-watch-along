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
