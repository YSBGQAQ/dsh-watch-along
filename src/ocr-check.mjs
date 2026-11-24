// 「窗口识别测试」里不依赖机器状态的那部分：裁带、比对。
//
// 为什么单独一块：一次测试有三步 —— 取当前帧、裁剪、OCR、比对。只有裁带和比对
// 是纯函数、能被测试钉死的。边界错一次（整幅 vs 只读底部、水印混进台词），
// 界面上就会显示"识别正常"但实际陪看读不到 —— 所以这两步必须单独可测。

import { similarity } from './ocr.mjs'

// 必须和 src/ocr.mjs 里 createSubtitleReader 的默认分带一致：
// 现在只有 bottom 一条，读的是画面下方 34%。改了这里就要同步改那边，
// 否则测试通过、实际陪看读不到（反过来也一样）。
export const OCR_BAND = { top: 0.66, height: 0.34, label: 'bottom' }

/**
 * 按比例裁一条带出来。行区间与原图一致：`bottom` = 从 66% 到底。
 * @param {{width:number,height:number,rgb?:Buffer,buf?:Buffer}} frame
 */
export function cropBand(frame, band = OCR_BAND) {
  const width = Number(frame?.width)
  const height = Number(frame?.height)
  // 采集帧的像素字段叫 buf（capture-koffi 的出参），service 内部转手时叫 rgb。
  // 两种都收：调用方不该为了"字段名"再包一层（E2E 第一跑就是这里炸的）。
  const src = frame?.rgb ?? frame?.buf
  if (!(width > 0) || !(height > 0) || !src) return null
  const y0 = Math.max(0, Math.floor(height * (band.top ?? 0)))
  const y1 = Math.min(height, Math.ceil(height * ((band.top ?? 0) + (band.height ?? 1))))
  const h = y1 - y0
  if (h <= 0) return null
  const rgb = Buffer.alloc(width * h * 3)
  src.copy(rgb, 0, y0 * width * 3, y1 * width * 3)
  return { width, height: h, rgb, top: y0, bottom: y1 }
}

/**
 * 只留字母/数字/汉字。
 * 为什么不用严格相等：OCR 会在词间加空格、把「，」认成「,」、多认一个句点，
 * 这些都不该判成"没认出来"。真正要抓的是错字，不是标点。
 */
export function normalize(s) {
  return String(s ?? '').replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 这行像不像"真实的文字"（台词/字幕/正文），而不是 OCR 从界面上刮下来的噪声。
 *
 * 为什么需要：判据是"认到任意文字就算通过"，但实测底带里常混着模糊的搜索框、
 * 按钮边缘，OCR 会吐出 `A:4i4…1-×4`、`Lmm-mem).=1,1-11as1±` 这种串。
 * 这种串也能让测试"通过"，然后把窗口锁错。
 *
 * 判据故意宽松，只挡明显的噪声：
 *   · 至少 2 个汉字（中文字幕/正文），或
 *   · 连续 4 个以上英文字母（英文台词）
 * 注意这里**不包括数字**：实测噪声串 `Lmm-mem).=1,1-11as1±` 里能凑出「11as1」
 * 这种字母数字混排，把数字算进去就挡不住它。
 */
export function looksLikeText(line) {
  const t = String(line ?? '').trim()
  if (t.length < 2) return false
  if ((t.match(/[\u4e00-\u9fff]/g) ?? []).length >= 2) return true
  return /[A-Za-z]{4,}/.test(t)
}

/**
 * 判断"看到的是不是用户要的那句"。
 *
 * 判据（用户 2026-11-24 的口径）：认到的某一行**与输入相同**算正常识别。
 * 另外放两个更宽的信号，不改变结论，只用来解释"为什么没对上"：
 *   · contains —— OCR 把两行拼成一句（实测常见），输入是其中一段
 *   · best     —— 最像的那一行的相似度，用来区分"差一个字"和"完全没读到"
 */
export function judge(lines, expect) {
  const want = normalize(expect)
  const seen = (lines ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)
  if (!want) return { matched: false, exact: false, contains: false, lines: seen, best: null, reason: 'empty-expect' }

  let best = null
  for (const line of seen) {
    const s = similarity(want, normalize(line))
    if (!best || s > best.similarity) best = { line, similarity: Math.round(s * 1000) / 1000 }
  }
  const exact = seen.some((line) => normalize(line) === want)
  const contains = seen.some((line) => normalize(line).includes(want))
  return { matched: exact || contains, exact, contains, lines: seen, best }
}
