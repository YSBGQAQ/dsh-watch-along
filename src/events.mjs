// 事件队列：三条通道共用一条序列，id 单调递增，清空也不归零。
//
// 只做纯计算：不碰屏幕、不碰文件、不碰时间以外的外部世界。
export function createEventQueue({ capacity = 500, now = Date.now, startedAt = null } = {}) {
  const items = []
  let nextId = 1
  let highWater = 0 // 清空/淘汰都不回收，客户端靠它判断"你落后了"
  let dropped = 0
  const t0 = startedAt ?? now()

  function add(kind, payload = {}) {
    const id = nextId++
    const at = now()
    const event = { id, kind, t: Math.round(((at - t0) / 1000) * 1000) / 1000, at, ...payload }
    items.push(event)
    highWater = id
    while (items.length > capacity) {
      items.shift()
      dropped += 1
    }
    return event
  }

  /** 读：`sinceId` 之后的事件。落后超过内存里最旧的那条时，标记 staleSince 并从最旧给起。 */
  function read({ sinceId = null, limit = 100 } = {}) {
    const oldest = items.length ? items[0].id : highWater + 1
    let staleSince = false
    let from

    if (sinceId == null) {
      from = oldest
    } else {
      from = sinceId + 1
      if (sinceId < oldest - 1) {
        // 客户端要的那一段已经被淘汰了 —— 不能假装"没有新事件"
        staleSince = true
        from = oldest
      }
    }

    const picked = items.filter((e) => e.id >= from).slice(0, Math.max(1, limit))
    const last = picked.length ? picked[picked.length - 1].id : (sinceId ?? highWater)
    return {
      events: picked,
      nextId: Math.min(last, highWater) || highWater,
      pending: Math.max(0, items.filter((e) => e.id > last).length),
      staleSince,
      highWater,
      dropped,
    }
  }

  /** 长轮询：等到有事件或超时。超时不是错误。 */
  async function wait({
    sinceId = null,
    waitMs = 30_000,
    pollMs = 200,
    limit = 100,
  } = {}) {
    const deadline = now() + waitMs
    for (;;) {
      const got = read({ sinceId, limit })
      if (got.events.length) return { ...got, timedOut: false }
      if (now() >= deadline) return { ...got, timedOut: true }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  function size() {
    return { count: items.length, capacity, highWater, dropped }
  }

  return { add, read, wait, size }
}
