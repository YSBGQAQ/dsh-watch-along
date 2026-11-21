# 19: 图片链接的时效与不可猜测性

**What to build:** spec 第 18 条要求"图片链接有时效、过期即失效"。现在 `sheetId` 是 `sheet-1`、`sheet-2`，
**可猜、且永远有效**（只要还在最近 20 张里）。

**Blocked by:** 03

**Status:** done（2026-11-21）

- [x] `sheetId` 改成 `randomBytes(9).base64url`（12 位随机，不可猜）
- [x] 每张图带 `expiresAt`（默认 10 分钟，`WATCH_ALONG_SHEET_TTL_MS` 可调）；过期即删并明确报错
- [x] 事件体里仍只留 id，不留像素
- [x] 手机端与 `watch_frame` 走同一个 `service.frame({sheetId})`，同一套校验

## 现在的问题有多实际
服务绑 0.0.0.0、token 在日志里明文。**只要 token 泄露，任何人都能遍历 `sheet-1..20` 拿走截图。**
改随机串 + 过期，能把"泄露一次 = 永久可看"降成"泄露一次 = 十分钟内可看"。

## 实现说明
- 过期判断在 `frame()` 里，命中过期就 `delete` 并从这张图彻底消失（不占内存）
- 返回值多带 `expiresAt`，调用方可以据此提前刷新
- 测试用 `WATCH_ALONG_SHEET_TTL_MS=50` 制造过期，不靠改 `Date.now`（改不动，服务持有自己的 `now` 引用）
