// 验一件事：koffi BitBlt 能不能抓到 Chrome/Electron 窗口的真实画面（不是黑屏）。
// 用法：node scripts/probe-bitblt.mjs "窗口标题片段"
import fs from 'node:fs'
import path from 'node:path'
import { windowRect, capture } from '../src/native-capture.mjs'
import { encode } from '../src/png.mjs'

const frag = process.argv[2]
// 注意：windowRect 收的是**标题**，不是 hwnd（传 hwnd 会段错误 —— 已踩）
const r = windowRect(frag)
if (!r) { console.error('没找到窗口'); process.exit(1) }
console.log('窗口矩形', JSON.stringify(r))

// 传 outW/outH = 原尺寸，避免它默认缩到 1/4（缩放会毁字）
const img = capture({ x: r.x, y: r.y, width: r.width, height: r.height, outW: r.width, outH: r.height })
const px = img.rgb
let sum = 0, nonzero = 0
for (let i = 0; i < px.length; i += 3) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += v; if (v > 8) nonzero += 1 }
const n = px.length / 3
console.log(`尺寸 ${img.width}x${img.height} 平均亮度 ${(sum / n).toFixed(1)} 非黑像素占比 ${((nonzero / n) * 100).toFixed(1)}%`)

const out = path.resolve('.scratch/run/bitblt.png')
fs.writeFileSync(out, encode({ width: img.width, height: img.height, rgb: img.rgb }))
console.log('已存', out)
