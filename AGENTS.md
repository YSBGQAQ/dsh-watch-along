# AGENTS.md

这个仓库的工作约定，供 AI coding agent 读取。

## 硬性规则：下载必须由用户执行

**本项目涉及的一切网络下载——pip 包、wheel、模型权重、工具二进制——不允许 agent 私自拉取。**

需要什么就列清单交办用户，由用户下载到约定位置后再使用。约定的落地位置是
`C:\Users\24206\Desktop\源码与作者说明\_deps\`（`wheels` / `models` / `venv` 三个子目录）。

原因：本机到 HuggingFace、GitHub 的直连不稳（历史上 `git clone` 反复被 TLS 掐断），
而模型动辄 GB 级；agent 盲目重试既浪费时间，也容易留下半截文件而毫无察觉。

清单见 `docs/downloads.md`。

## 在 DSH 里下指令的固定格式

每次让 DSH 那边验功能，指令必须写清三件事，缺一不可：

1. **开头声明「这是一次测试，不是真实使用」** —— 否则对面会自己补上下文、改目标、替我们"优化"。
2. **明确希望返回什么** —— 字段名、条数、格式。不写就会被总结成一段话，拿不到原始数据。
3. **明确没返回时怎么办** —— 报错该贴原文还是换路子、该不该重试。不写就会自己发挥，把我们不知道的情况掩盖掉。

**为什么要写这么死**：实测中三次被误导，全是"对面自己补全意图"造成的——
把我们的字段名当成视频内容去分析、把 `desktop_app` 当成 `watch_windows` 报"已验证"、
在报错后自己换方案而不说。指令含糊，回来的东西就不能用。

## Agent skills

### Issue tracker

Issues 和 specs 以 markdown 文件存放在 `.scratch/<feature>/` 下。详见 `docs/agents/issue-tracker.md`。

### Domain docs

Single-context：仓库根目录的 `GLOSSARY.md` 加 `docs/adr/`。详见 `docs/agents/domain.md`。
