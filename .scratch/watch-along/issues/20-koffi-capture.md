# 20: 采集换成 koffi 直抓（放弃 ffmpeg）

**What to build:** 把窗口采集从 `spawn ffmpeg(gdigrab)` 换成进程内 koffi 直抓
（`SetProcessDpiAwarenessContext(-4)` + `BitBlt` + `GetDIBits`），
并把三带比例/门限对齐 streamvision。

**Blocked by:** 04（字幕通道）、12（覆盖率验证）

**Status:** done（待真机跑一轮确认字幕带）
**依据:** `docs/adr/0005-koffi-capture.md`

## 为什么（实测，不是推测）

| 路线 | 结果 |
|---|---|
| ffmpeg + 手算坐标 | 三次全偏（DPI 换算错两次：该乘 1.5、又改回除） |
| ffmpeg 整屏 | 能跑，但把聊天窗/书签栏一起读进来 |
| **koffi 直抓** | 矩形 `x=1228` = `819×1.5`（物理像素），**一次抓对**；OCR 整句正确：`就咱们一个宿舍顶着17级台风打牌确实有点爽啊` |

## 要做的事（按顺序）

- [x] `src/capture-koffi.mjs`：`windowRect` + `capture` + `startCapture`（与旧接口同形）
- [x] 入口类型校验：传非字符串立即抛 `TypeError`（不再段错误）
- [x] `index.js` 改用 `capture-koffi.mjs`
- [x] 三带改 0–0.38 / 0.32–0.72 / 0.66–1.0（重叠）
- [x] 门限对齐（intervalMs 1200 / threshold 0.85）
- [x] 放大自适应：带宽 <1200 才放大，否则原尺寸
- [x] 找不到窗口返回 null，由调用方报错（不退回整屏）
- [x] 删掉 `src/capture.mjs`（2026-11-22 已删：先把四个引用它的脚本迁到 koffi）

## 验收

- [x] 4K 屏窗口化播放：抓到的矩形换算正确（`region.x × 1.5` 对得上物理位置）— 见「实施结果」：`windowRect('反向之地')` → `x:1228` = 819×1.5
- [ ] `bottom` 带能读到整句字幕，且不含书签栏/地址栏 —— **必须走 DSH 一轮**（`soak.mjs` 不接 OCR 通道，验不了这条）
- [ ] 小窗口（宽 < 1200）时自动放大，字仍可读 —— 代码路径在（`scaleTo`），未真机验
- [ ] 窗口最小化 → 明确报错，不产出黑图 —— 未真机验；注意下面「发现」里写的 `onClose` 语义问题
- [x] 单元测试覆盖：`windowRect` 非字符串入参必须抛错（防段错误）— `test/capture-koffi.test.mjs`
- [x] 连续跑 3 分钟不崩（koffi 崩是硬崩，没有异常栈）— 2026-11-22 `frames=1402 / state=running / 断号 0 / RSS 100→100`

## 已知不解决

**遮挡**：BitBlt 抓的是屏幕像素，别家窗口盖住就抓到它。用户决定接受（ADR 0005）。

## 风险

koffi 是 native 调用，**参数类型写错直接段错误**，不是异常。所以：
1. 所有调用点做类型校验
2. 测试必须覆盖"传错类型"
3. 首次跑用子进程隔离，避免连累主进程

## 实施结果（2026-11-21）

- `windowRect('反向之地')` → `{x:1228,y:0,width:2981,height:2170}`（物理像素，与 819×1.5 一致）
- `capture()` → 2612×2160（被屏幕高度钳位）、平均亮度 **174.5**（非黑，真实画面）
- 传数字给 `windowRect` → 立即 `TypeError`，**不再段错误**
- 56 个测试全绿

**未验**：插件里跑一轮，确认 bottom 带读到的是字幕而非书签栏（需 DSH 重启）。

## 收尾：删掉旧采集前的迁移（2026-11-22）

原本以为「删掉 `src/capture.mjs`」是删一个文件，实际它有 **四个调用方**，而且其中一个是票 09 要用的脚本：

| 脚本 | 迁移后 |
|---|---|
| `scripts/soak.mjs` | ✅ 换 import（**这条不修会毁掉票 09**：两小时压测会去验一条没人再用的 ffmpeg 路径） |
| `scripts/smoke.mjs` | ✅ |
| `scripts/probe-30s-events.mjs` | ✅ |
| `scripts/ocr-loop.mjs` | ✅ 顺带删掉 `onStderr`（ffmpeg 时代选项，koffi 解构里没这个键，传了是空转） |

- 迁完 `grep` 确认零残留引用，`src/capture.mjs` 已 `git rm`。
- **顺带修好一件事**：这四个脚本现在也走 koffi 的 `dpiScale` 换算。旧 ffmpeg 路径靠手算坐标，本票开头记过「三次全偏（DPI 换算错两次）」——脚本以前是带着这个坑在跑的。
- 新增 `test/capture-koffi.test.mjs`（6 条）：`windowRect` 传非字符串/空串抛 `TypeError`、`capture` 缺尺寸抛错、`params` 形状（`fps/region/width/height` 缺一个就死在 `status()`）、`dpiScale` 换算、只给 `region` 时输出尺寸跟随、`stop()` 之后不再出帧。

真机：`node scripts/soak.mjs "see-now新版本发布" 3` → `frames=1402 / state=running / 断号 0 / RSS 100→100 / verdict 通过`。
（`events=0` 是正常的：那个页面是暂停的静态画面，没有变化事件。）

## 发现（属票 A7 的范围，本票不动）

两个采集实现对 `onClose` 的语义**不一样**：

- ffmpeg 版：`onClose` = 子进程退出，一次，确实等于「采集结束」；
- koffi 版：`capture()` 每拍失败都调一次 `onClose`，8 fps 就是**每秒 8 次**。

而 `src/service.mjs:122` 的 `onCaptureEnded` 一收到就把 `state='failed'`，且**没有任何路径把它改回 running**。于是「窗口最小化一秒」这种可恢复的瞬时失败，会让 `watch_status` 永久显示失败——正是票 A7「意图 ≠ 可用性」要治的那类错。

建议在 A7 里改成「连续 N 次失败才算结束」，而不是现在这样一次就判死。
