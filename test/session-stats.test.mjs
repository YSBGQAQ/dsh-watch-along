import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStats, formatSummary, fmtDuration } from '../src/session-stats.mjs'

test('按类型计数，记住 id 首尾', () => {
  const s = createSessionStats({ now: () => 0, rss: () => 0 })
  s.reset(1_000)
  s.onEvent({ id: 1, kind: 'motion' })
  s.onEvent({ id: 2, kind: 'ocr' })
  s.onEvent({ id: 3, kind: 'speech' })
  s.onEvent({ id: 4, kind: 'motion' })
  const sum = s.summary({ at: 4_000 })
  assert.equal(sum.events, 4)
  assert.deepEqual(sum.byKind, { motion: 2, ocr: 1, speech: 1 })
  assert.equal(sum.firstId, 1)
  assert.equal(sum.lastId, 4)
  assert.equal(sum.missing, 0)
  assert.equal(sum.durationSec, 3)
})

test('id 真的缺号时要报出来（这是票 09 要的第一个数）', () => {
  const s = createSessionStats({ now: () => 0, rss: () => 0 })
  s.reset(0)
  s.onEvent({ id: 1, kind: 'motion' })
  s.onEvent({ id: 4, kind: 'motion' }) // 2、3 丢了
  const sum = s.summary({ at: 1000 })
  assert.equal(sum.missing, 2)
  assert.deepEqual(sum.gaps, [{ from: 2, to: 3 }])
})

test('RSS 记首末与峰值，并给出采样次数', () => {
  const seq = [100, 120, 148, 114]
  let i = 0
  const s = createSessionStats({ now: () => 0, rss: () => seq[i++] * 1024 * 1024 })
  s.reset(0)
  seq.forEach(() => s.sample())
  const sum = s.summary({ at: 1000 })
  assert.deepEqual(sum.rssMb, { first: 100, last: 114, peak: 148, samples: 4 })
})

test('一条事件都没有也不炸', () => {
  const s = createSessionStats({ now: () => 0, rss: () => 0 })
  s.reset(0)
  const sum = s.summary({ at: 0 })
  assert.equal(sum.events, 0)
  assert.equal(sum.firstId, null)
  assert.equal(sum.missing, 0)
  assert.doesNotThrow(() => formatSummary(sum))
})

test('汇总一行里必须带齐三个数：事件数、断号、RSS', () => {
  const s = createSessionStats({ now: () => 0, rss: () => 100 * 1024 * 1024 })
  s.reset(0)
  s.onEvent({ id: 1, kind: 'motion' })
  s.onEvent({ id: 2, kind: 'speech' })
  s.sample()
  const line = formatSummary(s.summary({ at: 31 * 60_000 }), '拼图 620 张（成功 615 / 失败 5）')
  assert.match(line, /事件 2/)
  assert.match(line, /motion 1 \/ speech 1/)
  assert.match(line, /缺 0/)
  assert.match(line, /RSS 100→100MB/)
  assert.match(line, /拼图 620/)
  assert.equal(line.split('\n').length, 1, '必须是一行，别跟刷屏日志混在一起')
})

test('时长格式：秒 / 分秒 / 时分秒', () => {
  assert.equal(fmtDuration(6), '6 秒')
  assert.equal(fmtDuration(1866), '31 分 06 秒')
  assert.equal(fmtDuration(3729), '1 小时 02 分 09 秒')
})
