# 18: 手机端页面（不只是接口）

**What to build:** spec 第 17 条要的是"在手机上也能收到同样的文字和图片"，现在只有 JSON/PNG 接口，
**没有页面**——手机浏览器打开是一串 JSON。

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] `GET /?token=…` 返回一个能在手机上看的事件列表页（单文件 HTML，无构建）
- [ ] 事件按时间倒序，`text` 原样显示，`sheetId` 渲染成缩略图（点开全屏）
- [ ] 自动刷新：页面内轮询 `/api/events?sinceId=`，断线后**自己重连**（spec 第 24 条）
- [ ] token 存在 URL 里即可，不做登录
- [ ] 断网 10 秒再恢复，页面能自己接上、不丢事件

## 为什么单文件
不引入前端构建链（这项目连 bundler 都没有），一个 HTML 字符串由 Node 直出最省事。
