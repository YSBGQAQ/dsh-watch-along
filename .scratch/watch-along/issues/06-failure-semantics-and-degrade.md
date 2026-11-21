# 06: 故障语义与单通道降级

**What to build:** 任何一条通道坏掉，其余照常工作，状态里能查到"谁坏了、为什么"。采集结束一律当错误处理，不假装正常停止。

**Blocked by:** 01, 04, 05

**Status:** done（tset 覆盖，见 test/failure.test.mjs）

- [x] 采集流断掉 → 状态 `failed`，`reason` 带上游错误（测试：ffmpeg 退出码 1）
- [x] 字幕通道抛错 → 画面照常出事件，整体仍是 `running`（测试）
- [ ] 占满显存 → 声音 `failed` 且 `reason` 指出是 GPU 不可用
- [x] `watch_status` 给得出 `state` 与 `reason`（测试：idle → running → idle）
- [ ] 任一故障都在日志里留下一行可读的原因，不是堆栈
- [ ] 恢复后重新 `watch_start` 能重新起来（不要求自动重试）
