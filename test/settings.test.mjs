import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, validate, ENV_CHECKS } from '../src/settings.mjs'

test('场景预设已删除：写 preset 会被当成未知字段拒掉', () => {
  // 2026-11-22 用户决定删掉预设：它只是个"一次写四个值"的快捷方式，
  // 而其中 density 谁都不读，留着反而误导。参数现在都在面板上直接填。
  const r = validate({ preset: 'game' })
  assert.equal(r.ok, false)
  assert.equal(r.rejected[0].field, 'preset')
})

test('fps 可设，范围 0–30（0 = 关闭画面通道）', () => {
  assert.equal(validate({ fps: 12 }).value.fps, 12)
  assert.equal(validate({}).value.fps, DEFAULTS.fps)
  assert.equal(validate({ fps: 0 }).value.fps, 0)
  assert.equal(validate({ fps: 31 }).ok, false)
  assert.equal(validate({ fps: 7.5 }).ok, false)
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
test('wakeGapSec 是 0–300 的整数秒，0 = 不说话', () => {
  assert.equal(validate({ wakeGapSec: 45 }).value.wakeGapSec, 45)
  assert.equal(validate({}).value.wakeGapSec, 30, '默认 30 秒')
  assert.equal(validate({ wakeGapSec: 0 }).value.wakeGapSec, 0, '0 要能存下来（= 不说话）')
  assert.equal(validate({ wakeGapSec: -1 }).ok, false)
  assert.equal(validate({ wakeGapSec: 301 }).ok, false)
  assert.equal(validate({ wakeGapSec: 12.5 }).ok, false)
})

test('maxWakes 已经从设置里删掉（它当时是死代码）', () => {
  assert.equal('maxWakes' in validate({}).value, false)
})

test('idleStopMin 允许 0（= 不因空闲收工），负数与超过一天要拒', () => {
  assert.equal(validate({ idleStopMin: 0 }).value.idleStopMin, 0)
  assert.equal(validate({ idleStopMin: 1440 }).ok, true)
  assert.equal(validate({ idleStopMin: -1 }).ok, false)
  assert.equal(validate({ idleStopMin: 1441 }).ok, false)
})

test('fps 允许 0（= 关闭画面通道），负值与超过 30 仍拒', () => {
  assert.equal(validate({ fps: 0 }).value.fps, 0)
  assert.equal(validate({ fps: -1 }).ok, false)
  assert.equal(validate({ fps: 31 }).ok, false)
})

test('speechPerMin 允许 0（= 不限制），31 拒', () => {
  assert.equal(validate({ speechPerMin: 0 }).value.speechPerMin, 0)
  assert.equal(validate({ speechPerMin: 31 }).ok, false)
  assert.equal(validate({ speechPerMin: 2.5 }).ok, false)
})
