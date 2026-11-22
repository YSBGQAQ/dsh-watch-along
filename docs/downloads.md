# 需要下载的东西（交办清单）

> **2026-11-22 更新：OCR 已回退 CPU。**
> `onnxruntime-gpu 1.26` 在常驻服务里出现显存/内存线性泄漏（约 20 秒打满 16GB 显存、OCR 进程涨到 17.9GB），三次整轮测试 0 次成功；CPU 版两轮 5 分钟 OCR 79.2% / 76.1%、不卡。
> 已卸载 GPU 包、离线装回 `onnxruntime 1.32.0` CPU 版。**下面带【已弃用】标记的 GPU 资源不再安装、不再引用**；文件暂留在包内，彻底删除需经用户确认。

约定落地位置：`C:\Users\24206\Desktop\源码与作者说明\_deps\`

```
_deps\
├── wheels\      ← pip 下载的 .whl（含 onnxruntime-1.32.0 CPU 版）
├── models\
│   ├── whisper-large-v3-turbo-ct2\
│   └── ppocr\
├── cuda_dlls\   ← 【已弃用】原为 OCR GPU 准备的 3 个 cu12 DLL
└── venv\        ← 本地创建，不用下载
```

> 本机已有的东西不要再下：Python 3.12（`C:\Users\24206\AppData\Local\Programs\Python\Python312`）、ffmpeg 9.0.2、Node 22。

---

## 1. 建 venv（本地，不联网）

```powershell
py -3.12 -m venv "C:\Users\24206\Desktop\源码与作者说明\_deps\venv"
& "C:\Users\24206\Desktop\源码与作者说明\_deps\venv\Scripts\python.exe" -m pip install -U pip
```

## 2. 下载 wheel（约 1.3 GB）

先把这个文件存成 `_deps\requirements.txt`：

```
rapidocr>=3.9.0
onnxruntime>=1.17
faster-whisper>=1.1
soundcard>=0.4
numpy>=1.26
nvidia-cublas-cu12
nvidia-cudnn-cu12
nvidia-cuda-nvrtc-cu12
```

> **OCR 用 CPU 版 `onnxruntime`**，不要再装 `onnxruntime-gpu`（两者同名、不能共存）。
> 下面三个 nvidia wheel 是给 **faster-whisper 声音转写** 用的，与 OCR 无关。

然后：

```powershell
& "C:\Users\24206\Desktop\源码与作者说明\_deps\venv\Scripts\python.exe" -m pip download -r "C:\Users\24206\Desktop\源码与作者说明\_deps\requirements.txt" -d "C:\Users\24206\Desktop\源码与作者说明\_deps\wheels"
```

| 包 | 体积 | 用途 | 备注 |
|---|---|---|---|
| `rapidocr` ≥3.9.0 | ~30 MB | OCR | **wheel 里已含 PP-OCRv6 det/rec small**，不用另下模型 |
| `onnxruntime` | ~15 MB | OCR 推理（CPU） | 实测 1.32；离线 wheel 已在 `_deps\wheels\` |
| `faster-whisper` + `ctranslate2` | ~40 MB | 语音转写（GPU） | |
| `soundcard` | <1 MB | 环回录音 | |
| `numpy` | ~15 MB | 音频处理 | |
| `nvidia-cublas-cu12` | ~500 MB | 声音转写的 GPU 依赖 | 若机器已装 CUDA 12 可跳过 |
| `nvidia-cudnn-cu12` | ~700 MB | 同上 | 同上 |
| `nvidia-cuda-nvrtc-cu12` | ~76 MB | 同上 | 同上 |

国内镜像可加速：加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`

### 2.1 【已弃用】GPU 资源（2026-11-22 回退，不再安装）

这些文件**暂留在包内但不再引用**，彻底删除需经用户确认（合计约 574 MB）。保留的目的是留个回溯：当初为 GPU 化下载过什么。

| 文件 | 位置 | 大小 | SHA256 |
|---|---|---|---|
| `onnxruntime_gpu-1.26.0-cp312-cp312-win_amd64.whl` | 包根目录 | 226,548,963 B | `5f49c44689894650990e4c8a857d2edafc276fbd79bba57ceb224bd18d25d491` |
| `cudart64_12.dll` | `_deps\cuda_dlls\` | 573,952 B | `c2c9a9c22a9bcba90e261825968836787b331038047a26770cffb7a583c28344` |
| `cufft64_11.dll` | `_deps\cuda_dlls\` | 276,121,600 B | `f4fea9227b14843894ad5436725f9638b172171142c95291fc6ae7a493248221` |
| `curand64_10.dll` | `_deps\cuda_dlls\` | 71,955,968 B | `3465fd1b46e551339b8f44c455756a0f2cba8bd846562eb659040d48edb7aaac` |

失败原因见 ADR 0002 / 0004：CUDA 后端的 `kNextPowerOfTwo` 显存池对不同尺寸输入持续按 2 的幂扩且不归还，最后连 `cublasCreate` 都失败。

## 3. 下模型

### 3.1 Whisper large-v3-turbo（约 1.6 GB）

首选（faster-whisper 官方映射 `large-v3-turbo` → 这个仓库）：

```
https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo
```

备选（社区验证过可直接访问，返回 200）：

```
https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2
```

**要下的文件**（放到 `_deps\models\whisper-large-v3-turbo-ct2\`）：

- `model.bin`（1.5 GB，主体）
- `config.json`
- `tokenizer.json`
- `vocabulary.json`
- `preprocessor_config.json`

> 目录名不重要，我们直接把路径传给 faster-whisper；但五个文件必须齐全。

### 3.2 PP-OCRv6 small —— **不用下**

rapidocr 的 wheel 里已经带了 `det_small`（9.5 MB）+ `rec_small`（20 MB）——那个 wheel 有 29.5 MB 正是因为这个。

要单独取这两份文件，**从已下载的 wheel 里解出来**，不要去猜 ModelScope 的地址（那里的路径随版本变，猜必错，会返回「文件内容为空」）：

```powershell
cd "C:\Users\24206\Desktop\源码与作者说明\_deps\wheels"
& "..\venv\Scripts\python.exe" -m zipfile -l rapidocr-*.whl | findstr /i onnx
& "..\venv\Scripts\python.exe" -m zipfile -e rapidocr-*.whl "..\models\ppocr_wheel"
```

解出来的 `.onnx` 在 `ppocr_wheel\rapidocr\models\` 下。

---

## 4. 下完之后

告诉我一声，我用离线方式安装（`pip install --no-index --find-links=…`），全程不联网。

**总计约 3 GB**（其中 NVIDIA 轮子约 1.3 GB、whisper 1.6 GB）。

## 5. 如果下不动

优先级从高到低：

1. **只下 whisper + rapidocr 相关**（约 1.7 GB）——足够先把画面和字幕跑起来
2. **NVIDIA 轮子跳过时，声音按 ADR 0003 直接报错**（不再静默退到 CPU int8 假装能用）；OCR 本来就是 CPU 版，不受影响
3. 真下不动就停在字幕层，声音那期等网络好的时候再补

---

## 6. 交付包（项目完成后打包，两个包）

定稿于 2026-11-21 06:03；2026-11-22 曾追加 GPU OCR 资源，**同日已整体回退 CPU**。会发到网盘供他人配环境，所以必须**自解释**：拿到包的人不看我们的对话也能装起来。

**拆两个包**：必需包装上就能跑画面 + 字幕 + CPU OCR；GPU 包只给声音转写用。

### 6.1 `watch-along-env-required-v1.zip`（约 1.85 GB）

```
├── README.md                            ← 环境要求 + 「环境问题不在支持范围」
├── requirements.txt
├── install-offline.ps1                  ← 建 venv → 装必需 → 写 env.json → 跑八项检查
├── wheels\                              ← 除 NVIDIA 外的全部 .whl
├── models\whisper-large-v3-turbo-ct2\   ← 五个文件（1.6 GB）
├── bundled\
│   ├── python-3.12.10-amd64.exe
│   └── ffmpeg-9.0.2-essentials_build.7z
├── samples\                             ← 合成素材，见 6.3
└── SHA256SUMS.txt
```

### 6.2 `watch-along-env-gpu-v1.zip`（约 1.33 GB，只给声音转写）

```
├── wheels\
│   ├── nvidia_cublas_cu12-12.9.2.10-*.whl      553 MB
│   ├── nvidia_cudnn_cu12-9.28.1.4-*.whl        696 MB
│   └── nvidia_cuda_nvrtc_cu12-12.9.86-*.whl     76 MB
├── install-gpu.ps1                      ← 复用同一个 venv 追加安装
└── SHA256SUMS.txt
```

> 原先列在这里的 `onnxruntime_gpu-...whl` 与 `cuda_dlls\` 已移除，见 2.1【已弃用】。

### 6.3 `samples\` 只放合成素材

| 内容 | 用来看什么 |
|---|---|
| `video/testsrc-30s.mp4` | 采集、判据、拼图出不出东西 |
| `shots\` 三张（正常字幕 / 小字弹幕 / 无字幕）+ `truth.txt` | OCR 与放大倍数（真值人工抄） |
| `audio\` 四段（人声 / 音乐 / 混合 / 静音） | VAD 切句、转写、幻觉过滤 |
| `expected\`（事件样例 + 一张拼图） | 装完 diff，而不是"看着像对的" |

**不放真实直播切片**——那是别人的内容，跟着包分发是版权风险，体积也大。

### 6.4 `install-offline.ps1` 的行为

1. 建 venv（若不存在）
2. `pip install --no-index --find-links=wheels -r requirements.txt`
3. 生成 `env.json`：`{ pythonPath, whisperModelDir, installedAt, versions }`
4. 跑八项环境检查，逐项打绿/黄/红
5. 若同目录存在 `wheels\nvidia_*.whl` 也一并装（单包场景）

**全程不联网**，只用 `--no-index`。

### 6.5 四条纪律

- **不放 venv** —— 里面是绝对路径，绑死本机，别人拷走跑不了。
- **必须带 `SHA256SUMS.txt`** —— cublas 553 MB、`model.bin` 1.6 GB，坏一个字节就加载失败，而报错完全指不到根因。
- **压缩用 zip，且不重压** —— wheel 本身就是压缩包，再压几乎没有收益，却让人多装一个解压工具。
- **README 的免责声明原样保留** —— 环境问题不归项目管，这句话是这份包的一部分。

### 6.6 合规

NVIDIA 的轮子按 EULA **不属于可公开再分发的产物**。用户已明确决定带进包里（Q1 = b），前提是这份包**只做私下转发、不公开挂出**。详见 ADR 0004。若要公开发布，先剔除 `nvidia_*` wheel，README 改成一条 `pip install`。
