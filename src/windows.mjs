// 窗口发现：列表用 PowerShell（拿标题最省事），取矩形用 koffi（快、每帧级可用）。
import { execFileSync } from 'node:child_process'
import { windowRect, dpiForSystem } from '../vendor/dsh-streamvision-main/lib/native.js'

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

/**
 * 按标题片段找窗口矩形；找不到或最小化时返回 null。
 *
 * gdigrab 抓的是「桌面坐标」，桌面坐标的尺度取决于抓取进程是否声明了高 DPI 感知；
 * 而 native.js 里写死了 -4（Per-Monitor-V2），拿到的矩形是物理像素。150% 缩放下
 * 直接用物理坐标去抓，会抓成左上角的一小块。这里按系统 DPI 换回逻辑坐标。
 */
export function lookupWindow(fragment, { dpiScale = null } = {}) {
  const hit = windowRect(fragment)
  if (!hit) return hit
  const scale = dpiScale ?? dpiForSystem() / 96
  if (!(scale > 0) || scale === 1) return { ...hit, dpiScale: 1 }
  return {
    x: Math.round(hit.x / scale),
    y: Math.round(hit.y / scale),
    width: Math.round(hit.width / scale),
    height: Math.round(hit.height / scale),
    hwnd: hit.hwnd,
    dpiScale: scale,
  }
}
