// 陪看循环（票 11 的"一直陪"）。
//
// 出处：watch-together `src/watch-loop.js` 的三频率设计 —— 大部分时间在本地算，
// 只有"真到点"才叫模型。这里只保留最小可用形态：
//
//   everyMs  本地 tick（默认 2 秒，纯算术，不碰模型）
//   gapMs    两次唤醒的最小间隔（默认 30 秒，等于 watch-together 的 calm 档）
//   idleMs   "多久没人理就收工"（默认已停用，见下面第 3 条）
//
// 三条规矩，缺一条就会出问题：
//   1. **一次只允许一条在飞**：投递还没返回就不叫下一条（防重入）。
//      注意：判据是"投递完成"，**不是**"模型调了工具"——见 tick() 里的说明。
//   2. **没有新东西不叫**：hasNews() 为假就闭嘴，否则就是定时刷屏。
//   3. **会自己收工**：默认**关**。2026-11-23 用户决定停用：实测 30 分钟里循环投递 6 次后
//      自己收工，之后 28 分钟只采集不说话；而整轮 22M token 只花了 ¥0.55，没有省钱的必要。
//      代码留着（IDLE_STOP_ENABLED 开关），要复开改一行即可。

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

  /** 模型调了一次工具。现在只记 lastAckAt（状态展示用）；放不放行下一条不再看它。 */
  function noteActivity() {
    lastAckAt = now()
    // 顺手清 inFlight 无副作用：老调用方（工具回调）还在调它。
    inFlight = false
  }

  /** 一次判定。返回 {fired, reason}；测试直接调它，不用等定时器。 */
  async function tick() {
    if (stopped) return { fired: false, reason: `stopped:${stopped}` }
    // 空闲收工：默认关闭。要复开把这个常量改成 true（idleMs 仍然有效）。
    // 关掉的理由是实测出来的，不是感觉：30 分钟那一轮，模型只在前 3 分钟调过工具，
    // 循环按 idleMs 判定"没人理"，自己在 01:54:51 收工，后面 28 分钟只采集不说话。
    const IDLE_STOP_ENABLED = false
    if (IDLE_STOP_ENABLED && now() - lastAckAt > idleMs) {
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
    // **投递完成就放行**，不等模型调工具。
    // 原来的判据是 noteActivity()（模型调了我们的工具才算接住），实测这条会死锁：
    // 模型经常只是回一句话、根本不调工具，于是 inFlight 永远为真 —— 循环还活着，
    // 但一句话都不再说，日志里连"收工"都没有，看起来像"陪看突然哑了"。
    // 防重入的目的靠上面 `if (inFlight)` 已经达到：wake() 没返回之前不会再发第二条。
    inFlight = false
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
