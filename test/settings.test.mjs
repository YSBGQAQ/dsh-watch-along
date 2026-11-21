import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, PRESETS, validate, ENV_CHECKS } from '../src/settings.mjs'

test('三个预设各自写进对应参数', () => {
  const g = validate({ preset: 'game' })
  assert.equal(g.ok, true)
  assert.equal(g.value.quality, 'high')
  assert.equal(g.value.speechPerMin, 4)

  const c = validate({ preset: 'cinema' })
  assert.equal(c.value.speechPerMin, 3)
})

test('非法值不抛错，而是逐条说明原因（200 + rejected）', () => {
  const r = validate({ quality: 'ultra', speechPerMin: 99, 不认识的字段: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.rejected.length, 3)
  const fields = r.rejected.map((x) => x.field)
  assert.deepEqual(fields, ['quality', 'speechPerMin', '不认识的字段'])
  for (const x of r.rejected) assert.ok(x.reason.length > 3, `${x.field} 缺原因`)
})

test('合法改动会被合并，非法的那一条不落地', () => {
  const r = validate({ subtitle: false, maxWaitSec: 999 })
  assert.equal(r.value.subtitle, false)
  assert.equal(r.value.maxWaitSec, DEFAULTS.maxWaitSec, '非法值不该覆盖原值')
})

test('环境检查是八项，且每项有 id 与中文标签', () => {
  assert.equal(ENV_CHECKS.length, 8)
  for (const c of ENV_CHECKS) {
    assert.ok(c.id && c.label)
  }
})

test('窗口标题会被去空白', () => {
  const r = validate({ window: '  哔哩哔哩  ' })
  assert.equal(r.value.window, '哔哩哔哩')
})
