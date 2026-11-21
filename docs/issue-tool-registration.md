# 待修：工具注册成功但不出现在会话里

记录时间：2026-11-21 08:30。**未修**，只做诊断留档。

## 现象

- `.scratch/run/plugin.log` 明确记录 `apply 完成：注册 6 个工具`（08:12、08:28 两次）
- 但 DSH 会话的工具列表里**没有任何 `watch_*` 工具**
- 重启两次都一样；`apply` 没抛错，`register()` 也没抛

## 同类失败在社区已有记载

`vendor/dsh-see-now-main/src/define-tool.js` 开头的原话：

> 插件的工具定义要用宿主的 `defineTool()`：它把 author spec 编译成 JSON Schema、给 execute 包一层参数校验。但 `@deepseek-ai/dsh-tools` **被打包进宿主的 `app.asar`**，插件从自己的 `node_modules` 往上解析时**找不到这个包** → `import()` 抛 → `apply()` 被 catch 吞掉 → **整个插件静默不注册任何工具**。

> 「根源没变：它 `import('@deepseek-ai/dsh-tools')`，宿主的这份被打进 `app.asar`，plugins 侧解析不到，加载时就在注册工具之前抛了」

## 判断

我们的工具形状不对，两处：

1. **`parameters` 给的是 JSON Schema，宿主 `defineTool` 要的是属性表（author spec）**

   ```js
   // 现在（错）
   parameters: { type: 'object', properties: { window: { type: 'string' } }, required: ['window'] }
   // 应当是
   parameters: { window: { type: 'string', required: true, description: '…' } }
   ```

   编译规则：属性上的 `required: true` 提升到父级 `required` 数组并从属性里删掉；
   没标 `required: true` 的一律当可选。

2. **注册必须过 `defineTool` 包装**：`ctx.tools.register(裸对象)` 不报错，但产物不是宿主认的编译结果。

## 修法（三处）

1. `src/tools.mjs`：6 个工具的 `parameters` 改成属性表
2. `index.js`：`ctx.tools.register(defineToolCompat(tool))` —— 兜底实现直接复用
   `vendor/dsh-see-now-main/src/define-tool.js`（它逐条照抄了宿主的编译规则）
3. `test/tools.test.mjs`：断言编译后的 schema 里 `required` 是数组、且不含顶层 `type:'object'`

改完需要**重启 DSH** 才能验。

## 验证方法

1. 重启后看 `.scratch/run/plugin.log` 有没有新行
2. 会话里问「用 watch_windows 列出窗口，返回里要有 count 和 titles」
3. 拿到 `{count, titles}` 才算通——拿到 `id/pid/bounds` 是 `desktop_app` 在冒充

## 为什么这次失败让人烦

插件加载失败是**静默的**：不写宿主日志、不抛到界面、只是工具不见了。
本次已加的两处加固（每个工具单独 try/catch、失败也写文件日志）只能覆盖"注册抛错"，
覆盖不了"注册被接受但不生效"——这一类只能靠形状正确。
