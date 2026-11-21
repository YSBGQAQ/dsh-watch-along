# 15: 打包与可移植（换台机器能装起来）

**What to build:** 现在只有这台机器能跑：`MODEL_DIR` 是绝对路径、venv 在桌面目录、两个服务的启动命令是手拼的。

**Blocked by:** 05

**Status:** 进行中（路径与启动脚本已做，README 待写）

- [x] `MODEL_DIR` 改为：`WATCH_ALONG_WHISPER_DIR` → 仓库内 `models/whisper-turbo`
- [ ] `python/ocr_service.py` 同理（模型在 wheel 里，路径不必配）
- [ ] 一条 `scripts/setup.cmd`：创建 venv、离线装 wheel、校验模型文件齐全
- [x] `scripts/start-services.cmd`：一次起两个服务，端口/解释器/模型全走环境变量，文件本身不用改
- [ ] `README.zh.md`：从零到"能陪看"的步骤，含"音量必须是 0 以上"这种前置
- [ ] 换一台机器（或重装 venv）能照文档跑通

## 为什么要紧
"能跑"和"能交付"是两件事。现在环境全硬编码，别人拿到仓库装不起来。

## 说明（2026-11-21）
- `ocr_service.py` 的模型在 wheel 里（`rapidocr/models/*.onnx`），不需要配置路径
- 启动脚本用 `start "title" "<exe>" ...` 直接拉起，不再嵌套一层 shell
- 仍缺：`scripts/setup.cmd`（建 venv + 离线装 wheel）与 README
