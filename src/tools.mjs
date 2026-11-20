// 工具层：AI 唯一能碰到的四个入口。
// 薄适配器 —— 只做参数转写与结果整形，判断全在 service 里。
import fs from 'node:fs'
import path from 'node:path'

const RUN_DIR = path.resolve('.scratch', 'run', 'frames')

function savePng(shot, seq, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `frame_${String(seq).padStart(4, '0')}.png`)
  fs.writeFileSync(file, shot.png)
  return file
}

export function createTools({ service, listWindows, attachments = null, outDir = RUN_DIR }) {
  let seq = 0

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

  return [
    {
      name: 'watch_windows',
      description:
        '列出当前可见的窗口标题。陪看前先用它挑一个窗口，把标题片段交给 watch_start。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const titles = [...new Set((listWindows?.() ?? []).filter(Boolean))]
        return { count: titles.length, titles }
      },
    },
    {
      name: 'watch_start',
      description:
        '开始陪看某个窗口：按标题片段找到窗口并起采集。找不到时会把可见窗口列出来。',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', description: '窗口标题片段，例如「哔哩哔哩直播」' },
        },
        required: ['window'],
      },
      async execute(args = {}) {
        return service.start({ window: args.window })
      },
    },
    {
      name: 'watch_frame',
      description:
        '取一张当前画面（PNG 落盘并返回路径与尺寸）。想看细节时用；返回的是文件，不是像素。',
      parameters: {
        type: 'object',
        properties: {
          live: { type: 'boolean', description: 'true = 现在就抓一张（默认 true）' },
        },
      },
      async execute(args = {}) {
        const shot = await service.frame({ live: args.live !== false })
        seq += 1
        const file = savePng(shot, seq, outDir)
        const { ref, via, attachmentError } = await deliver(shot.png, `watch-along-${seq}.png`)
        return {
          width: shot.width,
          height: shot.height,
          t: shot.t,
          at: shot.at,
          pngBytes: shot.png.length,
          file,
          ref,
          via,
          ...(attachmentError ? { attachmentError } : {}),
        }
      },
    },
    {
      name: 'watch_status',
      description: '看当前状态：在盯哪个窗口、跑没跑、为什么失败。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return service.status()
      },
    },
    {
      name: 'watch_stop',
      description: '停止陪看，释放采集。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return service.stop()
      },
    },
  ]
}
