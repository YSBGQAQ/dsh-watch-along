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

// 收包的人先看这个
fs.writeFileSync(
  path.join(OUT, 'INSTALL.md'),
  `# 安装（3 步）

这是一个 DSH 插件。**不装 Node 也能先跑起来**，但 DSH 本身需要 Node 20+。

## 1. 放好目录

把这个文件夹放到一个**不会被同步盘搬走**的位置，例如：

    D:\\dsh-plugins\\dsh-watch-along

（不要放桌面/OneDrive：软链遇到同步盘会断）

## 2. 让 DSH 认识它

编辑 \`%USERPROFILE%\\.dsh\\profiles\\desktop\\package.json\`，在 \`dependencies\` 里加一行：

    "dsh-watch-along": "link:D:/dsh-plugins/dsh-watch-along"

再执行（在该目录下）：

    pnpm install

## 3. 准备环境包（画面/字幕/声音要用的 Python 服务）

需要另外一份 \`_deps\`（venv + wheels，约 3.8 GB）和一个 Whisper 模型目录。
把路径写进 \`<插件目录>\\.scratch\\run\\services.json\`：

    {
      "python": "<_deps>\\venv\\Scripts\\python.exe",
      "whisperDir": "<模型目录>\\faster-whisper-small"
    }

**Whisper 目录必需文件**：config.json / model.bin / tokenizer.json / vocabulary.txt
（4 个，没有 preprocessor_config.json 是正常的）

## 4. 验证

重启 DSH →（新会话里）看设置面板：
- 侧栏出现「陪看」
- 第一屏「环境检查」八项，绿的能跑、红的按提示补

然后让 AI 调 \`watch_start\`。

---

## 包里有什么

| 路径 | 作用 |
|---|---|
| \`index.js\` / \`src/\` | 插件主体：工具、消息、采集、服务管家 |
| \`client.js\` | 面板（设置 + 环境检查） |
| \`python/\` | 两个常驻服务：OCR / ASR |
| \`vendor/\` | 第三方代码：see-now 的管线、streamvision 的抓屏与 PNG（各自 LICENSE 在内） |
| \`node_modules/koffi\` | 唯一的原生依赖（屏幕抓取），已随包带上 |
| \`scripts/setup.cmd\` | 建 venv（需要 _deps/wheels） |

**没有带**：\`.scratch/\`（运行数据与日志，含本机窗口标题）、\`test/\`、\`docs/\`。

## 已知限制

- 仅在 Windows 上验证过（抓屏走 BitBlt + 进程回环）
- 环境包（_deps）没有随包分发，需要单独拷
- 长会话建议同时装 \`dsh-live-compact\`，否则上下文可能超限
`,
)

const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(`已生成：${OUT}`)
console.log(`体积：${mb} MB（未压缩）`)
