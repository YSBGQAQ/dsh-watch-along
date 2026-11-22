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
| 常用项 | `DEFAULTS` 渲染 | 改完走 `validate(patch)`，`rejected` 逐条显示在字段下 |
| ~~场景预设~~ | ~~`PRESETS`~~ | **已取消**（2026-11-21 用户决定）：参数逐个暴露，不再做一键预设 |
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

## 实测反馈（2026-11-21 09:44）

浏览器控制台（设置页 Ctrl+Shift+I）：

```
web boot: warning: 1 entry did not activate
dsh-watch-along: pending (waiting for service: @deepseek-ai/dsh-client-ui-slots)
```

**含义**：client.js 被加载器读到了，但它在等 `@deepseek-ai/dsh-client-ui-slots` 这个服务，
而该服务没有就绪 → 面板永远不激活 → 设置里看不到「陪看」。

**已改**：`dsh.client.inject` 从两个补成三个（加上 `@deepseek-ai/dsh-client-locale`），
与 basics-panel 完全一致。

**下次要看**：重启后控制台那句话是否变化 ——
- 若变成 `waiting for service: @deepseek-ai/dsh-client-locale`，说明 locale 缺，继续补
- 若消失但仍无面板，说明服务齐了但槽位名不对（去查 basics-panel 里 `"nav"` 的用法）
- 若报别的错，按报错原文查

## 结论（2026-11-21 09:46）：卡在未公开的客户端服务契约上，暂时撤下

**两次重启，控制台一字不变：**

```
web boot: warning: 1 entry did not activate
dsh-watch-along: pending (waiting for service: @deepseek-ai/dsh-client-ui-slots)
```

- 补齐 `locale` 后无变化 → 不是注入清单缺项
- `client.js` 已被加载器读到（否则不会有这条 pending）
- 报错明确指向 **服务本身没提供**，不是我们调用方式错

**已做**：从 `package.json` 撤掉 `dsh.client`，控制台恢复干净；`client.js` 保留在仓库里
（代码是对的，差的是宿主没有这个服务）。

**下次要查的三件事**
1. 本机这个 DSH 构建里，`@deepseek-ai/dsh-client-ui-slots` 到底叫什么（去 `app.asar` 或
   `dsh-client-*` 包的 manifest 里找服务名）
2. 有没有别的面板类插件真在本机跑起来过（拿它的声明做对照）
3. 是否必须通过官方的插件脚手架打包，手写的 `__ModuleLoader__` 形态不被接受

**在此之前，设置界面这条路是堵的** —— 但插件的功能一件没少：
工具、三条通道、手机端接口全部可用，只是没有图形设置入口。

## 第二次结论（2026-11-21 09:54）：五个服务全 pending，已排除的假设

补齐成 purge 的清单后，控制台变成：

```
dsh-watch-along: pending (waiting for services: @deepseek-ai/dsh-client-connection,
  @deepseek-ai/dsh-client-runtime, @deepseek-ai/dsh-client-locale,
  @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-settings)
```

**五个全等** = 我们的 client entry 没拿到**任何**服务作用域，不是"少一个"。

与 `dsh-purge-community`（本机唯一确认跑通的同类插件）逐项比对，**四项完全一致**：

| 项 | 结论 |
|---|---|
| `exports["./client"]` | 一致（都是 `./client.js`） |
| 包装形态 | 一致（`window.__ModuleLoader__.load({id, factory})`） |
| `dsh.client.inject` 清单 | 一致（照抄后 5 项全同） |
| `cordis.patch.yml` | 一致（都只有 bundle 内条目） |

差别只剩**宿主内部的客户端引导逻辑**——那份代码在 `app.asar` 里，插件侧读不到。

**判断**：手写 client 这条路在当前构建上走不通，不是写法问题。
要么用官方脚手架打包（可能有额外的构建产物标记），要么等宿主文档。

**已撤**：`dsh.client` 从 package.json 移除，控制台恢复干净；`client.js` 保留待用。

## 第三次结论（2026-11-21 09:59）：闭环矛盾，钉死

导出 `inject: []` 后控制台变成：

```
dsh-watch-along: failed: Error: cannot get property "slots" without inject
```

**这条把结论钉死了**，因为它是宿主的 Cordis 容器在拒绝"访问未申报的服务"：

| 写法 | 结果 |
|---|---|
| 不申报（`inject: []`） | `ctx.slots` **访问即抛** → entry failed |
| 申报 5 个 | 5 个全 `ctx.get() === undefined` → entry pending |

**两边都走不通，说明服务确实不在我们这条 entry 的作用域里。** 不是清单写错、不是格式不对、不是缺 locale。

### 已排除（六项）
1. `exports["./client"]` 路径 — 与 purge 一致
2. `__ModuleLoader__.load` 包装形态 — 与 purge 一致
3. `dsh.client.inject` 清单 — 照抄 purge 后 5 项全同
4. `cordis.patch.yml` — 与 purge 一致
5. 缺 locale — 补了没用
6. 手写 vs 打包 — 加载器能读到（否则不会有 pending/failed 诊断）

### 剩下的可能（都要读宿主源码才能确认）
- 客户端服务由**另一套 composition** 提供，我们的包只进了服务端那份
- purge 能跑是因为它**改过宿主**（目录里有 `lib/index.js.dshpurge.bak`）
- 官方插件可能有构建期标记（如 `__PURGE_MODULE_URL__` 那样的注入）

### 已撤
`dsh.client` 移除，控制台恢复干净。`client.js` 保留，`apply` 里已做可选访问保护。
