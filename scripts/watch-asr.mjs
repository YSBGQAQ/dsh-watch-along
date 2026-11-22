// 实时观察 ASR 听写结果（给人看）
//
// 用法：scripts\watch-asr.cmd   或   node scripts/watch-asr.mjs
//
// 为什么要单独一个：陪看时"AI 到底听到了什么"是最常被怀疑的事，
// 但 /health 只告诉你"在采音"，拿不到文本。这个脚本不断调 POST /
// （那正是插件每拍调的那个接口），把交付出来的句子原样打到屏幕上。
//
// 注意：它和插件**抢同一个交付游标** —— asr_service 的 pull() 是"交给谁就不再给"。
// 所以观察时插件那边会少句子。这是有意的：先把"听得对不对"看清楚，再谈陪看。
const PORT = Number(process.env.WATCH_ALONG_PORT_ASR || 8766)
const BASE = `http://127.0.0.1:${PORT}`
const EVERY = 800

const stamp = () => new Date().toTimeString().slice(0, 8)
const say = (s) => process.stdout.write(s + '\n')

let bannerShown = false
let warnedDown = false
let count = 0

async function once() {
  const r = await fetch(`${BASE}/`, { method: 'POST', body: '{}' })
  const j = await r.json()

  if (!bannerShown) {
    bannerShown = true
    say(`== ASR ${BASE} ==`)
    say(`   设备：${j.device ?? '?'}   模型就绪：${j.ready ?? '?'}   采音中：${j.capturing ?? '?'}`)
    if (j.audioNote) say(`   ⚠ ${j.audioNote}（说明回退到整机混音了）`)
    say('   下面每行 = 一句已说完的话。Ctrl+C 退出。')
    say('')
  }
  if (j.error) say(`[${stamp()}] ⚠ 服务报错：${j.error}`)

  for (const line of j.lines ?? []) {
    const text = String(line.text ?? '').trim()
    if (!text) continue
    count += 1
    const at = line.t0 != null ? `t=${Number(line.t0).toFixed(1)}s` : ''
    say(`[${stamp()}] ${at.padEnd(9)} ${text}`)
  }
  // 静音时给个心跳，免得看起来像卡死
  if (!(j.lines ?? []).length && j.silent) {
    process.stdout.write('.')
  }
  return j
}

say('等 ASR 服务…（第一次可能要 10–30 秒加载模型）')
for (;;) {
  try {
    await once()
    warnedDown = false
  } catch (e) {
    if (!warnedDown) {
      warnedDown = true
      say(`\n[${stamp()}] 连不上 ${BASE} —— 服务没起？先跑：scripts\\start-services.cmd`)
    }
  }
  await new Promise((r) => setTimeout(r, EVERY))
}
