# 11: 主动唤醒（proactive wake）

**What to build:** 陪看不再只等你问。出现值得说的事时，主动往**开启陪看的那个会话**塞一条 user 消息，让模型自己开口。没有值得说的事就闭嘴；你睡着时要自己停下来。

**Blocked by:** 02（事件队列）

**Status:** claimed（判定层已实现并有 12 条测试；接线待一轮 DSH 实机验证，两个宿主字段名仍是猜的）

## 决策（与用户逐条敲定，2026-11-21 10:46）

| 项 | 决定 | 为什么 |
|---|---|---|
| 默认 | **关**（`wake=false`） | 照抄 dsh-watch-together：主动插话会**挡住用户自己要说的话** |
| 触发 | `strength=high` 或 `cut=true` | 我们的数据是事件流，不是台词库存——没值钱的事就不该开口 |
| 兜底 | 长时间无高质量事件时，说**亮点**（不说“还在看吗”） | 用户明确否掉了“还在看吗”这种空话 |
| 亮点谁挑 | **模型自己挑**（消息里只放最近事件摘要） | 用户选 a：给我们排序后的摘要，措辞交给模型 |
| 最小间隔 | 可配，默认 **120 秒** | 作者的实践节奏；留参数因为我们的密度更高 |
| 目标会话 | **最后一次 `watch_start` 的那个会话** | 谁开的陪看回谁那儿，不误发 | 
| 判定被回应 | 下次唤醒前查一次：上次唤醒后有无新的 **user** 消息 | 不用实时订阅，一次性查询即可 |
| 无回应 | +1；用户一说话归零 | |
| 5 次后 | **本次陪看不再唤醒**（`wakeMaxMisses` 可调），重新 `watch_start` 才恢复 | 防用户睡着后被反复吵 |
| 拿不到宿主能力 | **静默降级 + 一条日志** | 可选功能不能拖挂主流程 |
| 关闭时 | 只写日志，**不往会话发消息** | 它已经睡了，别再用消息吵醒 |

**术语（不要再混用）**
- **wake / 唤醒**：往会话塞一条 user 消息，让模型跑一轮
- **台词**：准备让模型说的内容
- **播报**：TTS 念出来（本票不做）
- **插话**：用户自己的话被我们的唤醒打断（要避免的现象）

## 验收

- [x] 默认不唤醒：装好不动，一小时里会话里没有任何自动消息 —— 默认 `enabled=false`，
      且要有 `WATCH_ALONG_WAKE=1` 才开；启动时会打一行「主动唤醒：关/开；sessionController=有/无」
- [x] 打开后，出现 `high`/`cut` 事件时，**120 秒内最多一条**唤醒消息
- [x] 唤醒消息里含最近 3 分钟、最多 20 条事件摘要（按 strength 排序）
- [ ] 用户回一句后计数器归零 —— 逻辑已写并有测试，但**接线时 `hasUserMessageSince` 传的是 null**
      （见 Comments「两个仍是猜的」），所以真机上这条还不生效
- [ ] 连续 5 次无回应 → 本次陪看不再唤醒，日志留痕，会话无新消息 —— 同上，逻辑有、历史读不到
- [x] 重新 `watch_start` → 计数与开关恢复 —— `onWatchStart` → `waker.reset()`，有测试
- [x] 拿不到 `sessionController` / 读不到会话历史 → 只打一条日志，工具与三条通道**全部照常**

## 两个未验的事实（动手前先验，各自一行）

1. `ctx.get('sessionController')` 是否能拿到 —— 拿不到则整票降级为“不做”
   - **2026-11-22 静态已确认存在**：宿主 `docs/capability-seams.md` 里 `ctx.sessionController` 是 `core` 服务，owner 包 `api-session-controller`，说明栏写着「Owns Session commands, cold reads, durable-event following, live control state, model catalogs, workspace opening, and Agent activation policy」。
   - 塞消息的入口是 `@Remote('prompt') prompt(request, signal): Promise<SessionPromptValue>`，JSDoc 写的是「Admit one prompt after explicitly resuming its Session」，`request` 含**Session 身份、prompt 内容、来源元数据、投递方式**——正是本票要的「往开陪看的那个会话塞一条 user 消息」。
   - 还差一步：插件 ctx 里 `ctx.get('sessionController')` 这一跳没在运行时验过（`prompt` 请求体的字段名要从 typert 生成的 schema 取，不是手写）。
2. 能否读到会话里的 user 消息 —— 读不到则**保守处理**：不确定就不计数（5 次永远不会触发，等于只保留主动唤醒、不自动停）

## 遗留

- ADR 尚未单独成文（决策表在本票里；如需长期留档，另写 `docs/adr/0005-proactive-wake.md`）
- 播报（TTS）不在本票范围

## Comments

### 2026-11-22 实现：判定层全做完，接线留两个待确认的字段名

- **`src/wake.mjs`**：节流 / 触发判据 / 摘要挑选 / 次数上限 / reset 全在这一层，`send` 注入，
  所以能全量单测。**`test/wake.test.mjs` 12 条**，覆盖：默认关、high/cut 才叫、120 秒节流、
  连续 5 次不回应就闭嘴、回话归零、读历史失败要保守不计数、send 失败不拖挂主流程、
  reset 恢复、摘要 3 分钟/20 条/按强度排序。
- **`src/service.mjs` 加了两个观察者钩子**：`onEvent(kind, payload)` 与 `onWatchStart()`。
  为什么必须新开钩子：**`motion` 事件不走 `emit()`**（它直接 `eventQueue.add`），
  只包 `emit` 会漏掉三分之二的事件。两处都调，且有 try/catch —— 观察者出错不许影响入队。
- **默认关**：`enabled=false`，要有 `WATCH_ALONG_WAKE=1` 才开。启动时打一行
  「主动唤醒：关/开；sessionController=有/无」，一眼能看出宿主给没给。
- **一个真 bug（测试抓到的）**：采集侧给的 `strength` 是 `high / medium / low`，
  而票里的表格写的是 `mid`。我第一版排序表只认 `mid`，会让"中等强度"排到 `low` 后面，
  摘要顺序整个反掉。已把 `medium` 与 `mid` 都认，并加了一条用真实取值的测试。

**两个仍是猜的（真机第一轮就会暴露）：**

1. `ctx.get('sessionController')` 这一跳没在运行时验过（宿主文档与代码里确实有这个服务，
   方法名 `prompt(request, signal)` 也确认了）；
2. `prompt` 的**请求体字段名**是按文档语义猜的（`{sessionId, content:[{type:'text',text}]}`），
   宿主是 `typert` 生成的 schema，字段名可能不叫这个。发不出去时不致命 —— `send` 抛错
   会被 waker 捕获并写一行日志，三条通道照常。

**因此 `hasUserMessageSince` 先传 `null`**：走票里写好的保守分支（不计数、只保留主动唤醒、
不自动停）。等第 2 条确认后再接 `sessionQuery.filterEvents`，「5 次自动停」那条才会生效。
