# 环境交付包里带上 NVIDIA 的 cublas / cudnn 轮子

NVIDIA 的 CUDA Toolkit EULA 只允许「以目标代码形式并入一个具备实质额外功能的软件应用」再分发，把原始 wheel 当独立产物公开分发不在授权范围内。我们仍然把这两个 wheel 放进环境交付包——理由是这份包只做**私下转发**（发给需要配环境的人），不公开发布；换来的收益是「拿到包的人不必再去找 1.2 GB 的依赖」，而这正是这份包存在的意义。风险由分发者承担，不是技术问题。

**Consequences**

- 这两个包**不得公开挂出**（公开仓库、公开网盘索引都不行）。要公开发布，必须先剔除三个 `nvidia_*` wheel，README 改成一条 `pip install`。
- 交付包必须拆成「必需」与「GPU」两个，让不需要 GPU 的人根本拿不到这两个文件——顺带也降低了误分发的概率。
- 其余 40 个包不受影响：rapidocr 是 Apache-2.0，**onnxruntime / onnxruntime-gpu 是 MIT**（旧版这里误写成 Apache-2.0），faster-whisper、soundcard 是 MIT，numpy 是 BSD，Whisper 权重是 MIT，PP-OCRv6 模型是 Apache-2.0。

## 【已作废】2026-11-22 曾尝试：交付包追加 GPU OCR 资源（结论见文末）

原来只带 cublas / cudnn 两个 wheel 给 faster-whisper 用。现在 OCR 改走 `onnxruntime-gpu==1.26.0`（CUDA 12 / cuDNN 9），交付包还需要：

- `onnxruntime_gpu-1.26.0-cp312-cp312-win_amd64.whl`（226,548,963 B，放在包根目录）
- `_deps/cuda_dlls/` 下的 `cudart64_12.dll` / `cufft64_11.dll` / `curand64_10.dll`（这三个是 CUDA provider 运行时依赖，本机取自 ComfyUI 的 torch/lib，已备份）
- 或在干净机器上直接装 `nvidia-cuda-runtime-cu12` / `nvidia-cufft-cu12` / `nvidia-curand-cu12` 三个 wheel，效果等价

**版本别乱升**：1.27+ 的 PyPI GPU 包默认是 CUDA 13 构建，需要另拉 cu13 依赖；本机是 cu12 环境，锁 1.26.0。

CPU 版 `onnxruntime` 与 GPU 版同名，**不能共存**，安装前先卸载。

## 2026-11-22 晚：GPU 相关交付已回退

上述 `onnxruntime_gpu-1.26.0-...whl` 与 `_deps/cuda_dlls/` 三个 DLL **已从交付清单移除、不再安装也不再引用**（文件暂留在包内，标记为弃用；彻底删除需走回收站并由用户确认）。原因是 GPU 版在常驻服务里显存/内存线性泄漏、端到端 0 次成功，已切回 CPU 版。

合规章节里「GPU 包可选」的说法随之作废：当前交付包只装 CPU 版 OCR，GPU 只服务 faster-whisper 转写。
