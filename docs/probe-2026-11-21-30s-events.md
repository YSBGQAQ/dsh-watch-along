# 陪看实跑汇报 · 30 秒事件（2026-11-21）

- 时刻：07:15–07:17（Asia/Shanghai）
- 窗口：`WorkBuddy`（WorkBuddy.exe，hwnd 723538，物理 2652×2160 → 逻辑 214,0 · 1768×1440，DPI 150%）
- 命令：`node scripts/probe-30s-events.mjs WorkBuddy 30 10`
- 一句话结论：**这 30 秒窗口真的没动 —— 像素通道最多只变了 0.009%（89/255 单点，光标闪烁），文字通道 52 行 OCR 行级零变化，运动通道 0 条事件。事件流"空"是对的，不是插件坏了。**

---

## 1. 三条通道，同一段时间

| 通道 | 方法 | 结果 |
|---|---|---|
| 运动（门面事件队列） | gdigrab 8fps 采 317 帧 + pipeline 判据 + 长轮询 | **0 条 `motion` 事件** |
| 文字（分带 OCR） | 0/10/20/30s 各一张 798×450 原帧 → 9 条带 ×3 倍 OCR | 每次 52 行、**相邻帧 changed=0** |
| 像素（硬证据） | 相邻快照做 RGB 全量逐像素差 | 0→10s `maxΔ=0`；10→20s `maxΔ=0`；20→30s `maxΔ=89`、moved **0.009%** |

逐拍实况：

```
+0.4s  text lines=52  ocr=518ms
+10.0s text lines=52  ocr=548ms  pxMaxΔ=0    moved=0%
+20.1s text lines=52  ocr=546ms  pxMaxΔ=0    moved=0%
+30.1s text lines=52  ocr=524ms  pxMaxΔ=89   moved=0.009%
[summary] elapsed=40.0s frames=317 state=running motion=0 textChanges=0 snaps=4 lastLines=52
```

`pxMaxΔ=89 / moved=0.009%` 的位置就是右侧那个呼吸光标 —— 大约 0.9% 面积的一张 798×450 图里 89 个像素，换算成 pipeline 的 64×36 网格根本落不进任何一个格子。

---

## 2. 屏幕上那 30 秒是什么（OCR 原文节选，未修错字）

窗口停在 Matt Pocock 技能设置那份长文档的中段：

```
我 0 了 码 ： peak 是 •peak ． t0F1 × ed 《 1 ） ， 而 region 式 下 “ “ 0 只 啊 0 ． 0028
peak 仍 然 原 样 透 传 ．
则 静 止 画 面 20 秒 冒 一 · 于 没 做
过 · fiush() 拿 到 -Xnfinity · ， h ' ' t
w•tch—start 岌 不 出 状
0 魷 崩 。 三 处 补 丁 在 vendoe/ 一 ． / p 飞 p01 ne ． 3s ， 9 行 新 增 ，
留 六 则 下 次 0 新 v@'×跹” 会 把 这 个 冲 棹 “
在 的 状 态
```

也就是说：我 07:12 拍下的上一张 `last.png` 和 07:16 的 `snap_03_30s.png` 是**同一屏**，中间只多了光标闪。

---

## 3. 这 30 秒暴露的真问题（已修 / 待定）

### 3.1 已修：门面先 `take()` 后 `drainChanges()`，事件被自己的 tick 节奏吃光

`src/service.mjs` 原顺序是 `take()` → `drainChanges()`。`take()` 是"取走即清"，它先把图队列清了；`pipeline.flush()` 里的 `noteChange()` 又是在出图那一刻才写摘要。于是：

- 没出图的那一帧攒下的 `change`，会在**下一次出图**时被 `take()` 和摘要一起挤掉；
- 画面有变化但暂时不出图的那段时间 = 摘要全部丢失。

改法：先读摘要、再取图；顺带把"最近一张真拼出来的图"记成 `latestSheet`，给 `sheet()` / `rawFrame()` 用。

```js
const changeList = pipe.drainChanges?.() ?? []
const sheet = pipe.take?.() ?? null
if (sheet?.png) latestSheet = sheet
for (const change of changeList) { ... }
```

### 3.2 待定：`take()` 把图截走却没人交付

`service.mjs` 里 `pipe.take()` 的结果只用来取 `sheetId`，图本身被丢弃。要么交给附件通道，要么改 `peek()`。目前"取图"走 `frame()`（原始帧直出），所以功能上不丢东西，但拼图那条回看路径还空着。

### 3.3 待定：`strength` 分档对暗色静止 UI 无意义

本轮 0 条事件，无所谓；但上一轮实测 `peak≈0.0028`，`classify()` 的 10/18 阈值永远够不着。要么提采样分辨率到 1242×700（上一轮实测 score 反而升），要么让分档读"切点/cells"而不是 peak（见上一份 probe 报告第 5 节）。

---

## 4. 回归

| 套件 | 结果 |
|---|---|
| `test/events.test.mjs` | pass 5 / fail 0 |
| `test/service.test.mjs` | pass 5 / fail 0 |
| `test/service-events.test.mjs` | pass 3 / fail 0 |
| `test/tools.test.mjs` | pass 5 / fail 0 |
| vendor `pacing / pack / split-bin / change-log / two-frame / boost` | 全 fail 0 |

---

## 5. 新增产物

| 文件 | 说明 |
|---|---|
| `scripts/probe-30s-events.mjs` | 双通道 30 秒陪看实跑（运动长轮询 + 定时 OCR + 像素差） |
| `scripts/ocr-window.ps1` | 分带全窗口 OCR：9 条带 ×3 倍，窄带是这套 Windows OCR 唯一稳定的形态 |
| `.scratch/run/live-events.jsonl` | 本轮运动事件（空文件 = 0 条） |
| `.scratch/run/text-diff.json` | 4 张快照的行数/OCR 耗时/像素差 + 行级 diff |
| `.scratch/run/ocr-30s.txt` | 30s 快照的全窗 OCR 原文 |
| `.scratch/run/frames/snap_00..03_*.png` | 0/10/20/30s 四张原帧 |

---

## 6. 下一步建议（按价值排）

1. **给"零事件"正名**：事件流静止时应当返回 `quiet: true + 兜底图`，而不是让调用方猜"是不是坏了"。这一轮 AI 端最需要的其实是这句话。
2. **把 OCR 通道接进事件队列**：本轮文字通道是我在探针里手搓的；插件里还只有 `motion`。直接复用 `scripts/ocr-window.ps1`（一次 0.52s，可以 2s 一拍，追上打字/滚动）。
3. **验证"真的有事件"那一侧**：本轮窗口是静止的，`motion` 出事件这条路只在上轮兜底图上验证过。下次请给一个有动画的窗口（视频/滚动长文/正在生成答案的会话）跑同一条命令。
