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

/** 竖排拼图（中间留黑带，防上下行粘连） */
function stackVertical(imgs) {
  const W = imgs[0].width
  const gap = 24
  const H = imgs.reduce((a, i) => a + i.height, 0) + gap * (imgs.length - 1)
  const out = Buffer.alloc(W * H * 3)
  let y = 0
  for (const img of imgs) {
    for (let row = 0; row < img.height; row += 1) {
      img.rgb.copy(out, ((y + row) * W) * 3, row * img.width * 3, (row + 1) * img.width * 3)
    }
    y += img.height + gap
  }
  return { width: W, height: H, rgb: out }
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
  // 2026-11-22：移除时间节流（intervalMs）。它原是给已废弃的「两次一致」判定留时间间隔的，
  // 现在一拍即发、CPU 单拍约 1.2s，节流恒不触发（埋点 t 一直为 0），留着只会误导。
  // 节奏由 busy 标志自然决定：上一次 OCR 没跑完就跳过新帧，不会堆积。
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
    // 2026-11-22 受控实验结论：CPU 版 + batch:1 跑 6 分钟不泄漏（显存峰值 4.1GB、
    // OCR 内存峰值 649MB 且无线性增长），证明之前的泄漏是 GPU 显存池造成的，不是 batch:1。
    // 严格按测试窗口核对：CPU batch3+700 = 76.1%，CPU batch1 = 72.2%，两者接近；
    // 而 GPU 轮只有 24.4% / 14.0%（服务被拖死，事件数骤减）。
    // every: 每 n 轮跑一次；只跑字幕带，mid 需要时把注释打开。
    // { top: 0.32, height: 0.4, label: 'mid', scale: 2, every: 4 },
    // scale 1（不放大）+ batch 3：2026-11-23 用真实帧实测，三帧竖拼 2.45 秒、三帧全读对；
    // 而放大到 3 倍要 3.9 秒，还把"仨"读成"仁"—— 又慢又差，所以不放大。
    { top: 0.66, height: 0.34, label: 'bottom', scale: 1, every: 1, batch: 3, once: true },
  ],
  // spec 要求 text ≤60 字。整幅识别会把多处文字拼成一句（实测 80–120 字），
  // 截断是"不猜位置"前提下唯一能守住的硬约束。
  maxChars = 60,
  // 同时跑几路 OCR。2026-11-23 实测：单次 OCR 固定要 3 秒左右（跟图片大小几乎无关），
  // 而字幕平均 2.6 秒换一条 —— 单路串行最多只能读一半。
  // 真正有效的办法是 batch（一次读多个时刻），并发只保留 2 路给"攒批次"和"识别"重叠用。
  maxInFlight = Number(process.env.WATCH_ALONG_OCR_INFLIGHT || 2),
  // 同一个带里，两帧至少隔这么久才允许拼进同一张（否则拼的是同一句字幕）
  batchMs = Number(process.env.WATCH_ALONG_OCR_BATCH_MS || 800),
  now = Date.now,
  minChars = 2,
} = {}) {
  let pending = null // 尚未确认的上一行
  let emitted = null // 已经发出去的那一行：同一句不重复发
  let inFlight = 0 // 正在跑的 OCR 路数（旧版是 busy 布尔：一次只许一个）

  // 只读埋点（2026-11-22）：统计 busy 丢帧 / 实际 OCR 耗时，每 10 拍落一条汇总。
  let feeds = 0
  let busySkips = 0
  let ocrCalls = 0 // 真正送出去的 OCR 次数（攒批没满的那些不算）
  let ocrMsTotal = 0

  // 行级稳定判定（2026-11-21 改）。
  //
  // 原来是"整条带 join 成一句再比相似度"——视频字幕场景下必然失效：
  // bottom 带同时有水印（不变）和字幕（每两秒换），字幕一变整句就变，
  // 相似度永远到不了 0.85，于是一条都发不出来（实测 20 秒 0 条）。
  // 改成以"一行文字"为单位累计出现次数：同key 两拍以上且间隔够久才发。
  let round = 0
  const pendingBands = new Map() // label -> 待拼的图（batch>1 时攒够再送）
  const seen = new Map() // key -> { hits, firstAt, emitted }
  // 拼图里同一句字幕常被认成细微不同的文本（差一个字），各出现 1 次 → 永远凑不齐两拍。
  // 所以找 key 时先做相似度归并（≥0.85 视为同一句），这是 streamvision 的做法。
  const normText = (t) => t.replace(/[^\p{L}\p{N}]/gu, '')
  const bigrams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i += 1) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const sim = (a, b) => {
    if (!a || !b) return 0
    if (a === b) return 1
    const ga = bigrams(a)
    const gb = bigrams(b)
    let inter = 0
    let uni = 0
    for (const [g, n] of ga) {
      const m = gb.get(g) ?? 0
      inter += Math.min(n, m)
      uni += Math.max(n, m)
    }
    for (const [g, n] of gb) if (!ga.has(g)) uni += n
    return uni ? inter / uni : 0
  }
  const alias = new Map() // label -> [{ key, norm }]

  // 每带一个帧队列（存已裁剪、已缩放的图），OCR 期间采集的帧全进这里
  const frameQueue = new Map() // label -> [img]
  const QUEUE_MAX = Number(process.env.WATCH_ALONG_QUEUE || 24)

  function cropToImg(band, buf, width, height) {
    const y0 = Math.max(0, Math.floor(height * (band.top ?? 0)))
    const y1 = Math.min(height, Math.ceil(height * ((band.top ?? 0) + (band.height ?? 1))))
    const h = y1 - y0
    if (h <= 0) return null
    const rgb = Buffer.alloc(width * h * 3)
    buf.copy(rgb, 0, y0 * width * 3, y1 * width * 3)
    return { width, height: h, rgb }
  }

  function enqueueBand(band, buf, width, height) {
    const label = band.label ?? 'band'
    const q = frameQueue.get(label) ?? []
    if (q.length >= QUEUE_MAX) q.shift() // 满了丢最旧的，别无限涨
    const img = cropToImg(band, buf, width, height)
    if (img) q.push(img)
    frameQueue.set(label, q)
  }
  // 会话内重复计数：不判断"这是什么"，只看"它是不是在不停重复"。
  // 水印必然重复，台词很少重复到阈值；阈值可调，默认 5。
  const MUTE_AFTER = Number(process.env.WATCH_ALONG_MUTE_AFTER || 3)
  const counts = new Map() // 归一化文本 -> 次数
  const muted = new Set()  // 已静音的相似组 key（仍在 counts 里计数）
  const normKey = (t) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

  async function feed({ buf, width, height }) {
    // 时间节流已移除：每帧都尝试，挡住的只有"在飞的路数已经到上限"。
    // 为什么允许多路：单次 OCR 固定约 3 秒，字幕 2.6 秒换一条，串行必然漏一半；
    // 服务是线程化的，3 路并发的总吞吐约是串行的 2–3 倍（2026-11-23 实测）。
    if (inFlight >= maxInFlight) { busySkips += 1; return null }
    inFlight += 1
    feeds += 1
    // 只有真的送了一次 OCR 才计耗时。攒批没满就返回的那些调用是 1ms 级的，
    // 混进平均会把 2.5 秒摊成 140ms，看埋点时会被骗（2026-11-23 踩过）。
    let didOcr = false
    const feedStart = now()
    try {
      const events = []
      const at = now()
      // 三带**并发**识别（streamvision 也是并发）：串行时一轮 = n×OCR，
      // 周期被拉长，字幕存续期内凑不齐两拍 → 只出水印、不出台词。
      round += 1
      const jobs = bands.map(async (band) => {
        if ((band.every ?? 1) > 1 && round % (band.every ?? 1) !== 0) return { label: band.label, lines: [], batchN: 1 }
        const label = band.label ?? 'band'
        const y0 = Math.max(0, Math.floor(height * (band.top ?? 0)))
        const y1 = Math.min(height, Math.ceil(height * ((band.top ?? 0) + (band.height ?? 1))))
        const h = y1 - y0
        if (h <= 0) return { label, lines: [], batchN: 1 }
        const q = frameQueue.get(label) ?? []
        let rgb
        if (q.length) {
          const cur = q.shift()                 // 用排队中的帧（OCR 期间采集的）
          rgb = cur.rgb
          frameQueue.set(label, q)
          var qWidth = cur.width
          var qHeight = cur.height
        } else {
          rgb = Buffer.alloc(width * h * 3)
          buf.copy(rgb, 0, y0 * width * 3, y1 * width * 3)
          var qWidth = width
          var qHeight = h
        }
        const below = Number(process.env.OCR_UPSCALE_BELOW || 1200)
        const sc = width >= below ? 1 : (band.scale ?? 1)
        const maxW = band.maxW ?? Number(process.env.OCR_MAX_WIDTH || 0)
        let img = sc === 1 ? { width, height: h, rgb } : upscale({ width, height: h, rgb, k: sc })
        if (maxW && img.width > maxW) img = downscale(img, maxW)

        const batch = Math.max(1, band.batch ?? 1)
        if (batch === 1) {
          const got = (await recognize(encode(img))) ?? []
          return { label, lines: got, batchN: 1, once: band.once }
        }
        // 攒 batch 帧，竖拼成一张再送：一次调用的固定开销摊到多帧上。
        // **必须隔一段时间收一帧**：连拍的 3 帧只隔 80 毫秒，拼起来是同一句字幕，白花 3 秒。
        // batchMs=800 时，一张三拼图覆盖约 1.6 秒的三个时刻，等于把采样率乘 3。
        const arr = pendingBands.get(label) ?? []
        const prev = arr[arr.length - 1]
        if (!prev || at - prev.at >= batchMs) arr.push({ at, img })
        if (arr.length < batch) { pendingBands.set(label, arr); return { label, lines: [], batchN: 0, once: !!band.once } }
        pendingBands.set(label, [])
        const stacked = stackVertical(arr.map((x) => x.img))
        didOcr = true
        const got = (await recognize(encode(stacked))) ?? []
        return { label, lines: got, batchN: arr.length, once: !!band.once }
      })
      const results = await Promise.all(jobs)

      for (const { label, lines, batchN, once } of results) {
        const bandOnce = once === true
        for (const raw of lines) {
          const line = String(raw).trim()
          if (line.length < minChars) { onDrop?.('too-short', line, label); continue }
          if (isNoise(line)) { onDrop?.('noise-format', line, label); continue }
          const normLine = normText(line)
          const list = alias.get(label) ?? []
          // 先找相似度 ≥0.85 的已有 key，避免同一句被拆成多个变体
          const near = list.find((e) => sim(e.norm, normLine) >= 0.8)
          const key = near?.key ?? `${label}|${normLine}`
          if (!near) {
            list.push({ key, norm: normLine })
            if (list.length > 120) list.shift()
            alias.set(label, list)
          }
          let st = seen.get(key)
          if (!st) {
            // 不再按拍数回推时间（节流已删）；firstAt 只用于「两拍一致」与过期清理。
            st = { hits: 0, firstAt: at, firstSeenReal: at / 1000, emitted: false }
          }
          st.hits += 1
          const pass = bandOnce
            ? st.hits >= 1                                   // 字幕：一拍即发（去重靠 emitted）
            : st.hits >= 2 && at - st.firstAt >= stableMs     // 其他：两拍一致
          if (!st.emitted && pass) {
            st.emitted = true
            const nk = normKey(line)
            const n = (counts.get(nk) ?? 0) + 1
            counts.set(nk, n)
            const cjk = (line.match(/[\u4e00-\u9fff]/g) ?? []).length
            if (n >= MUTE_AFTER && cjk < 2) {
              muted.set(nk, n)
              onDrop?.('muted-repeat', line, label)
              seen.set(key, st)
              continue
            }
            if (muted.has(nk)) { onDrop?.('muted-repeat', line, label); seen.set(key, st); continue }
            // 只带 t0：一拍即发模型下发出去的瞬间还不知道会停留多久，
            // 硬塞 t1 只会恒等于 t0（实测），反而误导（"停留 0 秒"）。
            const ev = {
              band: label,
              text: line,
              t0: Number((st.firstSeenReal ?? at / 1000).toFixed(2)),
              hits: st.hits,
              similarity: 1,
              // 从"这一行第一次出现在画面上"到"事件发出去"用了多久。
              // 这是唯一能跟"起点错位"分开的延迟数：不看视频时间，只看我们自己的管线。
              latencyMs: Math.max(0, Math.round(now() - (st.firstSeenReal ?? at / 1000) * 1000)),
            }
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
      inFlight -= 1
      if (didOcr) {
        ocrCalls += 1
        ocrMsTotal += now() - feedStart
      }
      if (feeds % 10 === 0) {
        const q = frameQueue.get('bottom') ?? []
        const avg = ocrCalls ? Math.round(ocrMsTotal / ocrCalls) : 0
        // 复用 onDrop 的会话分文件；index.js 会把 text 截到 40 字，所以用紧凑串
        // n= 真正的 OCR 次数（不是 feed 次数）｜a= 单次耗时｜c= 同时在跑几路
        onDrop?.('feed-stats', `f=${feeds} n=${ocrCalls} b=${busySkips} q=${q.length} a=${avg}ms c=${inFlight}`, 'feed')
      }
    }
  }

  return { feed }
}
