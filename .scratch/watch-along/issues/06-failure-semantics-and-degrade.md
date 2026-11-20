# 06: 故障语义与单通道降级

**What to build:** 任何一条通道坏掉，其余照常工作，状态里能查到"谁坏了、为什么"。采集结束一律当错误处理，不假装正常停止。

**Blocked by:** 01, 04, 05

**Status:** ready-for-agent

- [ ] 关掉直播窗口 → 三条通道全部 `failed`，`reason` 写明是采集结束
- [ ] 杀掉 OCR 服务 → 只有字幕 `failed`，画面与声音继续产出事件
- [ ] 占满显存 → 声音 `failed` 且 `reason` 指出是 GPU 不可用
- [ ] `watch_status` 对每条通道返回 `state`（idle/running/degraded/failed）与 `reason`
- [ ] 任一故障都在日志里留下一行可读的原因，不是堆栈
- [ ] 恢复后重新 `watch_start` 能重新起来（不要求自动重试）
