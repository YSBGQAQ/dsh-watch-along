import test from 'node:test'
import assert from 'node:assert/strict'
import { similarity, createSubtitleReader } from '../src/ocr.mjs'

const W = 40
const H = 20
const fakeEncode = ({ width, height }) => Buffer.alloc(width * height * 3)
const frame = () => ({ buf: Buffer.alloc(W * H * 3, 9), width: W, height: H })

test('相似度：完全相同 1，完全不同 0，改一个字介于两者之间', () => {
  assert.equal(similarity('hello', 'hello'), 1)
  assert.equal(similarity('abc', 'xyz'), 0)
  const s = similarity('这波操作可以', '这波操作不行')
  assert.ok(s > 0.5 && s < 1)
})

test('同一行要出现两次才收录，且只收录一次', async () => {
  const got = []
  let clock = 0
  const reader = createSubtitleReader({
    bands: [{ top: 0, height: 1, label: 'bottom' }],
    encode: fakeEncode,
    recognize: async () => ['这波操作可以'],
    onEvent: (e) => got.push(e),
    intervalMs: 0,
    stableMs: 500, // 测试用短稳定窗（生产默认 1200）
    now: () => (clock += 1000),
  })

  await reader.feed(frame())
  assert.equal(got.length, 0, '第一遍不该发')

  await reader.feed(frame())
  assert.equal(got.length, 1, '第二遍一致才发')
  assert.equal(got[0].text, '这波操作可以')
  assert.equal(got[0].band, 'bottom')

  await reader.feed(frame())
  assert.equal(got.length, 1, '同一条不该重复发')
})

test('文字变了就不发，等它稳定', async () => {
  const got = []
  const texts = [['这是第一句'], ['完全不同的另一句话'], ['完全不同的另一句话']]
  let i = 0
  let clock = 0
  const reader = createSubtitleReader({
    bands: [{ top: 0, height: 1, label: 'bottom' }],
    encode: fakeEncode,
    recognize: async () => texts[Math.min(i++, texts.length - 1)],
    onEvent: (e) => got.push(e),
    intervalMs: 0,
    stableMs: 500, // 测试用短稳定窗（生产默认 1200）
    now: () => (clock += 1000),
  })

  await reader.feed(frame())
  await reader.feed(frame()) // 变了 → 不发，重置
  assert.equal(got.length, 0)
  await reader.feed(frame()) // 稳定了 → 发
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '完全不同的另一句话')
})

test('OCR 报错时不抛，只回调错误，画面通道不受影响', async () => {
  const errs = []
  const reader = createSubtitleReader({
    bands: [{ top: 0, height: 1, label: 'bottom' }],
    encode: fakeEncode,
    recognize: async () => { throw new Error('服务没起来') },
    onEvent: (e) => errs.push(e),
    intervalMs: 0,
    now: () => Date.now(),
  })
  await reader.feed(frame())
  assert.equal(errs.length, 1)
  assert.match(errs[0].error, /服务没起来/)
})

test('上一次还在跑时，新帧被跳过（不排队堆积）', async () => {
  let calls = 0
  let release
  const reader = createSubtitleReader({
    bands: [{ top: 0, height: 1, label: 'bottom' }],
    encode: fakeEncode,
    recognize: () => { calls += 1; return new Promise((r) => { release = r }) },
    onEvent: () => {},
    intervalMs: 0,
    now: () => Date.now(),
  })
  const p1 = reader.feed(frame())
  await reader.feed(frame()) // 应该被跳过
  assert.equal(calls, 1)
  release([])
  await p1
})
