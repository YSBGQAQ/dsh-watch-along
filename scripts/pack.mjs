// 打一个能直接分享的 zip：别人解压 → 放好 → 在 DSH 里 link 进去就能用。
//
// 为什么要有白名单而不是"排除法"：
//   仓库里有 `.scratch`（跑出来的帧图、日志、会话 ID、用户窗口标题），
//   这些**绝对不能**进分享包。白名单比黑名单安全一个数量级。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const OUT = path.join(ROOT, 'dist', `dsh-watch-along-${pkg.version}`)

const files = [
  'index.js',
  'client.js',
  'package.json',
  'dsh.plugin.json',
  'cordis.patch.yml',
  'README.zh.md',
  'GLOSSARY.md',
]

// 目录级白名单：[源, 目标, 额外排除]
const dirs = [
  ['src', 'src', []],
  ['python', 'python', ['__pycache__']],
  // 这两个第三方项目是运行时依赖（管线 / PNG 编码 / 窗口坐标），只带用得到的部分
  ['vendor/dsh-see-now-main', 'vendor/dsh-see-now-main', ['samples', 'docs', 'test', 'examples', 'debug', 'node_modules', '.tmp', '.github']],
  ['vendor/dsh-streamvision-main', 'vendor/dsh-streamvision-main', ['samples', 'docs', 'test', 'examples', 'data', 'node_modules']],
  // koffi 是唯一的外部依赖。注意：**真正的 .node 二进制在 @koromix/koffi-win32-x64 里**，
  // 只带 koffi 本身在别人机器上会 load 失败（2026-11-23 打包时踩到）。
  ['node_modules/koffi', 'node_modules/koffi', ['doc', 'vendor']],
  ['node_modules/@koromix', 'node_modules/@koromix', []],
]

// 这两个脚本是收包的人最先用到的
const scripts = ['scripts/setup.cmd', 'scripts/start-services.cmd']

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

rmrf(OUT)
fs.mkdirSync(OUT, { recursive: true })

let bytes = 0
function copyFile(from, to) {
  const dst = path.join(OUT, to)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(from, dst)
  bytes += fs.statSync(dst).size
}

for (const f of files) {
  const src = path.join(ROOT, f)
  if (!fs.existsSync(src)) {
    console.log('跳过（不存在）：', f)
    continue
  }
  copyFile(src, f)
}

for (const [from, to, skip] of dirs) {
  const src = path.join(ROOT, from)
  if (!fs.existsSync(src)) {
    console.log('跳过（不存在）：', from)
    continue
  }
  const walk = (rel) => {
    const abs = path.join(src, rel)
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, ent.name)
      if (skip && r.split(/[\\/]/).some((seg) => skip.includes(seg))) continue
      if (ent.isDirectory()) walk(r)
      else copyFile(path.join(abs, ent.name), path.join(to, r))
    }
  }
  walk('')
}

for (const s of scripts) {
  const src = path.join(ROOT, s)
  if (fs.existsSync(src)) copyFile(src, s)
}

// 收包的人先看这个。正文维护在 docs/install.md，这里只负责拷进去 ——
// 之前把整篇说明写在脚本字符串里，改一次要动代码，容易和实际包对不上。
fs.copyFileSync(path.join(ROOT, 'docs', 'install.md'), path.join(OUT, 'INSTALL.md'))

const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(`已生成：${OUT}`)
console.log(`体积：${mb} MB（未压缩）`)
