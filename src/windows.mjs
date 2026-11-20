// 窗口发现：列表用 PowerShell（拿标题最省事），取矩形用 koffi（快、每帧级可用）。
import { execFileSync } from 'node:child_process'
import { windowRect } from '../vendor/dsh-streamvision-main/lib/native.js'

/**
 * 当前可见的顶层窗口标题（去重）。
 * 只在 watch_windows 与「找不到窗口」的报错里用，所以慢一点可以接受。
 */
export function listWindows({ timeoutMs = 8000 } = {}) {
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle -Unique",
  ].join('; ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    })
    return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
  } catch {
    return []
  }
}

/** 按标题片段找窗口矩形；找不到或最小化时返回 null。 */
export function lookupWindow(fragment) {
  return windowRect(fragment)
}
