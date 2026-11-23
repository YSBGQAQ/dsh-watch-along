# 环境包（_deps）分发说明

陪看的画面/字幕/声音要两个常驻 Python 服务，它们依赖这个环境包。
**插件 zip 里不含它**（体积原因），需要单独传。

## 最终分发布局（2026-11-23 用户改名后）

用户把插件与环境拼在**一个父目录**里，再整体压成一个 rar 分发：

```
dsh-watch-along-0.1.0\                    ← 父目录（用户改名）
├── dsh-watch-along-0.1.0-main\           ← 插件本体（原 dist/dsh-watch-along-0.1.0）
└── dsh-watch-along-0.1.0-env\            ← 环境包（两个 zip 原样放这，**不再解压**）
    ├── env-part1-venv.zip
    ├── env-part2-wheels-models.zip
    └── README-环境包.md
```

打包产物：`dsh-watch-along-0.1.0.rar`（约 3.3 GB）。

**名字约定**（以后重新打包照这个来）：父目录 `<名字>-<版本>`，插件 `<名字>-<版本>-main`，
环境 `<名字>-<版本>-env`。三个名字只差后缀，收包的人一眼能看出哪个是程序、哪个是依赖。

⚠️ 拼好的目录与 rar 都放在仓库根下时，`git status` 会把它当未跟踪文件。
`.gitignore` 已加 `/dsh-watch-along-*/` 与 `*.rar`，但如果要长期保留，建议移到仓库外
（同盘 `mv` 是瞬时的）。

## 两个包

| 文件 | 内容 | 解压后 | 体积 |
|---|---|---|---|
| `env-part1-venv.zip` | `venv/`（Python 3.12 虚拟环境，含 rapidocr / faster-whisper / soundcard） | 2.4 GB | **1.41 GB** |
| `env-part2-wheels-models.zip` | `wheels/`（离线安装包）+ `models/`（Whisper small）+ `requirements.txt` | 1.9 GB | **1.81 GB** |

校验：

```
env-part1-venv.zip
  sha256 7b9e5beddeac218e1420261179c2e4789c1054f0a2575f9a2152f13c9bc762e8
env-part2-wheels-models.zip
  sha256 3edf0af4e5f36a8235d472db89b10c5ecea5d108d6e46db988e6393a70ad8fac
```

Windows 校验命令：`certutil -hashfile env-part1-venv.zip SHA256`

## 怎么用

**两个包解压到同一个目录**，解压后应该是：

```
<你选的目录>\_deps\
├── venv\
├── wheels\
├── models\faster-whisper-small\
└── requirements.txt
```

然后把路径写进插件的 `.scratch\run\services.json`：

```json
{
  "python": "<目录>\\_deps\\venv\\Scripts\\python.exe",
  "whisperDir": "<目录>\\_deps\\models\\faster-whisper-small"
}
```

重启 DSH → 面板点「启动服务」→ 环境检查里 Python / 三个包 / Whisper / OCR / 输出设备 应该全绿。

## ⚠️ venv 的两个坑（先看再解压）

1. **它认绝对路径**。`venv\pyvenv.cfg` 里写死了基座解释器：
   ```
   home = C:\Users\24206\AppData\Local\Programs\Python\Python312
   ```
   对方机器上**必须也装了 Python 3.12 且路径相同**，否则 `python.exe` 起不来。

2. **更稳的做法是不要用 part1，用 part2 自己建**：
   ```
   cd <目录>\_deps
   ..\..\dsh-watch-along\scripts\setup.cmd
   ```
   它会用 `wheels\` 里的离线包建一个**本机路径正确**的 venv。
   part1 只是"对方环境和这台机器一模一样"时的省事方案。

## 内容清单（解压后核对用）

- `venv\Lib\site-packages\` 里应有：`rapidocr`、`faster_whisper`、`soundcard`、`onnxruntime`、`ctranslate2`
- `wheels\` 应有 **42 个 `.whl`**
- `models\faster-whisper-small\` 应有 4 个文件：`config.json`、`model.bin`、`tokenizer.json`、`vocabulary.txt`
  （**没有** `preprocessor_config.json` 是正常的，小模型就是这样）

## 体积与传输

- 两个包合计 **3.2 GB**，都控制在 2 GB 以内（多数网盘/聊天工具的单文件上限）
- 传的时候**必须两个都传**，缺一个都装不出完整环境
