// 一次陪看会话的流水账。
//
// 结束时用一句话说清四件事：跑了多久、出了多少事件（按三类分）、id 有没有缺、内存涨没涨。
//
// 为什么要专门记：这三项都只在内存里，会话一停就没了。2026-11-23 那轮 31 分钟的实测
// 就是因此拿不出数据 —— 只能靠 python 的旁证日志推"大概跑了半小时"，票 09 要的三个数
// （断号 / RSS / 各类条数）一个都给不出。记在 service 里而不是插件里，是因为只有事件队列
// 知道每条事件的 id。
//
// 只做记账，不参与采集、不参与判定。

const MB = 1024 * 1024

/** 本地时间 YYYY-MM-DD HH:mm:ss。给人看的一律用本地时间，UTC 只用来跟日志对表。 */
export function fmtLocal(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 时长：31 分 06 秒 / 1 小时 02 分 09 秒。 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h) return `${h} 小时 ${String(m).padStart(2, '0')} 分 ${String(ss).padStart(2, '0')} 秒`
  if (m) return `${m} 分 ${String(ss).padStart(2, '0')} 秒`
  return `${ss} 秒`
}

export function createSessionStats({ now = Date.now, rss = () => process.memoryUsage().rss } = {}) {
  let startedAt = 0
  let endedAt = 0
  let count = 0
  let byKind = Object.create(null)
  let firstId = null
  let lastId = null
  let gaps = [] // [{ from, to }]，只在真的缺号时才有内容
  let samples = [] // RSS（MB）序列
  let frames = 0

  function reset(at = now()) {
    startedAt = at
    endedAt = 0
    count = 0
    byKind = Object.create(null)
    firstId = null
    lastId = null
    gaps = []
    samples = []
    frames = 0
  }

  /** 每条入队事件调一次。id 由队列按 1 递增发号，缺号意味着中间有事件没记上。 */
  function onEvent(e) {
    if (!e || !Number.isFinite(e.id)) return
    count += 1
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    if (firstId == null) firstId = e.id
    else if (e.id > lastId + 1) gaps.push({ from: lastId + 1, to: e.id - 1 })
    if (lastId == null || e.id > lastId) lastId = e.id
  }

  /** 采一次内存（MB）。start/stop 各一次，运行中每 60 秒一次。 */
  function sample() {
    const mb = Math.round(rss() / MB)
    samples.push(mb)
    return mb
  }

  function summary({ at = now(), frameCount = null } = {}) {
    endedAt = at
    const rssFirst = samples.length ? samples[0] : null
    const rssLast = samples.length ? samples[samples.length - 1] : null
    const rssPeak = samples.length ? Math.max(...samples) : null
    const span = count ? lastId - firstId + 1 : 0
    return {
      startedAt,
      endedAt,
      durationSec: startedAt ? Math.round((endedAt - startedAt) / 1000) : 0,
      startedLocal: startedAt ? fmtLocal(startedAt) : null,
      endedLocal: endedAt ? fmtLocal(endedAt) : null,
      startedUtc: startedAt ? new Date(startedAt).toISOString() : null,
      endedUtc: endedAt ? new Date(endedAt).toISOString() : null,
      frames: frameCount ?? frames,
      events: count,
      byKind: { ...byKind },
      firstId,
      lastId,
      missing: span > count ? span - count : 0,
      gaps: gaps.slice(0, 10),
      rssMb: { first: rssFirst, last: rssLast, peak: rssPeak, samples: samples.length },
    }
  }

  function setFrames(n) {
    frames = n
  }

  return { reset, onEvent, sample, summary, setFrames }
}

/**
 * 汇总成一行给人读的结论。
 *
 * 一行而不是多行：这行会被写进 plugin.log，多行会跟"拼图失败"之类的刷屏混在一起，
 * 事后 grep 一条就能看全。
 */
export function formatSummary(s, extra = '') {
  if (!s) return '[会话汇总] （没有数据：这一段没跑起来）'
  const kinds = ['motion', 'ocr', 'speech']
    .filter((k) => s.byKind?.[k] != null)
    .map((k) => `${k} ${s.byKind[k]}`)
    .join(' / ')
  const rss = s.rssMb
  const rssText =
    rss?.first == null
      ? 'RSS 未采样'
      : `RSS ${rss.first}→${rss.last}MB 峰 ${rss.peak}（${rss.samples} 次采样${
          rss.first > 0 && rss.last != null ? `，${Math.round(((rss.last - rss.first) / rss.first) * 100)}%` : ''
        }）`
  const parts = [
    `${s.startedLocal ?? '?'} → ${s.endedLocal ?? '?'}（${fmtDuration(s.durationSec)}）`,
    `帧 ${s.frames}`,
    `事件 ${s.events}${kinds ? `（${kinds}）` : ''}`,
    `id ${s.firstId ?? '-'}→${s.lastId ?? '-'} 缺 ${s.missing}`,
    rssText,
  ]
  if (extra) parts.push(extra)
  if (s.failed) parts.push(`采集中断：${s.reason ?? '未知原因'}`)
  return `[会话汇总] ${parts.join('｜')}`
}
