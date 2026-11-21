import test from 'node:test'
import assert from 'node:assert/strict'
import { runChecks } from '../src/doctor.mjs'
import { ENV_CHECKS } from '../src/settings.mjs'

const allOk = () => Object.fromEntries(ENV_CHECKS.map((c) => [c.id, () => ({ ok: true, detail: 'fine' })]))

test('全部正常时 ready=true，八项都是绿', async () => {
  const r = await runChecks(allOk())
  assert.equal(r.ready, true)
  assert.equal(r.checks.length, 8)
  assert.ok(r.checks.every((c) => c.state === 'ok'))
})

test('一项红就 ready=false，并指出是哪一项、为什么', async () => {
  const probes = allOk()
  probes.whisper = () => ({ ok: false, detail: '缺 model.bin' })
  const r = await runChecks(probes)
  assert.equal(r.ready, false)
  assert.deepEqual(r.failed, ['whisper'])
  const bad = r.checks.find((c) => c.id === 'whisper')
  assert.equal(bad.state, 'fail')
  assert.match(bad.reason, /model\.bin/)
})

test('探测抛错算红，但要把错误原文带出来', async () => {
  const probes = allOk()
  probes.cuda = () => { throw new Error('cublas64_12.dll is not found') }
  const r = await runChecks(probes)
  const c = r.checks.find((x) => x.id === 'cuda')
  assert.equal(c.state, 'fail')
  assert.match(c.reason, /cublas64_12/)
})

test('能跑但有隐患时是黄，不算失败', async () => {
  const probes = allOk()
  probes.cuda = () => ({ ok: true, warn: true, detail: '走 CPU，会慢' })
  const r = await runChecks(probes)
  assert.equal(r.ready, true)
  assert.equal(r.checks.find((c) => c.id === 'cuda').state, 'warn')
})

test('没实现探测器的项标黄，不假装通过也不假装失败', async () => {
  const r = await runChecks({})
  assert.equal(r.checks.length, 8)
  assert.ok(r.checks.every((c) => c.state === 'warn'))
  assert.equal(r.ready, true)
})
