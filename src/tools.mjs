// 工具层：AI 唯一能碰到的四个入口。
// 薄适配器 —— 只做参数转写与结果整形，判断全在 service 里。
import fs from 'node:fs'
import path from 'node:path'

const RUN_DIR = path.resolve('.scratch', 'run', 'frames')

function savePng(shot, seq) {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  const file = path.join(RUN_DIR, `frame_${String(seq).padStart(4, '0')}.png`)
  fs.writeFileSync(file, shot.png)
  return file
}

export function createTools({ service, listWindows }) {
  let seq = 0

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
        const file = savePng(shot, seq)
        return {
          width: shot.width,
          height: shot.height,
          t: shot.t,
          at: shot.at,
          pngBytes: shot.png.length,
          file,
        }
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
