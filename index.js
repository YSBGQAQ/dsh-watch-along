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
  // 第一次请求顺带让服务清空缓冲并把本轮写到独立文件（session 由 watch_start 生成）
  if (asrFirst) SESSION = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
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

  // 字幕通道：两次一致才收录。onEvent 走 service.emit，和画面共用一条队列。
  let svcRef = null
  const subtitle = createSubtitleReader({
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

  const speech = createSpeechReader({
    listen,
    windowSec: 3,
    onEvent: (e) => {
      if (e?.error) return log(`声音通道：${e.error}`)
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

  const service = createWatchService({
    listWindows,
    lookupWindow,
    startCapture,
    encode,
    subtitle,
    speech,
    // 判据、档位、拼图全部来自参考库；打开 changeLog 才有"每张图一条变化摘要"可读。
    createPipeline: () =>
      createPipeline({ width: 798, height: 450, fps: 8, changeLog: true, changeLogMax: 500 }),
    onCaptureStderr: (s) => log(`ffmpeg: ${String(s).trim().slice(0, 300)}`),
  })

  const tools = createTools({
    service,
    listWindows,
    attachments: () => {
      try {
        return ctx.get?.('attachments') ?? null
      } catch {
        return null
      }
    },
  })

  const disposers = []
  svcRef = service
  for (const tool of tools) {
    // 单个工具注册失败不该拖垮其余：宿主可能对 schema 有额外要求。
    // 失败要写进文件日志 —— 光靠宿主 logger 看不到（实测两次"工具不见了"都无迹可查）。
    try {
      // 必须过 defineTool：它把属性表编译成宿主认的 JSON Schema 并校验 output。
      // 直接 register 裸对象会被接受但不生效（实测：日志说注册了 6 个，会话里一个都没有）。
      disposers.push(ctx.tools.register(defineToolCompat(tool)))
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
