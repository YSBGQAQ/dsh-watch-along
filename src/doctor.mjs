// 环境检查：八项各自"能不能用、为什么不能用"。
//
// 探测函数是注入的 —— 单测不需要真去查显卡；真实探测在 defaultProbes 里。
import fs from 'node:fs'
import { ENV_CHECKS } from './settings.mjs'

/**
 * 每项探测返回 `{ ok, warn?, detail }`：
 *   ok=true            → 绿
 *   ok=true + warn     → 黄（能用但有隐患，例如 CPU 模式）
 *   ok=false           → 红，detail 必须说清原因
 * 探测抛错也算红 —— 但要把错误原文带上，不能只说"失败"。
 */
export async function runChecks(probes = {}) {
  const out = []
  for (const check of ENV_CHECKS) {
    const probe = probes[check.id]
    if (typeof probe !== 'function') {
      out.push({ ...check, state: 'warn', reason: '这项没有探测器（未实现）' })
      continue
    }
    try {
      const r = (await probe()) ?? {}
      if (r.ok === true) out.push({ ...check, state: r.warn ? 'warn' : 'ok', reason: r.detail ?? null })
      else out.push({ ...check, state: 'fail', reason: r.detail ?? '未知原因' })
    } catch (e) {
      out.push({ ...check, state: 'fail', reason: `${e?.message ?? e}` })
    }
  }
  return {
    checks: out,
    // 一眼可见的结论：任何一项红，就是"还不能开始陪看"
    ready: out.every((c) => c.state !== 'fail'),
    failed: out.filter((c) => c.state === 'fail').map((c) => c.id),
  }
}

const exists = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * 真实探测。路径从 env.json / 默认位置来，缺了就报"找不到"，**不做任何下载**
 * （spec：环境检查只解释问题，下载一律由人来做）。
 */
export function defaultProbes({ venvPython, modelDir, whisperDir, ffmpegPath = 'ffmpeg' } = {}) {
  return {
    python: () => ({
      ok: Boolean(venvPython) && exists(venvPython),
      detail: venvPython ? venvPython : '还没装 venv（先按 README 跑安装脚本）',
    }),
    pkgs: () => ({
      ok: Boolean(venvPython) && exists(venvPython),
      detail: exists(venvPython) ? 'venv 已存在；包是否齐全由 setup 脚本自检' : 'venv 不存在，包无从谈起',
    }),
    ffmpeg: () => ({
      ok: true,
      warn: !exists(ffmpegPath) && ffmpegPath.includes('/'),
      detail: ffmpegPath,
    }),
    driver: () => ({ ok: true, warn: true, detail: '未探测（需要 nvidia-smi，稍后补）' }),
    cuda: () => ({ ok: true, warn: true, detail: '未探测（需要加载 cublas，稍后补）' }),
    ocrModel: () => ({
      ok: Boolean(modelDir) && exists(modelDir),
      detail: modelDir ?? '未配置 OCR 模型目录',
    }),
    whisper: () => {
      const want = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json', 'preprocessor_config.json']
      if (!whisperDir) return { ok: false, detail: '未配置 Whisper 目录' }
      const missing = want.filter((f) => !exists(`${whisperDir}/${f}`))
      return {
        ok: missing.length === 0,
        detail: missing.length ? `缺 ${missing.join(' / ')}` : `${want.length} 个文件齐全`,
      }
    },
    audioOut: () => ({ ok: true, warn: true, detail: '未探测（需要列出环回设备，稍后补）' }),
  }
}
