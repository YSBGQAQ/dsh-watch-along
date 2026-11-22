// 冒烟：apply() 必须能完整跑完。
//
// 这条是被一次真实翻车逼出来的：把服务管家插在 `const disposers = []` 之前，
// apply 里第一次 push 就抛 ReferenceError —— 插件在 DSH 里显示"异常"，
// 而 plugin.log 只到半路就断，单元测试全绿也发现不了。
// 教训：**apply 本身要有测试**，不能只测它调用的那些函数。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.WATCH_ALONG_NO_PANEL = '1' // 别占 8790，测试进程要能退出

test('apply 用假 ctx 能跑完，并注册 6 个工具', async () => {
  const mod = await import('../index.js')
  const registered = []
  const logged = []
  const ctx = {
    logger: { info: (m) => logged.push(String(m)), warn: () => {} },
    tools: { register: (t) => { registered.push(t?.name); return () => {} } },
    get: () => undefined,
    on: () => () => {},
    effect: () => {},
  }
  assert.doesNotThrow(() => mod.apply(ctx, { mobile: false, panel: false }))
  assert.equal(registered.length, 6, `只注册了 ${registered.length} 个：${registered.join(',')}`)
  assert.ok(logged.some((m) => m.includes('就绪')), '没有就绪日志')
})
