import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechReader } from '../src/speech.mjs'

const mk = (batches, over = {}) => {
  const got = []
  let i = 0
  const reader = createSpeechReader({
    listen: async () => ({ lines: batches[Math.min(i++, batches.length - 1)] }),
    onEvent: (e) => got.push(e),
    ...over,
  })
  return { reader, got }
}

test('一转出句子就发 speech 事件，带原文与时间码', async () => {
  const { reader, got } = mk([[{ text: '大家好', t0: 0.2, t1: 1.1 }]])
  await reader.tick()
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '大家好')
  assert.equal(got[0].t0, 0.2)
  assert.equal(typeof got[0].at, 'number')
})

test('转写服务给了 latencyMs 就原样带上（汇总要算真实延迟）', async () => {
  const { reader, got } = mk([[{ text: '我说话', t0: 0, t1: 2, latencyMs: 4200 }]])
  await reader.tick()
  assert.equal(got[0].latencyMs, 4200)
})

test('没给 latencyMs 就不编一个', async () => {
  const { reader, got } = mk([[{ text: '我说话', t0: 0, t1: 2 }]])
  await reader.tick()
  assert.equal('latencyMs' in got[0], false)
})

test('跨窗口重复的同一句不再发（窗口边界会被切两半）', async () => {
  const { reader, got } = mk([
    [{ text: '真的非常感谢你们给我的支持', t0: 0, t1: 3 }],
    [{ text: '真的非常感谢你们给我的支持', t0: 0, t1: 3 }],
    [{ text: '真的非常感谢你们给我的支持？', t0: 0, t1: 3 }],
  ])
  await reader.tick()
  await reader.tick()
  await reader.tick()
  assert.equal(got.length, 1, '同一句只该发一次')
})

test('短句和空串不发', async () => {
  const { reader, got } = mk([[{ text: '', t0: 0, t1: 1 }, { text: '。', t0: 1, t1: 2 }]])
  await reader.tick()
  assert.equal(got.length, 0)
})

test('服务挂了只报一条错误，不影响下一拍', async () => {
  const got = []
  let n = 0
  const reader = createSpeechReader({
    listen: async () => {
      n += 1
      if (n === 1) throw new Error('ASR 服务没响应')
      return { lines: [{ text: '恢复了', t0: 0, t1: 1 }] }
    },
    onEvent: (e) => got.push(e),
  })
  await reader.tick()
  await reader.tick()
  assert.equal(got.length, 2)
  assert.match(got[0].error, /没响应/)
  assert.equal(got[1].text, '恢复了')
})

test('上一次还没回来时，下一拍直接跳过（不排队）', async () => {
  let calls = 0
  let release
  const reader = createSpeechReader({
    listen: () => { calls += 1; return new Promise((r) => { release = r }) },
    onEvent: () => {},
  })
  const first = reader.tick()
  await reader.tick()
  assert.equal(calls, 1)
  release({ lines: [] })
  await first
})
