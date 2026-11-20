// 真屏幕冒烟：不带参数 = 列出窗口；带标题片段 = 抓一帧存成 PNG。
import fs from 'node:fs'
import path from 'node:path'
import { createWatchService } from '../src/service.mjs'
import { listWindows, lookupWindow } from '../src/windows.mjs'
import { startCapture } from '../src/capture.mjs'

const want = process.argv[2]

if (!want) {
  const titles = listWindows()
  console.log(JSON.stringify({ count: titles.length, titles }, null, 1))
  process.exit(0)
}

const outDir = path.join(process.cwd(), '.scratch', 'smoke')
fs.mkdirSync(outDir, { recursive: true })

const svc = createWatchService({
  listWindows, lookupWindow, startCapture,
  onCaptureStderr: (s) => process.stderr.write(s),
})
const t0 = Date.now()
const started = await svc.start({ window: want })
const first = Date.now() - t0
const shot = await svc.frame({ live: true })
const file = path.join(outDir, 'first-frame.png')
fs.writeFileSync(file, shot.png)

console.log(JSON.stringify({
  started,
  firstFrameMs: first,
  size: `${shot.width}x${shot.height}`,
  pngBytes: shot.png.length,
  file,
}, null, 1))

await svc.stop()
