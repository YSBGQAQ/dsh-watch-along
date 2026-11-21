// OCR 循环（不经过 DSH）：复用插件自己的取窗口与采集代码，所以 DPI 缩放、
// 窗口矩形、多分辨率都由同一处处理 —— 测试和真实环境走同一条路。
//
// 用法：node scripts/ocr-loop.mjs <窗口标题片段> [间隔秒] [分钟]
// 前提：OCR 服务在 8765（python/ocr_service.py --port 8765）
import fs from 'node:fs'
import path from 'node:path'
import { lookupWindow } from '../src/windows.mjs'
import { startCapture } from '../src/capture.mjs'
import { encode } from '../src/png.mjs'

const frag = process.argv[2]
if (!frag) {
  console.error('用法: node scripts/ocr-loop.mjs <窗口标题片段> [间隔秒=5] [分钟=10]')
  process.exit(1)
}
const gapMs = Number(process.argv[3] ?? 5) * 1000
const minutes = Number(process.argv[4] ?? 10)

const w = lookupWindow(frag)
// lookupWindow 已经处理过 DPI（dpiScale 一并返回），采集层按 hidpi 走 —— 这正是
// 手写 ffmpeg 坐标两次算错的那个坑，这里不再自己算。
const region = { x: w.x, y: w.y, width: w.width, height: w.height, hwnd: w.hwnd }
console.log(`窗口 ${JSON.stringify(region)} dpiScale=${w.dpiScale ?? '?'}`)

const DIR = path.resolve('.scratch', 'run', 'ocr')
fs.mkdirSync(DIR, { recursive: true })

let latest = null
const cap = startCapture({
  region,
  width: region.width,   // 原生尺寸：缩放会毁字（实测最近邻缩到 1/4 只剩 10% 的字）
  height: region.height,
  fps: 1,
  onFrame: (f) => { latest = f },
  onStderr: () => {},
  onClose: (why) => console.error('[capture closed]', why ?? ''),
})

const deadline = Date.now() + minutes * 60_000
let n = 0

async function tick() {
  if (Date.now() > deadline) {
    cap.stop?.()
    console.log(`[done] ${n} 帧`)
    process.exit(0)
  }
  if (latest) {
    n += 1
    // 和插件一致：只把 bottom 带（0.78–1.0）送去识别。
    // 整幅送会把地址栏、书签栏一起读进来（实测踩过）。
    const W = region.width
    const H = region.height
    const y0 = Math.floor(H * 0.78)
    const bandH = H - y0
    const band = Buffer.alloc(W * bandH * 3)
    latest.buf.copy(band, 0, y0 * W * 3, H * W * 3)

    const file = path.join(DIR, `f${String(n).padStart(3, '0')}.png`)
    fs.writeFileSync(file, encode({ width: W, height: bandH, rgb: band }))
    try {
      const r = await fetch('http://127.0.0.1:8765/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      })
      const j = await r.json()
      const txt = (j.lines ?? []).map((l) => l.t).join(' | ')
      console.log(`[${n}] ${j.ok ? txt.slice(0, 120) || '(空)' : `错误 ${j.error}`}`)
    } catch (e) {
      console.log(`[${n}] OCR 服务没响应：${e.code ?? e.message}`)
    }
  }
  setTimeout(tick, gapMs)
}

console.log(`开始：每 ${gapMs / 1000}s 一帧，共 ${minutes} 分钟`)
tick()
