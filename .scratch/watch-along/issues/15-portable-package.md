# 15: 打包与可移植（换台机器能装起来）

**What to build:** 现在只有这台机器能跑：`MODEL_DIR` 是绝对路径、venv 在桌面目录、两个服务的启动命令是手拼的。

**Blocked by:** 05

**Status:** done（脚本与文档齐备；setup 未在干净环境实测）

- [x] `MODEL_DIR` 改为：`WATCH_ALONG_WHISPER_DIR` → 仓库内 `models/whisper-turbo`
- [ ] `python/ocr_service.py` 同理（模型在 wheel 里，路径不必配）
- [x] `scripts/setup.cmd`：建 venv（已存在则跳过）、离线装包、校验 whisper 五个文件、import 冒烟
- [x] `scripts/start-services.cmd`：一次起两个服务，端口/解释器/模型全走环境变量，文件本身不用改
- [x] `README.zh.md`：前置条件/安装/启动/DSH 用法/手机/排障表/已知限制
- [ ] 换一台机器照文档跑通（**未验**：本机 venv 已装好，只能验"跳过"分支）

## 为什么要紧
"能跑"和"能交付"是两件事。现在环境全硬编码，别人拿到仓库装不起来。

## 说明（2026-11-21）
- `ocr_service.py` 的模型在 wheel 里（`rapidocr/models/*.onnx`），不需要配置路径
- 启动脚本用 `start "title" "<exe>" ...` 直接拉起，不再嵌套一层 shell
- 仍缺：`scripts/setup.cmd`（建 venv + 离线装 wheel）与 README

## 追加（2026-11-23）：环境包必须带 `dsh-live-compact`

用户要求：**把上下文压缩插件塞进环境包**，否则别人拿到装好也在长会话里报上下文超限。

- 已产出 `package/plugins/dsh-live-compact-1.1.12.tgz`（107 KB，MIT），
  SHA256 `9185d0dc…7c4d16`
- 安装与验证写进 `docs/downloads.md` 6.7；包目录树（6.1）也加了 `plugins\` 一行
- 它属于 DSH 侧 JS 插件，不进 venv、不进 wheels，跟 python 依赖完全分开
