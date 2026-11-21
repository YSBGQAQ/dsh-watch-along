// 字幕通道：把画面底部裁出来 → OCR → 两次一致才收录。
//
// 不做模型推理（那是 Python 常驻服务的事），只做三件事：
// 裁剪、去抖、判"这一行值得发出去"。
// 整幅识别。原本按"字幕在底部 30%"裁一刀，实测落空：那个视频的白字在中间偏左，
// 底部是纯背景，服务直接返回"text detection result is empty"，OCR 一条都出不来。
// 整幅一次也是 ~0.5s，先别赌位置，等见到更多素材再谈分带。
const DEFAULT_TOP = 0

/** 归一化编辑距离，0 = 完全不同，1 = 一模一样。 */
export function similarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  const m = a.length
  const n = b.length
  const prev = new Array(n + 1)
  const cur = new Array(n + 1)
  for (let j = 0; j <= n; j += 1) prev[j] = j
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j]
  }
  return 1 - prev[n] / Math.max(m, n)
}

/**
 * @param recognize (png:Buffer) => Promise<string[]>   —— 一次 OCR，返回各行文字
 * @param encode    ({width,height,rgb}) => Buffer      —— PNG 编码
 * @param onEvent   (event) => void                     —— 判定通过时回调
 */
export function createSubtitleReader({
  recognize,
  encode,
  onEvent,
  intervalMs = 1500,
  threshold = 0.85,
  top = DEFAULT_TOP,
  // 分带识别：每条带单独裁、单独 OCR，结果按顺序拼接。
  // 默认整幅一条（行为不变）；裁哪几条**必须先用 python/ocr_bands.py 量**，别拍脑袋。
  bands = [{ top: DEFAULT_TOP, height: 1 - DEFAULT_TOP }],
  now = Date.now,
  minChars = 2,
} = {}) {
  let lastAt = -Infinity
  let pending = null // 尚未确认的上一行
  let emitted = null // 已经发出去的那一行：同一句不重复发
  let busy = false

  async function feed({ buf, width, height }) {
    if (busy) return null // 上一次还没回来就跳过，绝不排队堆积
    if (now() - lastAt < intervalMs) return null
    lastAt = now()
    busy = true
    try {
      const lines = []
      for (const band of bands) {
        const y0 = Math.max(0, Math.floor(height * (band.top ?? 0)))
        const y1 = Math.min(height, Math.ceil(height * ((band.top ?? 0) + (band.height ?? 1))))
        const h = y1 - y0
        if (h <= 0) continue
        const rgb = Buffer.alloc(width * h * 3)
        buf.copy(rgb, 0, y0 * width * 3, y1 * width * 3)
        const got = (await recognize(encode({ width, height: h, rgb }))) ?? []
        lines.push(...got)
      }
      const text = lines.map((s) => String(s).trim()).filter(Boolean).join(' ').trim()

      if (!text || text.length < minChars) {
        pending = null
        return null
      }
      if (text === emitted) {
        pending = null // 还是刚才发过的那句，不重复
        return null
      }
      if (!pending) {
        pending = text // 第一遍：先记着，不下结论
        return null
      }
      const sim = similarity(pending, text)
      if (sim < threshold) {
        pending = text // 变了：说明这一行还在动，重新开始等
        return null
      }
      const event = { band: 'bottom', text: pending, hits: 2, similarity: +sim.toFixed(3) }
      emitted = pending // 记住发过什么，同一句不再发
      pending = null
      onEvent?.(event)
      return event
    } catch (e) {
      // OCR 挂了不能拖垮画面通道：这一拍放弃，下一拍照常
      pending = null
      onEvent?.({ error: String(e?.message ?? e) })
      return null
    } finally {
      busy = false
    }
  }

  return { feed }
}
