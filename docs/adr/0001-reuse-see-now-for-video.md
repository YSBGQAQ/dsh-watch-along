# 画面链路原样复用 dsh-see-now，不自研

采集、变化判据、档位分配、拼图排布、token 预算全部来自 dsh-see-now 0.2.5 的源码，算法一行不改；我们只写接线（喂帧、取图、落盘、发事件）。理由：这套算法带着作者在真实素材上的实测与回滚记录——比如把格子缩到 60×96 会让文字认不出，一个涨分的改动因此被回滚；自研等于把这些坑重踩一遍。而它的接口已经足够干净：`spawnFrames` 喂帧、`createPipeline` 处理、`take()` 取图、`flushNow()` 按需出图。

**Consequences**

- `createPipeline` 的 `drainChanges()` 只给「每张图一条摘要」（`{at,from,to,n,peak,cut,box}`），**不是逐帧事件流**。逐帧事件必须在 `push` 外面自己记。
- region 采集在 0.2.5 有个 bug：`isDda()` 只看 engine 参数、没看 region，会给 gdigrab 拼上 `hwdownload`，导致 ffmpeg 一帧都不出。必须显式传 `engine:'gdigrab'` 绕开（零改源码）。
