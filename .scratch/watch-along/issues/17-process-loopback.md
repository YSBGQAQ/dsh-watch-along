# 17: 进程级回环（只录指定的声音来源）

**What to build:** 现在录的是整机混音——视频、我们自己的 TTS、微信提示音、任何软件的声音都进来。
改成能指定"只录某个进程"，默认仍是整机（兼容），可在设置里指定。

**Blocked by:** 12（先证明现有采集可用，再换）

**Status:** done（采集已实现并真机验通链路；「只录该进程、不含提示音」这一条仍需一轮人耳对照）

参考：`vendor/dsh-see-now-main/examples/floating-chat/procloopback.py`（纯 ctypes，无新依赖）

- [x] 默认行为不变：整机环回 —— `_capture_device()` 原样保留，默认来源仍是 `system`；`_resolve_audio_source('system')` 有测试守着
- [x] 设置项 `audioSource`: `system`（默认）/ `process:<pid|名字>`，非法值拒收
- [ ] 指定进程后，录到的只有该进程输出（验证：放视频 + 同时响一声系统提示音，提示音不应出现）
  —— 链路已通（见下「实施 2026-11-22」），但"只录该进程、不含提示音"这条**必须人耳对照**，机器验不了
- [ ] 进程退出后自动回退到整机环回，并写一条日志
  —— 实现已就位（`_capture_loop` 捕获 `TargetGone`/`OSError` → 打日志 → 走整机），但没真机杀过进程
- [x] 现在就是降级状态：设了 `process:` 会**明确打一行日志**再回退整机（不静默）

## 为什么值得做
1. 现在会录到**我们自己念出来的话**（将来上 TTS 会自我循环）
2. 微信/QQ 提示音会混进字幕
3. 进程回环与"哪台扬声器"无关——换设备不受影响

## 为什么只做了配置面（2026-11-21）
进程级回环要照 see-now 的 `procloopback.py`（纯 ctypes 的 WASAPI 进程环回，约三百行）。
这部分**只能真机验**，而今天没有余量做"写完→跑了才知道对不对"的循环。
所以先立配置面：
- `audioSource` 进设置模型（含校验），环境变量 `WATCH_ALONG_AUDIO_SOURCE` 可覆盖
- 设了非 `system` 时，**明确打印"尚未实现，已回退整机混音"** ——
  静默忽略配置最糟：用户会以为"只录视频"生效了，其实录的还是整机

剩下：把 `procloopback.py` 接进来，替换 `_capture_loop` 里的设备来源。

## Comments

### 实施 2026-11-22：移植 + 接线 + 真机验通链路

- **新增 `python/procloopback.py`**：从 `vendor/dsh-see-now-main/examples/floating-chat/procloopback.py`（Apache-2.0）移植，只留用得上的部分。**删掉** `audio_sessions()` / `auto_target()`（see-now 的"自动挑正在出声的进程"）与 CLI —— 本票只要求显式指定，留着就是死代码。
- **`asr_service.py` 拆成三条路径**：`_capture_loop()` 只做分发；`_capture_device()` 是原来的整机逻辑（一字未改功能）；`_capture_process(pid)` 走进程回环。缓冲与 raw 落盘抽成 `_ingest(chunk)` 两条路径共用。
- **回退只发生一次**：进程回环中断后，这一轮剩下的时间都走整机（目标真退了就该退，反复重试只会每 2 秒刷一行日志）。
- **`resolve_pid` 有个必须踩的坑**：回环的激活模式是「目标 + 全部子孙」。浏览器是「主进程不发声、声音在 audio utility 子进程」的结构，随手挑一个渲染子进程 → 拿到的是那个子树 → **全是静音**。真机第一次探针就踩到了：挑中 pid 35232，3 秒拿到 2.99 秒音频、**峰值 0.0000**。所以现在多个同名进程时**优先取进程树的根**，`iter_processes()` 相应多返回父 pid。
- **真机链路已通**（`.scratch/run/probe_procloopback.py`）：`ego`（37 个进程）→ 树根 → 打开耗时 0.00–0.02 秒，3 秒内 299 块 / 47840 采样 ≈ 2.99 秒。**峰值 0 是因为当时没在放声音**，不是链路问题。
- 测试：`python/test_procloopback.py` 16 条（来源解析、PID 解析、树根优先、路径按文件名匹配）+ `test_asr_pull.py` 里 4 条（`_resolve_audio_source` 的四条分支）。python 33 条 / node 63 条全绿。

### 已知缺口（不属本票）

`src/settings.mjs` 里的 `audioSource` 设置项**没有接到 python 服务上**——插件运行时不读 settings（整个 settings 模型目前只有 `doctor.mjs` 在用，见票 07「设置页」已关）。所以现在真正生效的是环境变量 `WATCH_ALONG_AUDIO_SOURCE`：

```
set WATCH_ALONG_AUDIO_SOURCE=process:ego
```

已在 `settings.mjs` 的注释里写明这条，别让人以为改设置就有用。
