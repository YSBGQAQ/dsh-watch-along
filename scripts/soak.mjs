// 稳定性压测：长时间开着，看会不会崩、会不会漏事件、内存会不会涨。
//
// 用法：node scripts/soak.mjs "窗口标题片段" 120
//       第二个参数是分钟数，默认 120（两小时）
//
// 它只验三件事，别的都不管：
//   1. 不崩     —— state 一直 running，进程活着
//   2. 不丢     —— 事件 id 连续（断号说明中间有事件没送到）
//   3. 不涨     —— RSS 与缓冲帧数在一段时间后应趋于平稳
import { createWatchService } from '../src/service.mjs'
import { listWindows, lookupWindow } from '../src/windows.mjs'
import { startCapture } from '../src/capture.mjs'
import { encode } from '../src/png.mjs'
import { createPipeline } from '../vendor/dsh-see-now-main/src/pipeline.js'

const title = process.argv[2]
const minutes = Number(process.argv[3] ?? 120)
if (!title) {
  console.error('用法: node scripts/soak.mjs "窗口标题片段" [分钟数]')
  const all = [...new Set((listWindows() ?? []).filter(Boolean))]
  console.error(`当前可见窗口（${all.length}）：`)
  for (const t of all) console.error('  -', t)
  process.exit(1)
}

import fs from 'node:fs'
import path from 'node:path'

const LOG = path.resolve('.scratch', 'run', 'soak.log')
fs.mkdirSync(path.dirname(LOG), { recursive: true })
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (...a) => {
  const line = [stamp(), ...a].join(' ')
  console.log(line)
  // 同时落盘：两小时里终端可能被关掉、被滚屏冲掉，日志是唯一能回看的证据
  try {
    fs.appendFileSync(LOG, `${line}\n`)
  } catch {
    /* 日志写不进去不该影响压测 */
  }
}
const mb = (n) => Math.round(n / 1024 / 1024)

const service = createWatchService({
  listWindows,
  lookupWindow,
  startCapture,
  encode,
  createPipeline: () => createPipeline({ width: 798, height: 450, fps: 8, changeLog: true, changeLogMax: 500 }),
  onCaptureStderr: (s) => {
    const t = String(s).trim()
    if (t) say('ffmpeg:', t.slice(0, 160))
  },
})

let cursor = null
let received = 0
let maxId = 0
let gaps = [] // 断号
const byKind = new Map()
let timeouts = 0
const rss = []

const startedAt = Date.now()
const deadline = startedAt + minutes * 60_000

say(`[start] window=${title} 时长=${minutes} 分钟   日志：${LOG}`)
const st0 = await service.start({ window: title })
say(`[running] region=${JSON.stringify(st0.region)} size=${st0.size?.width}x${st0.size?.height}`)

function sample() {
  // 只采本进程（采集与判据都在这里）；python 服务在外面，由人另看
  const rec = { at: Math.round((Date.now() - startedAt) / 1000), mb: mb(process.memoryUsage().rss) }
  rss.push(rec)
  return rec // 调用处要读 .mb，别返回 undefined
}

const sampler = setInterval(sample, 60_000)
sample()

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) process.exit(130) // 连按两次直接退
  interrupted = true
  say('[interrupt] 收到 Ctrl+C，正在出 summary（再按一次强制退出）')
})

let lastReport = Date.now()
while (Date.now() < deadline && !interrupted) {
  const got = await service.events({ sinceId: cursor, waitMs: 20_000 })
  if (got.timedOut) timeouts += 1
  for (const e of got.events) {
    if (maxId && e.id > maxId + 1) gaps.push({ from: maxId + 1, to: e.id - 1 })
    maxId = Math.max(maxId, e.id)
    received += 1
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  }
  cursor = got.nextId

  if (Date.now() - lastReport >= 60_000) {
    lastReport = Date.now()
    const s = service.status()
    const live = rss[rss.length - 1]?.mb ?? '?'
    say(
      `[心跳 ${Math.round((Date.now() - startedAt) / 60_000)}min]`,
      `frames=${s.frames}`,
      `state=${s.state}`,
      `事件=${received}`,
      `空等=${timeouts}`,
      `rss=${live}MB`,
    )
  }
  if (service.status().state === 'failed') {
    say('[fatal] 状态变成 failed：', service.status().reason)
    break
  }
}

clearInterval(sampler)
const status = service.status()
const first = rss.slice(0, 5)
const last = rss.slice(-5)
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b.mb, 0) / arr.length) : 0)

const report = {
  minutes: Math.round((Date.now() - startedAt) / 60_000),
  state: status.state,
  reason: status.reason,
  frames: status.frames,
  events: received,
  byKind: Object.fromEntries(byKind),
  timeouts,
  maxId,
  gaps: gaps.slice(0, 10),
  rssMb: { first: avg(first), last: avg(last), samples: rss.length },
  verdict: null,
}

report.verdict = status.state === 'failed'
  ? `崩了：${status.reason}`
  : gaps.length > 0
    ? `漏事件：${gaps.length} 处断号`
    : avg(last) > avg(first) * 1.5 && rss.length > 3
      ? `内存涨了 ${avg(last) - avg(first)}MB（首 ${avg(first)} → 末 ${avg(last)}）`
      : '通过：没崩、没断号、内存平稳'

say('[summary]', JSON.stringify(report, null, 1))
await service.stop()
process.exit(report.verdict.startsWith('通过') ? 0 : 2)
