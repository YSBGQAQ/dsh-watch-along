// 窗口发现：列表与匹配用**同一套**原生枚举（capture-koffi），不再走 PowerShell。
// 为什么换掉 PowerShell：起一个 powershell.exe 约 300ms，面板刷新一次就抖一下；
// 更要紧的是它列的是"进程主窗口标题"，和按标题匹配时枚举的"顶层可见窗口"是两个来源，
// 会出现"列表里有、匹配时找不到"。
import { windowRect, dpiForSystem } from '../vendor/dsh-streamvision-main/lib/native.js'
import { listWindowTitles } from './capture-koffi.mjs'

/**
 * 当前可见的顶层窗口标题（按标题去重，保持枚举顺序：最上层在前）。
 * 微秒级，可以给面板频繁刷新用。
 */
export function listWindows() {
  try {
    return listWindowTitles().map((x) => x.title)
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
