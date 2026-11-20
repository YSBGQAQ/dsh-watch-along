# 声音只保留 faster-whisper large-v3-turbo，不做人声分离

三档引擎取舍之后只留一条链：WASAPI 环回 → better-ears 的 VAD / 分窗 / 幻觉过滤 → faster-whisper large-v3-turbo（GPU）。**不做 MDX 人声分离，不保留 SenseVoice 作快档。** 理由：内容判别加人声分离要多付约 1.7 秒/句和整套 ONNX 依赖，而主场景是游戏直播——主播说话占主导，BGM 是背景；SenseVoice 的保留价值只剩「GPU 不可用时的退路」，为了让那条退路成立要多养一套模型，不如改成明确报错。

**Consequences**

- **BGM 压过人声时会掉字**，且唱歌会被当说话转写——MV / 音乐区不适合这个方案。以后要补分离，它是一个开关，不是地基。
- GPU 依赖（`cublas` / `cudnn`）缺失时，faster-whisper 会退到 CPU int8，那是 1× 实时、等于不可用。这种情况必须**显式报错**，不许静默变成没有字幕。
- 时间码一律用 epoch 毫秒，不用样本数累加：WASAPI 静音时不推数据，样本计时会永久漂移。
