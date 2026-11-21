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
/** 最近邻整数放大：只在小窗口时用（大窗口放大没有收益，只增加耗时） */
function upscale({ width, height, rgb, k }) {
  const W = width * k
  const H = height * k
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    const sy = Math.floor(y / k)
    for (let x = 0; x < W; x += 1) {
      const s = (sy * width + Math.floor(x / k)) * 3
      const d = (y * W + x) * 3
      out[d] = rgb[s]
      out[d + 1] = rgb[s + 1]
      out[d + 2] = rgb[s + 2]
    }
  }
  return { width: W, height: H, rgb: out }
}

/** UI 噪声（时间码/清晰度/倍速/网址）——照 streamvision 的 NOISE 思路 */
const NOISE_RES = [
  /^\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?(\s*\/\s*\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?)?$/,
  /^\d{1,3}\s*[xX×]$/,
  /^(HD|SD|FHD|4K|UHD|1080P|720P)$/i,
  /^https?:\/\//i,
  /^[\d\s.,:：;；|/\\-]+$/,
]
/** 水印/播放器署名：短、稳定、永远是噪音（我们场景特有，streamvision 那边没有） */
// OCR 会把水印认歪（实测 "bilibili"→"LiliLili"、"Ai看剧"→"Ai石剧"），
// 所以按"特征"而不是精确串匹配。
const WATERMARK = [
  /[Ll]ili/i,
  /Ai.?.?剧/,
  /小伙柴/,
  /正在看/,
  /未删减/,
  /^哔哩?哩?哔?哩?$/,
  /^[A-Za-z]{2,10}$/, // 纯拉丁短串基本是播放器水印/标签
]

function isNoise(line) {
  const t = line.trim()
  // 词表已关闭（2026-11-21 用户决定）：只保留"绝不可能是台词"的纯格式规则，
  // 其余交给"重复计数自动静音"。词表追不上 OCR 的变体（bilibili→LiliLili），
  // 而且会误杀 OK / Go 这类真台词。
  return NOISE_RES.some((re) => re.test(t))
}

function downscale({ width, height, rgb }, maxW) {
  const k = maxW / width
  const W = maxW
  const H = Math.max(1, Math.round(height * k))
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / H))
    for (let x = 0; x < W; x += 1) {
      const s = (sy * width + Math.min(width - 1, Math.floor(((x + 0.5) * width) / W))) * 3
      const d = (y * W + x) * 3
      out[d] = rgb[s]
      out[d + 1] = rgb[s + 1]
      out[d + 2] = rgb[s + 2]
    }
  }
  return { width: W, height: H, rgb: out }
}

export function createSubtitleReader({
  recognize,
  encode,
  onEvent,
  onDrop, // (reason, text, band) —— 丢弃要留痕，否则'为什么少了'永远查不出
  intervalMs = 1500,
  stableMs = 1200, // 同一行要隔这么久仍被认到才发（streamvision 的 STABLE_MS）
  threshold = 0.85,
  top = DEFAULT_TOP,
  // 分带识别：每条带单独裁、单独 OCR，结果按顺序拼接。
  // 默认整幅一条（行为不变）；裁哪几条**必须先用 python/ocr_bands.py 量**，别拍脑袋。
  // 三带：顶 / 中 / 底。**不猜字幕在哪**，而是把画面分三段各自识别，
  // 每条带单独出事件（band 字段标明），让 AI 自己判断哪条是字幕。
  // 参考 streamvision 的做法（三带 + 两次一致），固定比例但覆盖常见布局。
  // 三条带**故意重叠**（streamvision 的常量）：正好压在分界线上的字不会被切断。
  // 默认只跑 mid + bottom：top 是浏览器标签/书签/地址栏，实测整屏噪音、
  // 而且每轮多花一次 OCR。需要"读页面顶部文字"时再显式打开 top。
  bands = [
    // every: 每 n 轮跑一次。字幕是主角（每轮），正文可以低频（每 4 轮）——
    // 一轮只调一次 OCR，周期才能压到 0.6s 左右，字幕期内才凑得齐两拍。
    // 默认只跑字幕带：一次识别 ≈ 一次 OCR 的耗时，周期才压得下来。
    // mid（正文）每 4 轮一次即可，需要时把注释打开。
    // { top: 0.32, height: 0.4, label: 'mid', scale: 2, every: 4 },
    { top: 0.66, height: 0.34, label: 'bottom', scale: 3, every: 1, maxW: 1100 },
  ],
  // spec 要求 text ≤60 字。整幅识别会把多处文字拼成一句（实测 80–120 字），
  // 截断是"不猜位置"前提下唯一能守住的硬约束。
  maxChars = 60,
  now = Date.now,
  minChars = 2,
} = {}) {
  let lastAt = -Infinity
  let pending = null // 尚未确认的上一行
  let emitted = null // 已经发出去的那一行：同一句不重复发
  let busy = false

  // 行级稳定判定（2026-11-21 改）。
  //
  // 原来是"整条带 join 成一句再比相似度"——视频字幕场景下必然失效：
  // bottom 带同时有水印（不变）和字幕（每两秒换），字幕一变整句就变，
  // 相似度永远到不了 0.85，于是一条都发不出来（实测 20 秒 0 条）。
  // 改成以"一行文字"为单位累计出现次数：同key 两拍以上且间隔够久才发。
  let round = 0
  const seen = new Map() // key -> { hits, firstAt, emitted }
  // 会话内重复计数：不判断"这是什么"，只看"它是不是在不停重复"。
  // 水印必然重复，台词很少重复到阈值；阈值可调，默认 5。
  const MUTE_AFTER = Number(process.env.WATCH_ALONG_MUTE_AFTER || 3)
  const counts = new Map() // 归一化文本 -> 次数
  const muted = new Map()  // 归一化文本 -> 次数（已静音，仍在记）
  const normKey = (t) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

  async function feed({ buf, width, height }) {
    if (busy) return null
    if (now() - lastAt < intervalMs) return null
    lastAt = now()
    busy = true
    try {
      const events = []
      const at = now()
      // 三带**并发**识别（streamvision 也是并发）：串行时一轮 = n×OCR，
      // 周期被拉长，字幕存续期内凑不齐两拍 → 只出水印、不出台词。
      round += 1
      const jobs = bands.map(async (band) => {
        if ((band.every ?? 1) > 1 && round % (band.every ?? 1) !== 0) return { label: band.label, lines: [] }
        const label = band.label ?? 'band'
        const y0 = Math.max(0, Math.floor(height * (band.top ?? 0)))
        const y1 = Math.min(height, Math.ceil(height * ((band.top ?? 0) + (band.height ?? 1))))
        const h = y1 - y0
        if (h <= 0) return { label, lines: [] }
        const rgb = Buffer.alloc(width * h * 3)
        buf.copy(rgb, 0, y0 * width * 3, y1 * width * 3)
        const below = Number(process.env.OCR_UPSCALE_BELOW || 1200)
        const sc = width >= below ? 1 : (band.scale ?? 1)
        // 送图尺寸封顶：OCR 耗时基本随像素线性增长，1688 宽没必要全送
        const maxW = band.maxW ?? Number(process.env.OCR_MAX_WIDTH || 0)
        let img = sc === 1 ? { width, height: h, rgb } : upscale({ width, height: h, rgb, k: sc })
        if (maxW && img.width > maxW) img = downscale(img, maxW)
        const got = (await recognize(encode(img))) ?? []
        return { label, lines: got }
      })
      const results = await Promise.all(jobs)

      for (const { label, lines } of results) {
        for (const raw of lines) {
          const line = String(raw).trim()
          if (line.length < minChars) { onDrop?.('too-short', line, label); continue }
          if (isNoise(line)) { onDrop?.('noise-format', line, label); continue }
          const key = `${label}|${line.replace(/[^\p{L}\p{N}]/gu, '')}`
          const st = seen.get(key) ?? { hits: 0, firstAt: at, emitted: false }
          st.hits += 1
          if (!st.emitted && st.hits >= 2 && at - st.firstAt >= stableMs) {
            st.emitted = true
            const nk = normKey(line)
            const n = (counts.get(nk) ?? 0) + 1
            counts.set(nk, n)
            if (n > MUTE_AFTER && line.length <= 8 && !/[。？！，；、]/.test(line)) {
              muted.set(nk, n)
              onDrop?.('muted-repeat', line, label)
              seen.set(key, st)
              continue
            }
            if (muted.has(nk)) { onDrop?.('muted-repeat', line, label); seen.set(key, st); continue }
            const ev = { band: label, text: line, hits: st.hits, similarity: 1 }
            events.push(ev)
            onEvent?.(ev)
          }
          seen.set(key, st)
        }
      }
      // 只认到一次的行：过了 2 倍稳定窗就判定"凑不齐两拍"，报出来再清
      for (const [k, v] of seen) {
        if (!v.emitted && at - v.firstAt > stableMs * 2) {
          onDrop?.('need-2-hits', k.split('|')[1] ?? k, k.split('|')[0])
          seen.delete(k)
        }
      }
      // 清掉太久没出现的，避免长跑无限增长
      if (seen.size > 400) {
        const cut = now() - 60_000
        for (const [k, v] of seen) if (v.firstAt < cut && v.emitted) seen.delete(k)
      }
      return events.length ? events : null
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
