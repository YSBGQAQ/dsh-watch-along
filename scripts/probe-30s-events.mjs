// 陪看实跑：盯住 WorkBuddy 窗口，同一 30 秒里同时跑两条通道。
//   1) 运动通道 —— 插件门面的长轮询事件队列（motion）
//   2) 文字通道 —— 定时抽原始帧 → 分带 OCR → 行级 diff（UI 的"事件"其实是文字变了）
// 用法：node scripts/probe-30s-events.mjs [窗口片段] [秒数] [采样间隔秒]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWatchService } from '../src/service.mjs'
import { listWindows, lookupWindow } from '../src/windows.mjs'
import { startCapture } from '../src/capture.mjs'
import { encode } from '../src/png.mjs'
import { createPipeline } from '../vendor/dsh-see-now-main/src/pipeline.js'

const WINDOW = process.argv[2] || 'WorkBuddy'
const SECONDS = Math.max(5, Math.min(180, Number(process.argv[3] || 30)))
const STEP = Math.max(5, Number(process.argv[4] || 10))
const RUN = path.resolve('.scratch', 'run')
const OCR = path.resolve('scripts', 'ocr-window.ps1')

const line = (m) => {
  const s = `${new Date().toISOString()} ${m}`
  console.log(s)
  try {
    fs.mkdirSync(path.join(RUN, 'frames'), { recursive: true })
    fs.appendFileSync(path.join(RUN, 'plugin.log'), s + '\n', 'utf8')
  } catch {}
}

function ocrPng(pngPath) {
  const t = Date.now()
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR, '-Path', pngPath, '-Scale', '3', '-BandCount', '9'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 << 20 })
    const i = out.lastIndexOf('\nJSON ')
    const raw = i >= 0 ? out.slice(i + 6) : out.slice(out.indexOf('JSON ') + 5)
    return { ...JSON.parse(raw.trim()), ms: Date.now() - t }
  } catch (e) {
    return { rows: [], error: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t }
  }
}

const norm = (s) => String(s).replace(/\s+/g, '')

// 像素级硬证据：同尺寸 RGB 缓冲的最坏单通道差 / 变化像素占比。
// 这条通道不看 pipeline 的任何判据，专门用来回答"这 30 秒画面到底有没有动"。
function pixelDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let maxD = 0
  let moved = 0
  const n = a.length / 3
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
    if (d > maxD) maxD = d
    if (d > 8) moved += 1
  }
  return { maxD, movedPct: +((moved / n) * 100).toFixed(3) }
}

function diffLines(a, b) {
  // 条带内按顺序对齐（OCR 的 Lines 是阅读序），文本差异即"这一格变了"
  const out = []
  const n = Math.max(a.length, b.length)
  const usedB = new Set()
  for (let i = 0; i < a.length; i += 1) {
    const la = a[i]
    let hit = -1
    for (let j = 0; j < b.length; j += 1) {
      if (usedB.has(j)) continue
      if (b[j].band === la.band) { hit = j; break }
    }
    if (hit >= 0 && norm(b[hit].text) === norm(la.text)) { usedB.add(hit); continue }
    if (hit >= 0) {
      // 同带里顺序扫，找最像的下一行
      let best = -1
      let bestScore = 0
      for (let j = 0; j < b.length; j += 1) {
        if (usedB.has(j) || b[j].band !== la.band) continue
        const common = [...norm(la.text)].filter((c) => norm(b[j].text).includes(c)).length
        const sc = common / Math.max(1, new Set([...norm(la.text)]).size)
        if (sc > bestScore) { bestScore = sc; best = j }
      }
      if (bestScore >= 0.6) {
        usedB.add(best)
        out.push({ type: 'edit', band: la.band, before: la.text, after: b[best].text })
        continue
      }
    }
    out.push({ type: 'gone', band: la.band, before: la.text })
  }
  for (let j = 0; j < b.length; j += 1) if (!usedB.has(j)) out.push({ type: 'new', band: b[j].band, after: b[j].text })
  return { diffs: out, untouched: usedB.size, seen: n }
}

const svc = createWatchService({
  listWindows,
  lookupWindow,
  startCapture,
  encode,
  createPipeline: () => createPipeline({ width: 798, height: 450, fps: 8, changeLog: true, changeLogMax: 500 }),
  onCaptureStderr: () => {},
})

fs.mkdirSync(path.join(RUN, 'frames'), { recursive: true })
fs.writeFileSync(path.join(RUN, 'live-events.jsonl'), '', 'utf8')

const t0 = Date.now()
const st = await svc.start({ window: WINDOW })
line(`[start] window=${st.window} region=${JSON.stringify(st.region)} size=${JSON.stringify(st.size)} fps=${st.fps} span=${SECONDS}s step=${STEP}s`)

// ── 运动通道：全时段长轮询 ──
let sinceId = null
let motion = 0
const motionLoop = (async () => {
  while (Date.now() - t0 < SECONDS * 1000) {
    const left = SECONDS * 1000 - (Date.now() - t0)
    let res
    try {
      res = await svc.events({ sinceId, waitMs: Math.max(0, Math.min(3000, left)), limit: 50 })
    } catch (e) {
      line(`[motion] error ${String(e?.message ?? e)}`)
      break
    }
    sinceId = res.nextId
    for (const e of res.events) {
      motion += 1
      const sec = ((e.at ?? Date.now()) - t0) / 1000
      line(`+${sec.toFixed(1)}s motion #${e.id} strength=${e.strength ?? '-'} where=${e.where ?? '-'} peak=${e.peak ?? '-'} cells=${e.cells ?? '-'} cut=${e.cut ?? '-'}`)
    }
  }
})()

// ── 文字通道：每 STEP 秒一帧 OCR ──
const snaps = []
const textLoop = (async () => {
  for (let k = 0; Date.now() - t0 < SECONDS * 1000 + 100; k += 1) {
    const f = await svc.rawFrame({ live: true })
    const sec = (Date.now() - t0) / 1000
    const p = path.join(RUN, 'frames', `snap_${String(k).padStart(2, '0')}_${sec.toFixed(0)}s.png`)
    fs.writeFileSync(p, encode({ width: f.width, height: f.height, rgb: f.buf }))
    const ocr = ocrPng(p)
    const px = snaps.length ? pixelDiff(snaps[snaps.length - 1].buf, f.buf) : null
    snaps.push({ k, sec, file: p, rows: ocr.rows ?? [], ms: ocr.ms, error: ocr.error, buf: f.buf, px })
    const pxTxt = px ? ` pxMaxΔ=${px.maxD} moved=${px.movedPct}%` : ''
    line(`+${sec.toFixed(1)}s text lines=${(ocr.rows ?? []).length} ocr=${ocr.ms}ms${ocr.error ? ' err=' + ocr.error : ''}${pxTxt}`)
    const wait = STEP * 1000 - (Date.now() - t0 - snapBase(k))
    await new Promise((r) => setTimeout(r, Math.max(0, wait)))
  }
})()
const snapBase = (k) => k * STEP * 1000

await Promise.all([motionLoop, textLoop])
const elapsed = (Date.now() - t0) / 1000
void elapsed

// ── 文字 diff：相邻两帧比 ──
let churn = 0
const allDiffs = []
for (let i = 1; i < snaps.length; i += 1) {
  const d = diffLines(snaps[i - 1].rows, snaps[i].rows)
  churn += d.diffs.length
  line(`[text-diff] ${snaps[i - 1].sec.toFixed(0)}s→${snaps[i].sec.toFixed(0)}s changed=${d.diffs.length}`)
  for (const x of d.diffs.slice(0, 8)) {
    line(`  ${x.type} band=${x.band} ${x.type === 'new' ? '+ ' + x.after : x.type === 'gone' ? '- ' + x.before : x.before + '  →  ' + x.after}`)
  }
  allDiffs.push({ from: snaps[i - 1].sec, to: snaps[i].sec, diffs: d.diffs })
}

const last = snaps[snaps.length - 1] ?? { rows: [] }
fs.writeFileSync(path.join(RUN, 'text-diff.json'), JSON.stringify({ snaps: snaps.map((s) => ({ sec: s.sec, lines: s.rows.length, ms: s.ms, error: s.error, px: s.px })), diffs: allDiffs }, null, 1), 'utf8')

const s = svc.status()
line(`[summary] elapsed=${elapsed.toFixed(1)}s frames=${s.frames} state=${s.state} motion=${motion} textChanges=${churn} snaps=${snaps.length} lastLines=${last.rows.length}`)
await svc.stop()
process.exit(0)
