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

let hit = 0, simSum = 0
const missed = []
for (const g of gt) {
  // 找时间上重叠的我们的行，取相似度最高的
  let best = 0
  for (const o of ours) {
    if (o.t1 < g.t0 - 1 || o.t0 > g.t1 + 1) continue
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
  字幕条数: gt.length,
  我们条数: ours.length,
  覆盖率: gt.length ? `${((hit / gt.length) * 100).toFixed(1)}%` : '-',
  命中平均相似度: hit ? (simSum / hit).toFixed(3) : '-',
  重复句: dups.length,
  漏掉的例子: missed,
}, null, 1))
