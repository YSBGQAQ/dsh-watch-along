// DSH 插件入口。
//
// 只做三件事：装配真实适配器、把工具注册给宿主、在插件卸载时停掉采集。
// 所有判断都在 src/service.mjs 里，这里不写业务逻辑。
import { createWatchService } from './src/service.mjs'
import { createTools } from './src/tools.mjs'
import { listWindows, lookupWindow } from './src/windows.mjs'
import { startCapture } from './src/capture.mjs'
import { encode } from './src/png.mjs'
import { createPipeline } from './vendor/dsh-see-now-main/src/pipeline.js'
import { createSubtitleReader } from './src/ocr.mjs'
import { createSpeechReader } from './src/speech.mjs'
import { defineToolCompat } from './vendor/dsh-see-now-main/src/define-tool.js'
import http from 'node:http'
import os from 'node:os'

const OCR_PORT = 8765
const ASR_PORT = 8766

/** 问转写服务"刚才这几秒说了什么"。走文件没必要 —— 它只要秒数，不用图。 */
function listen(seconds) {
  const body = JSON.stringify({ seconds })
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
  })
}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-watch-along'
export const inject = ['tools']

export function apply(ctx) {
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
    onEvent: (e) => {
      if (e?.error) return log(`字幕通道：${e.error}`)
      svcRef?.emit('ocr', e)
      log(`字幕：${e.text}`)
    },
  })

  const speech = createSpeechReader({
    listen,
    windowSec: 6,
    onEvent: (e) => {
      if (e?.error) return log(`声音通道：${e.error}`)
      svcRef?.emit('speech', e)
      log(`声音：${e.text}`)
    },
  })

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

  ctx.on?.('dispose', () => {
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
