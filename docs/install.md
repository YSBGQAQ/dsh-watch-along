# 安装（4 步）

这是一个 DSH 插件「陪看」：让 AI 看你的屏幕，读字幕、听声音，边看边跟你聊。
包名里的 `-main` 是程序本体，旁边同级的 `-env` 是它要用的 Python 环境。

## 0. 先看清楚拿到了什么

```
dsh-watch-along-0.1.0\                 ← 父目录
├── dsh-watch-along-0.1.0-main\        ← 程序（这个）
└── dsh-watch-along-0.1.0-env\         ← 环境（两个 zip）
    ├── env-part1-venv.zip
    └── env-part2-wheels-models.zip
```

## 1. 放好程序目录

把 `dsh-watch-along-0.1.0-main` 整个搬到**不会被同步盘搬走**的位置，例如：

    D:\dsh-plugins\dsh-watch-along-0.1.0-main

不要放桌面/OneDrive：软链遇到同步盘会断。

## 2. 让 DSH 认识它

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dependencies` 里加一行：

    "dsh-watch-along": "link:D:/dsh-plugins/dsh-watch-along-0.1.0-main"

然后在那个目录下执行：

    pnpm install

## 3. 准备环境（Python 服务）

### 3a. 解压

把 `-env` 里的两个 zip **解压到同一个目录**，得到：

```
<任意位置>\_deps\
├── venv\
├── wheels\
├── models\faster-whisper-small\
└── requirements.txt
```

### 3b. 两种用法，选一种

**A. 直接用（省事，但挑机器）**：`venv\pyvenv.cfg` 里写死了基座解释器路径
`C:\Users\24206\AppData\Local\Programs\Python\Python312`。对方机器必须也装了
Python 3.12 且在该路径，否则 `python.exe` 起不来。

**B. 自己建（推荐）**：用 `wheels` 里的离线包重建一个本机路径正确的 venv：

    cd <程序目录>
    scripts\setup.cmd

### 3c. 告诉插件环境在哪

编辑 `<程序目录>\.scratch\run\services.json`（没有就新建）：

    {
      "python": "<_deps 路径>\\venv\\Scripts\\python.exe",
      "whisperDir": "<_deps 路径>\\models\\faster-whisper-small"
    }

Whisper 目录必需 **4 个**文件：`config.json` / `model.bin` / `tokenizer.json` / `vocabulary.txt`
（**没有** `preprocessor_config.json` 是正常的）

## 4. 验证

重启 DSH → 新开一个会话 → 看设置页：

- 侧栏出现「陪看」
- 第一屏「环境检查」八项：Python / 三个包 / ffmpeg / 显卡 / CUDA / OCR 模型 / Whisper / 输出设备
  - 绿 = 能跑
  - 黄 = 能用但有隐患（例如没显卡走 CPU）
  - 红 = 按括号里的原因补，**插件不会替你下载任何东西**
- 点「启动服务」，两盏灯变绿后让 AI 调 `watch_start`

## 包里有什么

| 路径 | 作用 |
|---|---|
| `index.js` / `src/` | 插件主体：工具、消息、采集、服务管家 |
| `client.js` | 面板（设置 + 环境检查） |
| `python/` | 两个常驻服务：OCR / ASR |
| `vendor/` | 第三方代码：see-now 的管线、streamvision 的抓屏与 PNG（各自 LICENSE 在内） |
| `node_modules/koffi` + `@koromix/koffi-win32-x64` | 唯一的原生依赖（屏幕抓取），连 `.node` 二进制一起带 |
| `scripts/setup.cmd` | 用 wheels 建 venv |

**没有带**：`.scratch/`（运行数据与日志，含本机窗口标题）、`test/`、`docs/`。

## 已知限制

- 只在 Windows 上验证过（抓屏走 BitBlt + 进程回环）
- 环境包不含在 `-main` 里，需单独传（就是旁边的 `-env`）
- 长会话建议同时装 `dsh-live-compact`，否则上下文可能超限
