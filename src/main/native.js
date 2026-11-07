// Win32 绑定：只用进程内 FFI，不额外起进程（常驻内存 0 增量）
// koffi 的 int64 在 JS 侧可能回 Number 也可能回 BigInt，统一 Number() 归一，
// 否则 BigInt 与 Number 的位运算/比较会静默给出错误结果
let koffi = null
let user32 = null
let dwmapi = null
let POINT = null

const GA_ROOT = 2
const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x0008
const VK_LBUTTON = 0x01
const DWMWA_EXTENDED_FRAME_BOUNDS = 9

const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010

const api = {
  available: false,
  GetCursorPos: null,
  WindowFromPoint: null,
  GetAncestor: null,
  GetWindowLongPtrW: null,
  SetWindowPos: null,
  GetAsyncKeyState: null,
  GetWindowTextLengthW: null,
  GetWindowTextW: null
}

try {
  koffi = require('koffi')
  user32 = koffi.load('user32.dll')
  POINT = koffi.struct('POINT', { x: 'long', y: 'long' })

  api.GetCursorPos = user32.func('bool GetCursorPos(void *pt)')
  api.WindowFromPoint = user32.func('int64 WindowFromPoint(POINT pt)')
  api.GetAncestor = user32.func('int64 GetAncestor(int64 hwnd, uint flags)')
  api.IsWindow = user32.func('bool IsWindow(int64 hwnd)')
  api.GetWindowLongPtrW = user32.func('int64 GetWindowLongPtrW(int64 hwnd, int index)')
  api.SetWindowPos = user32.func('bool SetWindowPos(int64 hwnd, int64 insertAfter, int x, int y, int cx, int cy, uint flags)')
  api.GetAsyncKeyState = user32.func('short GetAsyncKeyState(int vk)')
  api.GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(int64 hwnd)')
  api.GetWindowTextW = user32.func('int GetWindowTextW(int64 hwnd, void *buf, int maxChars)')
  api.IsIconic = user32.func('bool IsIconic(int64 hwnd)')

  dwmapi = koffi.load('dwmapi.dll')
  api.DwmGetWindowAttribute = dwmapi.func('long DwmGetWindowAttribute(int64 hwnd, uint attr, void *value, uint size)')
  api.available = true
} catch {
  // 32 位系统或缺 user32 时降级：环形菜单照常，置顶槽位给出提示
}

function cursorPoint () {
  if (!api.available) return null
  const buf = Buffer.alloc(8)
  if (!api.GetCursorPos(buf)) return null
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
}

function isButtonDown () {
  if (!api.available) return false
  return (api.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
}

// 指针下的顶层窗口；返回 null 表示桌面/自己/取不到
function rootWindowUnder (pt) {
  if (!api.available || !pt) return null
  const hwnd = Number(api.WindowFromPoint({ x: pt.x, y: pt.y }))
  if (!hwnd) return null
  const root = Number(api.GetAncestor(hwnd, GA_ROOT))
  return root || null
}

function isTopmost (hwnd) {
  const style = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  return (style & WS_EX_TOPMOST) !== 0
}

function setTopmost (hwnd, on) {
  const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
  return api.SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, flags)
}

function windowTitle (hwnd) {
  const len = api.GetWindowTextLengthW(hwnd)
  if (!len) return ''
  const buf = Buffer.alloc((len + 1) * 2)
  api.GetWindowTextW(hwnd, buf, len + 1)
  return buf.toString('utf16le', 0, len * 2)
}

// DWM 扩展边框 = 去掉透明阴影后的可见窗口，物理像素
function frameBounds (hwnd) {
  if (!api.available) return null
  const buf = Buffer.alloc(16)
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) !== 0) return null
  const l = buf.readInt32LE(0), t = buf.readInt32LE(4), r = buf.readInt32LE(8), b = buf.readInt32LE(12)
  if (r <= l || b <= t) return null
  return { left: l, top: t, right: r, bottom: b }
}

function isMinimized (hwnd) {
  return api.available ? api.IsIconic(hwnd) : false
}

// 钉标位置：标题栏三个按钮从右往左是 关闭/最大化/最小化，插到最小化左边。
// Win11 的标题栏按钮是 46x32 DIP，按显示器缩放换算成物理像素再定位
const CAPTION_BUTTON_W = 46
const CAPTION_H = 32

function captionAnchor (hwnd, scaleFactor, sizeDip) {
  const f = frameBounds(hwnd)
  if (!f) return null
  const s = scaleFactor || 1
  const markW = sizeDip * s
  const x = f.right - CAPTION_BUTTON_W * 3 * s - 8 * s - markW / 2
  const y = f.top + (CAPTION_H * s) / 2 - markW / 2
  return { x: Math.round(x), y: Math.round(y) }
}

module.exports = {
  api,
  cursorPoint,
  isButtonDown,
  rootWindowUnder,
  isTopmost,
  setTopmost,
  windowTitle,
  frameBounds,
  isMinimized,
  captionAnchor
}
