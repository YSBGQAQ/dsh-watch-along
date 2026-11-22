import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimit } from '../src/rate-limit.mjs'

function fake(perMin) {
  let t = 1_000_000
  const rl = createRateLimit({ perMin, now: () => t })
  return { rl, advance: (ms) => { t += ms } }
}

test('一分钟内放行 perMin 条，之后拒绝', () => {
  const { rl } = fake(3)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), false)
  assert.equal(rl.state.dropped, 1)
})

test('满 60 秒后重新放行', () => {
  const { rl, advance } = fake(2)
  rl.allow()
  rl.allow()
  assert.equal(rl.allow(), false)
  advance(60_001)
  assert.equal(rl.allow(), true, '跨窗口没复位')
})

test('边界：59.9 秒还不复位', () => {
  const { rl, advance } = fake(1)
  rl.allow()
  advance(59_900)
  assert.equal(rl.allow(), false)
})

test('takeDropped 取走并清零', () => {
  const { rl } = fake(1)
  rl.allow()
  rl.allow()
  rl.allow()
  assert.equal(rl.takeDropped(), 2)
  assert.equal(rl.takeDropped(), 0)
})

test('perMin 非法值兜底成 1（不能因为写错就变成不限流）', () => {
  const { rl } = fake(0)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), false)
})
