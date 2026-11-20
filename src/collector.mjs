// 第一期：采集 → see-now 的 pipeline → 落盘 + 事件
// 原则：画面全链路原样用 see-now，不自创。本文件只做接线。
import fs from 'node:fs'
import path from 'node:path'
import { spawnFrames } from '../vendor/dsh-see-now-main/src/capture.js'
import { createPipeline } from '../vendor/dsh-see-now-main/src/pipeline.js'

const W = Number(process.env.W || 798)
const H = Number(process.env.H || 450)
const FPS = Number(process.env.FPS || 8)
const SECONDS = Number(process.argv[2] || 12)
const REGION = process.env.REGION ? JSON.parse(process.env.REGION) : null

const OUT = path.join(process.cwd(), '.scratch', 'run')
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true })
const EVENTS = path.join(OUT, 'events.jsonl')
fs.writeFileSync(EVENTS, '')

let seq = 0
const emit = (rec) => fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n')

const pipe = createPipeline({
  width: W, height: H, fps: FPS,
  changeLog: true,
  strategy: 'standard',
})

const source = { kind: 'screen', ...(REGION ? { region: REGION } : {}) }
let stderrTail = ''

const cap = spawnFrames({
  source, width: W, height: H, fps: FPS,
  // region 走 gdigrab；但 see-now 0.2.5 的 isDda() 只看 engine，会误加 hwdownload
  // 让 ffmpeg 一帧都出不来。显式指定 gdigrab 即可绕开（未改源码）。
  ...(REGION ? { engine: 'gdigrab' } : {}),
  onFrame: ({ t, buf }) => {
    try { pipe.push({ t, buf }) } catch (e) { stderrTail = 'push: ' + e.message }
  },
  onStderr: (s) => { stderrTail = String(s).slice(-300) },
})

// 停止时 ffmpeg 非零退出会在 done 上 reject；这是预期内的，别让它把进程带崩
Promise.resolve(cap.done).catch(() => {})

let framesIn = 0
const origPush = pipe.push
// 计数用：包一层不影响内部逻辑
pipe.push = (f) => { framesIn += 1; return origPush(f) }

/** 一张拼图落盘 + 记事件 */
function saveSheet(s) {
  seq += 1
  const name = `sheet_${String(seq).padStart(4, '0')}.png`
  fs.writeFileSync(path.join(OUT, 'sheets', name), s.png)
  emit({
    id: seq, kind: 'sheet', at: new Date().toISOString(),
    from: +s.from.toFixed(2), to: +s.to.toFixed(2),
    frames: s.frames, cells: s.cells.length,
    w: s.w, h: s.h, fill: +(s.fill || 0).toFixed(3),
    wallFrom: s.wallFrom, wallTo: s.wallTo, why: s.why,
    file: `sheets/${name}`,
  })
  console.log(JSON.stringify({ sheet: seq, why: s.why, from: +s.from.toFixed(1), to: +s.to.toFixed(1), frames: s.frames.length, size: `${s.w}x${s.h}` }))
  return name
}

// FLUSH=秒数：到点走"我要看现在"那条路（不等判据）
if (process.env.FLUSH) {
  setTimeout(() => {
    const s = pipe.flushNow(null, 'user')
    if (s) saveSheet(s)
    else console.log(JSON.stringify({ flushNow: null, hasFrame: pipe.hasFrame }))
  }, Number(process.env.FLUSH) * 1000)
}

const timer = setInterval(() => {
  let s
  while ((s = pipe.take())) saveSheet(s)
  const changes = pipe.drainChanges()
  for (const c of changes) {
    seq += 1
    // 注意：drainChanges 给的是「每张图一条摘要」{at,from,to,n,peak,cut,box}，
    // 不是逐帧事件流。逐帧事件要另做（pipeline 内部 entry 有字段但没外露）。
    emit({ id: seq, kind: 'change', wall: Date.now(), ...c })
    console.log(JSON.stringify({ change: seq, at: c.at, n: c.n, peak: c.peak, cut: c.cut, box: c.box }))
  }
}, 300)

setTimeout(() => {
  clearInterval(timer)
  cap.stop()
  const st = pipe.stats
  const cpu = process.cpuUsage()
  const cores = +(((cpu.user + cpu.system) / 1e6) / SECONDS).toFixed(3)
  console.log(JSON.stringify({
    done: true, seconds: SECONDS, framesIn,
    fps: +(framesIn / SECONDS).toFixed(2),
    nodeCores: cores,
    kept: st.kept, cuts: st.cuts, marks: st.marks, sheets: st.sheets,
    tierHist: st.tierHist, stderrTail,
  }, null, 1))
  setTimeout(() => process.exit(0), 300)
}, SECONDS * 1000)
