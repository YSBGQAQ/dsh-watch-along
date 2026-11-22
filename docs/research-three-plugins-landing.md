# 三插件落地对照：能直接提升 / 不能直接抄 / 本地已有代码

调研日期：2026-11-22
材料：作者自述 `看视频插件三件套-原理解析.视频内容说明.md`（770 行）、三个只读源码 zip、项目 `vendor/` 一手源码。
本篇是**落地清单**（每条给出本地文件与行号）；生态层面的调研与来源 URL 见 `docs/research-dsh-realtime-asr.md`。

## 一句话结论

作者自述里那套画面算法（HSL 切点、积分取帧、拼图装箱）**我们项目里已经全有了**，不用重做。能提升的集中在 **ASR 管线**与**回环语义**，且多数零依赖。SenseVoice 路线不是不能换，而是**现在换测不出结论**——断流 bug 和录音输入两个问题还在，换完分不清是模型变好还是老毛病没修。

---

## 0. 本地已有代码资产（不用联网、不用下载，可直接打开参考）

| 本地路径 | 是什么 | 关键行 |
|---|---|---|
| `vendor/dsh-see-now-main/examples/floating-chat/listen.py` | WASAPI 实时环回采集 + 静音断句，作者踩坑全写在开头 | `:2` 定位；`:14-17` 库选型；`:24-25` 静音不推数据；`:27-28` 声道顺序；`:37-43` device/process/auto；`:344-352` `.tmp`+原子 rename；`:355-360` 静音补格 |
| `vendor/dsh-see-now-main/examples/floating-chat/procloopback.py` | 进程级环回，纯 ctypes 零依赖 | `:2` 定位；`:74-78` `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` |
| `vendor/dsh-see-now-main/src/listen.js` | 环回 wav → 转写服务 → `{t0,t1,text}` | `:8` 实时无捷径；`:12-15` 链路；`:30-32` 三级降级；`:193` 默认 paraformer；`:205-208` 转交音频 |
| `vendor/dsh-see-now-main/src/pipeline.js` | 画面判据完整实现（**项目已在用**） | `:94` `cutAbs:12`；`:256-260` 亮度归一+黑边；`:444` fps 折算；`:547` 积分阈值；`:991-993` 尖峰+台阶；`:1064` 地板+尖峰 |
| `vendor/dsh-see-now-main/README.md` | 作者实测数据与局限 | `:374-376` 要什么；`:400/:409-410` 开销与 0.6s 延迟；`:413-415` live 快照；`:444-453` 局限；`:725` listen.py 归属；`:767-777` 许可证协议 |
| `vendor/dsh-see-now-main/docs/调参与实测.md` | 判据调参矩阵 | `:33-55` cutAbs 25/15/12/7；`:59-74` 地板管够不够大、尖峰管是不是一下子 |
| `vendor/dsh-soundtry-main/python/soundtry.py` | `--prompt` / `initial_prompt` 的现成实现 | `:851` 223 token 上限；`:1141` 传入；`:1189` **第二轮特意设 None** 防强行对齐歌词 |
| `C:\Users\24206\Desktop\源码与作者说明\dsh-realtime-subtitles-main.zip` → `engine/engine.py` | 草稿/终稿双模型实时字幕（843 行） | `:57-61` 100ms/30ms/360ms/270ms；`:115/:346` 只取 `[:,0]`；`:197/:217` WhisperModel；`:252-256` 双模型；`:275-279` **终稿清草稿**；`:319-347` VAD 回退能量；`:409-413` 静音 trim；`:743/:751/:756/:774/:776` soundcard 环回 |
| `C:\Users\24206\Desktop\源码与作者说明\dsh-live-voice-main.zip` → `docs/CHOOSING-AN-ENGINE.md` | 引擎选型实测建议 | `:11-17` 中文推荐 Qwen3 ASR / Whisper HTTP（2–3GB RAM） |
| 同上 → `packages/live-voice/deploy/attendee/audio_bridge.py` | 本地 WebSocket 音频中转（**不是** WASAPI 环回） | `:1` 定位；`:136` ingestUrl |
| 同上 → `README.md` | 会议语音助手定位 | `:77` 共享音频与麦克风分离控制 |
| `docs/reference-projects.md` | 项目自己的竞品笔记 | `:176` 四家不抓系统声音；`:191` **OCR 字幕当 initial_prompt** 的跨模态点子；`:195-201` 双引擎定案 |
| `.scratch/watch-along/issues/17-process-loopback.md` | 我们想做但只做了配置面的票 | 全文；「为什么只做了配置面」 |
| `.scratch/run/verify_ocr_quality.py` / `eval_1330.py` | 评估尺子（0–300s / 148 条字幕 / 827 bigram） | 全文，换模型前后用同一把尺子 |

---

## 1. 三个插件定位（一句话）

| 插件 | 干什么 | 与我们的关系 |
|---|---|---|
| **see-now**（三件套作者，vendor 里全量源码） | 实时看屏幕 + WASAPI 环回听「电脑正在放什么」 | **最对标**，采集与断句几乎同构；画面算法已被我们复用 |
| **realtime-subtitles**（oreo0614） | WASAPI 环回 → WebRTC VAD → faster-whisper tiny/base(CPU) → 滚动字幕 | **最同构**，同为 soundcard 环回 + 本地 whisper；差在小模型 CPU、输出给人看 |
| **live-voice**（454 文件） | 会议语音助手：麦克风 + 共享音频 + Qwen3 ASR/Whisper HTTP | 不是 WASAPI 环回；引擎是云/HTTP，与「音频不离机」冲突 |

---

## 2. A 类：能直接提升的方案（别人的优化思路）

> 「改哪里」一列全部是**本项目内的文件**，无需联网、无需下载（除标注外）。

### A1 · 修掉静音早退不裁剪缓冲（断流主因）
- **别人的思路**：`listen.py:24-25` 与 `anchoredship` 都踩过「WASAPI 静音不推数据」；`engine.py:319-347` 用状态机而不是「整段 rms」判断有声。
- **我们的问题**：`python/asr_service.py:304` `if rms < 0.001: return` 是**提前返回**，跳过 `:351-354` 的缓冲裁剪 → 缓冲实测堆到 823 秒（上限本该 40 秒），而 `rms` 对整段算、被历史静音稀释 → 之后有声音也判静音；`:348` 的 6 秒强推排在早退之后，执行不到。
- **改哪里**：`python/asr_service.py:283-305`（早退前先裁剪 / rms 只算最近 N 秒）、`:351-354`（裁剪逻辑抽成公共函数）。
- **依赖**：无。**预期**：ASR 覆盖率从 15.7% 回到 40–52% 的历史稳定带。

### A2 · 核对声道混合顺序（可能关联「波形相关 0.007」）
- **别人的思路**：`listen.py:27-28` 原文「先混单声道再降采样，顺序错了会双声道相位抵消，ASR 只认出『嗯。』」；`engine.py:115/:346` 明确 `block[:, 0]` 只取一个声道。
- **我们的问题**：`python/asr_service.py:146` 请求 `channels=1`，`:149` 拿到数据直接 `.reshape(-1)` 拉平。若 `soundcard` 实际返回 `(N, ch)`，拉平会把左右声道交错。
- **改哪里**：`python/asr_service.py:146-151`，先打印一次 `chunk.shape` 实测，再按 see-now 的 `reshape(-1, ch).mean(1)` 混合；配合 `WATCH_ALONG_DUMP_RAW=1` 与 mp3 做波形比对。
- **依赖**：无。**预期**：可能直接解决长期查不出原因的「环回录音和 mp3 不是一回事」。

### A3 · 静音补时间格 / wall-clock 时间码
- **别人的思路**：`listen.py:355-360` 「静音格子显式补 -120dB，时间轴才连续」；ADR 0003:9 已抄了「不用样本数累加」。
- **改哪里**：`python/asr_service.py:271-305`（`pull()` 的时间基准），必要时 `index.js` 的 `t0/t1` 展示。
- **依赖**：无。

### A4 · 终稿一到就清掉待处理草稿（防过期文本覆盖）
- **别人的思路**：`engine.py:275-279` `submit()` 里 `if chunk.get("final"): self.items = [i for i in self.items if i.get("final")]`；`:252-256` 终稿优先于草稿。
- **改哪里**：纯逻辑，可先落在 `src/ocr.mjs:296-302`（`seen`/`emitted` 状态）或 `index.js` 的事件派发处；若将来做草稿/终稿，直接照这段写队列。
- **依赖**：无（双模型本身要下载，见 A5）。

### A5 · 草稿 + 终稿双档降首字延迟
- **别人的思路**：`engine.py:57-61` 360ms 草稿 / 270ms 定稿；`README.md:413-415` see-now 的「说满 1.8 秒先转一版 live 快照，首版字幕 3.30s → 2.08s」。
- **改哪里**：`python/asr_service.py:252-268`（`transcribe()` 支持两档）+ `src/events.mjs` 增加「覆盖同一 id」的事件形态。
- **依赖**：**要下 tiny/base 约 220MB**（按 AGENTS.md 下载必须交办用户）。

### A6 · `beam_size` 与 `initial_prompt`（零成本）
- **别人的思路**：`soundtry.py:1141` 传 prompt、`:1189` 第二轮去掉；`docs/reference-projects.md:191` 早就写了「用屏幕 OCR 的字幕做 whisper 的 initial_prompt」。
- **改哪里**：`python/asr_service.py:252-261`（`beam_size=1` → 5，加 `initial_prompt`）；prompt 内容取 `src/ocr.mjs` 已产出的字幕文本，用现成的 `similarity()`（`src/ocr.mjs:11`）挑最近一行。
- **依赖**：无。**注意**：别一直挂着 prompt，soundtry 的教训是会把识别结果硬拉向提示内容。

### A7 · 意图 ≠ 可用性（关窗判据）
- **别人的思路**：作者自述 §4.8 / §7 第 12 条「心跳抖一下、机器睡了一觉就被判成用户关窗，会话再也回不来」；`README.md:450-452` 关窗语义。
- **我们的问题**：`src/service.mjs:121-126` `onCaptureEnded` 把任何采集结束一律置 `state='failed'`，三条通道全停。
- **改哪里**：`src/service.mjs:121-132`，区分「主动 stop」「窗口真的关了/最小化」「流抖动可恢复」。
- **依赖**：无。

### A8 · 幻觉词表 / 无人声不送识别
- **别人的思路**：`dsh-better-ears-main/lib/asr.js:26` 中英幻觉词表 + `looks_hallucinated()`；`README.md:449-453` see-now 自述「对音乐吐幻觉歌词」。
- **改哪里**：`python/asr_service.py:_looks_hallucinated()`（`grep -n` 定位）与 `src/ocr.mjs:217-221` 的 `MUTE_AFTER` 静音规则。
- **依赖**：无。

### A9 · 参数描述与枚举一致性 / 溢出静默丢失
- **别人的思路**：§7 第 13 条「工具骗模型，然后我们怪模型」、第 14 条「44% 折进溢出文件，模型从来没读过；宁可在边界停住并告知区间」。
- **改哪里**：`docs/downloads.md` / `docs/adr/0002` / `README.zh.md` 里残留的过时参数值；`src/events.mjs:16-20` 已有 `dropped` 计数，但要确认客户端能感知「已落后到边界」而不是静默拿后半段。
- **依赖**：无。

### A10 · 进程级回环（票 17 的现成答案）
- **别人的思路**：`vendor/dsh-see-now-main/examples/floating-chat/procloopback.py` 纯 ctypes、零依赖，`:74-78` 常量；`listen.py:37-43` 的 `auto` 先试进程、失败回落整机。
- **改哪里**：`.scratch/watch-along/issues/17-process-loopback.md` 里写明的「替换 `_capture_loop()` 的设备来源」，即 `python/asr_service.py:120-146`。
- **依赖**：无下载，但约 300 行代码，工作量最大。

### A11 · 三级降级
- **别人的思路**：`src/listen.js:30-32`（宿主 SenseVoice → `~/.dsh/asr.json` → 不出字幕）、`dsh-better-ears-main/lib/asr.js:408-421`（host/http/command/auto）。
- **改哪里**：`python/asr_service.py:96-115`（`load()`）现在只有「GPU 起不来就报错」一档，可加一个可选 CPU 档。
- **依赖**：降级到 SenseVoice 要下模型（见 B1）；降级到纯 CPU int8 零依赖。

---

## 3. B 类：不能直接抄的方案（SenseVoice 路线为主）

| 编号 | 方案 | 为什么现在不能抄 |
|---|---|---|
| **B1** | **整个换 SenseVoice / FunASR** | ① 要下 INT8 约 240MB，自装 FunASR 还要拖 `torch`/`torchaudio` 几个 GB（**下载按 AGENTS.md 必须交办用户**）；② `python/asr_service.py:252-268` 的 `WhisperModel` 整套要换，`load()`、模型路径、`WATCH_ALONG_WHISPER_DIR`、`setup.cmd`、`downloads.md`、ADR 0003 全跟着改；③ SenseVoice 给字级毫秒时间戳，`pull():309-324` 按秒级 `seg.start/seg.end` 算，要重做对齐；④ **最要命**：A1/A2 没修之前，换完测出的数字无法归因，测了白测。公开中文 CER 7.81% vs Whisper 20.02% 是别人的素材、别人的链路，没有一条在我们环回链路上验证过。 |
| **B2** | 直接把宿主 `speechToText` 当实时流用 | 官方 `speech-to-text-sensevoice` 是 **record-then-transcribe**（录一段、提交一次、单一 worker 串行），不是流式；且 `docs/reference-projects.md:165` 记着「这台机器 `.dsh` 里没查到，要验一次」，语音输入 bundle 默认关闭。see-now 的做法是**自己切好 3 秒 wav 再一段段交**，不是把宿主当流。 |
| **B3** | live-voice 的引擎与音频桥 | `docs/CHOOSING-AN-ENGINE.md:11-17` 推荐 Qwen3 ASR / Whisper HTTP（云或 HTTP，2–3GB RAM）；`audio_bridge.py` 是容器内 WebSocket 中转，**不是 WASAPI 环回**。与「音频不离机」定案冲突，只能借鉴 `README.md:77` 的「共享音频与麦克风分离控制」。 |
| **B4** | 人声分离（MDX-Net / Demucs） | ADR 0003 已砍；`dsh-soundtry-main/README.md:36/53` 的 2.3× 实时是 **CPU 离线整首**的尺子，拿它否定实时方案不成立；oreo0614 与 drliuhuan 两个实时方案也都没做分离。 |
| **B5** | 浏览器 `getUserMedia` / `MediaRecorder` / `AudioWorklet` 链路 | 抓的是麦克风 capture endpoint，抓不到系统输出；`dsh-pinpu` 作者实测本机立体声混音被禁用、`navigator.mediaDevices` 不列出。 |
| **B6** | 照抄作者自述的画面算法 | `vendor/dsh-see-now-main/src/pipeline.js` 已全量实现（见 §0）；`src/service.mjs:12` 的 `cheapDiff` 只是默认关闭的 spike 扳机，注释已写明「真正的判定仍在 pipeline 里」。 |
| **B7** | 把批量版阈值抄到实时版 | 作者自述 §4.9 / §5.5：批量版窗宽 100 帧、阈值是「每帧碰上切点的概率」；实时版 12 帧、单位是「每秒几次」。**同名阈值表单位相反，抄错差 30 倍**。 |
| **B8** | `dsh-watch-together` 的播放位置驱动 | 靠浏览器扩展报 `<video>.currentTime` + yt-dlp 字幕轨，是「跟着播放进度交付」，与「系统正在播什么就实时转写」两种时钟模型；且公开仓库里没有 `listen.py`（见 `research-dsh-realtime-asr.md` 存疑节）。 |

---

## 4. 建议执行顺序（等用户拍板，本轮未改代码）

1. **P0（零依赖、正对最痛）**：A1 修断流 + A2 核声道。做完用 `WATCH_ALONG_DUMP_RAW=1` 验证环回录音，再用 `.scratch/run/eval_1330.py` 的同一把尺子看 ASR 是否回到 40–52%。
2. **P1（零依赖、小改）**：A3 静音补格、A6 `beam_size` + OCR prompt、A7 关窗语义、A9 文档一致性。
3. **P2（零依赖、工作量较大）**：A4 终稿优先、A10 进程级回环、A11 降级链。
4. **P3（需下载，交办用户后再评估）**：A5 双档草稿；只有 P0–P2 稳定后，**B1 换 SenseVoice** 才是一次能作数的对比测试。

---

## 5. 约束与存疑

- **下载限制是谁下的**：AGENTS.md 规定所有下载必须交办用户，agent 不许私自拉取。所以 B1 / A5 的模型不会自动装，不是能力不足，也不是用户没配好。
- **效果数据都不可当定论**：see-now 的 0.6s / 130–160ms、oreo0614 的 360ms/270ms、各引擎 CER，全是作者自述或公开榜单，**没有第三方复现，也没有在我们环回链路上的字错率**。
- **`soundcard` 三方结论冲突**：`listen.py:14` 说恒返回 0、`docs/reference-projects.md:166-168` 本机实测 440Hz 可用、`engine.py:751/756` 用它抓环回成功——设备/驱动差异，未复测。
- **路径是本机绝对路径**：桌面 zip 与 vendor 路径换机器需替换；zip 建议只读（`Python zipfile`），不要解压污染工作区。
- **评估口径必须固定**：0–300 秒 / 148 条字幕 / 827 bigram；换模型前后用 `.scratch/run/verify_ocr_quality.py` 与 `eval_1330.py` 同尺子，否则数字不可比（票 12 已踩过口径坑）。

## 6. 落地结果（2026-11-22，票 21 收口）

| 条目 | 结果 |
|---|---|
| **A1 静音早退不裁剪缓冲** | **已修**。另外实测挖出两条本文没写到的真因：①采集线程/录音流卡死后无人重启——`start_capture()` 只判断「有没有线程对象」，线程死了对象还在；②游标被「整段落在游标之前的残句」钉死——`segs>0` 就不许推进游标的保护被同一句残句触发。两处都在 `python/asr_service.py` 修掉，回归测试见 `python/test_asr_pull.py`。 |
| **A2 声道混合顺序** | **本机不成立**。探针 `.scratch/run/probe_channels.py` 实测 `channels=1` 回 `(n,1)`，`.reshape(-1)` 是无害空操作，不存在相位抵消，也解释不了「波形相关 0.007」。仍加了 `_to_mono()` 闸防设备行为变化。 |
| **A3 静音补格 / wall-clock 时间码** | 未做。出口判据已过，做了反而让后续对比无法归因。 |
| **A6 `beam_size` + `initial_prompt`** | **只做 beam**：1 → 5，线上 81.5% → **85.9%**，逐句 79.7% → 83.8%，p90 218ms（3 秒预算的 7%）。扫描数据见票 21。`initial_prompt` **永久不做**（用户决定：换内容会误导）。 |
| **A7 意图 ≠ 可用性** | 未做。 |
| A4 / A5 / A8 / A9 / A10 / A11 | 未做，不属票 21 范围。 |
| **B1–B8（换 SenseVoice）** | **整条取消**（用户 2026-11-22 决定，理由见票 21）。 |
