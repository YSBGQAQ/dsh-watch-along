// 把我们的转写和 B 站字幕文件对照，算覆盖率与准确率。
// 用法: node scripts/check-transcript.mjs <字幕.json> [fromSec] [toSec]
// 读:   .scratch/run/asr-out.jsonl（asr_service 交付时自动写）
import fs from 'node:fs'

const [gtPath, fromArg, toArg] = process.argv.slice(2)
if (!gtPath) {
  console.error('用法: node scripts/check-transcript.mjs <字幕.json> [fromSec] [toSec]')
  process.exit(1)
}
const from = Number(fromArg ?? 0)
const to = Number(toArg ?? 2400)
const ASR = '.scratch/run/asr-out.jsonl'

const norm = (s) => String(s ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

/** 字符级相似度（LCS 比例），短串足够用 */
function ratio(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  const m = a.length, n = b.length
  let prev = new Uint16Array(n + 1), cur = new Uint16Array(n + 1)
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n] / Math.max(m, n)
}

const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8')).body
  .filter((x) => x.from >= from && x.from < to)
  .map((x) => ({ t0: x.from, t1: x.to, text: x.content, key: norm(x.content) }))

if (!fs.existsSync(ASR)) {
  console.error(`没有 ${ASR}：先让 asr_service 跑一轮（它交付时会自动写）`)
  process.exit(2)
}
const ours = fs.readFileSync(ASR, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

// 自动找时间偏移：我们的时间从"服务启动"算，字幕从"视频开始"算，两者差多少不知道。
// 扫一遍偏移，取覆盖率最高的那个 —— 否则覆盖率会被这个平移压成个位数（实测 2%）。
function score(offset) {
  let hit = 0
  let sim = 0
  for (const g of gt) {
    let best = 0
    for (const o of ours) {
      const o0 = o.t0 + offset
      const o1 = o.t1 + offset
      if (o1 < g.t0 - 1 || o0 > g.t1 + 1) continue
      const r = ratio(g.key, norm(o.text))
      if (r > best) best = r
    }
    if (best >= 0.5) { hit += 1; sim += best }
  }
  return { hit, sim }
}

let bestOffset = 0
let bestHit = -1
for (let off = -600; off <= 600; off += 5) {
  const { hit } = score(off)
  if (hit > bestHit) { bestHit = hit; bestOffset = off }
}
const offset = bestOffset
if (process.env.SHOW_OFFSET) console.error('最佳偏移', offset, '秒')

// 只按文本算的覆盖率：不管时间。
// 为什么需要它：字幕是一句一条，我们经常一条含几句（"看见什么了 快说呀"），
// 严格按"一条对一条"会把明明听到了的判成漏（实测 5.4% vs 实际大量命中）。
function textHit(g) {
  let best = 0
  for (const o of ours) {
    const r = ratio(g.key, norm(o.text))
    if (r > best) best = r
    if (best >= 0.8) break
  }
  return best
}
let textHits = 0
for (const g of gt) if (textHit(g) >= 0.6) textHits += 1

let hit = 0, simSum = 0
const missed = []
for (const g of gt) {
  // 找时间上重叠的我们的行，取相似度最高的
  let best = 0
  for (const o of ours) {
    const o0 = o.t0 + offset
    const o1 = o.t1 + offset
    if (o1 < g.t0 - 1 || o0 > g.t1 + 1) continue
    const r = ratio(g.key, norm(o.text))
    if (r > best) best = r
  }
  if (best >= 0.5) { hit += 1; simSum += best } else if (missed.length < 10) missed.push({ t: g.t0, text: g.text })
}

const dupText = new Map()
for (const o of ours) {
  const k = norm(o.text)
  dupText.set(k, (dupText.get(k) ?? 0) + 1)
}
const dups = [...dupText.entries()].filter(([, n]) => n > 1)

console.log(JSON.stringify({
  区间: `${from}s – ${to}s`,
  最佳偏移秒: offset,
  字幕条数: gt.length,
  我们条数: ours.length,
  覆盖率_时间对齐: gt.length ? `${((hit / gt.length) * 100).toFixed(1)}%` : '-',
  覆盖率_仅文本: gt.length ? `${((textHits / gt.length) * 100).toFixed(1)}%` : '-',
  命中平均相似度: hit ? (simSum / hit).toFixed(3) : '-',
  重复句: dups.length,
  漏掉的例子: missed,
}, null, 1))
