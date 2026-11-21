// 不用 DSH 验三带：直接跑插件的真实链路
//   capture-koffi → ocr.mjs(三带 + 两次一致) → 打印事件
// 用法：node scripts/verify-ocr-koffi.mjs "窗口标题片段" [秒=60]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { windowRect, startCapture } from '../src/capture-koffi.mjs'
import { createSubtitleReader } from '../src/ocr.mjs'
import { encode } from '../src/png.mjs'

const frag = process.argv[2]
const seconds = Number(process.argv[3] ?? 60)
if (!frag) { console.error('用法: node scripts/verify-ocr-koffi.mjs <窗口标题> [秒]'); process.exit(1) }

const region = windowRect(frag)
if (!region) { console.error('找不到窗口'); process.exit(1) }
console.log('采集矩形', JSON.stringify(region))

const tmp = path.join(os.tmpdir(), 'watch-along-ocr-verify.png')

/** 与 index.js 里同形的 recognize：把 PNG 落到临时文件再让服务读 */
async function recognize(png) {
  fs.writeFileSync(tmp, png)
  const r = await fetch('http://127.0.0.1:8765/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: tmp }),
  })
  const j = await r.json()
  return (j.lines ?? []).map((l) => l.t)
}

const reader = createSubtitleReader({
  encode,
  recognize,
  intervalMs: 1200, // 与 streamvision 的 STABLE_MS 对齐
  onEvent: (e) => console.log(`[${e.band}] ${e.text}  (相似 ${e.similarity})`),
})

const cap = startCapture({
  region,
  fps: 4,
  onFrame: (f) => { reader.feed({ buf: f.buf, width: f.width, height: f.height }) },
  onClose: (why) => console.error('[capture]', why),
})

setTimeout(() => { cap.stop(); console.log('结束'); process.exit(0) }, seconds * 1000)
console.log(`跑 ${seconds}s …（每 1.2s 一次，三条带各自两次一致才发）`)
