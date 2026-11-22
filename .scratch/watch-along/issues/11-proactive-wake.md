# 11: 主动唤醒（proactive wake）

**What to build:** 陪看不再只等你问。出现值得说的事时，主动往**开启陪看的那个会话**塞一条 user 消息，让模型自己开口。没有值得说的事就闭嘴；你睡着时要自己停下来。

**Blocked by:** 02（事件队列）

**Status:** claimed（接线按 `agent.steer` 完成，等一次重启做实机验证）

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

- ADR 尚未单独成文（决策表在本票里；如需长期留档，另写 `docs/adr/0006-proactive-wake.md`
  —— 注意 **0005 已被 `0005-koffi-capture.md` 占用**，别再写 0005）
- 播报（TTS）不在本票范围

## Comments

### 2026-11-22 关键发现：机制选错了，这张票要重设计（不是"做不到"）

**宿主探测（一次生效的重启，`11:51:44Z` 那一轮真实加载）：**

```
宿主能力探测：{"attachments":true,"sessionController":false,"propSessionController":"throw",
             "session":false,"agents":false,"remote":false,"remoteSession":"throw"}
插件 ctx 的自有键：fiber
```

读法：

- `attachments: true` —— `ctx.get()` 这条通路**是通的**（出图就靠它）；
- `sessionController / session / agents / remote` 全是 `false` —— 会话类服务**不在插件作用域**；
- `propSessionController: "throw"` —— 直接访问 `ctx.sessionController` 会**抛**。上一轮插件加载崩掉就是这一句（没包 try/catch），已修；
- `Object.keys(ctx)` 只有 `fiber` —— ctx 是代理，`get()` 才是唯一入口。

**结论：宿主对外部插件的契约是"注册工具"，没有"往会话塞消息"这条路。** 所以票面写的机制
（塞一条 user 消息把模型叫醒）在这个宿主上**走不通**，再试名字也没用。

### 但原始实现根本不是那么干的

回看那 29 分钟的讲解 §3.7，作者说的是：

> AI 执行任务时处于**阻塞等待**，收不到任何指令……它在等**任务完成时给出的信号**。
> 所以：给我们的输入也挂上这样一个信号。

也就是说，**主动搭话靠的是"模型本来就卡在一个等待工具里"，插件往那个通道喂字** —— 不是注入消息。
而我们的 `watch_events` **已经有长轮询**（`waitMs`，见 `service.mjs:273`）：

> 读事件。`waitMs > 0` 走长轮询，没事件就等到点返回 timedOut。

**所以这条功能的正确形态是：让模型挂着 `watch_events({waitMs})` 阻塞，事件一到工具自然返回，
模型就开口。** 完全在"注册工具"这个契约之内，不需要宿主给任何新能力。

### 作者真正的做法（2026-11-22 读代码核实，`vendor/dsh-see-now-main/src/timer.js`）

**不是注入消息，是拿 agent 句柄直接「塞」给它：**

```js
// timer.js:69
export function deliverToAgent(agent, text, { mode = 'steer' } = {}) {
  const message = userMessage(text)          // {id, role:'user', content:[{type:'text'}], source:{kind}}
  if (mode === 'steer' && typeof agent.steer === 'function') {
    agent.steer(message)                     // 下一个 step 就交给模型，正在跑的轮次也立刻看得见
    return { ok: true, via: 'steer' }
  }
  agent.followup(message)                    // 否则排到下一轮
}
```

**agent 句柄从哪来——从工具调用的 run context 里拿，不需要任何服务：**

```js
// index.js:710
function callerSessionOf(run) {
  const session = run?.agent?.session               // ← run.agent 就是宿主给的 Agent
  const id = session?.header?.id ?? session?.id ?? null
  ...
}
```

`sessionController` 只用在**命令路径**里"按会话 id 反查 agent"（`controllerOf(ctx)`），
而且作者自己对它也做了防御（`serviceOf` 里把 Proxy 抛的错收住）—— 和我们探到的一样。

**所以票 11 完全可做，且不需要 `sessionController`：**

1. `watch_start` 的 `execute(args, run)` 第二个参数就是 run context，`run.agent` 拿到句柄；
2. 存下这个句柄 = **天然满足「目标会话 = 最后一次 watch_start 的那个会话」**（不用猜、不用 list）；
3. 唤醒时 `agent.steer(userMessage(text))`，失败退 `agent.followup`；
4. 消息形状照抄：`{id: randomUUID(), role:'user', content:[{type:'text',text}], source:{kind:'watch-along'}}`。

**我上一版写的「改用长轮询」是错的方向**（长轮询确实有，但不是作者的做法，也不需要为此重设计）。
判定层 `src/wake.mjs` 原样保留：它产出的就是一串 prompt 文本，`send` 换成 steer 即可。

### 2026-11-22 接线完成（等实机验证）

- **新增 `src/agent-delivery.mjs`**：`userMessage()` 造 user 角色消息，
  `deliverToAgent(agent, text)` 走 `agent.steer`，失败退 `followup`，两条都失败如实返回。
  **8 条测试**：消息形状 / 每次 id 不同 / steer 抛错要退 / 两条都抛要报失败 / 没 agent /
  空文本不发 / 只有 followup 也能用。
- **`watch_start` 的 `execute(args, run)` 现在收第二个参数**，把 `run.agent` 存下来。
  「目标会话 = 最后一次 watch_start 的那个会话」从此是**抓到的**，不是猜的 ——
  之前那个"取 `list()` 第一条"的妥协已删掉。
- waker 的 `send` 换成 `deliverToAgent(lastAgent, text)`，**完全不碰 `sessionController`**。
- **开关**：环境变量 `WATCH_ALONG_WAKE=1`，或建一个标记文件 `.scratch/run/wake-on`
  （给 DSH 设环境变量要改系统设置并重登，试验一次不值当）。
- 投递成功/失败都写进 `plugin.log`：`主动唤醒已投递：N 字` / `主动唤醒没发：<原因>`。

**验证步骤**（重启一次即可）：重启 DSH → 调 `watch_start` → 日志出现
`主动唤醒已绑定会话：<id>` → 等一次 `high` 或切镜 → 会话里冒出 `[陪看] …`，
日志出现 `主动唤醒已投递`。

**仍不生效的一条**：「连续 5 次没回应就停」—— 读会话历史要 `sessionController`
（宿主不给），`hasUserMessageSince` 仍传 `null`，走不计数分支。要做得另找读会话的路子。

### 2026-11-22 实机首测：机制通了，但我用错了投递方式（会话被打断）

`plugin.log` 那一轮：

```
12:00:41 主动唤醒：开
12:01:08 主动唤醒已绑定会话：session-b3547b0c…
12:01:51 主动唤醒已绑定会话：session-ef275bd6…   ← 两次 watch_start，绑了不同会话
12:02:06 主动唤醒已投递：40 字
12:02:23 主动唤醒没发：too-soon
```

**端到端是通的**：抓到了 agent、真的投出去 40 字、节流也生效。

**但用户看到的是"会话中断了，不是我自己停的"。** 原因查到了，在 see-now 的 CHANGELOG
（PR #56）里写着：

> `steer` → `next-step`（下一个 step 就交给模型）。**人在窗口里说的话**改走 `steer`，
> **机器自己叫的「有新画面了」仍走 `followup`**。

`steer` 是"人插话"的通道，会把消息塞进**正在跑的那一轮**里 —— 用它做主动唤醒等于抢轮次。
我是机器自己叫，必须走 `followup`（排队到下一个轮次，不打断当前这一步）。

**已修**：`deliverToAgent` 的默认 `mode` 从 `steer` 改成 `followup`；`steer` 只在显式指定时用
（留给"用户自己在窗口里说话"的场景）。日志同时补上会话 id 与投递方式，便于下次一眼看出
发给了谁、走的哪条路。

**待查的第二件事**：12:01 那两次 `watch_start` 绑的是**两个不同会话**
（`b3547b0c` 与 `ef275bd6`）。如果当时开了两个对话，唤醒会发给后绑的那个。
现在日志会打印 `→ session-…`，下次能直接看出来。

**因此票 11 不从"受阻"结案，改成"机制要换"** —— 判定层 12 条测试仍有效，接法换一条。

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

### 2026-11-22 实机探测：宿主没把 sessionController 暴露给插件

`plugin.log` 里那一轮真实加载（`2026-11-22T11:41:56Z`）打出：

```
主动唤醒：关（WATCH_ALONG_WAKE=1 打开）；sessionController=无
```

静态侧也对得上：宿主里它的注册是 `super(ctx, "sessionController", { namespace: "session" })`
（`dsh-api-session-controller/lib/index.js`），注册在**宿主 API 那个作用域**；
而第三方插件是被 `cordis.patch.yml` insert 进 **profile 作用域** 的。两个作用域不重合，
所以 `ctx.get('sessionController')` 拿到 null —— 不是名字写错，也不是加载时序问题。

**还差一个对照实验（要一次生效的重启）**：探测代码已把 `attachments` 一起打
（它是已知能拿到的，出图靠它）。若 `attachments:true` + `sessionController:false`，
就确认是"作用域隔离"而不是"`get()` 这条通路在插件里整个不可用"。届时再定接法：
找宿主给插件开放的路（`ctx.hostApi` / `ctx.remote.session` / 或申请把该服务挂到 profile）。

**因此本轮到此为止**：判定层 12 条测试全绿、逻辑完备，接线这一段单独拾起即可，不用重做。

### 审查指出、本轮没做的三条（spec 与实现不一致，得说清）

1. **「兜底：长时间无高质量事件时说亮点」整条没落地** —— 现在没有 `high`/`cut` 就永远不开口，
   空闲判定与定时器都还没有；票面验收也没覆盖这一条。等真机跑过再定要不要做。
2. **「目标会话 = 最后一次 `watch_start` 的那个会话」没按票面实现** —— 现在是
   `ctx.sessionId`（有就用）否则取 `sessionController.list()` 的第一条（宿主文档说按活跃度排序，
   通常就是当前这条）。票面的语义是"`watch_start` 时把会话 id 记下来"，而现在是**发送时才去查**，
   多会话并存时可能发错人。下一轮要改成 start 时记录。
3. **「最小间隔可配」「`wakeMaxMisses` 可调」只停在函数参数层面** —— `index.js` 没从设置里
   传值（settings 未接运行时，票 07 已关），实际固定 120 秒 / 5 次。与 `audioSource` 是同一个缺口。

### 2026-11-22 决策变更：跟 see-now 一致，"有动静就说"，不按强度筛

票面原写「AI 到精彩的地方会自动发话」，一度打算改成只认 `high`/`cut`。**用户拍板不这么改**：

> 那算了，改成和 see-now 一样就行……另外设置界面留三档可设置

理由：see-now 本来就是**有新帧就叫**（按节奏，不按强度），"只在高潮说"会让慢节奏片十几分钟不吭声，
陪看感没了。代价是费 token，用户接受。

**它的 loop 不能直接复用**：`src/loop.js` 绑死在它自己的 `runner` / `pipeline` / `speech` / `window` 上。
做法是**照规则重写、常量原样抄**（行为对齐、代码独立），对照表：

| see-now | 我们 | 状态 |
|---|---|---|
| 有新帧就叫，不筛强度 | `hasNews()` = 有新事件 | ✅ |
| `noteActivity` 一次只许一条在飞 | `inFlight` + 工具调用记账 | ✅ |
| `PACES` calm 30 / normal 15 / dense 8 | 设置项 `wakePace` | ✅ |
| `MAX_AUTONOMOUS_WAKES = 8` | 设置项 `maxWakes`（1–200） | ✅ |
| `IDLE_STOP_MS = 3min` | 设置项 `idleStopMin`（0 = 不收工） | ✅ |
| `WAKE_MIN_GAP_MS = 8000` | dense 档的 8 秒即地板 | ✅ |

**尚未实机跑过**：循环只在 `watch_start` 之后起跑，部署后还没触发过一次完整链路
（日志里最后一条投递是 20:33，早于循环上线）。验证方式：DSH 里说"开始陪看"，
`plugin.log` 应出现 `陪看循环已启动`，随后每隔 `wakePace` 秒最多一条 `唤醒投递 followup（flush=true）`。

---

## 关闭（2026-11-23 01:30）——实机验收通过

用户连续实测三轮，最后一轮（01:25–01:29）确认可用：

> 这般很成功应该可以关闭工单准备压测了。

### 最终形态

**两条通道，限流在唯一发送点**（`src/wake.mjs`，调用方绕不过）：

| 通道 | 间隔 | 带图 | 输出 | 作用 |
|---|---|---|---|---|
| 观察 `observe()` | 5 秒（内部硬闸） | 是（`image` 字段） | 一个代码块、一行 | 让它一直看 |
| 说话 `maybeWake()` | `gapSec`（默认 30 秒） | 是 | 2–3 句评价 | 陪聊 |

**消息是紧凑 JSON**，5 个字段：`at` / `windowSec` / `image` / `events` / `prompt`。
事件项用键名承载类型：`say`（台词）/ `sub`（字幕）/ `motion`（画面变化，无文字时给"画面变化(12格)"）。

### 这一票踩过的四个坑（都写进了工作区记忆）

1. `onEvent` 里**每个事件都调一次 maybeWake** —— 8fps 下等于每秒叫好几次，
   把 loop 的 30 秒间隔整个绕过。这是"3 分钟 70 轮""6 条排队"的共同根因。
2. `restart()` 重置 `lastWakeAt` —— 模型每轮调 watch_start 就把间隔清零。
3. `watch_events` 默认长轮询 20 秒 —— 队列一直有新事件，于是立刻返回、自转。
4. 限流写在**调用方**（三次都栽在这）：只要有一处漏调或新增入口，闸门就废。
   现在搬进 waker 内部，观察 5 秒、说话 `gapSec`，任何调用方都绕不过。

### 已知取舍

- 消息频率不能超过模型一轮耗时，否则 DSH 队列涨。5 秒是实测能稳的下限。
- 想 1 秒一条必须去掉取图 —— 那时模型是在**猜**画面（旧版就是这样）。
