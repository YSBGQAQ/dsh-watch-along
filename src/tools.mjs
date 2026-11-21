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
        '开始陪看某个窗口：按标题片段找到窗口并起采集。找不到时会把可见窗口列出来。',
      // 宿主 defineTool 要的是「属性表」（author spec），不是 JSON Schema：
      // 必填标在属性上，编译时会提升到父级 required 数组。写顶层 type:'object' 会被静默忽略。
      parameters: {
        window: { type: 'string', required: true, description: '窗口标题片段，例如「哔哩哔哩直播」' },
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
        live: { type: 'boolean', description: 'true = 现在就抓一张（默认 true）' },
        sheetId: { type: 'string', description: '取事件里带的那张拼图；给了就不重新抓屏' },
      },
      async execute(args = {}) {
        const shot = await service.frame({ live: args.live !== false, sheetId: args.sheetId ?? null })
        seq += 1
        const file = savePng(shot, seq, outDir)
        const { ref, via, attachmentError } = await deliver(shot.png, `watch-along-${seq}.png`)
        return {
          width: shot.width,
          height: shot.height,
          t: shot.t,
          at: shot.at ?? null,
          cached: shot.cached === true,
          pngBytes: shot.png.length,
          file,
          ref,
          via,
          ...(attachmentError ? { attachmentError } : {}),
        }
      },
    },
    {
      name: 'watch_events',
      description:
        '读画面/字幕/声音的事件流。传上次拿到的 nextId 作 sinceId 续读；wait 秒数内没新事件会返回 timedOut。',
      parameters: {
        sinceId: { type: 'number', description: '上次收到的 nextId，首次不传' },
        wait: { type: 'number', description: '长轮询最多等几秒，默认 20' },
      },
      async execute(args = {}) {
        const waitSec = Number.isFinite(args.wait) ? Math.max(0, args.wait) : 20
        return service.events({
          sinceId: Number.isFinite(args.sinceId) ? args.sinceId : null,
          waitMs: Math.round(waitSec * 1000),
        })
      },
    },
    {
      name: 'watch_status',
      description: '看当前状态：在盯哪个窗口、跑没跑、为什么失败。',
      parameters: {},
      async execute() {
        return service.status()
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
