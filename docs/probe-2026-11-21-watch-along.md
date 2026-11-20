# 陪看插件（dsh-watch-along）实跑汇报

- 日期：2026-11-21 07:08（Asia/Shanghai）
- 触发：用户要求「陪我看标题里有 WorkBuddy 的窗口，然后持续读事件，把每条的 kind/strength/where 告诉我」
- 结论一句话：**采集与事件流在本地实跑通了，`motion` 事件能出；但 `strength` 恒为 low、`where` 恒为 null，且插件未被当前宿主加载、`ocr`/`speech` 两条通道尚未接线。**

---

## 0. 交付状态总览

| 项 | 状态 | 说明 |
|---|---|---|
| 窗口发现（标题片段） | ✅ | 命中 `WorkBuddy`（hwnd 723538） |
| gdigrab 区域采集 | ✅ | 16 秒出 197 帧，稳定不掉 |
| 单帧出图 | ✅ | 798×450，PNG 112 894 B |
| 事件队列 / 长轮询 | ✅ | `sinceId`/`nextId`/`timedOut` 语义正常 |
| `motion` 事件产出 | ⚠️ | 只有兜底图触发的 1 条，`peak=0` |
| `strength` 分档 | ⚠️ | 实测恒为 `low`（score 量级 1e-3） |
| `where` 位置 | ❌ | **恒 `null`——字段名对不上，真 bug** |
| `ocr` 事件 | ❌ | 未接线（OCR 常驻服务未建） |
| `speech` 事件 | ❌ | 未接线（WASAPI 环回 + faster-whisper 未建） |
| 插件加载进宿主 | ❌ | 未登记进 profile，6 个工具都没注册 |

---

## 1. 窗口定位

| 窗口标题 | 进程 | 句柄/ID | 矩形（逻辑像素，DPI 150%） |
|---|---|---|---|
| `WorkBuddy` | WorkBuddy.exe | hwnd 723538 | 214,0 · 1768×1440 |
| `读取 WorkBuddy 窗口事件信息 — DeepSeek Harness` | DeepSeek Harness.exe | w-328844 | 1020,464 · 1943×1243 |

- `watch_windows` 侧按片段 `"WorkBuddy"` 命中第一个；采集区域据此裁成 798×450。
- `lookupWindow` 的 DPI 换算生效：物理 2652×2160 → 逻辑 1768×1440（scale 1.5），未出现「抓成左上角一小块」。

---

## 2. 实跑事件流（真实采集，8 fps）

```
[start]  state=running window=WorkBuddy region=214,0 1768x1440 size=798x450 fps=8
[poll 1] timedOut=true  nextId=0  frames=46
[poll 2] timedOut=true  nextId=0  frames=96
[poll 3] timedOut=true  nextId=0  frames=145
[poll 4] timedOut=false nextId=1  frames=163
  #1 t=20.561s kind=motion strength=low where=null peak=0 cells=2 cut=false sheet=null
[poll 5] timedOut=true  nextId=1  frames=212
[poll 6] timedOut=true  nextId=1  frames=261
[poll 7] timedOut=true  nextId=1  frames=310
[poll 8] timedOut=true  nextId=1  frames=359
[poll 9] timedOut=true  nextId=1  frames=409
[poll 10] timedOut=true nextId=1  frames=459
[frame] 798x450 bytes=112894 t=57.25
[status] running, frames=459
```

逐条按用户要求的三个字段：

| id | t (s) | kind | strength | where |
|---|---|---|---|---|
| 1 | 20.561 | motion | low | null |

**为什么 20 秒才出一条**：`#1` 不是画面真的变了，而是 `silentFloorSec: 20` 的**兜底图**（`floors:1`、`cuts:0`、`marks:0`）。这一条的语义是"我还在看，屏幕没动"，不是"发生了什么事"。

---

## 3. 问题一：pipeline 在 region 模式下第一帧即崩（已修）

### 现象
```
TypeError: sheet.at.toFixed is not a function
  at noteChange   pipeline.js:522
  at flush        pipeline.js:867
  at flushNow     pipeline.js:1182
  at onFrame      service.mjs:149
```
`watch_start` 都发不出状态就整个进程退出。

### 根因
1. `lastBound` 初始值是 `-Infinity`，只在"积分攒够、真的留下帧"时才前进；
2. `finish()` 收尾时把 `lastBound` 当 `t` 传给 `flush()` → `sheet.at = -Infinity`；
3. `noteChange()` 里 `+sheet.at.toFixed(2)` 直接抛错。
4. 陪看插件每帧先 `push` 再扳机（`flushNow('spike')`），一有尖峰批次就被清空，`lastBound` 可能整段都没动过 —— 这就是每次必崩的原因。

### 修法（`vendor/dsh-see-now-main/src/pipeline.js`，三处）
- `flush()` 入口：`t` 不是有限数就回退到本批最后一帧的 `t`；
- `finish()` 收尾：优先用最后一帧，`lastBound` 无效时才兜底；
- floor 判定前补 `lastBound`：否则 `entry.t - (-Infinity) = Infinity`，第一帧就误触兜底图，`checkFlush` 的「攒够 3 帧 / 15 秒」永远轮不到。

### 回归
| 测试 | 结果 |
|---|---|
| pacing.test.mjs | pass 10 / fail 0 |
| pack.test.mjs | pass 11 / fail 0 |
| split-bin.test.mjs | pass 6 / fail 0 |
| change-log.test.mjs | pass 5 / fail 0 |
| two-frame.test.mjs | pass 1 / fail 0 |
| boost.test.mjs | pass 4 / fail 0 |

装好的插件副本 `~/.dsh/profiles/desktop/node_modules/dsh-watch-along/` 已同步，6 个关键文件哈希一致（`service/events/tools/capture/windows/pipeline`）。

---

## 4. 问题二：`where` 恒为 null（未修，3 行）

### 现象
管道给出的 box 是 `{x0,y0,x1,y1}`（`pipeline.js:514`，0..1 比例），而门面 `src/service.mjs:30` 读的是：

```js
const where = box && box.x != null
  ? `${Math.round((box.x + box.w / 2) * 100)}%,${Math.round((box.y + box.h / 2) * 100)}%`
  : null
```

`box.x` 永远是 `undefined` → `where` 永远是 `null`。

### 验证
用假变化喂门面（`box={x0:.31,y0:.32,x1:.46,y1:.58}`），`where` 依旧 `null`，`peak/cells` 正常透传：

```
#1 t=0.139s kind=motion strength=high  where=null peak=22.7 cells=12 cut=true
#2 t=0.139s kind=motion strength=low   where=null peak=9.1  cells=4  cut=false
```

### 建议修法
```js
const where = box && box.x0 != null
  ? `${Math.round(((box.x0 + box.x1) / 2) * 100)}%,${Math.round(((box.y0 + box.y1) / 2) * 100)}%`
  : null
```

---

## 5. 问题三：`strength` 恒为 low

### 实测数据
| 采集尺寸 | scoreMax | scoreSum | kept |
|---|---|---|---|
| 798×450 | 0.0028 | 0.003 | 1 |
| 1242×700 | 0.0131 | 0.025 | 1 |
| 1400×790 | 0.0086 | 0.014 | 1 |

分档阈值：`peak >= 18 → high`、`>= 10 → medium`、否则 `low`。量级差 3~4 个数量级。

### 两个原因叠加
1. **画面本身静**：WorkBuddy 是深色静态界面，块状重绘，逐帧差极小；
2. **压缩把细变化抹平**：1768px 宽压到 798px 是 2.2 倍降采样，细线/文字反锯齿直接被平均掉（1242×700 时 score 反而上升，佐证了这点）。

### 不要做的事
直接调低 `classify()` 阈值只改变分类标签，**不会**让画面本身的 `peak` 变准，且会引入噪声误报。正确方向是提高采样分辨率或做窗口局部 ROI。

---

## 6. 问题四：`ocr` / `speech` 通道未接线

- `src/` 下只有 `capture / events / png / service / tools / windows` 六个文件；
- 常驻 OCR 服务、WASAPI 环回、faster-whisper 转写尚未落地；
- 因此事件流目前**只会有 `kind: "motion"`**，`ocr`（`band/text/stableMs/hits`）与 `speech`（`text/t0/t1`）字段还没有产出者。

---

## 7. 问题五：插件未装进当前宿主

- 插件目录已 link 到 `~/.dsh/profiles/desktop/node_modules/dsh-watch-along`；
- 但 `package.json` 的 `dsh.profile.bundles` 未登记，`cordis.patch.yml` 里也没有 `watch-along` 条目；
- 结果：宿主启动时不 `apply()`，6 个工具（`watch_windows/watch_start/watch_frame/watch_events/watch_status/watch_stop`）一个都没注册进来；
- `.scratch/run/plugin.log` 最后一条仍停在 `2026-11-20T22:48:50.604Z`，之后没有新的 apply 记录。

另：`http://127.0.0.1:55331` 当前返回 401（`dsh web authentication required`），需要带 token 的完整地址才能从浏览器侧核对。

---

## 8. 待办（按优先级）

1. **`where` 三行修复** + 补一条单测（断言 `box.x0..x1` → `"38%,45%"` 形态）。
2. **登记进 profile**：`cordis.patch.yml` 加插件条目后重启 DSH，让 6 个工具真正可调。
3. **`ocr` 通道**：常驻 RapidOCR + PP-OCRv6_small，三条重叠带 +「两次识别一致」保留不变。
4. **`speech` 通道**：WASAPI 环回 → 16k 单声道 → VAD 切句 → faster-whisper large-v3-turbo。
5. **`strength` 可用性**：优先提分辨率 / 局部 ROI 重测，再决定是否动阈值。
6. **静态画面验收**：连续 10 秒 0 事件（目前 20 秒兜底 1 条，符合 `silentFloorSec` 设计，但要确认交付文本不会被兜底图刷屏）。

---

## 9. 复现命令

```powershell
# 1) 起采集 + 长轮询读事件（本地实跑脚本）
cd C:\Users\24206\AppData\Local\Temp\dsh-watchalong-run
& 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' .\probe-watch2.mjs

# 2) 只测管道判据（不经过门面）
& 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' .\probe-motion.mjs

# 3) 回归
cd vendor\dsh-see-now-main
& 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' test\pacing.test.mjs
```

产物：
- 采集帧：`.scratch/run/frames/last.png`（798×450）
- 插件日志：`.scratch/run/plugin.log`
