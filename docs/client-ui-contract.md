# DSH 客户端面板契约（侦察记录，2026-11-21）

参考实现：`C:\Users\24206\.dsh\vendor\dsh-basics-panel`（一个真实的设置面板插件）。

**状态：只读侦察完成，我们的面板还没写。**

## 1. 三处声明，缺一不可

**① `package.json` 的 exports 要有 `./client`**

```json
"exports": {
  ".": "./index.js",
  "./client": "./client.js"
}
```

**② `package.json` 的 `dsh.client`**

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-slots"
    ]
  }
}
```

**③ `client.js` 必须是"已打包"的形态**

不是普通 ESM。宿主用自带的模块加载器读它：

```js
window.__ModuleLoader__.load({
  id: 'dsh-basics-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')
    let jsx_runtime = require('react/jsx-runtime')
    // ...组件与 apply...
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

意味着：**没有 JSX 运行时编译**。要用 `jsx_runtime.jsx(type, props)` 或 `React.createElement` 手写元素树。

## 2. 挂到设置页的调用

```js
function apply(ctx) {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'basics-panel',      // 唯一 id
        order: 200,              // 排序
        label: () => '基础能力',  // 侧栏标题
        inject: () => ({ ctx }), // 给组件注入依赖
      },
      PanelSection,              // React 组件
    ),
  )
}
```

要点：
- `ctx.slots.inject(slotName, cb)` —— 槽位就绪后再注册，不能直接 register
- `ctx.effect(fn)` —— 注册与清理成对，返回 disposer
- `ctx.locale.register(ns, 'zh', dict)` —— 多语言（可选）

## 3. 我们的面板要画什么

逻辑层已经全部完成（`src/settings.mjs`、`src/doctor.mjs`），面板只是壳：

| 区块 | 数据来源 | 交互 |
|---|---|---|
| 环境检查八项 | `runChecks(probes)` | 只读，绿/黄/红 + 原因 |
| 常用 6 项 | `DEFAULTS` 渲染 | 改完走 `validate(patch)`，`rejected` 逐条显示在字段下 |
| 场景预设 | `PRESETS` | 一次写入 fps/density/quality/speechPerMin |
| 高级（折叠） | `region` / `maxWaitSec` | 同上 |

**面板与主进程通信**：走 `ctx` 提供的 RPC（待确认具体方法名，basics-panel 里是直接 `inject: () => ({ ctx })` 后组件用 ctx 调宿主服务）。
这一步还没验证过——**是下次开工的第一个待确认点**。

## 4. 为什么没有直接开写

1. `client.js` 要手写成打包产物形态，写错会让**整个插件加载失败**，连带 6 个工具一起消失（今天已经在"工具静默不注册"上摔过两次）
2. 面板与主进程的 RPC 接口还没确认
3. 上面两点都需要一次"改完重启验证"的循环，而验证失败的代价是所有工具不可用

## 5. 下次开工的步骤

1. 先确认 RPC：在 basics-panel 的 `src/client/` 里找 `ctx.` 调用了哪些宿主服务
2. 写一个**最小面板**（只画环境检查八项，只读，不写设置）
3. 重启验证：能打开、八项显示正常
4. 再加表单与校验（逻辑层已就绪，直接绑定）
