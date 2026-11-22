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

// ── 唤醒节奏三项（对齐 see-now 的 defaultPace / maxAutonomousWakes / idleStopMin）──
test('wakeGapSec 是 5–300 的整数秒，默认 30', () => {
  assert.equal(validate({ wakeGapSec: 45 }).value.wakeGapSec, 45)
  assert.equal(validate({}).value.wakeGapSec, 30)
  assert.equal(validate({ wakeGapSec: 4 }).ok, false)
  assert.equal(validate({ wakeGapSec: 301 }).ok, false)
  assert.equal(validate({ wakeGapSec: 12.5 }).ok, false)
})

test('maxWakes 边界：0–999 收，0 表示不限', () => {
  assert.equal(validate({ maxWakes: 0 }).value.maxWakes, 0)
  assert.equal(validate({ maxWakes: 999 }).ok, true)
  assert.equal(validate({ maxWakes: -1 }).ok, false)
  assert.equal(validate({ maxWakes: 1000 }).ok, false)
  assert.equal(validate({ maxWakes: 3.5 }).ok, false)
  assert.equal(validate({}).value.maxWakes, 0, '默认应该是不限')
})

test('idleStopMin 允许 0（= 不因空闲收工），负数与超过一天要拒', () => {
  assert.equal(validate({ idleStopMin: 0 }).value.idleStopMin, 0)
  assert.equal(validate({ idleStopMin: 1440 }).ok, true)
  assert.equal(validate({ idleStopMin: -1 }).ok, false)
  assert.equal(validate({ idleStopMin: 1441 }).ok, false)
})
