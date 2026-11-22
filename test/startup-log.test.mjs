import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendStartupLog, readStartupLog, collectEnv } from '../src/startup-log.mjs'

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-startup-'))
  return path.join(dir, 'startup.jsonl')
}

test('第一次启动会建目录并写入一条', () => {
  const f = tmpFile()
  const r = appendStartupLog(f, { at: '2026-11-23T00:00:00Z', note: 'first' })
  assert.equal(r.kept, 1)
  const back = readStartupLog(f)
  assert.equal(back.length, 1)
  assert.equal(back[0].note, 'first')
})

test('超过 50 条顶掉最老的', () => {
  const f = tmpFile()
  for (let i = 0; i < 55; i++) appendStartupLog(f, { i })
  const back = readStartupLog(f)
  assert.equal(back.length, 50, '不是 50 条')
  assert.equal(back[0].i, 5, '最老的应该被顶掉')
  assert.equal(back[49].i, 54)
})

test('单条不限篇幅：10 万字符也要原样存下来', () => {
  const f = tmpFile()
  const big = 'x'.repeat(100_000)
  appendStartupLog(f, { big })
  const back = readStartupLog(f)
  assert.equal(back[0].big.length, 100_000)
})

test('文件里有坏行也不影响后续写入', () => {
  const f = tmpFile()
  fs.writeFileSync(f, '{"ok":1}\n这不是 JSON\n', 'utf8')
  appendStartupLog(f, { ok: 2 })
  const back = readStartupLog(f)
  assert.equal(back.length, 2, '坏行应该被丢掉，好行保留')
  assert.equal(back[1].ok, 2)
})

test('collectEnv 给得出 CPU / 内存 / 系统这些关键项', () => {
  const e = collectEnv({ settings: { fps: 12 } })
  assert.ok(e.os.includes(os.arch()))
  assert.ok(e.cpu.length > 3)
  assert.ok(e.memoryGB > 0)
  assert.equal(e.settings.fps, 12)
  assert.ok(Array.isArray(e.gpu))
})
