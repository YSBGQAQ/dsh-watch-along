// 每分钟条数上限（设置里的「说话频率上限」用它）。
//
// 为什么要单独一层：转写是连续的，一场电影能出几百句；不设闸就会把事件队列刷满，
// 模型每轮都要把这一串重读一遍。这里的口径是**进入队列的条数**，不是转写次数
// （转写照常跑，只是超出的不发出去）。
export function createRateLimit({ perMin = 6, now = Date.now } = {}) {
  const limit = Math.max(1, Number(perMin) || 1)
  let windowStart = now()
  let count = 0
  let dropped = 0
  return {
    /** true = 放行，false = 这一分钟已经超了 */
    allow() {
      const t = now()
      if (t - windowStart >= 60_000) {
        windowStart = t
        count = 0
      }
      if (count >= limit) {
        dropped += 1
        return false
      }
      count += 1
      return true
    },
    /** 取走并清零"被丢掉多少条"，用于偶尔打一行日志（不刷屏） */
    takeDropped() {
      const n = dropped
      dropped = 0
      return n
    },
    get state() {
      return { count, dropped, limit, windowStart }
    },
  }
}
