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
      // 首次读（不给 sinceId）= "现在有什么" → 取**最近**的 limit 条。
      // 原来是 from = oldest（最旧的 limit 条），长会话里会返回几十分钟前的事件，
      // 于是"刚才说了什么"答不上来 —— 这不是上下文缺失，是取错了那一段。
      const tail = items.slice(-Math.max(1, limit))
      const lastId = tail.length ? tail[tail.length - 1].id : highWater
      return {
        events: tail,
        nextId: Math.min(lastId, highWater) || highWater,
        pending: 0,
        staleSince: false,
        highWater,
        dropped,
        quiet: tail.length === 0,
      }
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
      // 明确的"没动静"：让调用方不用猜是真安静还是坏了。
      // 落后（staleSince）不算 quiet —— 那说明有事件但你看丢了。
      quiet: picked.length === 0 && !staleSince,
    }
  }

  /** 长轮询：等到**新**事件或超时。超时不是错误。 */
  async function wait({
    sinceId = null,
    waitMs = 30_000,
    pollMs = 200,
    limit = 100,
  } = {}) {
    // 不给 sinceId 的"长轮询"语义是"从现在开始等新的"，
    // 所以起点落在 highWater（此刻），而不是回头去捞历史 ——
    // 否则 read(null) 现在返回最近一批，长轮询会立刻返回、根本不等待。
    if (sinceId == null) sinceId = highWater
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
