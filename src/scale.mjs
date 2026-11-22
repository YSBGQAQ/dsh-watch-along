// 只做一件事：把 rgb24 缩小，给"平时上传"用。
//
// 为什么不直接改采集分辨率：采集那一份同时喂 OCR/拼图/判据，动它等于动三条通道的输入。
// 这里只缩"发给模型的那一张"，磁盘上仍然存全尺寸（回看要用）。
//
// 双线性插值而不是最近邻：画面里的小字（门牌、短信、弹幕）是模型看图的主要目标，
// 最近邻会把细笔画打碎成噪点，反而让它看不清。
export function shrink({ width, height, rgb }, maxW) {
  if (!(maxW > 0) || width <= maxW) return { width, height, rgb, scaled: false }
  const W = Math.max(1, Math.round(maxW))
  const H = Math.max(1, Math.round((height * W) / width))
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    const sy = ((y + 0.5) * height) / H - 0.5
    const y0 = Math.min(height - 1, Math.max(0, Math.floor(sy)))
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = Math.min(1, Math.max(0, sy - y0))
    for (let x = 0; x < W; x += 1) {
      const sx = ((x + 0.5) * width) / W - 0.5
      const x0 = Math.min(width - 1, Math.max(0, Math.floor(sx)))
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = Math.min(1, Math.max(0, sx - x0))
      const o = (y * W + x) * 3
      for (let c = 0; c < 3; c += 1) {
        const p00 = rgb[(y0 * width + x0) * 3 + c]
        const p10 = rgb[(y0 * width + x1) * 3 + c]
        const p01 = rgb[(y1 * width + x0) * 3 + c]
        const p11 = rgb[(y1 * width + x1) * 3 + c]
        const top = p00 + (p10 - p00) * wx
        const bot = p01 + (p11 - p01) * wx
        out[o + c] = Math.round(top + (bot - top) * wy)
      }
    }
  }
  return { width: W, height: H, rgb: out, scaled: true }
}
