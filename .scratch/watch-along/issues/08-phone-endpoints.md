# 08: 手机端接口

**What to build:** 手机在同一个 Wi-Fi 下能读到同样的事件流和同一张图，不用装任何东西；链接有时效，过期即失效，手机掉线一会儿回来还能接上。

**Blocked by:** 02, 03

**Status:** done（2026-11-21 只读三条；**2026-11-24 扩写**：加现抓一帧 + 启停两条）

- [ ] 开启端口后，手机浏览器能 `GET /events?sinceId=0&wait=30` 拿到事件
- [ ] `GET /frame/<sheetId>?token=…` 返回 PNG，带 `Content-Length`
- [ ] 同一 `sheetId` 第二次请求返回 304
- [ ] token 缺失或错误 → 401；来源不在私有网段 → 403（IPv4 私有段与 IPv6 `fe80::/10`、`fd00::/8`、`::1` 放行）
- [ ] 手机侧断开 30 秒不关端口；重连后 `sinceId` 能补齐中间事件
- [ ] 无任何请求满 30 分钟 → 端口自动关闭并写日志
- [ ] 端口默认关闭，不开启时不监听任何地址

## 实现（2026-11-21 09:36）

| 接口 | 说明 |
|---|---|
| `GET /api/status?token=` | 当前状态（窗口、帧数、state、region、lastRegion） |
| `GET /api/events?token=&sinceId=&wait=` | 长轮询，语义与 `watch_events` 一致 |
| `GET /api/frame?token=&sheetId=` | 取已产出的拼图（PNG 字节） |
| `GET /api/frame?token=&live=1` | **现抓一帧**（PNG）；同一秒内重复请求回上一张 —— 2026-11-24 加，因为拼图只在画面明显变化时才产，看视频时常常一张都没有 |
| `POST /api/start?token=` | 起采集，body `{"window":"标题片段"}`（可空 → 用设置里的默认窗口）—— 2026-11-24 加 |
| `POST /api/stop?token=` | 停采集 —— 2026-11-24 加 |
| `POST /api/ocr-test?token=` | 窗口识别测试并锁定，body `{"window":"标题片段"}`：认到底部任意文字即通过，并把该窗口设成默认 —— 2026-11-24 加。与面板 `POST /ocr-test` 共用 `index.js` 的 `ocrTestRoute`，不复制实现 |
| `GET /api/windows?token=` | 列当前可见窗口标题 —— 2026-11-24 加。与面板 `GET /windows` 共用 `listWindowsRoute`；原生枚举，约 5ms |

- 全部要 token（`?token=` 或 `Authorization: Bearer`），服务绑 `0.0.0.0`
- token 默认随机生成并打进日志；可用 `WATCH_ALONG_TOKEN` 固定
- 端口 `WATCH_ALONG_PORT`，默认 8770
- **写只做启停**：不碰设置、不碰文件、不执行命令。失败一律 `200 + {ok:false,error:"中文原因"}`（只有缺 token 是 401），让手机面板能把这句原样显示出来
- 接线：`src/http.mjs` 只认注入的 `control = { start(window), stop() }`，不认识 supervisor；真接线在 `index.js`，`start` 里会先等 python 服务就绪（最多 20 秒），并区分「已经在采 / 采集中断」

**踩到的坑**：`apply` 里启动监听后，预检脚本不会退出（进程被 server 挂着）——
给 `apply` 加了第二参数 `{mobile:false}`，预检时跳过。
