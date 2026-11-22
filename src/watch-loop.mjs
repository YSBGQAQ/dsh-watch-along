// 陪看循环（票 11 的"一直陪"）。
//
// 出处：watch-together `src/watch-loop.js` 的三频率设计 —— 大部分时间在本地算，
// 只有"真到点"才叫模型。这里只保留最小可用形态：
//
//   everyMs  本地 tick（默认 2 秒，纯算术，不碰模型）
//   gapMs    两次唤醒的最小间隔（默认 30 秒，等于 watch-together 的 calm 档）
//   idleMs   这么久没有任何工具调用就收工（默认 3 分钟，同 see-now 的 IDLE_STOP_MS）
//
// 三条规矩，缺一条就会出问题：
//   1. **一次只允许一条在飞**：上一条叫醒之后模型没调过工具（noteActivity），就不叫下一条。
//      不这么做会积出一串"有新画面了"，用户得一条条点掉（see-now 社区实报）。
//   2. **没有新东西不叫**：hasNews() 为假就闭嘴，否则就是定时刷屏。
//   3. **会自己收工**：idleMs 内毫无动静就停（没人理的陪伴该停）。

export function createWatchLoop({
  wake, // async () => ({ok, reason?, ...})
  hasNews = () => false, // () => boolean —— 上次唤醒之后有没有新事件
  onStop = () => {},
  now = Date.now,
  everyMs = 2000,
  gapMs = 30_000,
  idleMs = 3 * 60_000,
  setTimer = setInterval,
  clearTimer = clearInterval,
  log = () => {},
} = {}) {
  let timer = null
  let started = false
  let lastWakeAt = 0
  let lastAckAt = now() // 最近一次"模型真的动了"（工具调用）
  let wakes = 0
  let inFlight = false
  let stopped = null // 停的理由，null = 还在跑

  function stop(reason) {
    if (stopped) return
    stopped = reason
    inFlight = false
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    log(`陪看循环收工：${reason}`)
    try {
      onStop(reason)
    } catch {
      /* 收工回调出错不影响停止本身 */
    }
  }

  /** 模型调了一次工具 = 它接住了上一条叫醒。 */
  function noteActivity() {
    lastAckAt = now()
    inFlight = false
    // wakes 只做状态展示，不再当收工线。
    // 曾经的 maxWakes（"连续 N 次没人接"）是死代码：inFlight 已经保证没被接住就不叫下一条，
    // 计数永远到不了 2（2026-11-22 被测试抓到，已删）。真正的收工线是 idleMs。
  }

  /** 一次判定。返回 {fired, reason}；测试直接调它，不用等定时器。 */
  async function tick() {
    if (stopped) return { fired: false, reason: `stopped:${stopped}` }
    if (now() - lastAckAt > idleMs) {
      stop('idle')
      return { fired: false, reason: 'idle' }
    }
    if (inFlight) return { fired: false, reason: 'in-flight' }
    if (!hasNews()) return { fired: false, reason: 'no-news' }
    if (lastWakeAt && now() - lastWakeAt < gapMs) return { fired: false, reason: 'too-soon' }

    inFlight = true
    let r = null
    try {
      r = await wake()
    } catch (e) {
      r = { ok: false, reason: String(e?.message ?? e) }
    }
    if (!r?.ok) {
      // 发失败不算"叫醒"：不占间隔、也不累计次数，否则一次故障能把人叫停
      inFlight = false
      return { fired: false, reason: `wake-failed:${r?.reason ?? '?'}` }
    }
    lastWakeAt = now()
    wakes += 1 // 只用于状态展示（排查用），不再作为收工线
    return { fired: true, reason: 'woke', via: r.via, flushed: r.flushed }
  }

  function start() {
    if (started || stopped) return false
    started = true
    timer = setTimer(() => {
      void tick()
    }, everyMs)
    // Node 的 Timer 要 unref，否则插件会拖住宿主退出
    try {
      timer?.unref?.()
    } catch {
      /* 不是 Node Timer 就算了 */
    }
    log(`陪看循环已启动：每 ${everyMs}ms 判定一次，间隔 ${gapMs}ms`)
    return true
  }

  /** 重新起跑：新一次 watch_start 时调，把"收工"和计数全部复位。 */
  function restart() {
    // 循环还活着就**什么都别重置**：模型可能每轮都调一次 watch_start，
    // 每次都清零 lastWakeAt、放开 inFlight，30 秒间隔会立刻失效
    // （实测退化成 6 秒一次，同一毫秒还出现两条重复投递）。
    if (started && !stopped) {
      noteActivity()
      return true
    }
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    stopped = null
    started = false
    wakes = 0
    lastWakeAt = 0
    inFlight = false
    lastAckAt = now()
    return start()
  }

  return {
    start,
    restart,
    stop,
    tick,
    noteActivity,
    get state() {
      return { started, stopped, wakes, inFlight, lastWakeAt, lastAckAt }
    },
  }
}
