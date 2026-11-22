import test from 'node:test'
import assert from 'node:assert/strict'
import { gridFor, pickEvenly, composeGrid } from '../src/compose-sheet.mjs'

test('格子按帧数选近正方：1→1×1, 2→2×1, 4→2×2, 6→3×2', () => {
  assert.deepEqual(gridFor(1), { cols: 1, rows: 1 })
  assert.deepEqual(gridFor(2), { cols: 2, rows: 1 })
  assert.deepEqual(gridFor(4), { cols: 2, rows: 2 })
  assert.deepEqual(gridFor(6), { cols: 3, rows: 2 })
})

test('等距取帧：3 秒 30 帧取 3 帧，落在首/中/尾', () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({ i }))
  const picked = pickEvenly(frames, 3)
  assert.deepEqual(picked.map((f) => f.i), [0, 15, 29], '等距 = 首 / 中 / 尾')
})

test('帧数比要的少时，有几个取几个（不重复凑数）', () => {
  const frames = [{ i: 0 }, { i: 1 }]
  assert.equal(pickEvenly(frames, 6).length, 2)
})

test('拼图把每帧填进对应格子（用纯色验证）', () => {
  const mk = (r, g, b) => ({ buf: new Uint8Array([r, g, b]), width: 1, height: 1 })
  const grid = composeGrid({ frames: [mk(255, 0, 0), mk(0, 255, 0)], canvasW: 100, canvasH: 50 })
  assert.equal(grid.cols, 2)
  assert.equal(grid.rows, 1)
  assert.equal(grid.width, 100)
  assert.equal(grid.height, 50)
  // 左格中心应是红，右格中心应是绿
  const at = (x, y) => {
    const i = (y * grid.width + x) * 3
    return [grid.rgb[i], grid.rgb[i + 1], grid.rgb[i + 2]]
  }
  assert.deepEqual(at(25, 25), [255, 0, 0])
  assert.deepEqual(at(75, 25), [0, 255, 0])
})

test('没有帧时返回 null，不抛错', () => {
  assert.equal(composeGrid({ frames: [], canvasW: 10, canvasH: 10 }), null)
})
