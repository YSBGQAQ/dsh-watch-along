// 把几帧拼成一张图（"每 3 秒一张多帧图"用的）。
//
// 为什么不用现成的拼图逻辑：那套是按"变化强度分格子大小"的，产出时机由 pipeline 决定；
// 这里要的是**按时间等距取帧、等格排布**——两件事的目的不同，硬套会把 pipeline 的
// 判据搅乱。所以这里只做纯几何 + 像素拷贝，不参与任何判定。
//
// 纯函数，不碰文件、不碰网络：给定帧数组和画布尺寸，返回 RGB。

/** 近正方形的排布：1 帧 1×1，2 帧 2×1，3–4 帧 2×2，5–6 帧 3×2。 */
export function gridFor(n) {
  if (n <= 1) return { cols: 1, rows: 1 }
  if (n === 2) return { cols: 2, rows: 1 }
  if (n <= 4) return { cols: 2, rows: 2 }
  if (n <= 6) return { cols: 3, rows: 2 }
  return { cols: 3, rows: 3 }
}

/**
 * 从一段帧里等距挑 n 帧。
 *
 * 等距而不是"最新的 n 帧"：3 秒 24 帧里，只要 6 帧时，取最新的 6 帧会把时间挤在最后一秒，
 * 前两秒就没了 —— 那就失去了"这 3 秒发生了什么"的意义。
 */
export function pickEvenly(frames, n) {
  const list = (frames ?? []).filter(Boolean)
  if (!list.length) return []
  const want = Math.max(1, Math.min(n, list.length))
  if (want === 1) return [list[list.length - 1]]
  const out = []
  for (let i = 0; i < want; i++) {
    const idx = Math.round((i * (list.length - 1)) / (want - 1))
    out.push(list[idx])
  }
  return out
}

/**
 * 等格拼图：每格按最近邻缩放填入。
 *
 * @param frames  [{ buf, width, height }]
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @returns {{ rgb: Uint8Array, width, height, cols, rows, cellW, cellH, cells }}
 */
export function composeGrid({ frames, canvasW, canvasH }) {
  const list = (frames ?? []).filter((f) => f && f.buf && f.width > 0 && f.height > 0)
  if (!list.length) return null

  const { cols, rows } = gridFor(list.length)
  const cellW = Math.floor(canvasW / cols)
  const cellH = Math.floor(canvasH / rows)
  const width = cellW * cols
  const height = cellH * rows
  const rgb = new Uint8Array(width * height * 3)

  list.forEach((f, i) => {
    const cx = (i % cols) * cellW
    const cy = Math.floor(i / cols) * cellH
    for (let y = 0; y < cellH; y++) {
      // 最近邻：源图 y 按比例映射
      const sy = Math.min(f.height - 1, Math.floor((y * f.height) / cellH))
      for (let x = 0; x < cellW; x++) {
        const sx = Math.min(f.width - 1, Math.floor((x * f.width) / cellW))
        const si = (sy * f.width + sx) * 3
        const di = ((cy + y) * width + (cx + x)) * 3
        rgb[di] = f.buf[si]
        rgb[di + 1] = f.buf[si + 1]
        rgb[di + 2] = f.buf[si + 2]
      }
    }
  })

  return { rgb, width, height, cols, rows, cellW, cellH, cells: list.length }
}
