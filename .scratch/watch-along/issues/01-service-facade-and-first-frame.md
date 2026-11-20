# 01: 服务门面 + 窗口发现 + 单帧出图

**What to build:** 用户说"陪我看标题里有 XXX 的那个窗口"，插件能找到那个窗口、开始采集，并交出第一张画面。找不到时不是静默失败，而是把当前可见的窗口列出来让人挑。同时立起 `WatchService` 门面与可注入的帧源，后面所有票都挂在这上面。

**Blocked by:** None（can start immediately）

**Status:** ready-for-agent

- [x] `watch_windows` 能列出当前可见窗口的标题（DSH 内实测：21 个窗口，返回 `{count,titles}`）
- [ ] `watch_start({window:"片段"})` 命中后返回确认信息（窗口矩形、采样帧率）
- [x] 标题匹配不到时返回错误，且错误体里带可见窗口列表（单测覆盖）
- [ ] `watch_frame({live:true})` 返回一张 798×450 的 PNG，并把它放进会话
- [x] 采集区域按 `engine:'gdigrab'` 启动（不带 `hwdownload`），10 秒内稳定出帧（冒烟：2652×2160 → 798×450）
- [x] 门面可注入假帧源；一条用假帧源的测试通过，不需要真实屏幕（5 条门面测试）
