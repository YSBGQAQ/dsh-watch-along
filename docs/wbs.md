# 实时陪看 · 开发与测试 WBS（事无巨细版）

口径：**参考度**＝我们直接抄它代码/参数的程度；**原创度**＝必须自己写的比例；**可行性**＝高（有现成路径）/ 中（有已知风险）/ 低（未验证过）。

---

## A. 环境与依赖（0.5 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| A1 建 Python 3.12 venv（rapidocr + onnxruntime + faster-whisper + soundcard + numpy） | soundtry 的 venv 模式 | 中 | 低 | 高 | 2h |
| A2 装 GPU 依赖（cublas / cudnn 两个轮子） | soundtry 文档 | 高 | 零 | 中（版本易错） | 1h |
| A3 下模型（PP-OCRv6_small 29.5MB + whisper turbo ≈1.6GB） | rapidocr 默认 / soundtry | 高 | 零 | 高 | 1h |
| A4 确认 ffmpeg 可用且版本够（已实测 9.0.2） | see-now | 高 | 零 | 高 | 10min |

## B. 插件骨架（1 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| B1 `dsh.plugin.json` + `cordis.patch.yml` | see-now / better-ears | 高 | 零 | 高 | 1h |
| B2 工具注册（`watch_start/stop/events/frame/status`） | streamvision 的 reg 包装 | 高 | 低 | 高 | 2h |
| B3 配置读取 + 校验（`readTuning` 那套形状） | see-now `tuning.js` | 高 | 中 | 高 | 3h |
| B4 进程内采集循环的生命周期（起/停/重启） | streamvision `sv_arm` | 中 | 中 | 高 | 2h |
| B5 状态工具（各通道活着没、最近错误） | see-now `status` | 中 | 中 | 高 | 1h |

## C. 采集（1 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| C1 按标题片段找窗口（含最小化判定） | streamvision `native.js` `windowRect` | 高 | 低 | 高 | 2h |
| C2 每 2 秒比对窗口矩形 | streamvision 每帧重算的做法 | 中 | 中 | 高 | 1h |
| C3 `spawnFrames` 接线 + **必须传 `engine:'gdigrab'`** | see-now `capture.js` | 高 | 低 | 高（坑已踩过） | 1h |
| C4 矩形变化 → 停旧采集、起新采集（约 0.4s 断流） | 无 | — | 高 | 高 | 1.5h |
| C5 采集结束一律按故障处理（报错 + 日志，不细分） | 无（原参考 windows-capture 的 `on_closed`，已弃用） | 零 | 低 | 高 | 0.5h |
| C6 首帧超时与重试（不无限等） | see-now 首帧计时 | 中 | 中 | 高 | 1h |

## D. 画面判定与出图（0.5 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| D1 `createPipeline` 参数映射（fps / 画质 / 场景） | see-now `pipeline.js` | 高 | 零 | 高 | 1h |
| D2 `push({t, buf})` 喂帧（时间基准用单调时钟） | see-now | 高 | 零 | 高 | 1h |
| D3 `take()` → 落盘 PNG + 写事件 | see-now（`sheet.png` 已编码好） | 高 | 零 | 高 | 1h |
| D4 `flushNow()` 按需出图 | see-now | 高 | 零 | 高 | 30min |
| D5 逐帧事件（在 `push` 外层记 `score/mcRect/强度`） | 无（`drainChanges` 只给每张摘要） | — | 高 | 高 | 2h |
| D6 事件节流（切点最小间隔 + 每分钟上限） | streamvision `cooldownMs/maxPerMin` | 中 | 中 | 高 | 1h |
| D7 有界磁盘（按时间 + 条数清理） | streamvision `prune` | 高 | 低 | 高 | 1h |

## E. 字幕（1 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| E1 三带裁剪（重叠比例照抄） | streamvision `text.js` `BANDS` | 高 | 零 | 高 | 30min |
| E2 放大倍数可配（1×–3×） | streamvision `ocr.ps1`（只借思路） | 低 | 中 | 高 | 1h |
| E3 常驻 OCR 服务（加载一次模型，HTTP 返回 JSON） | 无 | — | 高 | 高 | 3h |
| E4 `ocr.json` 里写 20ms 客户端（curl） | streamvision 可插拔 OCR 接口 | 高 | 低 | 高 | 1h |
| E5 两次一致判定（1200ms / 0.85，落盘用第一次） | streamvision `ingestText` | 高 | 零 | 高 | 1h |
| E6 字幕事件入队（带全文，≤60 字截断） | 无 | — | 中 | 高 | 1h |
| E7 OCR 服务健康检查与重启 | 无 | — | 中 | 高 | 1h |

## F. 声音（1.5 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| F1 环回采集（soundcard，默认输出设备） | see-now `listen.py`（它用 pyaudiowpatch） | 中 | 中 | 高（已实测） | 2h |
| F2 48k 立体声 → 16k 单声道下混 | see-now | 中 | 低 | 高 | 1h |
| F3 VAD 切句 + 分窗 | better-ears `voiceBlocks/planWindows` | 高 | 零 | 高（已实测） | 1h |
| F4 句子写 WAV（文件名带 epoch 毫秒） | see-now `seg-<epochMs>.wav` | 高 | 低 | 高 | 1h |
| F5 faster-whisper turbo 转写（关 `condition_on_previous_text`） | soundtry | 高 | 低 | 中（GPU 依赖） | 3h |
| F6 幻觉过滤（两套词表 + 重复检测） | better-ears + soundtry | 高 | 低 | 高 | 1h |
| F7 GPU 不可用检测 + 显式报错 | soundtry 的降级链 | 中 | 中 | 高 | 1h |
| F8 输出设备变更跟随 —— **不做**（换音箱后要重启插件） | 无 | — | 零 | — | 0h |

## G. 事件总线（1 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| G1 单写者队列（三通道 → 一条） | 无（两个参考项目都是分开的流） | — | 高 | 高 | 2h |
| G2 id 递增 + 高水位线（清空不归零） | streamvision `events.seq` | 高 | 低 | 高 | 1h |
| G3 时间码（epoch ms + 相对秒都带） | see-now `wall` / streamvision `t` | 高 | 零 | 高 | 30min |
| G4 容量上限（内存 500 / 磁盘 2000）+ 超界标 `staleSince` | streamvision 的 `staleSince` | 高 | 中 | 高 | 1.5h |
| G5 长轮询（`sinceId` / `pending` / `truncated` / `nextId`） | streamvision `sv_events` | 高 | 低 | 高 | 2h |
| G6 `sinceId` 越界纠正（`staleSince`） | streamvision | 高 | 零 | 高 | 30min |

## H. 设置页（2.5 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| H0 设置页首项：环境检查（八项只读状态 + 失败原因 + README 地址） | 无（自研） | — | 高 | 中（要真跑 CUDA 探针） | 4h |
| H1 `client.js` 骨架（`__ModuleLoader__` + `slots`，零构建） | see-now `client.js` | 高 | 中 | 高 | 3h |
| H2 `GET /status`（当前值 + 默认值 + warnings） | see-now `settings-api` | 高 | 中 | 高 | 2h |
| H3 `POST /config`（后端校验，拒绝回 200 + `rejected`） | see-now | 高 | 中 | 高 | 2h |
| H4 常用 6 项表单 | see-now 表单样板 | 中 | 中 | 高 | 3h |
| H5 三个场景预设（游戏/讲课/影视，一次写多键） | see-now `defaultPace` 的思路 | 低 | 高 | 高 | 2h |
| H6 高级折叠（裸阈值） | see-now 的两组分法 | 高 | 低 | 高 | 2h |
| H7 改完重开 DSH 生效 —— **不做即时生效**（照 see-now） | see-now「已保存。重开 DSH 生效。」 | 高 | 零 | 高 | 0h |
| H8 文案与提示（状态、错误、默认值标注） | see-now | 中 | 中 | 高 | 2h |

## I. 手机端（1 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| I1 端口开关（默认关，连接时开，绑 LAN） | 无（五个插件都不开端口） | — | 高 | 高 | 2h |
| I2 token 签发 + TTL + 常量时间校验 | better-ears `sameToken` | 高 | 中 | 高 | 2h |
| I3 `/frame/<id>` 输出 PNG（`Content-Length` + 304） | qian-music `serveLocal`（去掉 Range） | 中 | 中 | 中（宿主路由无二进制先例） | 2h |
| I4 `/events?sinceId=&wait=` 长轮询 | streamvision 语义 | 高 | 低 | 高 | 1h |
| I5 只允许局域网来源（IPv4 私有段 + IPv6 `fe80::/10` / `fd00::/8` / `::1`） | better-ears 的来源栅栏 | 中 | 中 | 高 | 1h |
| I6 掉线**不关端口**；空闲 10 分钟才关；token 滑动续期 | 无 | — | 高 | 高 | 2h |

## J. 测试（2 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| J1 窗口查找：找不到 / 最小化 / 标题写错 | 无 | — | 中 | 高 | 1h |
| J2 采集冒烟：30 秒出一张图（已预演成功） | see-now | 高 | 低 | 高 | 1h |
| J3 静止画面零事件 | see-now 门控 | 高 | 零 | 高 | 30min |
| J4 切镜检出（合成素材：连续动画 vs 硬切） | see-now | 中 | 中 | 高 | 2h |
| J5 OCR 放大倍数扫描（1×/1.5×/2×/3× × 20 张真图） | 无 | — | 高 | 高 | 3h |
| J6 OCR 准确率统计（人工抄真值 + 字符比对） | 无 | — | 高 | 中（真值费时） | 3h |
| J7 VAD 切句（合成音频：语音/静音/BGM） | better-ears | 高 | 低 | 高 | 1h |
| J8 ASR 端到端（真实视频 2 分钟，数错字 + 计时） | soundtry | 中 | 中 | 中（GPU） | 3h |
| J9 长轮询与断线补齐（拔网线重连） | streamvision | 高 | 低 | 高 | 1h |
| J10 手机拉图 + 重复请求 304 | 无 | — | 中 | 中 | 1h |
| J11 连续 2 小时：崩溃 / 内存 / 句柄 | 无 | — | 中 | 高 | 2h |
| J12 CPU 占用（分通道计量） | 无 | — | 中 | 高 | 1h |
| J13 设置改参后 1 秒内生效 | 无 | — | 中 | 高 | 1h |
| J14 故障注入（关窗口 / 杀 OCR / 占满显存） | 无 | — | 高 | 高 | 2h |

## K. 文档与交付（0.5 天）

| 步骤 | 参考项目 | 参考度 | 原创度 | 可行性 | 工期 |
|---|---|---|---|---|---|
| K1 README（安装、依赖、最小可用示例） | see-now / better-ears | 中 | 中 | 高 | 2h |
| K2 参数说明（每个参数一句人话） | see-now | 高 | 低 | 高 | 1h |
| K3 故障排查表（症状 → 该查什么） | see-now `调参与实测.md` | 中 | 中 | 高 | 1h |
| K4 依赖与体积清单 | soundtry | 中 | 低 | 高 | 30min |
| K5 **环境交付包**：wheels + 模型 + requirements + 离线安装脚本 + README + SHA256 | 无 | — | 中 | 高 | 0.5h |

---

## 汇总

| 阶段 | 工期 | 原创度 | 主要风险 |
|---|---|---|---|
| A 环境 | 0.5 天 | 低 | GPU 轮子版本 |
| B 骨架 | 1 天 | 中 | 无 |
| C 采集 | 1 天 | 中 | 无（已简化为一律报错） |
| D 画面判定 | 0.5 天 | 低 | 无（已验证） |
| E 字幕 | 1 天 | 中 | OCR 准确率未测 |
| F 声音 | 1.25 天 | 中 | GPU 依赖 |
| G 事件总线 | 1 天 | 中高 | 合并队列的写竞争 |
| H 设置页 | 2.5 天 | 中 | 表单与文案量 + CUDA 探针 |
| I 手机端 | 1 天 | 中 | 二进制流无先例 |
| J 测试 | 2 天 | 中 | 人工抄真值费时 |
| K 文档 | 0.5 天 | 低 | 无 |
| **合计** | **12.5 天** | | |

> 施工单里的「7 天」只算了 A–I 的**开发**，没含测试与文档。这份 WBS 是 12.5 天含全程。

## 参考度分布

- **直接抄代码/参数（参考度高）**：约 18 项 —— 判据、拼图、OCR 接口、VAD、长轮询、id 水位、设置页形态
- **只借思路（参考度中低）**：约 14 项 —— 采集生命周期、节流、磁盘清理、token
- **完全原创（参考度为零）**：约 12 项 —— 三通道合并队列、逐帧事件、场景预设、端口开关、故障判定、设备跟随
