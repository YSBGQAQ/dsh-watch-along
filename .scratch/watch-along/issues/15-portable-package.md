# 15: 打包与可移植（换台机器能装起来）

**What to build:** 现在只有这台机器能跑：`MODEL_DIR` 是绝对路径、venv 在桌面目录、两个服务的启动命令是手拼的。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] `python/asr_service.py` 的 `MODEL_DIR` 改成"环境变量 → 配置文件 → 默认相对路径"三级
- [ ] `python/ocr_service.py` 同理（模型在 wheel 里，路径不必配）
- [ ] 一条 `scripts/setup.cmd`：创建 venv、离线装 wheel、校验模型文件齐全
- [ ] `scripts/start-services.cmd`：一次起两个服务，端口可改
- [ ] `README.zh.md`：从零到"能陪看"的步骤，含"音量必须是 0 以上"这种前置
- [ ] 换一台机器（或重装 venv）能照文档跑通

## 为什么要紧
"能跑"和"能交付"是两件事。现在环境全硬编码，别人拿到仓库装不起来。
