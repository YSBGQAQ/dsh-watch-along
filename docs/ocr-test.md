# 窗口识别测试（「测试并锁定匹配窗口」）

**它回答一个问题**：这个窗口的底部到底能不能认出字；认得到，就把它**锁下来**当成默认陪看目标。

## 一、链路（纯文字）

1. 面板填「窗口标题片段」→ 点「测试并锁定匹配窗口」→ `POST /ocr-test`，body `{ "window": "哔哩哔哩" }`
2. `index.js` 的 `ocrTestRoute` 接住：
   - 没带 window 就用本次运行锁定的那个（`cur.window`，每次启动为空）；两个都空 → 直接报「先填窗口标题片段」
   - `lookupWindow(fragment)`：先整标题精确匹配，再遍历所有可见窗口取第一个标题**包含**片段的；找不到就把当前所有窗口标题列在错误里
3. 对这块矩形临时起一次 `startCapture`，拿到第一帧就 `stop()`（不走 `service.start()`，不污染会话）
4. 裁出**底部 34%**（高度 66%→100%），送常驻 OCR 服务
5. 判定：**认到任意文字就算通过**（丢掉只有 1 个字的行，和字幕通道的 `minChars=2` 同一口径）。带了 `expect` 的老客户端仍按"某一行与它相同"判
6. 通过就**锁定**（只在本机内存里，不落盘）：`cur.window = fragment`、`service.rememberRegion(rect)`。
   窗口片段**每次启动都是空的**（用户要求），所以重启 DSH 后要重新锁定。
   锁定之后：说「开始陪看」不用报窗口名，手机 `/api/start` 不带 body 也行；
   模型第一次 `watch_start` 时会收到一句「现在正在锁定「xxx」窗口」，只提示一次。

## 二、接口契约

两个面共用**同一个**处理函数（`index.js` 的 `ocrTestRoute`）：

| 面 | 端口 | 路径 | 鉴权 |
|---|---|---|---|
| 本机面板 | `127.0.0.1:8790` | `POST /ocr-test` | 无（只绑回环） |
| 本机面板 | `127.0.0.1:8790` | `GET /windows` | 无 —— 列出当前可见窗口标题，给面板点选 |
| 局域网手机 | `0.0.0.0:8770` | `GET /api/windows` | token —— 同一个函数，给手机点选 |
| 局域网手机 | `0.0.0.0:8770` | `POST /api/ocr-test` | token（`?token=` 或 `Bearer`） |

`GET /windows` 返回：

```json
{"ok":true,"count":16,"windows":["WorkBuddy","…_哔哩哔哩_bilibili - ego","…"]}
```

它和按标题匹配用的是**同一套原生枚举**（`listWindowTitles`，微秒级），所以列出来的窗口一定点得中 ——
不会出现"列表里有、测试却说找不到"。也正因为快，面板打开时会自动刷一次。

请求（所有字段都可省）：

```json
{"window": "哔哩哔哩", "expect": "可选；不带就按任意文字判"}
```

成功（HTTP 200）：

```json
{"ok":true,"matched":true,"window":"bilibili","locked":true,"expect":"",
 "source":"window","band":"画面下方 34%（66%–100%）","size":"798×153",
 "lines":["给口癖加个称呼","模型怎么解释"],"best":null,"ms":1368}
```

失败也是 200，只给原因：

```json
{"ok":false,"error":"先填「窗口标题片段」：它是窗口标题里的一段字"}
{"ok":false,"error":"找不到窗口「不存在的」。当前可见窗口：WeGame / …"}
{"ok":false,"error":"抓不到画面：3 秒内没抓到帧（窗口可能最小化或已关闭）"}
{"ok":false,"error":"OCR 服务没响应：connect ECONNREFUSED（先去上面「服务」里把它启动起来）"}
```

- `matched=false` 但 `ok=true` 表示"跑通了但这条带里没字"，此时**不会锁定**
- `locked=true` 只在通过时出现

## 三、两条硬约束

1. **分带常量必须两处一致**：`src/ocr-check.mjs:12` 的 `OCR_BAND {top:0.66, height:0.34}` 与 `src/ocr.mjs:144` 的 bottom 带。改了这里不改那里，会出现"测试通过、陪看读不到"。
2. **34% 是整窗的 34%，不是视频的 34%**。抓的是整个窗口，窗口化时底带里会混进页面空白、推荐栏、遮挡物 —— 这也是界面上提醒"把窗口放最前面、别缩太小"的原因。

## 四、代码位置

| 环节 | 文件:行 | 说明 |
|---|---|---|
| 面板入口＋结果渲染 | `client.js:174` | `WindowTest`：窗口列表、片段输入、按钮、结果（含"已锁定"） |
| 面板接口地址 | `client.js:167` | `PANEL_API = http://127.0.0.1:8790` |
| 路由实现 | `index.js:741` | `ocrTestRoute`：找窗口 → 抓帧 → 裁带 → OCR → 锁定 |
| 临时抓帧 | `index.js:714` | `grabOneFrame`：fps 20 起采集，第一帧到手就 stop |
| 窗口列表路由 | `index.js:823` | `listWindowsRoute`：`GET /windows` |
| 原生枚举 | `src/capture-koffi.mjs:98` | `listWindowTitles()`，微秒级；`src/windows.mjs:12` 的 `listWindows()` 就是它的包装 |
| 路由注入（面板） | `index.js:843` | `supervisor.serve({ routes: { 'POST /ocr-test', 'GET /windows' } })` |
| 记住锁定区域 | `src/service.mjs:444` | `rememberRegion(rect)`；`status().lastRegion` 在 `:107` 带出 |
| 未锁定报错 / 锁定提示 | `index.js:870` / `:872` | `defaultWindow` 与 `lockNotice`（函数形式，锁定后立刻生效且只提示一次） |
| 工具侧取默认值与提示 | `src/tools.mjs:172` | 没窗口且没锁定 → 抛「还没锁定窗口」；用锁定时带 `notice` |
| 裁带 / 比对 | `src/ocr-check.mjs:18` / `:51` | 纯函数，可单测（`looksLikeText` 挡界面噪声） |
| 生产用的同一条分带 | `src/ocr.mjs:144` | `{ top: 0.66, height: 0.34, label: 'bottom' }` |

## 五、和「开始陪看」的关系

- **没锁定**时调用 `watch_start`（或手机 `/api/start` 不带 body），直接报错：
  「还没锁定窗口：去设置面板「窗口识别测试」点「看看有哪些窗口」，选一个，再点「测试并锁定匹配窗口」」
- **锁定后**第一次调用会附带一句「现在正在锁定「xxx」窗口（本次运行内有效；重启 DSH 后要重新锁定）」，
  之后不再重复。
- 锁定**不落盘**：窗口片段每次启动都是空的。上次锁的窗口多半早关了，拿旧片段去找只会让人困惑。
