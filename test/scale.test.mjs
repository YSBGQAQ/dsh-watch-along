import test from 'node:test'
import assert from 'node:assert/strict'
import { shrink } from '../src/scale.mjs'

const img = (w, h) => {
  const rgb = Buffer.alloc(w * h * 3)
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = (i / 3) % 256
    rgb[i + 1] = 128
    rgb[i + 2] = 255
  }
  return { width: w, height: h, rgb }
}

test('缩图：宽度到 maxW，高度按比例，通道数不变', () => {
  const out = shrink(img(798, 450), 640)
  assert.equal(out.width, 640)
  assert.equal(out.height, 361, '450 * 640/798 应约为 361')
  assert.equal(out.rgb.length, 640 * 361 * 3)
  assert.equal(out.scaled, true)
})

test('本来就不宽：原样返回，不做无谓的重采样', () => {
  const src = img(320, 180)
  const out = shrink(src, 640)
  assert.equal(out.scaled, false)
  assert.equal(out.rgb, src.rgb, '不该复制一份')
})

test('缩图不改变纯色（不会把颜色洗白或压暗）', () => {
  const src = { width: 100, height: 100, rgb: Buffer.alloc(100 * 100 * 3, 200) }
  const out = shrink(src, 50)
  for (const v of out.rgb) assert.equal(v, 200)
})
