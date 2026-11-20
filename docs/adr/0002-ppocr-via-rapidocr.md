# 字幕改用 RapidOCR + PP-OCRv6_small，经常驻服务接入

画面文字原本用 streamvision 的 `Windows.Media.Ocr`（`lib/ocr.ps1`），实测在 4K 屏小字上基本是乱码。改用它自带的 `data/ocr.json` 命令通道接 RapidOCR（rapidocr ≥ 3.9.0 的默认模型就是 PP-OCRv6 det_small + rec_small，共 29.5MB，ONNX Runtime 后端）。选择 small 而不是 tiny/medium：识别准确率 tiny 73.5% / small 81.3% / medium 83.2%，medium 只多 1.9 个点却慢 3.3 倍、模型大 4 倍。也不再自己混搭 det 与 rec 的后端——预处理参数与权重是绑定的，混错会**静默**掉准确率。

**Consequences**

- `ocr.json` 是「每次 OCR 起一个命令」，而模型加载要 1–3 秒。所以必须做成**常驻服务**，`cmd` 只写一个约 20ms 的客户端（curl 打本地端口），否则每 1.5 秒都在重新加载模型。
- 「两次一致」（间隔 ≥1.2s、相似度 ≥0.85）**保留不变**。它是用来对付 OCR 噪声的，不会因为换了更准的引擎就取消。
- 放大倍数不照抄 streamvision 的 2×/3×：那是给 Windows OCR 试出来的。PP-OCR 是 det + rec 两段式，外放大主要喂检测，倍数要用真实截图扫出来。
