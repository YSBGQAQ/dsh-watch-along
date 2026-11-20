# dsh-better-ears 宣传片（B 站）

成片：`dsh-better-ears-bilibili-1080p.mp4`（91.9 秒 / 1920×1080 / 30fps / H.264 + AAC 48kHz / −16.1 LUFS）
封面：`dsh-better-ears-cover.jpg`（1920×1080）
字幕：`dsh-better-ears.srt`（23 条，可直接上传）
发布文案：`发布文案.md`

片子里出现的数字都来自 dsh-better-ears 在你机器上的真实输出（music-120-am.wav / speech-zh.wav / aligned.mp4 / offbeat.mp4）。画面是「实机输出 + 界面复现」的动效，不是屏幕录制；测试素材是合成的音视频，切点就是色块切换。

---

## 章节

- 0:00 为什么做
- 0:11 七个工具
- 0:23 音乐：120 BPM、C 大调、两段式、A–F–C–G
- 0:40 语音：22.5s 音频，0.76s 本地转写，时间戳与 SRT
- 0:53 视频：对齐版 6/6，错位版 2/7
- 1:09 实现：命令行解码 + 自写 DSP + DSH 自带识别器
- 1:24 收尾：10 项测试全过，MIT

## 重建

旁白用 Edge 神经语音（zh-CN-XiaoxiaoNeural，rate -12%，pitch -2Hz），比系统 `say` 自然；品牌词在音频里写成 `DSH·ears`，中间点让 TTS 停顿，避免连读成 “DSH cheers”。

```bash
# 0. 依赖
python3 -m pip install --target .pydeps edge-tts

# 1. 旁白（改文案后重跑）
PYTHONPATH=.pydeps python3 gen_voice.py
for i in 1 2 3 4 5 6 7; do
  ffmpeg -y -i narration/S$i.mp3 -ar 48000 -ac 1 narration/S$i.wav
done

# 2. 按实测时长更新 timeline.py 的 SCENES / DURATION
#    lead 0.45；每场尾部留 1.0–1.4s 给转场和呼吸

# 3. 混音（旁白 + 原创氛围垫乐），响度归一到 -16 LUFS
python3 build_audio.py
ffmpeg -y -i audio_mix_raw.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 \
  -ar 48000 -ac 2 audio_mix.wav

# 4. 字幕
python3 -c "import timeline; timeline.write_srt('dsh-better-ears.srt')"

# 5. 渲染
python3 build_video.py --render
```

`build_video.py` 用 PIL 逐帧画 1920×1080，PNG 管道喂给 ffmpeg（libx264、preset medium、crf 18、yuv420p、30fps、AAC 192k、`+faststart`），音轨用 `audio_mix.wav`。

## 改的时候注意

- 场景函数收到的是局部时间 `t - sc['start']`；直接用全局时间会让第二场起动画一开始就全亮。
- 中英混排用 `draw_mixed` / `typed_mixed`，否则 PingFang 遇到 Menlo 字符会出豆腐块。
- S5 百分比要 `round`，否则 0.29 会显示 28%。
- S7 结束时间可能比 `DURATION` 早一帧，取场景时用 `next(..., SCENES[-1])` 兜底，避免 `StopIteration`。
- `SCENE_FN` 注册块放在所有 `s1`–`s7` 定义之后、`__main__` 之前。
- 根目录的 `dsh-better-ears-bilibili-1080p.mp4` 是交付成片；`out/` 里是早期并行版本的 78 秒旧片，不要上传。
