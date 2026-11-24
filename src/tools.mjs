// 工具层：AI 唯一能碰到的四个入口。
// 薄适配器 —— 只做参数转写与结果整形，判断全在 service 里。
import fs from 'node:fs'
import path from 'node:path'

const RUN_DIR = path.resolve('.scratch', 'run', 'frames')

// 帧图只留最近这么多张。强制看图之后是 5 秒一张，一张 400–550KB：
// 90 分钟不设上限就是 450MB。120 张≈10 分钟，够"回看刚才那个画面"。
const KEEP_FRAMES = 120
let sincePrune = 0

// 平时上传的图宽。798 是采集宽度；缩到 640 后模型侧处理明显轻，
// 而 640×360 认人脸/场景足够。要读小字时 watch_frame 传 hd:true。
const UPLOAD_MAX_W = 640

function pruneFrames(dir) {
  sincePrune += 1
  if (sincePrune % 10 !== 0) return // 每写 10 张才扫一次目录
  try {
    const names = fs.readdirSync(dir).filter((n) => /^frame_\d+\.png$/.test(n)).sort()
    const drop = names.length - KEEP_FRAMES
    for (const n of names.slice(0, Math.max(0, drop))) {
      try {
        fs.unlinkSync(path.join(dir, n))
      } catch {
        /* 正被读就走，下次再删 */
      }
    }
  } catch {
    /* 目录读不到不影响取帧 */
  }
}

function savePng(shot, seq, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `frame_${String(seq).padStart(4, '0')}.png`)
  fs.writeFileSync(file, shot.png)
  pruneFrames(dir)
  return file
}

export function createTools({ service, listWindows, attachments = null, outDir = RUN_DIR, onAgent = null, onFrame = null, serviceStatus = null, defaultWindow = '', lockNotice = null, uploadWidth = UPLOAD_MAX_W }) {
  let seq = 0

  /**
   * 最近 N 秒的完整快照：字幕 + 听写 + 变化次数。
   *
   * 为什么要它：模型一次调用就该拿到"此刻全部内容"——只给图看不到台词，
   * 只给文字看不到画面，两边都残。
   */
  let latestSheetId = null

  /**
   * 取一张快照：图 + 最近 N 秒的字幕与听写。
   *
   * watch_start 与 watch_frame 共用。**开头那次必须也走这里** —— 以前 watch_start
   * 只返回"开始成功"，模型还得再调一次 watch_frame，用户看到的就是开场连着四个
   * 工具调用（status → windows → start → frame），十几秒才出第一句话。
   */
  async function takeSnapshot(args = {}) {
    // 默认上传 640 宽：模型看图的时间跟像素走，而 640 已经够认人脸和场景；
    // 要读小字（门牌、短信、弹幕）时传 hd:true 拿原尺寸。磁盘上始终存全尺寸。
    const shot = await service.frame({
      live: args.live !== false,
      sheetId: args.sheetId ?? null,
      maxWidth: args.hd ? 0 : uploadWidth,
    })
    const recent = await recentSnapshot(args.lastSec)
    seq += 1
    const file = savePng({ png: shot.pngFull ?? shot.png }, seq, outDir)
    const { ref, via, attachmentError } = await deliver(shot.png, `watch-along-${seq}.png`)
    // 记一笔"它真的看了"：唤醒那边靠这个时间戳决定"要不要催它看图"。
    try {
      onFrame?.({ seq, at: Date.now(), bytes: shot.png.length, via, ok: !attachmentError, file })
    } catch {
      /* 记账失败不能影响取帧 */
    }
    return {
      width: shot.width,
      height: shot.height,
      hd: !!args.hd,
      fullSize: shot.fullWidth ? `${shot.fullWidth}×${shot.fullHeight}` : null,
      t: shot.t,
      at: shot.at ?? null,
      cached: shot.cached === true,
      pngBytes: shot.png.length,
      file,
      ref,
      via,
      recent, // 同一时间窗内的字幕与听写，一次给全
      ...(attachmentError ? { attachmentError } : {}),
    }
  }

  async function recentSnapshot(lastSec = 10) {
    const sec = Number.isFinite(lastSec) && lastSec > 0 ? lastSec : 10
    try {
      const got = await service.events({ lastSec: sec, limit: 200 })
      const list = got?.events ?? []
      // 每条都带"什么时候"：只有文字没有时间，模型就分不清"刚说的"和"一分钟前说的"
      const at = (e) => ({
        t: typeof e.t === 'number' ? Math.round(e.t * 10) / 10 : null,
        clock: typeof e.at === 'number' ? new Date(e.at).toTimeString().slice(0, 8) : null,
        text: e.text,
      })
      const ocr = list.filter((e) => e.kind === 'ocr' && e.text).map(at)
      const speech = list.filter((e) => e.kind === 'speech' && e.text).map(at)
      const motion = list.filter((e) => e.kind === 'motion').length
      const sheet = [...list].reverse().find((e) => e.sheetId)?.sheetId ?? latestSheetId
      return { seconds: sec, sheetId: sheet, ocr, speech, motionCount: motion }
    } catch (e) {
      return { seconds: sec, error: String(e?.message ?? e) }
    }
  }

  /** 服务没起来时必须**说出来**：否则用户看到的是"AI 不听声音"，查半天才知道服务没开。 */
  async function serviceWarnings() {
    if (!serviceStatus) return []
    try {
      const st = await serviceStatus()
      const down = (st?.services ?? []).filter((x) => !x.up).map((x) => x.name)
      const out = []
      if (down.length) out.push(`服务未启用：${down.join('、')}（设置页「陪看」里可以一键启动）`)
      if (st && st.configured === false) out.push(`服务缺配置：${(st.missing ?? []).join('；')}`)
      return out
    } catch {
      return []
    }
  }

  /** 有宿主附件服务就交图（AI 才能真的"看"）；没有就只给路径。 */
  async function deliver(png, name) {
    const svc = attachments?.()
    if (!svc?.saveImage) return { ref: null, via: 'file' }
    try {
      const ref = await svc.saveImage.call(svc, { data: png, mediaType: 'image/png', name })
      return { ref, via: 'attachment' }
    } catch (e) {
      return { ref: null, via: 'file', attachmentError: String(e?.message ?? e) }
    }
  }

  const list = [
    {
      name: 'watch_windows',
      description:
        '列出当前可见的窗口标题。陪看前先用它挑一个窗口，把标题片段交给 watch_start。',
      parameters: {},
      async execute() {
        const titles = [...new Set((listWindows?.() ?? []).filter(Boolean))]
        return { count: titles.length, titles }
      },
    },
    {
      name: 'watch_start',
      description:
        '开始陪看某个窗口：按标题片段找到窗口并起采集。\n' +
        '**这一次调用就把第一张画面和最近 10 秒的字幕/听写一起给你了**，不要再接着调 watch_frame。',
      // 宿主 defineTool 要的是「属性表」（author spec），不是 JSON Schema：
      // 必填标在属性上，编译时会提升到父级 required 数组。写顶层 type:'object' 会被静默忽略。
      parameters: {
        window: { type: 'string', required: true, description: '窗口标题片段，例如「哔哩哔哩直播」' },
      },
      // 第二个参数是宿主的 ToolRunContext（`run.agent` 就是发起这次调用的 Agent）。
      // 票 11 的主动唤醒全靠它：**"目标会话 = 最后一次 watch_start 的那个会话"
      // 不是靠猜出来的，就是这里抓到的那一个**。
      async execute(args = {}, run) {
        onAgent?.(run?.agent ?? null)
        // settings.window 当默认值（面板锁定窗口后立刻生效：所以允许传函数，
        // 传字符串就得重启 DSH 才更新）。模型没给窗口时兜一下。
        const fallback = typeof defaultWindow === 'function' ? defaultWindow() : defaultWindow
        const want = args.window || fallback || ''
        // 没锁定又没指定：直接说清楚该去哪做什么，别让它自己猜一个窗口名。
        if (!want) {
          throw new Error(
            '还没锁定窗口：去设置面板「窗口识别测试」点「看看有哪些窗口」，选一个，再点「测试并锁定匹配窗口」',
          )
        }
        const started = await service.start({ window: want })
        const warnings = await serviceWarnings()
        // 「现在锁定的是谁」只提示一次（锁完后的第一次调用），否则每轮都念一遍很吵。
        const notice = !args.window && typeof lockNotice === 'function' ? lockNotice() : null
        // **开场一次给全**：图 + 最近 10 秒的字幕/听写。
        // 以前这里只返回"开始了"，模型还得追一次 watch_frame —— 用户看到的就是
        // 开场连着四个工具调用（status → windows → start → frame），十几秒才出第一句。
        let snap = {}
        try {
          snap = await takeSnapshot({ lastSec: 10 })
        } catch (e) {
          snap = { frameError: String(e?.message ?? e) }
        }
        return { ...started, ...(warnings.length ? { warnings } : {}), ...(notice ? { notice } : {}), ...snap }
      },
    },
    {
      name: 'watch_frame',
      description:
        '取**当前这一帧**画面（PNG 落盘），并**同时带回最近 N 秒的字幕与听写**——\n' +
        '一次调用就能拿到"此刻完整内容"：画面、OCR 字幕、ASR 听写，每条都带时刻。\n' +
        '只适合回答"现在画面是什么"。问"**刚才/刚刚**说了什么、发生了什么"要用 watch_events（它有带时间的历史），' +
        '单看一帧看不到过去。',
      parameters: {
        live: { type: 'boolean', description: 'true = 现在就抓一张（默认 true）' },
        sheetId: { type: 'string', description: '取事件里带的那张拼图；给了就不重新抓屏' },
        hd: { type: 'boolean', description: '要原尺寸（798×450）。默认给 640 宽的缩图，只是为了省时间；看不清小字/表情时再开' },
        lastSec: { type: 'number', description: '附带最近 N 秒的字幕/听写，默认 10（每次多带 1 秒就多几十个 token，按需调大）' },
      },
      async execute(args = {}) {
        return takeSnapshot(args)
      },
    },
    {
      name: 'watch_events',
      description:
        '读画面/字幕/声音的事件流，**带时间**，**取一次就返回**。\n' +
        '问"刚才/最近 N 秒"用 lastSec（例如 lastSec: 10）；续读用 sinceId。\n' +
        '不要连着调它来"盯着"：那会让每一轮都产出一条回复、token 成倍涨。' +
        '要持续陪看时，取一次、说完就结束这一轮 —— 新变化会推送给你。',
      parameters: {
        sinceId: { type: 'number', description: '上次收到的 nextId，首次不传' },
        wait: {
          type: 'number',
          description:
            '长轮询最多等几秒，**默认 0 = 立刻返回**。一般不要填：连续长轮询会让每一轮都产出一次回复，' +
            'token 会成倍涨。想看新变化就等系统的推送，或隔一会儿再取一次。',
        },
        lastSec: { type: 'number', description: '只要最近 N 秒的事件（回答"刚才说了什么"用它）' },
      },
      async execute(args = {}) {
        // 默认 0：长轮询会让模型「每有动静就回一句」地自转起来
        // （实测 3 分钟 70 多轮、每轮 32K token）
        const waitSec = Number.isFinite(args.wait) ? Math.max(0, args.wait) : 0
        const ev = await service.events({
          sinceId: Number.isFinite(args.sinceId) ? args.sinceId : null,
          waitMs: Math.round(waitSec * 1000),
          lastSec: Number.isFinite(args.lastSec) ? Math.max(0, args.lastSec) : 0,
        })
        // 顺手记下最新拼图编号：模型下一次要"看画面"时不必再翻一遍事件
        for (const e of ev?.events ?? []) if (e?.sheetId) latestSheetId = e.sheetId
        return { ...ev, latestSheetId: latestSheetId ?? null }
      },
    },
    {
      name: 'watch_status',
      description: '看当前状态：在盯哪个窗口、跑没跑、为什么失败。',
      parameters: {},
      async execute() {
        const st = await service.status()
        const warnings = await serviceWarnings()
        return warnings.length ? { ...st, warnings } : st
      },
    },
    {
      name: 'watch_stop',
      description: '停止陪看，释放采集。',
      parameters: {},
      async execute() {
        return service.stop()
      },
    },
  ]

  // 宿主的 defineTool 要求每个工具都带 output.render（缺了会被静默丢弃，
  // 表现是"注册成功但工具列表里没有"）。统一给一个 JSON 渲染。
  // render(args, value) 必须返回内容块数组 —— 宿主会对它调 content.some()。
  // 返回字符串会报 `content.some is not a function`（实测）。
  const OUT = {
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
    ],
  }
  return list.map((t) => ({ ...t, output: OUT }))
}
