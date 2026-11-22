// 把一条 user 消息投给某个 agent（票 11 的"最后一公里"）。
//
// 出处：`vendor/dsh-see-now-main/src/timer.js:48-88`（Apache-2.0）。作者的做法不是
// "往会话注入消息"，而是拿到 **agent 句柄** 后直接 `agent.steer(...)`：
//   steer    → 下一个 step 就交给模型，正在跑的轮次也立刻看得见
//   followup → 排到下一轮，当前轮次不结束就一直等着
// 所以唤醒能力取决于"手上有没有 agent"，不取决于宿主给不给 sessionController
// （我们实测过：插件的 ctx 里 sessionController 根本取不到）。
import { randomUUID } from 'node:crypto'

/**
 * 宿主 `steer()` / `followup()` 要的是一条 user 角色的消息。
 * `source.kind` 用自定义值，方便在会话里认出"这条是我们自己塞的"。
 */
export function userMessage(text, { source = 'watch-along' } = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: source },
  }
}

/**
 * 投递一条消息给指定 agent。**永不抛** —— 返回 `{ok, via?, reason?}`。
 *
 * ## 默认必须走 followup，不是 steer
 *
 * see-now 的 CHANGELOG（PR #56）把这两条分得很清楚：
 *
 * > `steer` → `next-step`（下一个 step 就交给模型）。**人在窗口里说的话**改走 `steer`，
 * > **机器自己叫的「有新画面了」仍走 `followup`**。
 *
 * steer 是"人插话"的通道，会直接塞进正在跑的轮次里 —— 用它做主动唤醒，用户会看到
 * 会话被打断（2026-11-22 实测踩到：一条 40 字的唤醒让正在进行的对话中断）。
 * 我们是机器自己叫，所以默认 followup：排队到下一个轮次，不抢当前这一步。
 *
 * `mode: 'steer'` 保留，但只该用在"用户自己在那个窗口里说话"的场景。
 */
export function deliverToAgent(
  agent,
  text,
  { mode = 'followup', source = 'watch-along', sessions = null } = {},
) {
  if (!agent) return { ok: false, reason: 'no-agent' }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty-text' }
  const message = userMessage(text, { source })
  const done = (via, extra = {}) => {
    // followup 只是**排进队列**；不 flush 的话模型一直是 idle，看起来就是"自己停了"。
    // 出处：watch-together 的 `timer.js:116 wakeSession` —— followup 之后紧跟
    // `sessions.flush(agent.session)`。没有 sessions（宿主没给这个服务）就跳过，
    // 但那一条要能在日志里看出来，不能假装推成功了。
    let flushed = null
    try {
      if (sessions?.flush) {
        const r = sessions.flush(agent.session)
        if (r && typeof r.then === 'function') {
          r.catch(() => {})
          flushed = true
        } else {
          flushed = true
        }
      }
    } catch {
      flushed = false
    }
    return { ok: true, via, flushed, ...extra }
  }
  if (mode === 'steer' && typeof agent.steer === 'function') {
    try {
      agent.steer(message)
      return done('steer')
    } catch (e) {
      // 继续往下走 followup
      try {
        agent.followup(message)
        return done('followup', { fallback: String(e?.message ?? e) })
      } catch (e2) {
        return { ok: false, reason: String(e2?.message ?? e2) }
      }
    }
  }
  try {
    if (typeof agent.followup !== 'function') return { ok: false, reason: 'no-followup' }
    agent.followup(message)
    return done('followup')
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}
