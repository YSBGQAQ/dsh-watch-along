# 18: 手机端页面（不只是接口）

**What to build:** spec 第 17 条要的是"在手机上也能收到同样的文字和图片"，现在只有 JSON/PNG 接口，
**没有页面**——手机浏览器打开是一串 JSON。

**Blocked by:** 08

**Status:** done（页面已出，待真机看一眼）

- [x] `GET /?token=…` 返回事件列表页（单文件 HTML，无构建）
- [x] 事件倒序、`text` 原样、`sheetId` 渲染成图（懒加载）
- [x] 页面内长轮询 `/api/events?wait=10`，异常后 2 秒自动重连（spec 第 24 条）
- [x] token 在 URL 里，不做登录
- [ ] 断网再恢复的实机验证（代码已就绪，未真机试）

## 为什么单文件
不引入前端构建链（这项目连 bundler 都没有），一个 HTML 字符串由 Node 直出最省事。

## 实现说明
- 页面是 `src/http.mjs` 里的一个模板字符串（`PAGE(token)`），不引入构建链
- 用 `sinceId` 续读 + `seen` 去重，重复渲染同一事件会被挡掉
- 深浅色跟随系统（`prefers-color-scheme`）
- 测到的是**结构和关键行为**（会轮询、有重连、401 拦截），外观要真机看
