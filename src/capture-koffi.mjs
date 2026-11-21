// koffi 直抓采集（替换 ffmpeg 子进程）。依据 ADR 0005 / 票 20。
//
// 为什么换：ffmpeg 子进程默认不声明 DPI 感知，`lookupWindow` 给的是逻辑像素，
// 直接传给 gdigrab 会抓偏（实测错两次）。这里在模块加载时声明 per-monitor DPI 感知，
// 之后所有坐标都是物理像素，不用换算。
//
// **段错误警告**：koffi 是 native 调用，参数类型传错会直接 segfault（没有异常栈）。
// 所以对外入口一律先做类型校验。
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

const GetDC = user32.func('void* GetDC(void* hwnd)')
const ReleaseDC = user32.func('int ReleaseDC(void* hwnd, void* hdc)')
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)')
const FindWindowW = user32.func('void* FindWindowW(str16 cls, str16 title)')
const GetWindowRect = user32.func('int GetWindowRect(void* hwnd, _Out_ int* rect)')
const CreateCompatibleDC = gdi32.func('void* CreateCompatibleDC(void* hdc)')
const CreateCompatibleBitmap = gdi32.func('void* CreateCompatibleBitmap(void* hdc, int w, int h)')
const SelectObject = gdi32.func('void* SelectObject(void* hdc, void* obj)')
const BitBlt = gdi32.func('int BitBlt(void* dst, int dx, int dy, int w, int h, void* src, int sx, int sy, uint32 rop)')
const GetDIBits = gdi32.func('int GetDIBits(void* hdc, void* bmp, uint32 start, uint32 lines, _Out_ uint8* bits, _Inout_ void* bi, uint32 usage)')
const DeleteObject = gdi32.func('int DeleteObject(void* obj)')
const DeleteDC = gdi32.func('int DeleteDC(void* hdc)')

const IsWindowVisible = user32.func('int IsWindowVisible(void* hwnd)')
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void* hwnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(void* hwnd, _Out_ uint16* buf, int n)')
const EnumWindows = user32.func('int EnumWindows(void* cb, intptr_t lParam)')
const ENUMPROC = koffi.proto('int __stdcall EnumProc(void* hwnd, intptr_t lParam)')

const SRCCOPY = 0x00cc0020

// per-monitor DPI aware：坐标与像素用同一把尺子
try {
  const setDpi = user32.func('int SetProcessDpiAwarenessContext(intptr_t ctx)')
  setDpi(-4)
} catch {
  /* 老系统没有这个 API 就按原样跑 */
}

const HEADER_SIZE = 40
function makeBitmapInfo(w, h) {
  const bi = Buffer.alloc(HEADER_SIZE + 16)
  bi.writeUInt32LE(HEADER_SIZE, 0)
  bi.writeInt32LE(w, 4)
  bi.writeInt32LE(h, 8) // 正数 = 自下而上
  bi.writeUInt16LE(1, 12)
  bi.writeUInt16LE(32, 14)
  bi.writeUInt32LE(0, 16) // BI_RGB
  return bi
}

export function findWindow(fragment) {
  if (!fragment) return null
  const want = String(fragment)
  let found = null
  const proc = koffi.register((hwnd) => {
    if (found) return 0
    if (!IsWindowVisible(hwnd)) return 1
    const len = GetWindowTextLengthW(hwnd)
    if (len <= 0) return 1
    const buf = Buffer.alloc((len + 1) * 2)
    const n = GetWindowTextW(hwnd, buf, len + 1)
    const title = buf.subarray(0, n * 2).toString('utf16le').trim()
    if (title && title.includes(want)) {
      found = hwnd
      return 0
    }
    return 1
  }, koffi.pointer(ENUMPROC))
  try {
    EnumWindows(proc, 0)
  } finally {
    koffi.unregister(proc)
  }
  return found
}


export function screenSize() {
  return { width: GetSystemMetrics(0), height: GetSystemMetrics(1) }
}

/**
 * 按标题拿窗口矩形（物理像素）。找不到/最小化返回 null。
 * @param {string} title 标题或标题片段 —— **必须是字符串**，传 hwnd 会段错误
 */
export function windowRect(title) {
  if (typeof title !== 'string' || !title) {
    throw new TypeError('windowRect(title) 只接受非空字符串（传 hwnd 会段错误）')
  }
  let hwnd = FindWindowW(null, title)
  if (!hwnd) hwnd = findWindow(title) // 精确标题常落空（浏览器带后缀），退回片段匹配
  if (!hwnd) return null
  const buf = Buffer.alloc(16) // RECT: 4 × int32
  if (!GetWindowRect(hwnd, buf)) return null
  const left = buf.readInt32LE(0)
  const top = buf.readInt32LE(4)
  const right = buf.readInt32LE(8)
  const bottom = buf.readInt32LE(12)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null
  if (left <= -30000 || top <= -30000) return null // 最小化
  return { x: left, y: top, width, height, hwnd: Number(hwnd) }
}

/** 抓一块矩形，返回原生尺寸的 RGB（不缩放：缩放会毁字） */
export function capture({ x = 0, y = 0, width, height } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new TypeError('capture({x,y,width,height}) 四个值都必须是有限数字')
  }
  const screen = screenSize()
  const w = Math.max(1, Math.min(Math.round(width), screen.width - Math.round(x)))
  const h = Math.max(1, Math.min(Math.round(height), screen.height - Math.round(y)))

  const screenDc = GetDC(null)
  const memDc = CreateCompatibleDC(screenDc)
  const bmp = CreateCompatibleBitmap(screenDc, w, h)
  const old = SelectObject(memDc, bmp)
  try {
    if (!BitBlt(memDc, 0, 0, w, h, screenDc, Math.round(x), Math.round(y), SRCCOPY)) {
      throw new Error('BitBlt 失败（窗口可能已销毁）')
    }
    const bgra = Buffer.alloc(w * h * 4)
    if (!GetDIBits(memDc, bmp, 0, h, bgra, makeBitmapInfo(w, h), 0)) {
      throw new Error('GetDIBits 失败')
    }
    // 正高度返回自下而上，逐行翻转并去 alpha
    const rgb = Buffer.alloc(w * h * 3)
    for (let row = 0; row < h; row += 1) {
      const src = (h - 1 - row) * w * 4
      const dst = row * w * 3
      for (let col = 0; col < w; col += 1) {
        const s = src + col * 4
        const d = dst + col * 3
        rgb[d] = bgra[s + 2]
        rgb[d + 1] = bgra[s + 1]
        rgb[d + 2] = bgra[s]
      }
    }
    return { width: w, height: h, buf: rgb }
  } finally {
    SelectObject(memDc, old)
    DeleteObject(bmp)
    DeleteDC(memDc)
    ReleaseDC(null, screenDc)
  }
}

/**
 * 与旧 ffmpeg 采集同形的接口：按 fps 持续出帧 {i, t, buf}。
 * 调用方（service）不用改。
 */
export function startCapture({ region, fps = 8, onFrame, onClose } = {}) {
  if (!region || typeof region !== 'object') throw new TypeError('startCapture 需要 region')
  const interval = Math.max(50, Math.round(1000 / fps))
  let i = 0
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    i += 1
    try {
      const frame = capture(region)
      onFrame?.({ i, t: Date.now(), ...frame })
    } catch (e) {
      // 抓不到不代表要停：窗口可能暂时最小化，下一拍继续
      onClose?.(`capture 失败：${e.message}`)
    }
  }, interval)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
