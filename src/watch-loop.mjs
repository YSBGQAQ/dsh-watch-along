// 陪看循环（票 11 的"一直陪"）。
//
// 出处：watch-together `src/watch-loop.js` 的三频率设计 —— 大部分时间在本地算，
// 只有"真到点"才叫模型。这里只保留最小可用形态：
//
//   everyMs  本地 tick（默认 2 秒，纯算术，不碰模型）
//   gapMs    两次唤醒的最小间隔（默认 30 秒，等于 watch-together 的 calm 档）
//   maxWakes 连续叫了这么多次都没人接就收工（默认 8，同 see-now）
//   idleMs   这么久没有任何工具调用就收工（默认 3 分钟，同 see-now 的 IDLE_STOP_MS）
//
// 三条规矩，缺一条就会出问题：
//   1. **一次只允许一条在飞**：上一条叫醒之后模型没调过工具（noteActivity），就不叫下一条。
//      不这么做会积出一串"有新画面了"，用户得一条条点掉（see-now 社区实报）。
//   2. **没有新东西不叫**：hasNews() 为假就闭嘴，否则就是定时刷屏。
//   3. **会自己收工**：叫满 maxWakes 次没人接、或 idleMs 内毫无动静，就停。

export function createWatchLoop({
  wake, // async () => ({ok, reason?, ...})
  hasNews = () => false, // () => boolean —— 上次唤醒之后有没有新事件
  onStop = () => {},
  now = Date.now,
  everyMs = 2000,
  gapMs = 30_000,
  maxWakes = 8,
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
    // 注意：**不清零 wakes**。wakes 是"这一场总共叫了多少次"的硬上限；
    // 清零会让"用户在跟它聊天"变成"永远不封顶"，而每叫一次都是一轮模型开销。
    // "没人理"这件事由 idleMs 管（3 分钟没有任何工具调用就收工）。
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
    wakes += 1
    if (wakes >= maxWakes) stop('max-wakes')
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
    log(`陪看循环已启动：每 ${everyMs}ms 判定一次，间隔 ${gapMs}ms，上限 ${maxWakes} 次`)
    return true
  }

  /** 重新起跑：新一次 watch_start 时调，把"收工"和计数全部复位。 */
  function restart() {
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
