# 16: 一次性的图交给子代理，主会话只收结论

**What to build:** 现在每张拼图/帧都直接进主会话，看久了上下文会被图撑爆（see-now 把这件事叫「看久了会变贵」）。
改成：取图 → 交给一个一次性子代理去"看"，主会话只拿回一段结论文字。

**Blocked by:** 03

**Status:** resolved（2026-11-22 用户决定**本轮暂不做**：能力已静态核实可行，排在票 11 与票 09 之后再说）

参考：`vendor/dsh-see-now-main/docs/subagent-context.md`（含实测数据与失败边界）

- [ ] `watch_frame` 返回的图**不再默认进主会话**，改为投递给子代理
- [ ] 子代理返回结构化结论（看到了什么 / 在哪 / 值不值得说）
- [ ] 主会话只拿到结论文本（不含图片字节）
- [ ] 配置项 `imageSink`: `attachment`（老行为）/ `subagent`（新），默认 `subagent`
- [ ] 图上仍保留 `file` 路径，需要原图时能回查

## 为什么不直接读图
一张 798×450 的 PNG 约 250KB；陪看一小时按 4 条/分钟算会取几十张图，
主会话上下文会被完全占据 —— 而其中大部分图 AI 只看一眼。

## 可行性（2026-11-22 静态核实，宿主 `E:\Program Files\DeepSeek Harness`）

之前这张票被标成「依赖宿主能力、未验证」。查了宿主自带的文档与真实代码，**三个必要条件都在**：

| 条件 | 证据 |
|---|---|
| 能起一次性子代理 | `ctx.subagents` 是宿主 `core` 的 seam，所有后端统一走 `startActivation`；实现里有 `subagent-spawn-in-process` / `subagent-fork-in-process` / `subagent-acp` / `subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk` |
| 能不继承父上下文 | provider 上有 `readonly inheritsParentContext: boolean`（`dsh-subagent/src/types.ts`） |
| 能有精简预设 | provider 能力位里有 `capabilities.agentPreset`，文档明确写「Requires a provider with `capabilities.agentPreset` that does not inherit…」 |

见 `docs/subsystems/subagent.zh.md`、`docs/capability-seams.md`。

**所以这张票不是「做不到」，是「能做但没做」。** 但两条前提仍要在实现时落实：

1. 插件 ctx 里 `ctx.get('subagents')` 这一跳没在运行时验过；
2. 必须**同时**拿到「不继承上下文」+「精简预设」，只拿前半条会比现在更贵（见上文失败边界）——这条是它和普通「起个 subagent 看看图」的本质区别。

## 为什么原作者要绕这一圈

票里原来的理由（「图把主会话撑爆」）只对了一半。查到的完整动因是三层叠加：

- 宿主有硬限制：单请求图片超 20 MiB 就**永久把最老的图换成占位文字**，改的是会话历史本身；
- 历史一改，前缀缓存从改动点往后**全部失效**，那段整段重算——惩罚是全量的，不是线性的；
- 「先堆进去再挖洞」（offload）两头付费。

而且真正省下的大头**跟图片无关**：8 万 → 2.2 万那一截砍的是「系统提示 + 工具表 + 技能目录」，图片只占 2.2 万里的 1–2 千。

## Answer

**本轮不做（2026-11-22 用户决定），但结论是"能做、只是没排上"，不是"做不了"。**

- 可行性已静态核实：`ctx.subagents`（core seam，统一入口 `startActivation`）、provider 上的
  `inheritsParentContext: boolean`、能力位 `capabilities.agentPreset` —— 三个必要条件在宿主里都在，
  见上面「可行性」一节。
- 拾起时第一步仍是运行时确认 `ctx.get('subagents')` 那一跳（静态核实只能证明宿主内部有这个服务）。
- 做的时候必须**同时**拿到「不继承上下文」与「精简预设」；只拿前半条会比现状更贵 ——
  单次看图主模型 222 token、子代理一轮约 2.2 万，差两个数量级。

## 为什么排在这一轮之后

票 11（主动唤醒）与票 09（稳定性压测）排在这一张之前：11 会改插件侧、09 必须跑在最终代码上，而本票只影响"看图怎么投递"，不阻塞它们。

## 失败边界（see-now 记过，先用他们的）

子代理上下文不是白嫖：子代理自己也要装图、也要花 token。真正的收益是
**主会话不被长期污染**，而不是"零成本"。
