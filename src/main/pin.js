const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')
const native = require('./native')

const TACK_SIZE = 44
const TIP = { x: 22, y: 31 } // 画布里的钉尖落点，让它正好压在指针上
const MARK_SIZE = 26
const POLL_MS = 16
const TRACK_MS = 90
const FEEDBACK_MS = 750
const VK_ESCAPE = 0x1b

let overlay = null
let timer = null
let feedback = null
let tracker = null
let wasDown = false
let wasEsc = false
let misses = 0
let onFinish = null

const marks = new Map() // hwnd -> { title, win }

const prefs = () => ({
  preload: path.join(__dirname, '..', 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
})

function ownHandles () {
  const set = new Set()
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      set.add(Number(win.getNativeWindowHandle().readBigUInt64LE(0)))
    } catch { /* 句柄取不到时跳过 */ }
  }
  return set
}

function displayScaleAt (physicalPt) {
  const dip = screen.screenToDipPoint(physicalPt)
  return screen.getDisplayMatching({ x: dip.x, y: dip.y, width: 1, height: 1 }).scaleFactor
}

function stopTracker () {
  if (tracker && marks.size === 0) {
    clearInterval(tracker)
    tracker = null
  }
}

function destroyMark (hwnd) {
  const mark = marks.get(hwnd)
  marks.delete(hwnd)
  if (mark && !mark.win.isDestroyed()) mark.win.destroy()
  stopTracker()
}

function track () {
  for (const [hwnd, mark] of marks) {
    if (!native.api.IsWindow(hwnd)) {
      destroyMark(hwnd)
      continue
    }
    if (mark.win.isDestroyed()) {
      marks.delete(hwnd)
      continue
    }
    if (native.isMinimized(hwnd)) {
      if (mark.win.isVisible()) mark.win.hide()
      continue
    }
    const f = native.frameBounds(hwnd)
    if (!f) continue
    const scale = displayScaleAt({ x: (f.left + f.right) / 2, y: (f.top + f.bottom) / 2 })
    const anchor = native.captionAnchor(hwnd, scale, MARK_SIZE)
    if (!anchor) continue
    const dip = screen.screenToDipPoint(anchor)
    mark.win.setPosition(Math.round(dip.x), Math.round(dip.y))
    if (!mark.win.isVisible()) mark.win.showInactive()
    mark.win.moveTop()
  }
  stopTracker()
}

function addMark (hwnd, title) {
  if (marks.has(hwnd)) return
  const win = new BrowserWindow({
    width: MARK_SIZE,
    height: MARK_SIZE,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: prefs()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('closed', () => {
    marks.delete(hwnd)
    stopTracker()
  })
  win.loadFile(path.join(__dirname, '..', 'ui', 'mark.html'), { search: new URLSearchParams({ hwnd: String(hwnd) }).toString() })
  marks.set(hwnd, { title, win })
  if (!tracker) tracker = setInterval(track, TRACK_MS)
  track()
}

function unpin (hwnd) {
  native.setTopmost(hwnd, false)
  destroyMark(hwnd)
}

function stop () {
  if (timer) clearInterval(timer)
  timer = null
  if (feedback) clearTimeout(feedback)
  feedback = null
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
  wasDown = false
  wasEsc = false
  misses = 0
  const done = onFinish
  onFinish = null
  if (done) done()
}

function poll () {
  if (!overlay || overlay.isDestroyed()) return stop()
  const pt = native.cursorPoint()
  if (!pt) {
    // 焦点在提权窗口上时读不到指针，也别把图钉冻在屏幕上
    if (++misses >= 5) return stop()
    return
  }
  misses = 0

  const dip = screen.screenToDipPoint(pt)
  overlay.setPosition(Math.round(dip.x - TIP.x), Math.round(dip.y - TIP.y))

  const esc = (native.api.GetAsyncKeyState(VK_ESCAPE) & 0x8000) !== 0
  if (esc && !wasEsc) return stop()
  wasEsc = esc

  const down = native.isButtonDown()
  if (!down || wasDown) {
    wasDown = down
    return
  }
  wasDown = true

  const target = native.rootWindowUnder(pt)
  if (!target || ownHandles().has(target)) return

  const title = native.windowTitle(target) || '（无标题窗口）'
  if (native.isTopmost(target)) {
    unpin(target)
    overlay.webContents.send('pin:state', { on: false, title })
  } else {
    native.setTopmost(target, true)
    addMark(target, title)
    overlay.webContents.send('pin:state', { on: true, title })
  }
  feedback = setTimeout(stop, FEEDBACK_MS)
}

function start (onDone) {
  if (!native.api.available) return false
  stop()
  onFinish = onDone || null

  overlay = new BrowserWindow({
    width: TACK_SIZE,
    height: TACK_SIZE,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: prefs()
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.on('closed', () => {
    overlay = null
    if (timer) clearInterval(timer)
    timer = null
  })
  overlay.loadFile(path.join(__dirname, '..', 'ui', 'pin.html'))
  overlay.once('ready-to-show', () => {
    overlay.showInactive()
    // 图钉窗本身对鼠标透明，WindowFromPoint 不会命中它，点击能落到目标窗口
    overlay.setIgnoreMouseEvents(true)
    timer = setInterval(poll, POLL_MS)
  })
  return true
}

function unpinAll () {
  const list = [...marks.keys()]
  for (const hwnd of list) unpin(hwnd)
  return list.length
}

function pinnedCount () {
  return marks.size
}

ipcMain.on('pin:unmark', (event) => {
  for (const [hwnd, mark] of marks) {
    if (!mark.win.isDestroyed() && mark.win.webContents === event.sender) {
      unpin(hwnd)
      return
    }
  }
})

module.exports = { start, stop, unpinAll, pinnedCount, TACK_SIZE, MARK_SIZE }
