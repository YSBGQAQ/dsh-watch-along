// koffi 直抓 + OCR：进程内 DPI 感知，坐标即物理像素，不再有 ffmpeg 的换算问题。
// 用法：node scripts/ocr-koffi.mjs "窗口标题片段" [间隔秒] [分钟]
import fs from 'node:fs'
import path from 'node:path'
import { windowRect, capture } from './native-capture.mjs'

const frag = process.argv[2]
if (!frag) {
  console.error('用法: node scripts/ocr-koffi.mjs <窗口标题片段> [间隔秒=4] [分钟=3]')
  process.exit(1)
}
const gap = Number(process.argv[3] ?? 4) * 1000
const minutes = Number(process.argv[4] ?? 3)

const DIR = path.resolve('.scratch', 'run', 'ocr')
fs.mkdirSync(DIR, { recursive: true })

let n = 0
const deadline = Date.now() + minutes * 60_000

async function tick() {
  if (Date.now() > deadline) {
    console.log(`[done] ${n} 帧`)
    return
  }
  n += 1
  const r = windowRect(frag)
  if (!r) {
    console.log(`[${n}] 窗口找不到（最小化或已关闭）`)
    return setTimeout(tick, gap)
  }
  // 采集原生尺寸（不缩：缩放会毁字）
  const img = capture({ x: r.x, y: r.y, width: r.width, height: r.height, outW: r.width, outH: r.height })
  const W = img.width
  const H = img.height

  // 只取下方 45%（实测字幕在这一带；窗口含标签栏时更靠上）
  const y0 = Math.floor(H * 0.55)
  const bh = H - y0
  const band = Buffer.alloc(W * bh * 3)
  img.rgb.copy(band, 0, y0 * W * 3, H * W * 3)

  const file = path.join(DIR, `k${String(n).padStart(3, '0')}.png`)
  fs.writeFileSync(file, (await import('../../src/png.mjs')).encode({ width: W, height: bh, rgb: band }))

  try {
    const res = await fetch('http://127.0.0.1:8765/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file }),
    })
    const j = await res.json()
    const txt = (j.lines ?? []).map((l) => l.t).join(' | ')
    console.log(`[${n}] ${txt.slice(0, 110) || '(空)'}`)
  } catch (e) {
    console.log(`[${n}] OCR 服务没响应：${e.code ?? e.message}`)
  }
  setTimeout(tick, gap)
}

console.log(`koffi 采集：${frag}，每 ${gap / 1000}s 一帧，共 ${minutes} 分钟`)
tick()
