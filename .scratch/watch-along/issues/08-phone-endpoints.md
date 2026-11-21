# 08: 手机端接口

**What to build:** 手机在同一个 Wi-Fi 下能读到同样的事件流和同一张图，不用装任何东西；链接有时效，过期即失效，手机掉线一会儿回来还能接上。

**Blocked by:** 02, 03

**Status:** done（只读；写接口有意不做）

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
| `GET /api/status?token=` | 当前状态（窗口、帧数、state） |
| `GET /api/events?token=&sinceId=&wait=` | 长轮询，语义与 `watch_events` 一致 |
| `GET /api/frame?token=&sheetId=` | 取已产出的拼图（PNG 字节），**不提供实时抓屏** |

- 全部要 token（`?token=` 或 `Authorization: Bearer`），服务绑 `0.0.0.0`
- token 默认随机生成并打进日志；可用 `WATCH_ALONG_TOKEN` 固定
- 端口 `WATCH_ALONG_PORT`，默认 8770
- **写接口不做**：每多一个写入口，就多一个可被控制你电脑的入口

**踩到的坑**：`apply` 里启动监听后，预检脚本不会退出（进程被 server 挂着）——
给 `apply` 加了第二参数 `{mobile:false}`，预检时跳过。
