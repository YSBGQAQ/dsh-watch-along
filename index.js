// DSH 插件入口。
//
// 只做三件事：装配真实适配器、把工具注册给宿主、在插件卸载时停掉采集。
// 所有判断都在 src/service.mjs 里，这里不写业务逻辑。
import { createWatchService } from './src/service.mjs'
import { createTools } from './src/tools.mjs'
import { listWindows, lookupWindow } from './src/windows.mjs'
import { startCapture } from './src/capture-koffi.mjs' // ADR 0005：koffi 直抓替代 ffmpeg
import { encode } from './src/png.mjs'
import { createPipeline } from './vendor/dsh-see-now-main/src/pipeline.js'
import { createSubtitleReader } from './src/ocr.mjs'
import { createSpeechReader } from './src/speech.mjs'
import { createMobileServer } from './src/http.mjs'
import { createWaker } from './src/wake.mjs'
import { deliverToAgent } from './src/agent-delivery.mjs'
import { createWatchLoop } from './src/watch-loop.mjs'
import { createSupervisor } from './src/service-supervisor.mjs'
import { loadSettings } from './src/settings.mjs'
import { collectEnv, appendStartupLog, defaultStartupLogFile } from './src/startup-log.mjs'
import { formatSummary } from './src/session-stats.mjs'
import { createRateLimit } from './src/rate-limit.mjs'
import crypto from 'node:crypto'
import { defineToolCompat } from './vendor/dsh-see-now-main/src/define-tool.js'
import http from 'node:http'
import os from 'node:os'

const OCR_PORT = 8765
const ASR_PORT = 8766

/** 问转写服务"刚才这几秒说了什么"。走文件没必要 —— 它只要秒数，不用图。 */
let asrFirst = true
let sessionStamp = null
function listen(seconds) {
  // 第一次请求顺带让服务清空缓冲：否则上一场陪看的尾巴会串到这一场来。
  // SESSION 在 watch_start 时就换好了（见 onWatchStart），这里不再现算。
  const body = JSON.stringify({ seconds, reset: asrFirst, session: SESSION })
  asrFirst = false
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: ASR_PORT, path: '/listen', method: 'POST', timeout: 30000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (!j.ok) return reject(new Error(j.error || '转写失败'))
            resolve({ lines: j.lines || [] })
          } catch (e) { reject(e) }
        })
      },
    )
    req.on('error', (e) => reject(new Error(`转写服务没响应（127.0.0.1:${ASR_PORT}）：${e.code || e.message}`)))
    req.on('timeout', () => req.destroy(new Error('转写超时')))
    req.end(body)
  })
}

/**
 * 把裁好的 PNG 交给常驻 OCR 服务。
 * 走文件而不是直接传二进制：服务端是 rapidocr，它要的是路径，省一次 base64。
 */
function recognize(png) {
  const file = path.join(os.tmpdir(), `watch-along-ocr-${Date.now()}.png`)
  fs.writeFileSync(file, png)
  const body = JSON.stringify({ path: file })
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: OCR_PORT,
        path: '/ocr',
        method: 'POST',
        timeout: 6000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (!j.ok) return reject(new Error(j.error || 'OCR 失败'))
            resolve((j.lines || []).map((l) => l.t))
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', (e) => reject(new Error(`OCR 服务没响应（127.0.0.1:${OCR_PORT}）：${e.code || e.message}`)))
    req.on('timeout', () => req.destroy(new Error('OCR 超时')))
    req.end(body)
  }).finally(() => {
    // 用完即删：这些都是屏幕截图，攒在 %TEMP% 里既占地方也留隐私痕迹
    try {
      fs.unlinkSync(file)
    } catch {
      /* 删不掉不影响主流程 */
    }
  })
}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 每轮一个会话 id：落盘按会话分文件，否则重启即清空、上一轮没法回头比
let SESSION = null
const runFile = (name) =>
  path.join(HERE, '.scratch', 'run', SESSION ? `${name}-${SESSION}.log` : `${name}.log`)

export const name = 'dsh-watch-along'
export const inject = ['tools']

export function apply(ctx, opts = {}) {
  const log = (m) => {
    try {
      (ctx.logger?.info ?? ctx.logger?.log ?? (() => {}))(`[watch-along] ${m}`)
    } catch {
      /* 日志失败不能影响插件加载 */
    }
  }

  /** 落一份文件日志：宿主日志不落地时，这是唯一能确认"加载过"的证据。 */
  const trace = (m) => {
    try {
      const f = path.join(HERE, '.scratch', 'run', 'plugin.log')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* 写不进就算了 */
    }
  }

  // 设置（票 07）：启动时读一次，改完要重启才生效 —— 这是票面承认的约定。
  const settingsFile = path.join(HERE, '.scratch', 'run', 'settings.json')
  const cur = loadSettings(settingsFile).value

  // 环境日志是**按会话**记的，不是按进程：同一个 DSH 进程里开两个会话，
  // 就应该是两条记录（它们的模型、上下文、设置可能不同）。
  // 触发点是"这个会话第一次调我们的工具"——那时才拿得到 agent。
  // 位置在 Documents 下（见 defaultStartupLogFile 的注释），不跟仓库走。
  const startupLogFile = defaultStartupLogFile()
  const sessionsLogged = new Set()

  function logSessionOnce(agent, toolName) {
    let sid = '?'
    try {
      sid = sessionOf(agent)
    } catch {
      /* 拿不到就按未知会话记，不要因此不记 */
    }
    if (sid !== '?' && sessionsLogged.has(sid)) return
    if (sid !== '?') sessionsLogged.add(sid)
    try {
      // 用服务实际在跑的那个 python，而不是 PATH 上的（两者装的包常常不一样）
      let pyExe = 'python'
      try {
        pyExe = JSON.parse(fs.readFileSync(path.join(HERE, '.scratch', 'run', 'services.json'), 'utf8')).python || 'python'
      } catch {
        /* 没配过就用 PATH 上的 */
      }
      const r = appendStartupLog(
        startupLogFile,
        collectEnv({
          settings: cur,
          python: pyExe,
          extra: { scope: 'session', sessionId: sid, firstTool: toolName, pid: process.pid },
        }),
      )
      log(`会话日志已写入（${sid.slice(0, 8)}… 首次调用 ${toolName}，历史共 ${r.kept} 条）`)
    } catch (e) {
      log(`会话日志写入失败：${e?.message ?? e}`)
    }
  }

  // 画质档 → 采集尺寸。三档都是 16:9，只改分辨率：
  // 尺寸越小越省 CPU，但字幕像素也越少 —— 改低画质要重新看 OCR 的准头。
  const QUALITY_SIZE = {
    low: { width: 480, height: 270 },
    medium: { width: 640, height: 360 },
    high: { width: 798, height: 450 },
  }
  const viewSize = QUALITY_SIZE[cur.quality] ?? QUALITY_SIZE.high

  // 采集帧率 0 = 关闭画面通道（只剩声音）。
  // 但底层不能真的传 0：采集循环按 `1000/fps` 算间隔，0 会变成死循环。
  // 所以实际仍以 1fps 维持采集，同时**不建 OCR、不产 motion 事件** —— 对外就是"画面关掉了"。
  const fpsSet = cur.fps ?? 8
  const videoOff = fpsSet === 0
  const captureFps = videoOff ? 1 : fpsSet

  // 字幕通道：两次一致才收录。onEvent 走 service.emit，和画面共用一条队列。
  let svcRef = null
  // 设置里关掉就不建这条通道（省 CPU，也免得用户以为关了还在跑）
  const subtitle = cur.subtitle === false || videoOff ? null : createSubtitleReader({
    encode,
    recognize,
    // 2026-11-22：时间节流已移除。它原本给已废弃的「两次一致」判定留时间间隔，
    // CPU 单拍约 1.2s 时恒不触发（埋点 t 一直为 0）；节奏由 busy 自然决定。
    onEvent: (e) => {
      if (e?.error) return log(`字幕通道：${e.error}`)
      svcRef?.emit('ocr', e)
      log(`字幕[${e.band}]：${e.text}`)
      // 发出的事件也要落盘，否则"准确率/召回率"永远只能靠抽样目测
      try {
        fs.appendFileSync(
          runFile('ocr-events'),
          `${new Date().toISOString()}\t${e.band}\t${e.text}\n`,
        )
      } catch {
        /* 写不进不影响主链路 */
      }
    },
    onDrop: (reason, text, band) => {
      // 单独落文件：宿主日志读不到，这是唯一能统计"为什么少了"的地方
      try {
        fs.appendFileSync(
          runFile('ocr-drops'),
          `${new Date().toISOString()} ${band}\t${reason}\t${String(text).slice(0, 40)}\n`,
        )
      } catch {
        /* 写不进不影响主链路 */
      }
    },
  })

  // 说话频率上限：转写照常跑，只是超出这一分钟配额的**不进队列**。
  // 不进队列才是"防刷屏"的真意 —— 转写本身停了会让字幕断档。
  // 0 = 关闭这条限制（不是"每分钟 0 条"）。所以这里直接不建限流器。
  const speechPerMin = cur.speechPerMin ?? 6
  const speechLimit = speechPerMin === 0 ? null : createRateLimit({ perMin: speechPerMin })
  const speech = cur.speech === false ? null : createSpeechReader({
    listen,
    windowSec: 3,
    onEvent: (e) => {
      if (e?.error) return log(`声音通道：${e.error}`)
      if (speechLimit && !speechLimit.allow()) {
        const n = speechLimit.takeDropped()
        if (n && n % 10 === 1) log(`声音：本分钟已到 ${speechPerMin} 条上限，累计略过 ${n} 条`)
        return
      }
      svcRef?.emit('speech', e)
      log(`声音：${e.text}`)
    },
  })

  // 启动时清一次历史残留（之前版本的实现把临时图留在了 %TEMP%）
  try {
    const tmp = os.tmpdir()
    const cutoff = Date.now() - 3600_000
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('watch-along-ocr-') || !name.endsWith('.png')) continue
      const f = path.join(tmp, name)
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f)
    }
  } catch {
    /* 清理失败不该阻止插件启动 */
  }

  // 调试产物不会自己过期：整段 PCM（raw-*.s16le）和测试录音（*.wav）都很大
  // （2026-11-23 台账：283MB 里 166MB 是它们）。超过 48 小时就删，留两天够复盘。
  try {
    const runDir = path.join(HERE, '.scratch', 'run')
    const cutoff = Date.now() - 48 * 3600_000
    for (const name of fs.readdirSync(runDir)) {
      if (!/^(raw-.+\.s16le|.+\.wav)$/i.test(name)) continue
      const f = path.join(runDir, name)
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f)
    }
  } catch {
    /* 同上：清理失败不影响启动 */
  }

  // ── 票 11：主动唤醒（默认关）──────────────────────────────────────────
  // 判定层在 src/wake.mjs（可全量单测），这里只负责"接到宿主的会话"。
  // 宿主能力拿不到就整条降级：只打一行日志，工具与三条通道照常。
  // 记录"开始加载"这件事本身：apply 中途抛错时，plugin.log 里如果连这一行都没有，
  // 就说明插件根本没被加载（而不是加载失败）—— 这两种情况以前分不清。
  trace('apply 开始')

  // 主动唤醒这类的"启动体检"必须落到文件：宿主 logger 在 DSH 里不一定看得到，
  // 而这几行是判断宿主能力有没有的唯一依据。走 log + trace 两处。
  const both = (m) => {
    log(m)
    trace(m)
  }

  // 开关两种写法：环境变量（长期）或一个标记文件（临时试验用）。
  // 为什么加文件：给 DSH 设环境变量要改系统设置并重登，试验一次不值当。
  const wakeFlagFile = path.join(HERE, '.scratch', 'run', 'wake-on')
  let wakeByFile = false
  try {
    wakeByFile = fs.existsSync(wakeFlagFile)
  } catch {
    /* 读不到就当没开 */
  }
  const wakeEnabled = String(process.env.WATCH_ALONG_WAKE ?? '') === '1' || wakeByFile
  const sessionCtl = (() => {
    try {
      return ctx.get?.('sessionController') ?? null
    } catch {
      return null
    }
  })()
  const has = (n) => {
    try {
      return !!ctx.get?.(n)
    } catch {
      return false
    }
  }
  // 访问 ctx 上不存在的属性**可能抛**（宿主给的 ctx 若是"未知键即报错"的 Proxy）。
  // 2026-11-22 踩过：这里没包 try/catch，直接让 apply 中途抛出 → 插件整体加载失败，
  // 而 plugin.log 里连一行都没有，看起来像"没重启"。所以每个访问都必须自己兜住。
  const safe = (fn, fallback) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  // attachments 是已知能拿到的（出图就是靠它），拿它当对照：
  // 如果它也是 false，说明 get() 这条通路本身在插件 ctx 上不可用，不是某个服务缺席。
  const probe = {
    attachments: has('attachments'),
    sessionController: has('sessionController'),
    propSessionController: safe(() => !!ctx.sessionController, 'throw'),
    session: has('session'),
    agents: has('agents'),
    remote: has('remote'),
    remoteSession: safe(() => !!(ctx.remote && ctx.remote.session), 'throw'),
  }
  const ctxKeys = safe(
    () => Object.keys(ctx).filter((k) => !k.startsWith('_')),
    ['(取不到)'],
  )
  both(
    `主动唤醒：${wakeEnabled ? '开' : '关'}（WATCH_ALONG_WAKE=1 打开）；sessionController=${sessionCtl ? '有' : '无'}`,
  )
  both(`宿主能力探测：${safe(() => JSON.stringify(probe), '(序列化失败)')}`)
  both(`插件 ctx 的自有键：${ctxKeys.slice(0, 60).join(',')}`)

  // "最后一次 watch_start 的那个会话" —— 直接是这次的 agent 句柄，不用反查。
  let lastAgent = null
  let lastAgentSession = '?'
  const sessionOf = (a) => safe(() => a?.session?.header?.id ?? a?.session?.id ?? '?', '?')

  let waker = null
  let watchLoop = null
  let eventSeq = 0
  let lastWokeSeq = 0
  let lastSheet = null // 最近一张拼图的编号，唤醒时交给模型看图
  let lastComposite = null // 最近一张"每 3 秒按时间拼出来的"多帧图
  let composeTimer = null
  let snapshotTimer = null // 每 5 分钟打一行快照：防"最后没调 watch_stop，数据全丢"
  let lastFrameAt = 0 // 最近一次 watch_frame 的时刻（强制看图的门闩看它）
  // 拼图成败只在这里能数到（service 不知道是插件在定时拼图），汇总时一并报出去。
  let composeOk = 0
  let composeFail = 0
  let observeTimer = null // 静默观察轮的定时器（observeSec > 0 才有）
  let observeSentAt = 0 // 上一条观察发出的时刻
  let observePending = false // 发出去还没等到"它动了"
  let lastTurnMs = 0 // 上一轮从发出到它调用工具花了多久（用来算下一轮最早什么时候能发）

  let lastSpeakAt = 0 // 上一次"允许说话"的投递时刻（兜底闸）

  /** 模型调了工具 = 它接住了上一条（观察轮也算）。 */
  function noteToolCall() {
    // 记下这一轮实际跑了多久：观察轮的节流线要**跟着它走**。
    // 固定 2 秒是错的 —— 一轮要 5–8 秒时，2 秒一条只会排队（实测三分钟积了 42 条）。
    if (observePending) {
      lastTurnMs = Date.now() - observeSentAt
      observePending = false
    }
    watchLoop?.noteActivity()
  }
  if (wakeEnabled) {
    /** 宿主的附件服务。取不到就返回 null —— 出图、附图都靠它，但拿不到也不能崩。 */
    const attachmentsOf = () => {
      try {
        return ctx.get?.('attachments') ?? null
      } catch {
        return null
      }
    }
    // 2026-11-23 07:12 第一次开：只给了 attachmentId，宿主校验不过 → 50 次调用 1 次成功。
    // 07:15 找到根因：宿主自己的图块是六项描述符（mediaType/width/height/bytes/name 都要）。
    // 补齐后重开；一旦日志里再出现 `图被拒` 或 finish=error 连片，立刻关掉。
    const ATTACH_IMAGE_IN_MESSAGE = true
    // 传图三档（设置可调，默认低清）：none 不传 / low 640 宽 / high 798 原尺寸
    const imgQ = cur.imageQuality ?? 'low'
    const uploadW = imgQ === 'high' ? 0 : 640
    const canAttach = ATTACH_IMAGE_IN_MESSAGE && imgQ !== 'none' && !!attachmentsOf()?.saveImage
    // 不传图时也别再逼它调工具看图 —— 那条路最后还是要传图。
    const forceLook = imgQ !== 'none'
    waker = createWaker({
      enabled: true,
      log: both,
      // 节奏交给下面的 watchLoop 管（tick 每 2 秒一次），waker 只负责"说什么"。
      // 两边都设间隔会互相打架：0 表示不在这里节流。
      promptTemplate: cur.commentPrompt,
      sheetId: () => lastComposite ?? lastSheet,
      composeSec: 3,
      // 强制看图：图能随消息附上时（正常情况）就不必再走工具，门闩直接放行；
      // 附件服务不可用才退回"上一轮有没有调 watch_frame"这套。
      frameGate: canAttach ? () => true : (sinceWakeAt) => lastFrameAt > (sinceWakeAt ?? 0),
      forceLook,
      attachImages: canAttach,
      gapSec: cur.wakeGapSec ?? 30,
      // send 失败只是这一拍没叫，不能影响陪看；waker 内部会捕获并记日志。
      // 投递走 agent.followup + sessions.flush（见 agent-delivery.mjs）。
      send: async (text) => {
        if (!lastAgent) throw new Error('还没绑定会话：先调用一次 watch_start')
        // 收工之后还会有一两拍尾巴（队列里排着的事件）：这时连屏幕都不采了，
        // 附图必然失败，白白发一条"还没开始采集"的日志 + 一次模型调用。
        // 直接不发 —— 2026-11-23 07:19 实测出现过一次。
        try {
          if (service.status().state !== 'running') return
        } catch {
          /* 状态读不到就照常发 */
        }
        // 把当前帧**直接附在这条消息里**：模型不用再花一次往返去调 watch_frame。
        // 实测（2026-11-23）：调工具那条路每轮 2 个 step、约 4 秒；附在消息里只要 1 个 step。
        let images = null
        try {
          if (!canAttach) throw new Error('宿主没有 attachments 服务')
          const shot = await service.frame({ live: true, maxWidth: uploadW })
          const svc = attachmentsOf()
          if (svc?.saveImage) {
            const name = `wake-${Date.now()}.png`
            const ref = await svc.saveImage.call(svc, { data: shot.png, mediaType: 'image/png', name })
            // 描述符六项必须齐（attachmentId/mediaType/width/height/bytes/name），
            // 少一项宿主就会把整个请求打成 TRANSPORT —— 2026-11-23 07:12 就是这么挂的。
            const att = ref && typeof ref === 'object' ? { ...ref } : { attachmentId: String(ref ?? '') }
            if (!att.attachmentId) throw new Error('saveImage 没给 attachmentId')
            att.mediaType ||= 'image/png'
            att.width ??= shot.width
            att.height ??= shot.height
            att.bytes ??= shot.png.length
            att.name ||= name
            images = [att]
          }
        } catch (e) {
          both(`唤醒附图失败，本条走纯文本：${e?.message ?? e}`)
        }
        const r = deliverToAgent(lastAgent, text, { sessions: sessionsOf(ctx), images })
        if (!r.ok) throw new Error(`投递失败：${r.reason}`)
        // 图已经随消息送到，门闩不必再催它调工具。
        if (images && !r.imageFallback) lastFrameAt = Date.now()
        both(
          `唤醒投递 ${r.via}（flush=${r.flushed === null ? '没有 sessions 服务' : r.flushed}）` +
            `${images ? '＋图' : ''}${r.imageFallback ? '（图被拒，已退回文本）' : ''}`,
        )
      },
      // 读会话历史要 sessionController，而宿主没把它给插件（实测取不到）。
      // 传 null = waker 走保守分支：不计数，只保留主动唤醒、不自动停。
      hasUserMessageSince: null,
    })

    // sessions 服务要**发送时再取**：watch-together 的注释写得很明白 ——
  // "webServer 可能晚于插件就绪；动态 inject 比 apply 时硬探测更可靠"。
  // 在 apply 里缓存一次，就等于把"服务晚到"判成"没有这个服务"。
  const sessionsOf = (c) => safe(() => c.get?.('sessions') ?? null, null)

  // 陪看循环：本地每 2 秒算一次，30 秒最多叫一次；没人接就不再叫（等下一次工具调用）。
    // 三项节奏从设置读（对齐 see-now 的节奏 / maxAutonomousWakes / idleStopMin）。
    // idleStopMin = 0 表示"不因空闲收工"，这里换算成 Infinity 交给循环。
    const idleMin = cur.idleStopMin ?? 3
    watchLoop = createWatchLoop({
      log: both,
      gapMs: (cur.wakeGapSec ?? 30) * 1000,
      idleMs: idleMin === 0 ? Number.POSITIVE_INFINITY : idleMin * 60_000,
      everyMs: 2_000,
      hasNews: () => eventSeq > lastWokeSeq,
      wake: async () => {
        // strength 给 high 是因为这一层不再按强度筛（"一直陪"要求有新画面就说）。
        const r = await waker.maybeWake({ kind: 'tick', strength: 'high' })
        if (r.woke) {
          lastWokeSeq = eventSeq
          lastSpeakAt = Date.now()
          both(`主动唤醒已投递 → ${lastAgentSession}`)
        } else if (r?.reason && r.reason !== 'disabled' && r.reason !== 'not-worth-it') {
          both(`主动唤醒没发：${r.reason}`)
        }
        return r
      },
      onStop: (why) => both(`陪看循环已停：${why}`),
    })
    both('主动唤醒已开启；循环等 watch_start 再起（不再因空闲收工，只有 watch_stop 才停）')
  }

  const service = createWatchService({
    listWindows,
    lookupWindow,
    startCapture,
    encode,
    subtitle,
    speech,
    // 采集尺寸与帧率都来自设置（画质档 / 预设）。两处必须同一个值，
    // 否则 service 按 798×450 记账、pipeline 按另一个尺寸切网格，坐标会整体偏掉。
    size: viewSize,
    fps: captureFps,
    // 判据、档位、拼图全部来自参考库；打开 changeLog 才有"每张图一条变化摘要"可读。
    createPipeline: () =>
      createPipeline({ ...viewSize, fps: captureFps, changeLog: true, changeLogMax: 500 }),
    onCaptureStderr: (s) => log(`ffmpeg: ${String(s).trim().slice(0, 300)}`),
    onEvent: (kind, payload) => {
      if (!waker) return
      if (videoOff && kind === 'motion') return // 画面通道关闭：motion 一律不投
      if (payload?.sheetId) lastSheet = payload.sheetId
      eventSeq += 1
      waker.feed({ kind, ...payload })
      // **这里不再直接叫醒**。
      // 原来每个事件都调一次 maybeWake，而采集是 8fps、motion 又密集 ——
      // 相当于每秒叫好几次，和 watch-loop 的 30 秒间隔完全无关。
      // 这就是"排队消息一直涨"的真因（用户实测 6 条积压、每秒一条）。
      // 现在只喂事件，什么时候说话由 watch-loop 决定。
    },
    onWatchStop: (summary) => {
      if (composeTimer) {
        clearInterval(composeTimer)
        composeTimer = null
      }
      if (snapshotTimer) {
        clearInterval(snapshotTimer)
        snapshotTimer = null
      }
      if (observeTimer) {
        clearInterval(observeTimer)
        observeTimer = null
      }
      // 一场陪看结束时打一行总账：多久、多少条事件（分三类）、id 有没有缺、内存涨没涨、拼图成没成。
      // 这五项以前都不落盘，只能用 python 的旁证日志推 —— 票 09 的三个数就是这么丢的。
      // 一场没采到帧就别打汇总：那多半是"刚开就停"，打出来全是 0，会把真正那组数字盖掉
      // （2026-11-23 06:51 实测：第二次空的汇总紧跟在有效汇总后面，只有 19 秒之差）。
      if (summary && summary.frames === 0 && summary.events === 0) {
        both('[会话汇总] 这一场没有采到帧（刚开就停？），不记数')
      } else {
        const composeText = `拼图 ${composeOk + composeFail} 张（成功 ${composeOk} / 失败 ${composeFail}）`
        both(formatSummary(summary, composeText))
      }
      composeOk = 0
      composeFail = 0
    },
    onWatchStart: () => {
      waker?.reset()
      composeOk = 0
      composeFail = 0
      // 每一场陪看换一个会话号，并让 ASR 下一拍 reset：清缓冲、时间原点归零、独立文件。
      // 以前 asrFirst 只在**进程生命周期**里重置一次，第二场开始 ASR 的时钟接着上一场跑
      // （2026-11-23 实测：31 分钟那轮整体偏了 88 秒，而且 31 分钟里又漂了 14%）。
      SESSION = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      asrFirst = true
      // 懒取 sessionController：apply 时探是拿不到的（服务注册得比插件晚），
      // 所以改到真正要用的时候再取。有它才能自动开新会话（create / resolveAgent）。
      const sc = safe(() => ctx.get?.('sessionController'), null)
      both(
        sc
          ? `sessionController 懒取成功：${Object.keys(sc).filter((k) => typeof sc[k] === 'function').slice(0, 8).join(',') || '（无方法）'}`
          : 'sessionController 懒取仍为空',
      )
      lastWokeSeq = eventSeq
      // 说话间隔填 0 = 不说话：只采集，不主动开口（票 07 的备注项）
      if ((cur.wakeGapSec ?? 30) === 0) {
        watchLoop?.stop('speak-off')
        both('主动说话已关闭（说话间隔 = 0）：只采集，不主动开口')
        return
      }
      // 每 3 秒按时间拼一张多帧图：pipeline 出的图按"变化"产，时间轴上会缺段；
      // 这张是等距取帧，模型才看得到"这 3 秒大致长什么样"。
      if (composeTimer) clearInterval(composeTimer)
      composeTimer = setInterval(() => {
        try {
          const c = service.composeSheet({ seconds: 3, cells: 6, width: viewSize.width, height: viewSize.height })
          if (c?.sheetId) {
            lastComposite = c.sheetId
            composeOk += 1
          }
        } catch (e) {
          composeFail += 1
          both(`拼图失败：${e?.message ?? e}`)
        }
      }, 3000)
      try {
        composeTimer.unref?.()
      } catch {
        /* 非 Node 定时器 */
      }

      // 静默观察：每隔 observeSec 秒叫醒它"只看不说"，让它保持对剧情的跟进。
      // 注意：这一轮它仍然是一轮模型调用（花钱），只是**不产生聊天气泡**。
      if (observeTimer) clearInterval(observeTimer)
      const obs = cur.observeSec ?? 0
      if (obs > 0) {
        observeTimer = setInterval(() => {
          const since = observeSentAt ? Date.now() - observeSentAt : Infinity
          // 最早什么时候能发下一条：设置值 与 上一轮实测耗时×1.3 取大，且不低于 6 秒。
          // DSH 的消息是排队的，发得比模型跑得快，队列就会一直涨（实测 42 条）。
          // **地板不低于 5 秒**：1 秒一条的实测结果是队列一直涨（用户看到 6 条积压）。
          // 模型一轮要几秒，发得比它跑得快，只会越积越多 —— 这不是配置问题，是物理限制。
          const floor = Math.max(obs * 1000, Math.round(lastTurnMs * 1.2), 5000)
          if (since < floor) return
          // 真实的背压：它还在跑上一轮，就别再往里塞。
          // 以前靠"模型调没调工具"判断（noteToolCall），但图随消息走之后它常常一轮
          // 一个工具都不调 —— 那个信号永远不来，节流退化成固定 5 秒，队列就一路涨
          // （2026-11-23 实测：10 分钟积 6 条）。
          const st = (() => {
            try {
              return String(lastAgent?.status ?? '')
            } catch {
              return ''
            }
          })()
          if (st && st !== 'idle' && st !== 'ready') {
            // 顺手把"这一轮到底跑了多久"记下来：下次的 floor 会跟着涨。
            lastTurnMs = Math.max(since, 5000)
            return
          }
          if (observePending && since > 120_000) {
            both('静默观察：上一轮 120 秒无动静，视为已结束')
            observePending = false
          }
          observePending = true
          observeSentAt = Date.now()
          waker?.observe?.().catch?.((e) => {
            observePending = false
            both(`静默观察出错：${e?.message ?? e}`)
          })
        }, Math.max(1000, Math.round(obs * 500)))
        try {
          observeTimer.unref?.()
        } catch {
          /* 非 Node 定时器 */
        }
        both(`静默观察已开启：每 ${obs} 秒一次（只更新理解，不输出文字）`)
      }

      // 每 5 分钟打一行快照。为什么要有：汇总只在 stop() 里打，而用户收尾时习惯说
      // "停止后台任务"——DSH 未必会调 watch_stop。那一轮就没有 RSS 曲线和事件数了。
      // 快照是只读的：不清计数、不停采集。
      if (snapshotTimer) clearInterval(snapshotTimer)
      snapshotTimer = setInterval(() => {
        const s = service.snapshot()
        const composeText = `拼图 ${composeOk + composeFail} 张（成功 ${composeOk} / 失败 ${composeFail}）`
        both(formatSummary(s, composeText, '会话快照 5min'))
      }, 5 * 60_000)
      try {
        snapshotTimer.unref?.()
      } catch {
        /* 非 Node 定时器 */
      }

      // 每一次 watch_start 都让循环重新起跑（含"上次已收工"的情况）
      watchLoop?.restart()
    },
  })

  // 服务管家：设置面板靠它显示"服务未启用"、以及一键启动。
  // 只绑 127.0.0.1，外部访问不到；面板在渲染进程里，只能走本机回环。
  // 注销清单要**在第一次 push 之前**声明：插在服务管家之后会让 apply 直接抛
  // ReferenceError（2026-11-22 实踩：插件在 DSH 里显示"异常"，而 plugin.log 只到
  // "循环等 watch_start 再起"就断了）。
  const disposers = []

  const supervisor = createSupervisor({
    log: both,
    rootDir: HERE,
    settingsFile,
    // 采集中断时面板要能看见原因并提示重启服务（不做自动恢复）
    watchStatus: () => service.status(),
  })
  // 测试/预检模式不占端口（监听中的 server 会让进程不退出，把测试挂死）
  const skipPanel = opts.panel === false || process.env.WATCH_ALONG_NO_PANEL === '1'
  const panelServer = skipPanel ? null : supervisor.serve()
  disposers.push(() => {
    try {
      panelServer?.close?.()
    } catch {
      /* 已经关了 */
    }
  })
  // apply 不是 async：用 then 链，别在这里 await（会卡住宿主启动）
  supervisor
    .status()
    .then((st) => {
      const down = st.services.filter((x) => !x.up).map((x) => x.name)
      both(
        down.length
          ? `服务未启用：${down.join('、')} —— 设置页可以一键启动`
          : `两个服务都在：${st.services.map((x) => x.name).join('、')}`,
      )
      if (!st.configured) both(`服务管家缺配置：${st.missing.join('；')}`)
    })
    .catch(() => {})

  const tools = createTools({
    service,
    listWindows,
    serviceStatus: () => supervisor.status(),
    defaultWindow: cur.window || '',
    uploadWidth: cur.imageQuality === 'high' ? 0 : 640,
    // 帧图**必须落在插件目录下**。默认值用的是进程 cwd，而 DSH 启动插件时 cwd 不是仓库根，
    // 结果 2026-11-23 那轮 66 次取帧的 PNG 全写到了别处（日志有"取帧"、仓库里一张没有）。
    outDir: path.join(HERE, '.scratch', 'run', 'frames'),
    // 取帧记账：waker 靠这个时间判断"上一轮到底看没看画面"。日志留痕，方便事后核对。
    onFrame: (info) => {
      lastFrameAt = info?.at ?? Date.now()
      both(
        `取帧 #${info?.seq ?? '?'}：${Math.round((info?.bytes ?? 0) / 1024)}KB，${info?.ok ? '已附图' : '附图失败'}` +
          (info?.file ? ` → ${info.file}` : ''),
      )
    },
    // 票 11：记住"谁开的陪看"。agent 句柄来自 watch_start 的 run context，
    // 不是靠 sessionController 反查 —— 宿主没把那个服务给插件（实测取不到）。
    onAgent: (agent) => {
      if (!agent) return
      lastAgent = agent
      lastAgentSession = sessionOf(agent)
      both(`主动唤醒已绑定会话：${lastAgentSession}`)
    },
    attachments: () => {
      try {
        return ctx.get?.('attachments') ?? null
      } catch {
        return null
      }
    },
  })

  // 关插件时停掉陪看循环，否则定时器会一直跑（Node 的 unref 只保证不阻退出）
  if (watchLoop) disposers.push(() => watchLoop.stop('dispose'))
  svcRef = service
  for (const tool of tools) {
    // 单个工具注册失败不该拖垮其余：宿主可能对 schema 有额外要求。
    // 失败要写进文件日志 —— 光靠宿主 logger 看不到（实测两次"工具不见了"都无迹可查）。
    try {
      // 必须过 defineTool：它把属性表编译成宿主认的 JSON Schema 并校验 output。
      // 直接 register 裸对象会被接受但不生效（实测：日志说注册了 6 个，会话里一个都没有）。
      // 包一层：**任何一次工具调用都算"接住了上一条叫醒"**，陪看循环据此决定能不能叫下一条
      // （see-now 的 noteActivity，见票 11）。
      const wired = {
        ...tool,
        async execute(args, run) {
          try {
            noteToolCall()
            // 这个会话第一次用我们的工具 → 记一条环境快照
            logSessionOnce(run?.agent, tool.name)
          } catch {
            /* 记账失败不影响工具本身 */
          }
          return tool.execute(args, run)
        },
      }
      disposers.push(ctx.tools.register(defineToolCompat(wired)))
      log(`已注册工具 ${tool.name}`)
      trace(`注册成功 ${tool.name}`)
    } catch (e) {
      const msg = String(e?.message ?? e)
      log(`注册失败 ${tool.name}: ${msg}`)
      trace(`注册失败 ${tool.name}: ${msg}`)
    }
  }

  trace(`apply 完成：注册 ${tools.length} 个工具（${tools.map((t) => t.name).join(',')}）`)

  // 手机端（只读）。启动失败不能影响工具注册 —— 端口被占是常事。
  let mobile = null
  // 预检脚本传 {mobile:false}：否则监听中的 server 会让进程不退出，把 check 挂死。
  if (opts.mobile === false) {
    log('手机端：本次跳过（预检模式）')
  } else try {
    const token = process.env.WATCH_ALONG_TOKEN || crypto.randomBytes(9).toString('base64url')
    mobile = createMobileServer({
      service,
      token,
      port: Number(process.env.WATCH_ALONG_PORT || 8770),
      host: process.env.WATCH_ALONG_HOST || '0.0.0.0', // 默认局域网可连；设置界面可改回 127.0.0.1
    })
    mobile
      .listen()
      .then((i) => log(`手机端就绪：${i.url}/api/events?token=${i.token}`))
      .catch((e) => log(`手机端没起来（不影响陪看）：${e?.message ?? e}`))
  } catch (e) {
    log(`手机端初始化失败（不影响陪看）：${e?.message ?? e}`)
  }

  ctx.on?.('dispose', () => {
    void mobile?.close?.()
    for (const d of disposers.reverse()) {
      try {
        d?.()
      } catch {
        /* 收不干净也不能再炸 */
      }
    }
    void service.stop()
  })

  log(`就绪：${tools.length} 个工具`)
}
