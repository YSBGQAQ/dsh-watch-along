# 08: 手机端接口

**What to build:** 手机在同一个 Wi-Fi 下能读到同样的事件流和同一张图，不用装任何东西；链接有时效，过期即失效，手机掉线一会儿回来还能接上。

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] 开启端口后，手机浏览器能 `GET /events?sinceId=0&wait=30` 拿到事件
- [ ] `GET /frame/<sheetId>?token=…` 返回 PNG，带 `Content-Length`
- [ ] 同一 `sheetId` 第二次请求返回 304
- [ ] token 缺失或错误 → 401；来源不在私有网段 → 403（IPv4 私有段与 IPv6 `fe80::/10`、`fd00::/8`、`::1` 放行）
- [ ] 手机侧断开 30 秒不关端口；重连后 `sinceId` 能补齐中间事件
- [ ] 无任何请求满 30 分钟 → 端口自动关闭并写日志
- [ ] 端口默认关闭，不开启时不监听任何地址
