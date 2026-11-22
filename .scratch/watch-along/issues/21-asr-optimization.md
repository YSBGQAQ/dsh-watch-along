# 21: ASR 优化（修 bug → 测 SenseVoice → 二选一收口）

**What to build:** 把 ASR 从「断流 + 录音失真」里救回来，用同一把尺子决定引擎选型，最后只保留一条链做最终测试与优化。

**Blocked by:** 无（票 12 已 resolved，只用它的口径与根因结论作基线）

**Status:** resolved（2026-11-22 收口：A1 修完 + 两处实测新增的修复、`beam_size` 1→5 线上验到 85.9%；A3/A7 与阶段二经用户决定不做，A6 只做 beam、`initial_prompt` 否掉）

**基线数字（2026-11-22）**：CPU 稳定轮 ASR **49.8%**（0–300s）；13:30 轮 **15.7%**（t1max 158.9s，断流）；同一个 turbo 模型喂干净 mp3 离线 **81.3%** —— 说明模型本身够用，差在录音输入与管线。

**口径三阶段共用，不许改**：字幕 JSON 0–300 秒 / 148 条 / 1050 字 / 827 bigram。脚本 `.scratch/run/verify_ocr_quality.py`、`eval_1330.py`。每阶段都报 bigram 覆盖率、逐句命中、t1max（断流位置）、资源曲线（`scripts/monitor-resources.py`）。换引擎前后必须同尺子，否则数字不可比（票 12 踩过口径坑）。

---

## 阶段一：修现有 bug（零依赖，先做）

> 依据：`docs/research-three-plugins-landing.md` 的 A1 / A2 / A3 / A6 / A7，含本地文件行号。

- [x] **A1 静音早退不裁剪缓冲（断流主因）**：`python/asr_service.py:304` 的 `if rms < 0.001: return` 是提前返回，跳过 `:351-354` 的缓冲裁剪 → 缓冲实测堆到 **823 秒**（`KEEP_SEC` 本该 40 秒）；`rms` 对整段算、被历史静音稀释 → 之后有声音也判静音；`:348` 的 6 秒强推排在早退之后，执行不到。修法：早退前也裁剪、`rms` 只算最近 N 秒、长静音时推进 `emitted_until`。
- [x] **A2 声道 / 降采样核对**：`python/asr_service.py:146-151` 请求 `channels=1` 后直接 `.reshape(-1)` 拉平。参考 `vendor/dsh-see-now-main/examples/floating-chat/listen.py:27-28`（顺序错会双声道相位抵消、ASR 只认出「嗯。」）与 `dsh-realtime-subtitles-main/engine/engine.py:115/:346`（只取 `[:,0]`）。先打印一次 `chunk.shape` 实测，再按 see-now 的 `reshape(-1, ch).mean(1)` 混合。**这条可能就是「环回录音与 mp3 波形相关只有 0.007」的老大难**。
- [ ] **A3 静音补时间格 / wall-clock 时间码**：`listen.py:355-360`，避免静音段时间轴断掉。
- [ ] **A6 零成本调参**：`python/asr_service.py:260` `beam_size 1→5`；`initial_prompt` 用 OCR 已产出的字幕文本（`docs/reference-projects.md:191` 的跨模态点子、`vendor/dsh-soundtry-main/python/soundtry.py:1141` 实现）。**注意** `soundtry.py:1189` 第二轮特意设 `None` —— prompt 一直挂着会把结果硬拉向提示内容。
- [ ] **A7 意图 ≠ 可用性**：`src/service.mjs:121-132` 现在把任何采集结束一律置 `state='failed'`、三条通道全停；作者自述 §7 第 12 条说这是最贵的错（心跳抖一下就被判用户关窗）。区分「主动 stop / 真关窗最小化 / 流抖动可恢复」。
- [ ] **验证**：开 `WATCH_ALONG_DUMP_RAW=1` + `WATCH_ALONG_DUMP_GAPS=1` 跑 5 分钟，确认 ①不再断流 ②t1max 接近 300 秒 ③原始录音与 mp3 波形相关性是否改善 ④资源曲线平稳。

**阶段一出口判据**：ASR 覆盖率回到 **40–52%** 历史稳定带且不再断流。没达到就停在这里，**不许进阶段二**（否则换引擎后数字无法归因）。

---

## 阶段二：测试 SenseVoice（需要用户下载，先交办）

> **下载是项目规矩下的限制，不是能力不足，也不是用户没配好**：按 AGENTS.md 所有下载必须交办用户，agent 不许私自拉取。

- [ ] **交办清单**：SenseVoice INT8 权重约 **240 MB**；若自装 FunASR 还需 `torch` / `torchaudio` 等几个 GB。另一条路是先验宿主 `speechToText` 是否可用 —— 但 `docs/reference-projects.md:165` 记着本机 `.dsh` 里没查到、语音输入 bundle 默认关闭，且官方 provider 是 **record-then-transcribe（录一段交一段）**，不是流式；see-now 的做法是自己切好 3 秒 wav 再一段段提交。
- [ ] **接线**：`python/asr_service.py:252-268` 的 `WhisperModel` → SenseVoice；`load()`、模型路径、`WATCH_ALONG_WHISPER_DIR` 跟着改。**时间戳形态不同**（SenseVoice 给字级毫秒，现有 `pull():309-324` 按秒级 `seg.start/seg.end` 算），要重做对齐。
- [ ] 同步 `scripts/setup.cmd`、`docs/downloads.md`、`_deps/requirements.txt`、ADR 0003。
- [ ] **同口径跑 5 分钟**，与阶段一结果并排：覆盖率、逐句命中、t1max、端到端延迟、内存 / 显存。
- [ ] 参考 `docs/research-dsh-realtime-asr.md`：公开中文 CER 7.81%（SenseVoice）vs 20.02%（Whisper-large-v3）是**别人的素材、别人的链路**，没有一条在我们环回链路上验证过，且全是作者自述无第三方复现 —— 不能直接当结论。

**阶段二出口判据**：给出「保持 turbo / 换 SenseVoice」的明确结论 + 数据对照。结论写进 `## Comments` 后再进阶段三。

---

## 阶段三：二选一，最终测试与优化

- [ ] 按阶段二结论选定一个引擎，**只保留一条链**（删掉没选中的分支与实验代码，避免双份维护）。
- [ ] 收口文档：`docs/adr/0003-audio-turbo-only.md` 记录最终决定与理由；`docs/downloads.md`、`scripts/setup.cmd`、`_deps/requirements.txt`、`README.md` / `README.zh.md` 同步；`docs/research-three-plugins-landing.md` 标注已落地项。
- [ ] 最终验证：同口径 5 分钟 + `watch_*` 全链路无报错、`dropped=0`、资源曲线平稳；OCR 侧不受影响（已回退 CPU，稳定轮 76.1%）。
- [ ] 把结论写进 `## Comments`，Status 改 `resolved`。

---

## 本地已有代码，可直接参考（不用联网、不用下载）

| 路径 | 用在哪 |
|---|---|
| `vendor/dsh-see-now-main/examples/floating-chat/listen.py` | A1 时间码、A2 声道、A3 静音补格 |
| `vendor/dsh-see-now-main/examples/floating-chat/procloopback.py` | 进程级回环（本票不做，见票 17） |
| `vendor/dsh-see-now-main/src/listen.js` | 三级降级、宿主 STT 接法 |
| `vendor/dsh-soundtry-main/python/soundtry.py` | `initial_prompt` 实现与「第二轮去掉」的教训 |
| `C:\Users\24206\Desktop\源码与作者说明\dsh-realtime-subtitles-main.zip` → `engine/engine.py` | 终稿清草稿、VAD 回退、声道取法 |
| `docs/research-three-plugins-landing.md` | A1–A11 / B1–B8 / P0–P3 全量落地对照 |
| `docs/research-dsh-realtime-asr.md` | 生态调研与来源 URL |

## 不做（避免跑偏）

- 不换 OCR（已回退 CPU，`batch:1 + 300ms` 稳定轮 72.2%，与 `batch:3` 76.1% 只差 3.9 点）。
- 不做人声分离（ADR 0003 已砍；oreo0614 / drliuhuan 两个实时方案也都没做）。
- 不照抄画面算法（`vendor/dsh-see-now-main/src/pipeline.js` 已全量实现）。
- 不在阶段一没达标时提前进阶段二；不双引擎长期并存。

## Comments

- 2026-11-22 建票。用户指示三阶段串行：先修现有 bug，再做 SenseVoice 测试，得出结论后二选一做最终测试与优化。编号 21（18 为历史空号，未复用）。
- 本票只做规划，未改任何生产代码。
- **2026-11-22 16:5x 阶段一开工（只做 A1 + A2）**，用户指示「先修 bug，我测试一遍」。
- A1 三处已改：①静音早退前也走 `_trim_buffer()`；②静音时按 `GAP_SEC`（6 秒）推进 `emitted_until`；③`rms` 改 `_loudest_second()`（按秒取最响的一秒，不再整段平均）。新增常量 `SILENT_RMS` / `GAP_SEC`。
- **A2 的定性变了，票里的机制在本机不成立**：探针 `.scratch/run/probe_channels.py` 实测本机 `channels=1` 回 `(n, 1)`，`.reshape(-1)` 是无害的空操作，不存在「拉平导致双声道相位抵消」。仍加了 `_to_mono()` 闸（2 维按声道轴平均）防设备/USB 声卡行为变化，并在采集开始时打印一次实测 `shape`。⇒ 「录音与 mp3 相关性 0.007」另有原因，A2 不解它。
- 新增 `python/test_asr_pull.py`（stdlib unittest，8 条，不装 pytest）：改前 2 红 5 错 → 改后全绿。覆盖缓冲裁剪、游标前进、静音后恢复交付、rms 不稀释、声道平均。
- 离线回放 `.scratch/run/replay_fixed.py`（直接 import 生产模块跑真 `pull()`，CPU int8，15 秒一拍，827 bigram 同口径）：干净 5 分钟 旧 85.7% / 新 85.9%，逐拍交付条数**完全一致**（无回归）；中段插 60 秒数字静音 旧 142 条 / 新 148 条，两边都在静音结束后恢复。
- **但这轮没复现 13:30 的停摆**：60 秒静音太短 —— `MAX_SLICE_SEC` 40 秒一夹，rms 最多被稀释到 40 秒内，掉不到 0.001 以下。所以要真正踩到那个死循环，需要「四十多分钟连续静音」。⇒ 「A1 是否就是 13:30 停止交付的原因」**目前没有证据**，靠下一轮实测判断。
- 新增 `_trace()`：每次 pull 往 `.scratch/run/pull-trace.jsonl` 追加一行 `total/base/emitted/rms/n/segs/slice`。若再断流，看这一行就能分清是没录进来（total 不涨）、游标卡住（emitted 不动）、还是转了没交付（segs>0 而 n=0）。
- 未做：A3 静音补格、A6 调参、A7 关窗语义（等 A1/A2 实测有结论再动）。工作区仍未 commit。
- **2026-11-22 17:1x 实测把真因挖出来了：采集线程卡死，`/health` 在骗人。** 这一轮（16:57:57 起、视频放了约 10 分钟）**0 句、raw 0 字节**：`raw-202611220857.s16le` 恒为 0 字节、`asr-out-202611220857.jsonl` 根本没生成、17:13 手动 `POST /listen` 返回 `total: 0.0`。而 `watch_status` 报 `frames: 4335` —— 画面在采，声音一个采样点都没进来。**不是参数问题，也不是用户操作问题。**
- 代码层三个原因：①`start_capture()` 用「有没有线程对象」判断，线程死了对象还在 → 永远不再拉起；②WASAPI 环回在声音停久后 `rec.record()` 卡在等一个不再来的事件，`is_alive()` 仍 True、不抛异常、`error` 为空；③`reset()` 还把 `error` 抹掉，等于把唯一线索也擦了。
- ⇒ **13:30 那次「t1max 停在 158.9s」很可能就是同一件事**：线程卡住 → 缓冲不再增长 → 每拍都在重转同一段旧音频、全被判重 → 永远 `n=0`。这比「rms 被稀释」更贴症状（rms 稀释被 `MAX_SLICE_SEC` 40 秒夹着，理论上稀释不动）。
- 已修：`start_capture()` 改看 `is_alive()`；新增 `_check_capture_health()`（每拍体检，`lastAudioAge > STALL_SEC`=8 秒就打断旧流并重开）；`ACC` 增 `last_chunk_at` / `rec`；`/health` 增 `lastAudioAge`，`capturing` 改成真实存活；`reset()` 不再清 `error`。
- 测试增至 11 条（新增 3 条：线程死了要重起、流卡住要重开、音频正常时别折腾），全绿。
- **这一轮没有可用的覆盖率数字**（0 数据），阶段一出口判据仍未判定。
- **2026-11-22 17:26–17:33 用 `scripts/asr-loop.cmd`（每 2 秒拉一次，不用 DSH）做了 6 分钟健康度粗测：音频通了。** 191 次拉取、时间轴 340→776 秒、字幕连续出；中途约 60 秒数字静音（`silent:true, rms:0.0`）之后**自动恢复交付**；缓冲全程封顶 40 秒（`total` 最大 40.0，修复前会堆到 823 秒）。看门狗 `reopen` 一次也没触发。
- **又抓到一个新 bug（已修）**：17:28:36 与 17:33:00 各有一次 `emitted_until` 冻结（494.2 / 736.3），切片从 3 秒涨到 40 秒、每拍白转一遍。原因：模型返回的句子整段落在游标之前（前摇那 1.5 秒重转出来的残句），被 `t1 <= emitted_until` 跳过；而「有新句子就不许推进游标」这条保护是按 `segs>0` 判断的，于是推进被同一句残句堵死。修法：改成 `freshSegs`，只算 `t1 > emitted_until` 的句子。
- 已知未修：重叠窗口重转会产生近似重复句（实测「该死的安全感」/「开始的安全感」逃过 0.85 相似度阈值同时交付）。属交付质量，不属本票阶段一，先记录。
- 测试增至 **12 条**，全绿。本轮 `raw` 没落盘（`asr-loop.cmd` 不发 `reset`，所以没建新 raw 文件），正式测量走 `watch_start` 会正常落盘。
- **2026-11-22 17:36–17:42 正式 5 分钟实测（`asr-out-202611220936.jsonl`，同口径）：ASR 163 条 | bigram 81.5% | 逐句 118/148 = 79.7%；时间轴 3.9–311.4 秒；缓冲峰值 40.0 秒；看门狗 0 次；无卡死。**
- **阶段一出口判据通过**（要求在 40–52% 且不断流）。而且 **81.5% 已经和「同一个 turbo 喂干净 mp3 离线 81.3%」打平** —— 说明环回录音这条链路不再是瓶颈，剩下的差距只可能来自模型本身。这是本次修复最硬的一条证据。
- 顺带两个观察：①交付 163 条里有 0 条前 8 字重复，重叠窗口的重复句问题这轮没出现（前面 `asr-loop` 那轮出现过的近似重复仍记着）；②17:41:12–18 有 3 拍 `slice` 涨到 14→20 秒未交付，属「尾巴还没说完」的正常等待，随后自行恢复。
- 建议：**A3/A6/A7 直接跳过**。出口判据已过，再改这三项会让阶段二「换引擎前后」的数字无法归因。
- **2026-11-22 17:47 用户决定不做阶段二（SenseVoice 不换）**，理由是使用范围广、不想为一个引擎绑下载。同时提了四条质疑，处置如下：
- **A6 的 `initial_prompt` 永久不做**（用户要求）：prompt 会把结果硬拉向提示内容，而本项目不是只陪一部片子，换内容就变成误导。**代码里其实一直没加过 `initial_prompt`**（`transcribe()` 只有 `language="zh"` / `vad_filter` / `beam_size=1` / `condition_on_previous_text=False`），所以无需删除，只需把 A6 那条标注为否掉，防止以后有人照它加上去。
- **同类问题（新记）**：`language="zh"` 是写死的，和 `initial_prompt` 一样会把非中文内容硬掰成中文解码。要通用化应改成可配置，但**这次不动** —— 动了今天 81.5% 的基线就不可比。留作下一轮单独验证（一次只改一个变量）。
- **热词后处理（FunASR `postprocess_hotwords` / 蛐蛐 QuQu）不做**：前者是识别之后的查表替换（毫秒级、确定性），后者是给「语音输入法」做的 LLM 润色。二者都只改字、补不了漏句，而我们的缺口主要是漏句；且全局映射表在换内容后有把正确文本改错的副作用。
- **下一步只做一件事：`beam_size` 1 → 5**。零下载、零依赖、显存不变，耗时约 2–3 倍但当前每拍只用了 3 秒预算的 5–7%，余量足够。跑一轮 5 分钟同口径，看能否把 81.5% 再往上推。若还不够再考虑换 `large-v3`（显存要单独验）。
- **2026-11-22 17:52 做了 beam 扫描（`.scratch/run/replay_beam.py`，素材是本轮真实环回 PCM 的前 300 秒，跑生产 `pull()`，只改 `BEAM_SIZE`）**：

  | beam | 条数 | bigram | 逐句 | p50 | p90 |
  |---|---|---|---|---|---|
  | 1 | 155 | 81.4% | 116/148 | 128ms | 156ms |
  | 5 | 152–154 | 83.6–84.0% | 116–117/148 | 176–178ms | 218–224ms |
  | 10 | 161 | 84.5% | 123/148 | 364ms | 482ms |
  | 20 | 154 | 82.7% | 119/148 | 931ms | 1292ms（单次最大 6.8s） |

- 结论：**`beam_size=5`**。同一配置跑两次差 0.4 点 / 1 句，所以 10 比 5 高的那 0.5 点落在噪声里；而 p90 从 224ms 翻到 482ms，切片追赶到 40 秒时会掉到 3 秒预算以下。20 更差，说明再往上不是单调收益。`asr_service.py` 已把宽度抽成 `BEAM_SIZE` 常量并**改为 5**（2026-11-22 17:57，用户批准）。
- **2026-11-22 17:58–18:05 线上确认（`asr-out-202611220958.jsonl`，同流程、同素材、只改了 beam）**：

  | | beam 1（17:36 轮） | beam 5（17:58 轮） |
  |---|---|---|
  | bigram | 81.5% | **85.9%** |
  | 逐句命中 | 79.7%（118/148） | **83.8%（124/148）** |
  | 交付条数 | 163 | 205（前 8 字重复 0 条） |
  | 缓冲峰值 | 40.0 秒 | 40.0 秒 |
  | 拉取间隔 | — | p50 3.0s / p90 3.1s / max 3.6s |

- 结论：**beam 5 实打实 +4.4 点 bigram、+4.1 点逐句，拉取节奏一点没拖（max 3.6 秒，预算 3 秒内靠 `busy` 互斥兜住）**。线上比离线回放预测的 83.6–84.0 还高，说明回放偏低是取样差异，不是 beam 的锅。
- 顺带修正一条旧结论：`docs/downloads.md`/票 12 里「干净 mp3 离线 81.3%」是 **beam 1** 下的天花板，不是这个模型的极限 —— 85.9% 已经超过它，说明卡住上限的是解码宽度而不是音频质量。
- 阶段一至此收口：A1（含实测新增的采集线程看门狗、游标被旧句子钉死两处）已修，A2 定性纠正，`beam_size` 1→5 已上线验证；A3/A7 与阶段二经用户决定不做，**A6 只做 beam 这一半、`initial_prompt` 那一半否掉**（不是整个 A6 都不做）。
- **关于出口判据的准确说法（2026-11-22 复核后修正）**：票面写的是「**回到 40–52% 历史稳定带**且不再断流」。实收 85.9% 并不落在这个带内，是**超出**（带上沿之外），不是「落回」。断流确实消失了。另外 85.9% 是 bigram 覆盖率，**对「多吐句子」没有惩罚**（交付 205 条 vs 字幕真值 148 条），所以这个数不能当"精确率"看。
- **收口记录（2026-11-22 18:0x）**：
  - **最终数字**：0–300 秒 bigram **85.9%**、逐句 **83.8%（124/148）**，对比起点 15.7% / 10.1%。三轮演进：15.7%（13:30 带病）→ 81.5%（修完 A1，beam 1）→ 85.9%（beam 5）。
  - **改了什么**：`python/asr_service.py`（静音早退先裁剪、游标在长静音时前进、`_loudest_second` 按秒取最响、`_to_mono` 声道闸、采集线程存活判断 + 8 秒看门狗重开、`freshSegs` 修游标钉死、`BEAM_SIZE=5`、`/health` 增 `lastAudioAge`、`pull-trace.jsonl` 状态轨迹）；新增 `python/test_asr_pull.py`（12 条回归测试）。
  - **文档同步**：`docs/adr/0003`（加 2026-11-22 复核）、`README.zh.md`（排障新增 `lastAudioAge` 一条、已知限制补基准数字）、`docs/research-three-plugins-landing.md`（新增「6. 落地结果」对照表）。`docs/downloads.md` 与 `scripts/setup.cmd` **无需改** —— 本轮没有新增任何依赖或模型。
  - **遗留（下次再开票）**：①`language="zh"` 硬编码，与 `initial_prompt` 同类的通用化问题；②重叠窗口重转会产生近似重复句（本轮线上 205 条里 0 条，但 `asr-loop` 那轮出现过）；③`docs/downloads.md` 里 GPU wheel 仍标【已弃用】未删，需用户确认后走回收站。
