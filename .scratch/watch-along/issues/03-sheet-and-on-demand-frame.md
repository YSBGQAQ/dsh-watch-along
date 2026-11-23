# 03: 拼图与按需取图

**What to build:** 攒到该看的时候，把若干帧按重要性排进一张图交给 AI；AI 问"现在什么样"时立刻给一张最新的。同一张图重复取不重新编码。

**Blocked by:** 02

**Status:** closed（2026-11-23 实机验证：事件带 `sheetId`、`watch_frame({sheetId})` 返回 `cached: true`、`live: true` 立刻出新图；每轮拼图 100% 成功）

- [ ] 有画面变化时 30 秒内至少产出一张拼图，事件里带 `sheetId`
- [ ] 拼图尺寸与帧数符合档位逻辑（帧多则格子小，帧少则格子大）
- [ ] `watch_frame({sheetId})` 取回同一张，返回 `cached: true`
- [ ] `watch_frame({live:true})` 立刻产出一张新图，不等判据与配额
- [ ] 单张拼图的 token 估算 ≤ 250
- [ ] 图落盘后事件只保存 `sheetId`，事件体里不含像素
