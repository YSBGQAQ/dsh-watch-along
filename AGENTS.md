# AGENTS.md

这个仓库的工作约定，供 AI coding agent 读取。

## 硬性规则：下载必须由用户执行

**本项目涉及的一切网络下载——pip 包、wheel、模型权重、工具二进制——不允许 agent 私自拉取。**

需要什么就列清单交办用户，由用户下载到约定位置后再使用。约定的落地位置是
`C:\Users\24206\Desktop\源码与作者说明\_deps\`（`wheels` / `models` / `venv` 三个子目录）。

原因：本机到 HuggingFace、GitHub 的直连不稳（历史上 `git clone` 反复被 TLS 掐断），
而模型动辄 GB 级；agent 盲目重试既浪费时间，也容易留下半截文件而毫无察觉。

清单见 `docs/downloads.md`。

## Agent skills

### Issue tracker

Issues 和 specs 以 markdown 文件存放在 `.scratch/<feature>/` 下。详见 `docs/agents/issue-tracker.md`。

### Domain docs

Single-context：仓库根目录的 `GLOSSARY.md` 加 `docs/adr/`。详见 `docs/agents/domain.md`。
