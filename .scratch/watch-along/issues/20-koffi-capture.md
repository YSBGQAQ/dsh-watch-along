# 20: 采集换成 koffi 直抓（放弃 ffmpeg）

**What to build:** 把窗口采集从 `spawn ffmpeg(gdigrab)` 换成进程内 koffi 直抓
（`SetProcessDpiAwarenessContext(-4)` + `BitBlt` + `GetDIBits`），
并把三带比例/门限对齐 streamvision。

**Blocked by:** 04（字幕通道）、12（覆盖率验证）

**Status:** ready-for-agent
**依据:** `docs/adr/0005-koffi-capture.md`

## 为什么（实测，不是推测）

| 路线 | 结果 |
|---|---|
| ffmpeg + 手算坐标 | 三次全偏（DPI 换算错两次：该乘 1.5、又改回除） |
| ffmpeg 整屏 | 能跑，但把聊天窗/书签栏一起读进来 |
| **koffi 直抓** | 矩形 `x=1228` = `819×1.5`（物理像素），**一次抓对**；OCR 整句正确：`就咱们一个宿舍顶着17级台风打牌确实有点爽啊` |

## 要做的事（按顺序）

- [ ] `src/capture-koffi.mjs`：从 `.scratch/proto/native-capture.mjs` 收编，只留 `windowRect` + `capture`
- [ ] **入口做参数类型校验**：`windowRect` 只收字符串标题（传 hwnd 会**段错误**，已踩一次，进程静默退出无报错）
- [ ] `index.js` 换接线，删掉 `capture.mjs` 的调用
- [ ] `src/ocr.mjs` 三带改 `top 0–0.38` / `mid 0.32–0.72` / `bottom 0.66–1.0`（**故意重叠，防切字**）
- [ ] 门限对齐 `STABLE_MS=1200`、`SIMILAR=0.85`
- [ ] **放大按带宽度自适应**：带宽 < 1200px 才按 2/2/3 放大，否则原尺寸
- [ ] 窗口找不到 → **显式报错**，绝不静默退回整屏
- [ ] 删掉 `src/capture.mjs` 或标注废弃（不再被引用）

## 验收

- [ ] 4K 屏窗口化播放：抓到的矩形换算正确（`region.x × 1.5` 对得上物理位置）
- [ ] `bottom` 带能读到整句字幕，且不含书签栏/地址栏
- [ ] 小窗口（宽 < 1200）时自动放大，字仍可读
- [ ] 窗口最小化 → 明确报错，不产出黑图
- [ ] 单元测试覆盖：`windowRect` 非字符串入参必须抛错（防段错误）
- [ ] 连续跑 3 分钟不崩（koffi 崩是硬崩，没有异常栈）

## 已知不解决

**遮挡**：BitBlt 抓的是屏幕像素，别家窗口盖住就抓到它。用户决定接受（ADR 0005）。

## 风险

koffi 是 native 调用，**参数类型写错直接段错误**，不是异常。所以：
1. 所有调用点做类型校验
2. 测试必须覆盖"传错类型"
3. 首次跑用子进程隔离，避免连累主进程
