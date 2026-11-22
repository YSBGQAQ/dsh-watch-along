# 字幕改用 RapidOCR + PP-OCRv6_small，经常驻服务接入

画面文字原本用 streamvision 的 `Windows.Media.Ocr`（`lib/ocr.ps1`），实测在 4K 屏小字上基本是乱码。改用它自带的 `data/ocr.json` 命令通道接 RapidOCR（rapidocr ≥ 3.9.0 的默认模型就是 PP-OCRv6 det_small + rec_small，共 29.5MB，ONNX Runtime 后端）。选择 small 而不是 tiny/medium：识别准确率 tiny 73.5% / small 81.3% / medium 83.2%，medium 只多 1.9 个点却慢 3.3 倍、模型大 4 倍。也不再自己混搭 det 与 rec 的后端——预处理参数与权重是绑定的，混错会**静默**掉准确率。

**Consequences**

- `ocr.json` 是「每次 OCR 起一个命令」，而模型加载要 1–3 秒。所以必须做成**常驻服务**，`cmd` 只写一个约 20ms 的客户端（curl 打本地端口），否则每 1.5 秒都在重新加载模型。
- 「两次一致」（间隔 ≥1.2s、相似度 ≥0.85）**后来被推翻**：实测字幕只活 1.5–2 秒，根本凑不齐两拍，改成**一拍即发**（`once: true`）+ 相似组出现 3 次后静音。详见 2026-11-21 的实测记录。
- 放大倍数不照抄 streamvision 的 2×/3×：那是给 Windows OCR 试出来的。PP-OCR 是 det + rec 两段式，外放大主要喂检测，倍数要用真实截图扫出来。

## 【已作废】2026-11-22 曾尝试：OCR 改走 GPU（结论见文末）

原本依赖 CPU 版 `onnxruntime`。现改为 `onnxruntime-gpu==1.26.0`（CUDA 12 / cuDNN 9 构建，与本机 `nvidia-*-cu12` 对齐；更新的 1.27+ 默认是 CUDA 13 构建，不要直接升）。

- `python/ocr_service.py` 默认 GPU，`WATCH_ALONG_OCR_GPU=0` 可一键回退；启动时挂 CUDA DLL 目录、用生产尺寸预热、从真实 session 读 provider，**请求了 GPU 却跑在 CPU 上会打警告**（不静默降级）。`/health` 新增 `device` / `gpuRequested`。
- rapidocr 的开关是 `EngineConfig.onnxruntime.use_cuda`；`cuda_ep_cfg.cudnn_conv_algo_search` 必须从默认 `EXHAUSTIVE` 改成 `HEURISTIC`，否则首次预热要几十秒。
- 缺的三个 cu12 DLL（`cufft64_11` / `cudart64_12` / `curand64_10`）已备份到 `_deps/cuda_dlls/`，路径可用 `WATCH_ALONG_CUDA_DLL_DIR` 覆盖。

**实测（生产尺寸 bottom 带 2532×720，2 行字，各 5 次取中位数）**：CPU 1236.7 ms，GPU 86.6 ms，**约 14 倍**。冷启动首次含 CUDA 初始化会慢 1–2 秒，常驻服务只吃一次。

**由此引出的新问题**：当前 `batch: 3` 三帧竖拼的做法是 CPU 时代为摊薄调用开销定的，在 GPU 上反而变成负担 —— 竖拼图（2532×2160）实测 **1948 ms**，单帧 74 ms，**慢 26 倍**；而攒 3 拍（3×700ms）意味着 2.1 秒才出一次结果，字幕只活 1.5–2 秒。是否改成单帧实时 OCR 需另开一轮验收。

## 2026-11-22 晚：GPU 化失败，整体回退 CPU

后续整轮实测把上面「GPU 更快」的结论推翻了。常驻服务连续跑 5 分钟时，`onnxruntime-gpu` 的 CUDA 显存池（`kNextPowerOfTwo`）对不同尺寸输入持续申请、按 2 的幂扩且不归还：**开测约 20 秒显存打满 16GB**，OCR 进程内存涨到 17.9GB、GPU 长时间 100%，最后 `cublasCreate` 直接失败、OCR 一条都出不来。三次整轮测试 **0 次完整成功**。

CPU 版（`onnxruntime 1.32.0` + `RapidOCR()` 默认 CPU provider）两轮 5 分钟：OCR **79.2% / 76.1%**，全程不卡。**已卸载 `onnxruntime-gpu`、离线装回 CPU 版，`ocr_service.py` 去掉全部 CUDA 代码。**

- 教训：当初只测了「固定图、连跑 5 次」的单次速度，没测「常驻服务、连续几百次不同输入」的长稳，评估方法有漏洞。
- `/health` 只查模型是否加载，不保证能推理 —— 确认服务可用必须 POST 一张图看 `ok:true`。
- 保留 `scripts/monitor-resources.py` 与 `feed-stats` 埋点，用于后续受控实验。
- 当前是 `CPU + batch:1 + intervalMs:300` 的**极限对照实验**（用户指定），目的是分离「GPU 显存池」与「batch:1」哪个导致泄漏；不是稳定配置。

## 2026-11-22 晚：严格核对质量 + 移除时间节流

用户要求用字幕 JSON 仔细核对「之前 40% 对 70%」的大差距到底是不是 `batch:1` 造成的。按每轮**真实测试窗口**（UTC 时分）切事件重算，避免把「测试结束后仍在采集」或混轮数据算进去：

| 轮次 | 事件 | bigram | 逐句命中 | 与字幕完全一致 |
|---|---:|---:|---:|---:|
| CPU 稳定轮 `batch:3 + 700ms` | 223 | **76.1%** | 108/148 | 67 |
| GPU `batch:1 + 300ms` | 52 | 24.4% | 29/148 | 14 |
| GPU `batch:1 + 700ms` | 44 | 14.0% | 17/148 | 12 |
| CPU `batch:1 + 300ms` | 206 | **72.2%** | 100/148 | 63 |

**结论**：CPU 两轮只差 3.9 点、8 句逐句命中；GPU 两轮才是崩盘（事件数骤减到 52/44、输出全是噪声如 `g>1.11=` / `plamta`）。所以大差距来自 **GPU 显存泄漏把服务拖死**，不是 `batch:1`。去水印后覆盖率几乎不变（76.1→75.9、72.2→71.5）；各轮漏句高度重合（「广告牌」「妈妈这么大的风」「我们先回家」），是固定难句。

**时间节流已移除**（用户决定）：`src/ocr.mjs` 删掉 `intervalMs` 参数与 `if (now() - lastAt < intervalMs) return` 判断、`throttleSkips` 埋点；`index.js` 不再传参；`test/ocr.test.mjs` 去掉多余的 `intervalMs: 0`。`firstAt` 改为当拍时间，`busy` 跳过保留（防堆积，不是节流）。删后 CPU 下行为基本不变——单拍 1.2s 本来就大于任何节流间隔。
