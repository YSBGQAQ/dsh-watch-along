import test from 'node:test'
import assert from 'node:assert/strict'
import { encode } from '../src/png.mjs'
import { composeGrid } from '../src/compose-sheet.mjs'

const isPng = (b) => b.subarray(1, 4).toString('ascii') === 'PNG'

test('encode 收 Buffer（采集帧给的就是它）', () => {
  const png = encode({ width: 2, height: 2, rgb: Buffer.alloc(2 * 2 * 3, 200) })
  assert.ok(isPng(png))
})

test('encode 收 Uint8Array（拼图给的是它，不是 Buffer）', () => {
  // 回归：composeGrid 返回 Uint8Array，而 vendor 的 encodePng 用 rgb.copy 逐行搬像素。
  // 曾经因此每 3 秒抛一次 "rgb.copy is not a function"，拼图全废、日志刷了 700+ 条。
  const png = encode({ width: 2, height: 2, rgb: new Uint8Array(2 * 2 * 3).fill(128) })
  assert.ok(isPng(png))
})

test('拼图 → 编码这条真实路径能走通', () => {
  const f = { buf: new Uint8Array([255, 0, 0]), width: 1, height: 1 }
  const grid = composeGrid({ frames: [f, f], canvasW: 4, canvasH: 2 })
  const png = encode({ width: grid.width, height: grid.height, rgb: grid.rgb })
  assert.ok(isPng(png), '拼图产物必须能直接编码成 PNG')
})
