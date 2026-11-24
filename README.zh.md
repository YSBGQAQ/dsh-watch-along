# 陪看 · 速查

**它是什么、为什么这么设计**，在 [`README.md`](README.md)。这页只放天天要翻的东西：启动、接口、排障、开发命令。

---

## 启动

```cmd
set WATCH_ALONG_PY=%CD%\venv\Scripts\python.exe
set WATCH_ALONG_WHISPER_DIR=D:\path\to\whisper-turbo
scripts\start-services.cmd
```

| 窗口 | 端口 | 看到这一行就算好了 |
|---|---|---|
| OCR | 8765 | `[ocr] 模型加载完成` |
| ASR | 8766 | `[asr] 开始连续录音：<你的扬声器名>` |

两个窗口都别关，关掉对应的通道就没了。首次安装见 [`docs/install.md`](docs/install.md)。

## 三条通道

| 字段 | 含义 | 关键内容 |
|---|---|---|
| `motion` | 画面变了 | `where`（下部/右部…）、`strength`、`cells`、`sheetId`（可回取那张拼图） |
| `sub` | 屏幕上的字 | `text`（≤60 字），只读窗口底部 34% |
| `say` | 人说的话 | `text`、`t0`/`t1`（秒） |

事件都带 `at`（`21:14:03` 这种时刻）。同一秒同一类的几条会合成一条，别当成好几句台词。

## 手机（同 WiFi，可选）

服务默认绑 `0.0.0.0`，手机能读也能启停采集：

| 接口 | 作用 |
|---|---|
| `GET /api/status?token=` | 当前状态（`state` / `window` / `frames` / `region` / `titles`），`titles` 是当前可见窗口标题（最多 20 条） |
| `GET /api/events?token=&sinceId=&wait=` | 长轮询取事件，语义与 `watch_events` 一致 |
| `GET /api/frame?token=&sheetId=<ID>` | 取已产出的拼图（PNG），10 分钟过期 |
| `GET /api/frame?token=&live=1` | **现抓一帧**（PNG），同一秒内重复请求回上一张 |
| `GET /api/windows?token=` | 列当前可见窗口标题，给「点一条选中」用 |
| `POST /api/start?token=` | 开始采集，body `{"window":"标题片段"}`（可空，空则用面板锁定的那个） |
| `POST /api/stop?token=` | 停止采集 |
| `POST /api/ocr-test?token=` | 窗口识别测试并锁定，body `{"window":"标题片段"}` |

```
http://<电脑IP>:8770/api/events?token=<TOKEN>
http://<电脑IP>:8770/api/frame?token=<TOKEN>&live=1
```

- `TOKEN` 在 DSH 日志「手机端就绪」那一行，或用 `WATCH_ALONG_TOKEN` 固定
- 鉴权两种写法都认：`?token=` 或 `Authorization: Bearer <TOKEN>`；不对一律 **401**
- **写只做启停**：不碰设置、不碰文件、不执行命令。改设置仍然只能在电脑面板里
- 写接口的失败**不用状态码**：一律 `200` + `{"ok":false,"error":"中文原因"}`，手机面板直接把这句显示出来
- `live=1` 抓的是调用之后到达的那一帧，最多等 0.8 秒；**窗口最小化/被挡住时会拍到遮挡物**
- 不想被局域网访问就设 `WATCH_ALONG_HOST=127.0.0.1`

## 排障（按现象查）

| 现象 | 先查什么 |
|---|---|
| 没有 `sub` 事件 | OCR 窗口在不在；画面里到底有没有字（**静止的纯视频画面本来就没字**） |
| 没有 `say` 事件 | ASR 窗口在不在；`curl -s http://127.0.0.1:8766/` 看 `device` 对不对；**音量是不是 0** |
| 本来有 `say`，突然整段没了 | 同上，看 `lastAudioAge`：**一直变大**说明录音流卡住了（WASAPI 环回在声音停久后会卡）。服务每 8 秒自检、自动重开，正常十几秒恢复；`capturing: false` 才是采集线程真退了，重启窗口 |
| 转出来的话是乱的 | 是不是抓到了别的窗口的字（`sub` 里出现菜单栏文字 = 有遮挡） |
| 事件全是 `motion`、没有文字 | 正常 —— 那段时间画面没字、也没人说话 |
| 手机打不开 | 防火墙拦了 8770，第一次要允许；或 `token` 拼错 |
| 手机点「开始」回「还没锁定窗口」 | 去电脑面板「测试并锁定匹配窗口」锁一个；锁定不落盘，重启 DSH 后要重锁 |
| 刚开场一直不说话 | 正常：第一次主动开口也要等满「主动说话间隔」（默认 30 秒） |
| 手机图是破的 | 图过期了（10 分钟），这是设计 |
| 报 `cublas64_12.dll is not found` | 缺 GPU 运行时，跑 `scripts\setup.cmd` 重装后重启服务。按 ADR 0003 **不会**静默退回 CPU，服务直接报错停在原地 |
| OCR 报错但 `/health` 是好的 | `/health` 只查模型加载，**不代表能推理**；用 `POST /ocr` 一张本地图确认返回 `ok:true` |
| 换耳机后没声音了 | 服务每 2 秒跟随默认输出设备，最多 2 秒恢复；一直不行看 `error` 字段 |

## 开发

```cmd
node --test test\*.test.mjs                        :: 238 条单元测试
node scripts\probe-30s-events.mjs "窗口标题" 30     :: 真机探针
node scripts\soak.mjs "窗口标题" 120                :: 两小时压测
node scripts\check-transcript.mjs <字幕.json> 0 300 :: 转写与字幕对照
```

设计文档在 `docs/`（含 ADR 与面板契约），票在 `.scratch/watch-along/issues/`，实测数据在 [`docs/benchmarks.md`](docs/benchmarks.md)。

**更新记录**：[`CHANGELOG.md`](CHANGELOG.md)。
