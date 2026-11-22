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
 * `steer` 失败（宿主版本老 / 轮次边界冲突）时退回 `followup`：投不到才是真丢话，
 * 顺序错了只是晚一轮。
 */
export function deliverToAgent(agent, text, { mode = 'steer', source = 'watch-along' } = {}) {
  if (!agent) return { ok: false, reason: 'no-agent' }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty-text' }
  const message = userMessage(text, { source })
  if (mode === 'steer' && typeof agent.steer === 'function') {
    try {
      agent.steer(message)
      return { ok: true, via: 'steer' }
    } catch (e) {
      // 继续往下走 followup
      try {
        agent.followup(message)
        return { ok: true, via: 'followup', fallback: String(e?.message ?? e) }
      } catch (e2) {
        return { ok: false, reason: String(e2?.message ?? e2) }
      }
    }
  }
  try {
    if (typeof agent.followup !== 'function') return { ok: false, reason: 'no-followup' }
    agent.followup(message)
    return { ok: true, via: 'followup' }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}
