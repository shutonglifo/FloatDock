const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')
const native = require('./native')

const RADIUS = 92
const FAN_RADIUS_MAX = 260
const SLOT_SIZE = 44
const MIN_SEP = SLOT_SIZE + 12
const MIN_RING_RADIUS = 64
const PAD = 14
// 提示气泡跟在图标旁边，窗口要留出它的位置
const TIP_PAD_X = 132
const TIP_PAD_Y = 30
const EDGE_MARGIN = 10
const ANGLE_SAMPLE = 2
const POLL_MS = 30

let ringWin = null
let timer = null
let hovered = -1
let ignoring = null
let wasDown = false
let dragging = false
let cursorMisses = 0
let slots = []
let visible = []
let positions = []
let runAction = null
let runReorder = null

// 半径 r 的这个方向上，44px 的图标能否完整留在工作区里
function fitsAt (r, angle, room) {
  const half = EDGE_MARGIN + SLOT_SIZE / 2
  const x = r * Math.cos(angle)
  const y = r * Math.sin(angle)
  return x + half <= room.right && -x + half <= room.left && y + half <= room.bottom && -y + half <= room.top
}

// 固定半径下还能放图标的最大连续角度区间（弧度，起点 + 跨度）
function openArc (r, room) {
  const steps = 360 / ANGLE_SAMPLE
  const ok = []
  for (let i = 0; i < steps; i++) ok.push(fitsAt(r, (i * ANGLE_SAMPLE - 180) * Math.PI / 180, room))
  if (ok.every(Boolean)) return { start: -Math.PI, span: Math.PI * 2 }
  let best = 0
  let bestAt = 0
  for (let i = 0; i < steps; i++) {
    if (!ok[i]) continue
    let n = 0
    while (n < steps && ok[(i + n) % steps]) n++
    if (n > best) { best = n; bestAt = i }
  }
  if (!best) return null
  const rad = ANGLE_SAMPLE * Math.PI / 180
  // 采样只有 2° 精度，两端各退一格，保证图标一定留在工作区内
  const span = Math.max(best * rad - rad * 2, rad)
  return { start: (bestAt * ANGLE_SAMPLE - 180) * Math.PI / 180 + rad, span }
}

function minGap (r, step) {
  return 2 * r * Math.sin(step / 2)
}

// 球不动，贴边时整圈沿着剩余空间展开成扇形/半椭圆
// count 是真正要出现的图标数（空槽不出现），图标越少圈收得越紧
function plan (ballBounds, workArea, ballRadius, count) {
  const cx = ballBounds.x + ballBounds.width / 2
  const cy = ballBounds.y + ballBounds.height / 2
  const room = {
    left: cx - workArea.x,
    right: workArea.x + workArea.width - cx,
    top: cy - workArea.y,
    bottom: workArea.y + workArea.height - cy
  }
  // 图标少的时候圈会收紧，但不让它贴到球身上
  const minR = Math.max(ballRadius + SLOT_SIZE / 2 + 6, MIN_RING_RADIUS)
  const full = (Math.PI * 2) / count

  if (count === 1) {
    const a = bestSingleAngle(room)
    return { r: fitsAt(RADIUS, a, room) ? RADIUS : minR, angles: [a] }
  }

  // 整圈能放下就用整圈，半径取「图标不重叠所需」和「不压到球」里的较大者
  const roundR = Math.max(minR, MIN_SEP / (2 * Math.sin(full / 2)))
  const nominal = []
  for (let i = 0; i < count; i++) nominal.push(-Math.PI / 2 + i * full)
  if (nominal.every((a) => fitsAt(roundR, a, room))) return { r: roundR, angles: nominal }

  // 否则沿最大的可用角度区间展开，半径从小到大，刚好不重叠就停
  let best = null
  for (let r = Math.max(minR, Math.min(roundR, RADIUS)); r <= FAN_RADIUS_MAX; r += 8) {
    const arc = openArc(r, room)
    if (!arc) break
    const even = arc.span >= Math.PI * 2 - 1e-9
    const step = even ? full : arc.span / (count - 1)
    const cand = { r, gap: minGap(r, step), arc, step }
    if (!best || cand.gap > best.gap) best = cand
    if (cand.gap >= MIN_SEP || even) break
  }

  if (!best) return { r: minR, angles: nominal }
  if (best.arc.span >= Math.PI * 2 - 1e-9) return { r: best.r, angles: nominal }

  // 0 号图标（快捷文本框）尽量停在正上方，其余沿弧顺序排开
  const end = best.arc.start + best.arc.span
  const backward = toTop(end) < toTop(best.arc.start)
  const angles = []
  for (let i = 0; i < count; i++) {
    angles.push(backward ? end - i * best.step : best.arc.start + i * best.step)
  }
  return { r: best.r, angles }
}

// 只有一个图标时，挑离正上方最近、又放得下的方向
function bestSingleAngle (room) {
  for (let d = 0; d <= 180; d += ANGLE_SAMPLE) {
    if (fitsAt(RADIUS, (-90 + d) * Math.PI / 180, room)) return (-90 + d) * Math.PI / 180
    if (fitsAt(RADIUS, (-90 - d) * Math.PI / 180, room)) return (-90 - d) * Math.PI / 180
  }
  return -Math.PI / 2
}

// 这个方向离正上方有多远（弧度）
function toTop (angle) {
  const tau = Math.PI * 2
  const d = (((angle + Math.PI / 2) % tau) + tau) % tau
  return Math.min(d, tau - d)
}

// 球的位置不变，只让功能圈改变形状
function layout (ballBounds, workArea, ballRadius) {
  const cx = ballBounds.x + ballBounds.width / 2
  const cy = ballBounds.y + ballBounds.height / 2
  // 空槽位展开时不出现；一个都没绑时至少把 10 个占位点亮出来，免得点了没反应
  visible = []
  slots.forEach((s, i) => { if (s.kind !== 'empty') visible.push(i) })
  if (!visible.length) visible = slots.map((s, i) => i)
  const { r, angles } = plan(ballBounds, workArea, ballRadius, visible.length)

  const pts = angles.map((a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }))

  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const p of pts) {
    left = Math.min(left, p.x)
    top = Math.min(top, p.y)
    right = Math.max(right, p.x)
    bottom = Math.max(bottom, p.y)
  }
  const raw = {
    x: cx + left - SLOT_SIZE / 2 - PAD - TIP_PAD_X,
    y: cy + top - SLOT_SIZE / 2 - PAD - TIP_PAD_Y,
    width: right - left + SLOT_SIZE + (PAD + TIP_PAD_X) * 2,
    height: bottom - top + SLOT_SIZE + (PAD + TIP_PAD_Y) * 2
  }
  // 四周的留白可能超出工作区，把窗口整个收回来，图标位置跟着平移
  const box = {
    x: Math.round(Math.min(Math.max(raw.x, workArea.x), workArea.x + workArea.width - raw.width)),
    y: Math.round(Math.min(Math.max(raw.y, workArea.y), workArea.y + workArea.height - raw.height)),
    width: Math.round(raw.width),
    height: Math.round(raw.height)
  }
  return {
    box,
    points: pts.map((p) => ({ x: Math.round(cx + p.x - box.x), y: Math.round(cy + p.y - box.y) }))
  }
}

// 贴边展开时图标可能挨得很近，所以取最近的而不是第一个命中的；返回真正的槽位下标
function hitSlot (lx, ly) {
  let best = -1
  let dist = SLOT_SIZE / 2 + 6
  for (let i = 0; i < positions.length; i++) {
    const d = Math.hypot(lx - positions[i].x, ly - positions[i].y)
    if (d < dist) { dist = d; best = visible[i] }
  }
  return best
}

function stopPolling () {
  if (timer) clearInterval(timer)
  timer = null
}

function closeRing () {
  stopPolling()
  hovered = -1
  ignoring = null
  dragging = false
  cursorMisses = 0
  wasDown = false
  if (ringWin && !ringWin.isDestroyed()) ringWin.destroy()
  ringWin = null
}

function poll () {
  if (!ringWin || ringWin.isDestroyed() || dragging) return
  const pt = native.cursorPoint()
  if (!pt) {
    // 焦点在提权窗口上时 GetCursorPos 会返回“拒绝访问”，
    // 这时不能继续穿透，否则整个功能圈都点不动
    if (++cursorMisses >= 3 && ignoring) {
      ignoring = false
      ringWin.setIgnoreMouseEvents(false)
    }
    return
  }
  cursorMisses = 0
  const dip = screen.screenToDipPoint(pt)
  const [wx, wy] = ringWin.getPosition()
  const slot = hitSlot(dip.x - wx, dip.y - wy)

  if (slot !== hovered) {
    hovered = slot
    ringWin.webContents.send('ring:hover', hovered)
    const shouldIgnore = hovered < 0
    if (ignoring !== shouldIgnore) {
      ignoring = shouldIgnore
      // 只有指针落在图标上时才接管鼠标，其余区域直接穿到下面的窗口
      ringWin.setIgnoreMouseEvents(shouldIgnore, shouldIgnore ? { forward: true } : {})
    }
  }

  const down = native.isButtonDown()
  if (down && !wasDown && hovered < 0) closeRing()
  wasDown = down
}

function open (ballBounds, nextSlots, handlers) {
  closeRing()
  slots = nextSlots
  runAction = handlers.action
  runReorder = handlers.reorder

  const workArea = screen.getDisplayMatching(ballBounds).workArea
  const geo = layout(ballBounds, workArea, handlers.ballRadius || ballBounds.width / 2)
  positions = geo.points

  ringWin = new BrowserWindow({
    x: geo.box.x,
    y: geo.box.y,
    width: geo.box.width,
    height: geo.box.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  ringWin.setAlwaysOnTop(true, 'screen-saver')
  ringWin.on('closed', () => { ringWin = null; stopPolling() })
  ringWin.loadFile(path.join(__dirname, '..', 'ui', 'ring.html'))
  ringWin.once('ready-to-show', () => {
    ringWin.showInactive()
    if (native.api.available) {
      ringWin.setIgnoreMouseEvents(true, { forward: true })
      ignoring = true
      timer = setInterval(poll, POLL_MS)
    } else {
      // 拿不到全局指针位置时整圈接管鼠标，改由页面点空白处收起
      ringWin.setIgnoreMouseEvents(false)
    }
  })
}

ipcMain.handle('ring:get', () => ({
  slots,
  // 空槽位不出现，所以位置要带上自己对应的槽位下标
  items: visible.map((index, i) => ({ index, x: positions[i].x, y: positions[i].y }))
}))

ipcMain.on('ring:pick', (_event, index) => {
  const slot = slots[index]
  const action = runAction
  closeRing()
  if (slot && slot.kind !== 'empty' && action) action(slot, index)
})

// 拖拽换位：松手时落到哪个槽位就和哪个交换，立刻持久化。
// 换位后功能圈保持展开，方便连续调整多个槽位
ipcMain.on('ring:reorder', (_event, { from, to }) => {
  if (!runReorder) return closeRing()
  const next = runReorder(from, to)
  if (Array.isArray(next)) {
    slots = next
    if (ringWin && !ringWin.isDestroyed()) ringWin.webContents.send('ring:slots', slots)
  } else {
    closeRing()
  }
})

// 拖动图标时整圈都要接住鼠标，否则指针一移出图标就变成穿透、指针捕获丢失
ipcMain.on('ring:dragging', (_event, on) => {
  dragging = !!on
  if (!ringWin || ringWin.isDestroyed()) return
  if (dragging) {
    ringWin.setIgnoreMouseEvents(false)
    ignoring = false
  } else {
    hovered = -1
    ringWin.webContents.send('ring:hover', -1)
    ringWin.setIgnoreMouseEvents(true, { forward: true })
    ignoring = true
  }
})

ipcMain.on('ring:dismiss', closeRing)

module.exports = { open, close: closeRing, RADIUS, SLOT_SIZE }
