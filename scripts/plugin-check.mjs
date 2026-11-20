// 插件入口预检：不开 DSH，用一个假 ctx 调 apply，看工具能不能注册、能不能执行。
import { apply } from '../index.js'

const regs = []
const ctx = {
  tools: { register: (t) => { regs.push(t); return () => {} } },
  get: () => null,
  on: () => {},
  logger: { info: () => {} },
}

apply(ctx)
console.log(JSON.stringify({ registered: regs.length, names: regs.map((r) => r.name) }))

const windows = regs.find((r) => r.name === 'watch_windows')
const out = await windows.execute({})
console.log(JSON.stringify({ windowsCount: out.count, first: out.titles[0] ?? null }))

const status = await regs.find((r) => r.name === 'watch_status').execute({})
console.log(JSON.stringify({ state: status.state }))
