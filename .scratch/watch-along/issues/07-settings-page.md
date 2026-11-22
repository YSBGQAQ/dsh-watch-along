# 07: 设置页

**What to build:** 打开设置页，第一屏先告诉你环境齐不齐；齐了才谈参数。参数改完要重启 DSH 生效，改坏了会当场告诉你为什么。

**Blocked by:** 02

**Status:** closed（不做了，用户 2026-11-21 决定）

- [ ] 设置页第一屏是**环境检查**：八项（Python / 三个包 / ffmpeg / 驱动 / CUDA / OCR 模型 / Whisper 五文件 / 输出设备），每项绿黄红加一句原因
- [ ] 环境检查里**没有任何下载动作**，失败只给原因与 README 对应地址
- [ ] 常用 6 项可改：窗口标题、场景预设、画质档、字幕开关、声音开关、说话频率
- [ ] 选场景预设（游戏 / 讲课 / 影视）一次性写入对应参数，界面上能看到改后的值
- [ ] 高级折叠里能看到裸阈值，但默认收起
- [ ] 提交非法值返回 200 + `rejected`，界面在对应输入框下显示后端给的原因
- [ ] 改完画质档 → 重启 DSH 后生效（不承诺即时生效）

## 进度：四块逻辑已收口（2026-11-21 09:06）

界面壳子还没做，但界面要绑的四块全部完成且有测试（`test/settings.test.mjs`、`test/doctor.test.mjs`）：

| 块 | 文件 | 对外形状 |
|---|---|---|
| 默认值与场景预设 | `src/settings.mjs` | `DEFAULTS`、`PRESETS`（游戏/讲课/影视，数值取自 spec） |
| 校验 | `src/settings.mjs` | `validate(patch, current) => {ok, value, rejected:[{field,reason}]}`，**不抛错** |
| 环境检查清单 | `src/settings.mjs` | `ENV_CHECKS`（八项 id/label） |
| 环境检查执行 | `src/doctor.mjs` | `runChecks(probes) => {checks[], ready, failed[]}`，三档 ok/warn/fail |

界面接上后，**这四块一行都不用改**：读 `DEFAULTS` 渲染表单、提交走 `validate`、第一屏渲染 `runChecks` 的结果。

### 还没做的（全是 UI 层）

- `client.js` 设置面板（需 DSH client 插件规范：`dsh.client` 字段 + 挂载点）
- 高级参数的折叠展开
- 把 `rejected` 逐条显示到对应输入框下面

### 两条刻意的设计（别在 UI 层破坏）

1. **`validate` 不抛错**：非法值是 `200 + rejected`，界面才能指出"哪一项、为什么"。抛错就只剩"保存失败"。
2. **没探测器的项标黄不标绿**：绿必须是"真的查过且没问题"。假绿比红危险——红会被修，假绿会让人以为好了。

## 结票（2026-11-21 11:38）：UI 不做，逻辑层保留

**决定**：宿主 composition 这条路走不通，用户拍板**不做了**，本票按通过结。

**依据（已排除 6 种写法，见 docs/client-ui-contract.md）**
- `inject: []` → `cannot get property "slots" without inject`（容器不允许访问未申报服务）
- 申报 5 个（照抄本机跑得通的插件）→ 5 个全 `ctx.get() === undefined`
- 两边都是死路，说明服务不在我们这条 entry 的作用域里，与写法无关

**已交付且继续有效的部分**
| 文件 | 内容 |
|---|---|
| `src/settings.mjs` | 默认值、三个预设、校验（非法值 200 + rejected）、持久化 |
| `src/doctor.mjs` | 环境检查八项，绿/黄/红三档 + 原因 |
| `test/settings.test.mjs`、`test/settings-store.test.mjs`、`test/doctor.test.mjs` | 覆盖上述逻辑 |

**保留的替代路径（本票不做，记在这里）**
设置界面可以由插件自己的 HTTP 服务提供（手机端接口 8770 已在跑），
浏览器打开即可用，不受宿主版本影响、也不用重启 DSH。要做时另开票。

**不做 UI 的代价**：改设置只能改 `watch-along.json` 或环境变量。
功能一件没少。

## 补记（2026-11-23）：场景预设已删除

本页上方清单里的「场景预设」（游戏/讲课/影视一次写多键）**不做了**，理由是用户 2026-11-21
的决定：参数逐个暴露，不做一键预设。

代码状态：`src/settings.mjs` 没有 `PRESETS`，`validate()` 不接受 `preset` 字段，
`watch_start` 也没有 `preset` 参数。文档已同步：`spec.md` 的用户故事 22 与设置章节、
`docs/client-ui-contract.md` 的区块表都标了「已取消」。

**别再照着本页的旧清单把预设加回来** —— 要加先改 spec 并说明为什么推翻了当时的决定。
