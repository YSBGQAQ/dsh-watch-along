// DSH 插件入口。
//
// 只做三件事：装配真实适配器、把工具注册给宿主、在插件卸载时停掉采集。
// 所有判断都在 src/service.mjs 里，这里不写业务逻辑。
import { createWatchService } from './src/service.mjs'
import { createTools } from './src/tools.mjs'
import { listWindows, lookupWindow } from './src/windows.mjs'
import { startCapture } from './src/capture.mjs'
import { encode } from './src/png.mjs'
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

  const service = createWatchService({
    listWindows,
    lookupWindow,
    startCapture,
    encode,
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
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
    log(`已注册工具 ${tool.name}`)
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
