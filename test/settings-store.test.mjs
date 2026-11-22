import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, validate, DEFAULTS } from '../src/settings.mjs'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-set-')), 'watch-along.json')

test('文件不存在时回默认值，不算错误', () => {
  const r = loadSettings(tmp())
  assert.equal(r.source, 'default')
  assert.equal(r.value.fps, DEFAULTS.fps)
  assert.equal(r.error, null)
})

test('存了再读，值一致', () => {
  const f = tmp()
  const w = saveSettings(f, { window: '哔哩哔哩', fps: 12 })
  assert.equal(w.ok, true)
  const r = loadSettings(f)
  assert.equal(r.source, 'file')
  assert.equal(r.value.window, '哔哩哔哩')
  assert.equal(r.value.fps, 12)
})

test('非法值不落盘，原文件保持不变', () => {
  const f = tmp()
  saveSettings(f, { window: 'ok' })
  const bad = saveSettings(f, { quality: 'ultra' })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected[0].field, 'quality')
  assert.equal(loadSettings(f).value.window, 'ok', '旧值不能被写坏')
})

test('文件是坏 JSON 时回默认值，并说明是坏的', () => {
  const f = tmp()
  fs.writeFileSync(f, '{ 这不是 json')
  const r = loadSettings(f)
  assert.equal(r.source, 'broken')
  assert.match(r.error, /JSON|Unexpected/i)
  assert.equal(r.value.window, DEFAULTS.window)
})

test('监听地址可调，非法的拒掉', () => {
  const ok = validate({ host: '127.0.0.1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.host, '127.0.0.1')
  const bad = validate({ host: '8.8.8.8' })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected[0].field, 'host')
})

test('录音来源只接受 system 或 process:<x>', () => {
  assert.equal(validate({ audioSource: 'system' }).ok, true)
  assert.equal(validate({ audioSource: 'process:mpv' }).ok, true)
  const bad = validate({ audioSource: 'speaker' })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected[0].field, 'audioSource')
})
