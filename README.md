# 实时陪看（watch along）

让 AI 陪你看网页上的直播或长视频：它盯着同一个窗口，读屏幕上的字、听系统输出的声音，把这一切变成一条带时间码的文字事件流，需要看清细节时再要一张拼图。电脑端直接可用，手机端可通过局域网读取。

> **环境必须先备好再谈使用。** 本项目**不代下载、不代安装**任何依赖（Python 包、模型权重、ffmpeg、显卡驱动）。缺什么请照下面的表格自己下好；**环境问题不在本项目支持范围内**——我们能查的是代码，查不了你的网络和显卡驱动。

---

## 一、环境要求（全部需要提前备好）

### 必需

| 组件 | 版本 | 用途 | 从哪下 | 体积 |
|---|---|---|---|---|
| **Python** | 3.12.x | 跑 OCR / 录音 / 转写 | <https://www.python.org/downloads/release/python-31210/> | ~25 MB |
| **ffmpeg** | ≥ 7.0（实测 9.0.2 可用） | 抓屏幕 | <https://www.gyan.dev/ffmpeg/builds/> | ~80 MB |
| **Node.js** | ≥ 20（实测 22） | 插件运行时 | <https://nodejs.org/> | ~30 MB |
| **DSH 桌面版** | 当前版本 | 插件宿主 | <https://github.com/deepseek-ai/deepseek-harness/releases> | — |
| **NVIDIA 驱动** | 支持 CUDA 12 | GPU 转写 | <https://www.nvidia.com/download/> | — |

### Python 包

装进一个 Python 3.12 的 venv 里，离线安装：

```powershell
pip install --no-index --find-links=<wheels 目录> -r requirements.txt
```

| 包 | 版本 | 用途 | 从哪下 |
|---|---|---|---|
| `rapidocr` | ≥ 3.9（实测 3.10.0） | 字幕 OCR。**wheel 内已含 PP-OCRv6 det/rec small 模型**（约 31 MB），不用另下 | <https://pypi.org/project/rapidocr/> |
| `onnxruntime` | ≥ 1.17（实测 1.32） | OCR 推理 | <https://pypi.org/project/onnxruntime/> |
| `faster-whisper` | ≥ 1.1（实测 1.2.1） | 语音转写 | <https://pypi.org/project/faster-whisper/> |
| `ctranslate2` | 随 faster-whisper（实测 4.9） | 转写推理引擎 | 同上 |
| `soundcard` | ≥ 0.4（实测 0.4.6） | 系统声音环回 | <https://pypi.org/project/soundcard/> |
| `numpy` | ≥ 1.26（实测 2.5.5） | 音频处理 | <https://pypi.org/project/numpy/> |
| `nvidia-cublas-cu12` | 12.x（实测 12.9） | **GPU 转写必需**，约 553 MB | <https://pypi.org/project/nvidia-cublas-cu12/> |
| `nvidia-cudnn-cu12` | 9.x（实测 9.28） | **GPU 转写必需**，约 696 MB | <https://pypi.org/project/nvidia-cudnn-cu12/> |

> 国内可加 `-i https://pypi.tuna.tsinghua.edu.cn/simple` 加速。

### 模型权重

| 模型 | 文件 | 从哪下 | 体积 |
|---|---|---|---|
| **Whisper large-v3-turbo**（CTranslate2 fp16） | `model.bin` `config.json` `tokenizer.json` `vocabulary.json` `preprocessor_config.json` | <https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo>（备选：<https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2>） | ~1.6 GB |
| **PP-OCRv6 small** | 已在 `rapidocr` 的 wheel 内 | — | 31 MB |

**Whisper 五个文件必须齐全**，少一个都加载不了。放哪个目录都行，设置页里指过去即可。

---

## 二、安装

1. 用 Python 3.12 建 venv（**不下载任何东西**）：

   ```powershell
   py -3.12 -m venv <某个目录>\venv
   ```

2. 离线装包：

   ```powershell
   <某个目录>\venv\Scripts\python.exe -m pip install --no-index --find-links=<wheels 目录> -r requirements.txt
   ```

3. 把 Whisper 模型放好，记住路径。

4. 在 DSH 里装插件，重启宿主。

---

## 三、设置页

进 **设置 → 插件 → 实时陪看**。

### 第 1 项永远是「环境检查」

只读，不提供任何一键下载（本项目不代下依赖）。每一项显示三种状态：

| 状态 | 含义 |
|---|---|
| 绿 | 可用 |
| 黄 | 可用但降级（例如 GPU 不可用，转写会失败但画面照常） |
| 红 | 不可用，该功能整条停用 |

检查项固定为这八条：

1. Python 解释器可执行，版本是 3.12
2. `rapidocr` / `faster_whisper` / `soundcard` 三个包能导入
3. `ffmpeg` 在 PATH 上，版本 ≥ 7
4. NVIDIA 驱动可见（`nvidia-smi` 能跑）
5. ctranslate2 能加载 CUDA（真的跑一句静音）
6. OCR 模型可加载（PP-OCRv6 small 在 wheel 内）
7. Whisper 模型目录存在，五个文件齐全
8. 系统默认输出设备可枚举（环回录音的前提）

每一项失败时，只显示**一句话原因 + README 里对应的下载地址**，不替用户下载。

### 之后才是参数

- 常用 6 项：窗口标题、场景预设、画质档、字幕开关、声音开关、说话频率
- 高级折叠：采样帧率、切点地板、积分秒数、字幕稳定间隔、句子封顶、事件保留条数

改完参数需要**重启 DSH** 生效。

---

## 四、使用

1. 在浏览器里打开直播间，窗口别拖来拖去（采集区域在启动时锁定）。
2. 对 AI 说一句「陪我看这个窗口，标题里有 XXX」。
3. AI 会开始收到事件；要看清画面时说「现在什么样」，它会取一张拼图。

---

## 五、已知限制

- **只支持 Windows**（依赖 gdigrab 与 WASAPI）。
- **窗口移动**会让采集区域错位，最多 0.4 秒后自动重启采集。
- **窗口关闭或最小化**一律按故障处理：三条通道一起停、写日志、报错。
- **BGM 压过人声时转写会掉字**（不做人声分离）；唱歌会被当说话转写，MV 类内容不适合。
- **换音频输出设备**（音箱↔耳机）后需要重启插件。
- **单显示器**设计，副屏与负坐标未支持。
- 手机端只提供接口（事件与图片），**不含手机 App**。

---

## 六、致谢

画面链路复用 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0）；字幕链路的思路与可插拔接口来自 [dsh-streamvision](https://github.com/shet114513/dsh-streamvision)（MIT）；VAD 与幻觉过滤来自 [dsh-better-ears](https://github.com/Destinhue/dsh-better-ears)（MIT）；转写参数参考 [dsh-soundtry](https://github.com/CixiSVesper/dsh-soundtry)。
