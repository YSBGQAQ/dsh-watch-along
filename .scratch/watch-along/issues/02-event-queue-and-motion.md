# 02: 事件队列与变化事件

**What to build:** 画面变化变成可读的短事件，进同一条队列；AI 用长轮询按 `sinceId` 增量读，断线或落后都能补齐。静止的画面什么也不产生。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 静止画面连续 10 秒产生 0 条事件
- [ ] 画面出现明显变化后产生 `motion` 事件，带 `strength` / `where` / `peak` / `cells`
- [ ] 连续运动（非切镜）不产生 `motion` 事件
- [ ] `watch_events({sinceId:n})` 只返回 id 大于 n 的事件，并给出 `nextId`
- [ ] 无新事件时长轮询到点返回 `timedOut: true`，不报错
- [ ] `sinceId` 早于内存最旧事件时返回 `staleSince: true`，并从最旧给起（不跳过中间）
- [ ] 内存持有上限 500 条，超出丢最旧；磁盘保留 2000 条
