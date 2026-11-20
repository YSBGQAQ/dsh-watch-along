# 环境交付包里带上 NVIDIA 的 cublas / cudnn 轮子

NVIDIA 的 CUDA Toolkit EULA 只允许「以目标代码形式并入一个具备实质额外功能的软件应用」再分发，把原始 wheel 当独立产物公开分发不在授权范围内。我们仍然把这两个 wheel 放进环境交付包——理由是这份包只做**私下转发**（发给需要配环境的人），不公开发布；换来的收益是「拿到包的人不必再去找 1.2 GB 的依赖」，而这正是这份包存在的意义。风险由分发者承担，不是技术问题。

**Consequences**

- 这两个包**不得公开挂出**（公开仓库、公开网盘索引都不行）。要公开发布，必须先剔除三个 `nvidia_*` wheel，README 改成一条 `pip install`。
- 交付包必须拆成「必需」与「GPU」两个，让不需要 GPU 的人根本拿不到这两个文件——顺带也降低了误分发的概率。
- 其余 40 个包不受影响：rapidocr / onnxruntime 是 Apache-2.0，faster-whisper、soundcard 是 MIT，numpy 是 BSD，Whisper 权重是 MIT，PP-OCRv6 模型是 Apache-2.0。
