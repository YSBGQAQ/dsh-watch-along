// watch_frame 必须是"完整快照"：图 + 同一时段的字幕与听写。
// 只给图，模型看得到画面读不到台词；只给文字则相反 —— 两边都残。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { createTools } from '../src/tools.mjs'

/** 造一张最小的合法 PNG（1×1 黑点），免得 savePng 崩掉。 */
function tinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const raw = Buffer.from([0, 0])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const fakeService = {
  async frame() {
    return { png: tinyPng(), width: 1, height: 1, t: 1, at: Date.now(), cached: false }
  },
  async events() {
    return {
      events: [
        { kind: 'ocr', text: '别开窗', sheetId: 'S1', t: 12.3, at: 1763900000000 },
        { kind: 'speech', text: '这风不对啊', t: 13.8, at: 1763900001500 },
        { kind: 'motion', sheetId: 'S1' },
      ],
      nextId: 3,
    }
  },
  async status() {
    return { running: true }
  },
  async start() {
    return { ok: true }
  },
  async stop() {
    return { ok: true }
  },
}

test('watch_frame 一次返回图 + 最近的字幕与听写', async () => {
  const tools = createTools({
    service: fakeService,
    listWindows: async () => [],
    outDir: path.join(os.tmpdir(), 'wa-tools-test'),
  })
  const frameTool = tools.find((t) => t.name === 'watch_frame')
  const out = await frameTool.execute({})
  assert.ok(out.file, '没有落盘路径')
  assert.equal(out.recent.seconds, 30)
  assert.equal(out.recent.ocr[0].text, '别开窗')
  assert.equal(out.recent.ocr[0].t, 12.3, '字幕没带相对秒数')
  assert.ok(out.recent.ocr[0].clock, '字幕没带绝对时刻')
  assert.equal(out.recent.speech[0].text, '这风不对啊')
  assert.equal(out.recent.sheetId, 'S1', '没从事件里带出拼图编号')
})

test('watch_events 返回最新拼图编号', async () => {
  const tools = createTools({ service: fakeService, listWindows: async () => [] })
  const evTool = tools.find((t) => t.name === 'watch_events')
  const out = await evTool.execute({})
  assert.equal(out.latestSheetId, 'S1')
})
