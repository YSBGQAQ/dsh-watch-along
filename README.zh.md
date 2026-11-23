# 陪看（watch-along）

让 DSH 里的 AI 看你屏幕上正在播的东西：**画面变化、屏幕文字、系统声音**，三条通道汇成一条事件流。
它不会自己说话——你问它才答。

---

## 一、前置条件

| 项 | 要求 | 不满足会怎样 |
|---|---|---|
| 系统 | Windows 10 2004+（用 gdigrab 与 WASAPI） | 起不来 |
| Node | 18+（插件跑在 DSH 里） | 插件加载失败 |
| Python | 3.12（模型与 wheel 是 3.12 编的） | 装包失败 |
| 屏幕 | **目标窗口不能被别的窗口盖住** | 抓到的是遮挡物 |
| 声音 | **系统音量不能是 0**，默认输出设备要正确 | 全程静音，且**不会报错** |
| 显卡 | NVIDIA + CUDA 12 / cuDNN 9（**声音转写必需**） | 声音走 GPU；OCR 走 CPU（GPU 版有显存泄漏，已回退） |
| 磁盘 | 模型约 1.6GB，wheel 约 1.3GB | 装不下 |

## 二、安装

```cmd
:: 1. 指定离线 wheel 目录（本仓库不自带，需另备）
set WATCH_ALONG_WHEELS=D:\path\to\wheels

:: 2. 指定 Whisper 模型目录（需含 model.bin / config.json / tokenizer.json /
::    vocabulary.json / preprocessor_config.json 五个文件）
set WATCH_ALONG_WHISPER_DIR=D:\path\to\whisper-turbo

:: 3. 安装（建 venv + 离线装包 + 检查模型文件）
scripts\setup.cmd
```

装机时不需要联网——所有包都从 `WATCH_ALONG_WHEELS` 装。

## 三、启动

```cmd
set WATCH_ALONG_PY=%CD%\venv\Scripts\python.exe
set WATCH_ALONG_WHISPER_DIR=D:\path\to\whisper-turbo
scripts\start-services.cmd
```

会开两个窗口：

| 窗口 | 端口 | 看到这一行就算好了 |
|---|---|---|
| OCR | 8765 | `[ocr] 模型加载完成` |
| ASR | 8766 | `[asr] 开始连续录音：<你的扬声器名>` |

**两个窗口都别关**，关掉对应的通道就没了。

## 四、在 DSH 里用

1. 重启 DSH（插件要加载）
2. 让它 `watch_windows` 找窗口，`watch_start` 挑一个
3. `watch_events` 读事件

返回的事件有三种 `kind`：

| kind | 含义 | 关键字段 |
|---|---|---|
| `motion` | 画面变了 | `where`（位置）、`strength`、`sheetId`（可回取那几帧） |
| `ocr` | 屏幕上的字 | `text`（≤60 字） |
| `speech` | 人说的话 | `text`、`t0`/`t1`（秒） |

## 五、手机上看（可选）

服务默认绑 `0.0.0.0`，同一 WiFi 的手机可以读接口：

```
http://<电脑IP>:8770/api/events?token=<TOKEN>
http://<电脑IP>:8770/api/frame?token=<TOKEN>&sheetId=<ID>
```

- `TOKEN` 在 DSH 日志里，或用 `WATCH_ALONG_TOKEN` 固定
- **只读**：能看事件和图，不能控制
- 图 **10 分钟过期**（`WATCH_ALONG_SHEET_TTL_MS` 可调）
- 不想被局域网访问就设 `WATCH_ALONG_HOST=127.0.0.1`

## 六、排障（按现象查）

| 现象 | 先查什么 |
|---|---|
| 没有 `ocr` 事件 | OCR 窗口在不在；画面里到底有没有字（**静止的纯视频画面本来就没字**） |
| 没有 `speech` 事件 | ASR 窗口在不在；`curl -s http://127.0.0.1:8766/` 看 `device` 对不对；**音量是不是 0** |
| 本来有 `speech`，突然整段没了 | `curl -s http://127.0.0.1:8766/` 看 `lastAudioAge`：**一直变大**说明录音流卡住了（WASAPI 环回在声音停久后会卡）。服务每 8 秒自检一次并自动重开，正常会在十几秒内恢复；`capturing: false` 才是采集线程真的退出了，重启窗口 |
| 转出来的话是乱的 | 检查是不是抓到了别的窗口的字（`ocr` 的 `text` 里出现菜单栏文字 = 有遮挡） |
| 事件全是 `motion`、没有文字 | 正常——那段时间画面没字、也没人说话 |
| 手机打不开 | 防火墙拦了 8770，第一次要允许；或 `token` 拼错 |
| 手机图是破的 | 图过期了（10 分钟），这是设计 |
| 报 `cublas64_12.dll is not found` / `GPU 转写不可用` | 缺 GPU 运行时，跑 `scripts\setup.cmd` 重装后重启服务。按 ADR 0003 **不会**静默退回 CPU，服务会直接报错停在原地 |
| 没有 `ocr` 事件 / OCR 报错 | `/health` 只查模型加载，**不代表能推理**；用 `POST /ocr` 一张本地图确认返回 `ok:true`。GPU 版已回退 CPU，若还见 `CUBLAS ... resource allocation failed` 说明环境里残留 GPU 包或旧进程 |
| 换耳机后没声音了 | 服务每 2 秒跟随默认输出设备，最多 2 秒恢复；若一直不行看 `error` 字段 |

## 七、已知限制

1. **遮挡无解**。抓的是屏幕像素，被盖住就抓到遮挡物。用的时候把目标窗口放前面。
2. **底部字幕带仍有 UI 噪声**。现在只跑 bottom 一条带（`top:0.66, height:0.34, scale:3`），不再整幅识别；但水印、清晰度角标、播放器控制条仍会混进 `ocr` 事件（实测约 10–17%），靠「汉字 < 2 丢弃」和「相似组出现 3 次后静音」挡一部分。
3. **整机混音**。录的是"电脑在放什么"，会连微信提示音一起录进去。
4. **识别噪声**。技术词容易听错：`帧/针`、`阈值/预值`。不影响"听懂大意"。基准点：2026-11-22 实测《反向之地》0–300 秒，bigram 覆盖 **85.9%**、逐句命中 83.8%（`beam_size=5`）。换内容会变，这只是一个参照。
5. **设置没有界面**。改配置只能改 `watch-along.json` 或环境变量（宿主不发放客户端服务，见票 07）。
6. **AI 不会主动说话**。现在是"你问我才答"；主动唤醒设计见票 11，默认关闭。

## 八、开发

```cmd
node --test test\*.test.mjs      :: 55 条单元测试
node scripts\probe-30s-events.mjs "窗口标题" 30   :: 真机探针
node scripts\soak.mjs "窗口标题" 120              :: 两小时压测
node scripts\check-transcript.mjs <字幕.json> 0 300  :: 转写与字幕对照
```

设计文档在 `docs/`（含 ADR 与面板契约侦察记录），票在 `.scratch/watch-along/issues/`。

**实测数据在 [`docs/benchmarks.md`](docs/benchmarks.md)**——每一场的帧数、事件数、延迟 p50/p90、费用，
以及版本演进过程中哪一步让指标变好/变坏。读的时候先看那页末尾的"口径坑"，否则容易把数字读反。
