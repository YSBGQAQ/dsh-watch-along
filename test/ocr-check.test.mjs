// 窗口识别测试的纯逻辑：裁带 + 比对。
// 这两步错了，界面上会显示"识别正常"但实际陪看读不到字 —— 最坏的一种错。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cropBand, normalize, judge, looksLikeText, OCR_BAND } from '../src/ocr-check.mjs'

function frame(width, height) {
  // 每一行的红通道 = 行号，用来断言"裁的是哪一段"
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgb[(y * width + x) * 3] = y % 256
  }
  return { width, height, rgb }
}

test('裁的是下方 34%，且行内容对得上', () => {
  const f = frame(80, 100)
  const c = cropBand(f)
  assert.equal(c.top, 66, '100 行里从第 66 行开始')
  assert.equal(c.height, 34)
  assert.equal(c.width, 80)
  assert.equal(c.rgb[0], 66, '第一行应该是原图第 66 行')
  assert.equal(c.rgb[(c.height - 1) * 80 * 3], 99, '最后一行应该是原图最后一行')
})

test('分带常量与字幕通道一致（bottom 66%–100%）', () => {
  // 这条是防"测试通过、实际读不到"的：src/ocr.mjs 改了分带，这里必须跟着改。
  assert.equal(OCR_BAND.top, 0.66)
  assert.equal(OCR_BAND.height, 0.34)
})

test('尺寸异常时返回 null，不抛', () => {
  assert.equal(cropBand(null), null)
  assert.equal(cropBand({ width: 0, height: 10, rgb: Buffer.alloc(0) }), null)
  assert.equal(cropBand({ width: 10, height: 0, rgb: Buffer.alloc(0) }), null)
  assert.equal(cropBand({ width: 10, height: 10 }), null)
})

test('采集帧给的是 buf 而不是 rgb 时也要能裁（E2E 第一跑就炸在这）', () => {
  const f = frame(8, 10)
  const c = cropBand({ width: 8, height: 10, buf: f.rgb })
  assert.ok(c, '不该返回 null')
  assert.equal(c.top, 6)
  assert.equal(c.height, 4)
  assert.equal(c.rgb[0], 6)
})

test('标点和空格不算错：整行相同即通过', () => {
  const r = judge(['你好，世界！'], '你好世界')
  assert.equal(r.matched, true)
  assert.equal(r.exact, true)
  assert.equal(r.lines.length, 1)
})

test('OCR 把两行拼成一句时，输入是其中一段也算通过', () => {
  const r = judge(['广告位 你好世界 播放器水印'], '你好世界')
  assert.equal(r.matched, true)
  assert.equal(r.exact, false)
  assert.equal(r.contains, true)
})

test('完全没读到就判不通过，并把最像的一行带出来', () => {
  const r = judge(['我们今天去哪里吃饭呢'], '你好世界')
  assert.equal(r.matched, false)
  assert.equal(r.exact, false)
  assert.ok(r.best)
  assert.equal(r.best.line, '我们今天去哪里吃饭呢')
  assert.ok(r.best.similarity < 0.5, '相似度应该很低，实际 ' + r.best.similarity)
})

test('差一个字要判不通过（这是"错字不算对"的底线）', () => {
  const r = judge(['你好世芥'], '你好世界')
  assert.equal(r.matched, false)
  assert.ok(r.best.similarity > 0.7, '相似度应该不低，才能看出是差一个字')
})

test('空输入永远不通过；空结果也不崩', () => {
  const a = judge(['随便什么'], '   ')
  assert.equal(a.matched, false)
  assert.equal(a.reason, 'empty-expect')
  const b = judge([], '你好')
  assert.equal(b.matched, false)
  assert.equal(b.best, null)
  const c = judge(null, '你好')
  assert.deepEqual(c.lines, [])
})

test('归一化只留字，不留标点', () => {
  assert.equal(normalize(' 你好，世界！ '), '你好世界')
  assert.equal(normalize('AB-12 3'), 'AB123')
})

test('噪声串不算"认到文字"，真台词才算', () => {
  // 真台词：中文 ≥2 字，或连续 4 个英文字母
  assert.equal(looksLikeText('给口癖加个称呼'), true)
  assert.equal(looksLikeText('Hello world'), true)
  // 实测从界面噪声里刮出来的串（2026-11-24 底带上真的出现过）
  assert.equal(looksLikeText('A:4i4…1-×4'), false)
  assert.equal(looksLikeText('Lmm-mem).=1,1-11as1± ./11'), false)
  assert.equal(looksLikeText('公'), false)
  assert.equal(looksLikeText(''), false)
  assert.equal(looksLikeText(null), false)
})
