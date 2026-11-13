const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')
const native = require('./native')
const { SLOT_COUNT } = require('./store')

const RADIUS = 92
const FAN_RADIUS_MAX = 260
const SLOT_SIZE = 44
// 外圈出现时：内圈图标缩一档，外圈再小一档，两圈边缘之间留 12px
const SLOT_SIZE_IN = 34
const SLOT_SIZE_OUT = 28
const RING_GAP = 12
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

// 半径 r 的这个方向上，size 大小的图标能否完整留在工作区里
function fitsAt (r, angle, room, size) {
  const half = EDGE_MARGIN + size / 2
  const x = r * Math.cos(angle)
  const y = r * Math.sin(angle)
  return x + half <= room.right && -x + half <= room.left && y + half <= room.bottom && -y + half <= room.top
}

// 采样找最长连续可用角段（弧度，起点 + 跨度）
function bestRunArc (okAt) {
  const steps = 360 / ANGLE_SAMPLE
  const ok = []
  for (let i = 0; i < steps; i++) ok.push(okAt((i * ANGLE_SAMPLE - 180) * Math.PI / 180))
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

// 固定半径下还能放图标的最大连续角度区间
function openArc (r, room, size) {
  return bestRunArc((a) => fitsAt(r, a, room, size))
}

function minGap (r, step) {
  return 2 * r * Math.sin(step / 2)
}

// 球不动，贴边时整圈沿着剩余空间展开成扇形/半椭圆
// count 是真正要出现的图标数（空槽不出现），图标越少圈收得越紧
function plan (ballBounds, workArea, ballRadius, count, size) {
  const sep = size + 12
  const room = roomAround(ballBounds, workArea)
  // 图标少的时候圈会收紧，但不让它贴到球身上
  const minR = Math.max(ballRadius + size / 2 + 6, MIN_RING_RADIUS)
  const full = (Math.PI * 2) / count

  if (count === 1) {
    const a = bestSingleAngle(room, size)
    return { r: fitsAt(RADIUS, a, room, size) ? RADIUS : minR, angles: [a] }
  }

  // 整圈能放下就用整圈，半径取「图标不重叠所需」和「不压到球」里的较大者
  const roundR = Math.max(minR, sep / (2 * Math.sin(full / 2)))
  const nominal = []
  for (let i = 0; i < count; i++) nominal.push(-Math.PI / 2 + i * full)
  if (nominal.every((a) => fitsAt(roundR, a, room, size))) return { r: roundR, angles: nominal }

  // 否则沿最大的可用角度区间展开，半径从小到大，刚好不重叠就停
  let best = null
  for (let r = Math.max(minR, Math.min(roundR, RADIUS)); r <= FAN_RADIUS_MAX; r += 8) {
    const arc = openArc(r, room, size)
    if (!arc) break
    const even = arc.span >= Math.PI * 2 - 1e-9
    const step = even ? full : arc.span / (count - 1)
    const cand = { r, gap: minGap(r, step), arc, step }
    if (!best || cand.gap > best.gap) best = cand
    if (cand.gap >= sep || even) break
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

function roomAround (ballBounds, workArea) {
  const cx = ballBounds.x + ballBounds.width / 2
  const cy = ballBounds.y + ballBounds.height / 2
  return {
    left: cx - workArea.x,
    right: workArea.x + workArea.width - cx,
    top: cy - workArea.y,
    bottom: workArea.y + workArea.height - cy
  }
}

// 只有一个图标时，挑离正上方最近、又放得下的方向
function bestSingleAngle (room, size) {
  for (let d = 0; d <= 180; d += ANGLE_SAMPLE) {
    if (fitsAt(RADIUS, (-90 + d) * Math.PI / 180, room, size)) return (-90 + d) * Math.PI / 180
    if (fitsAt(RADIUS, (-90 - d) * Math.PI / 180, room, size)) return (-90 - d) * Math.PI / 180
  }
  return -Math.PI / 2
}

function fitsRing (r, angles, room, size) {
  return angles.every((a) => fitsAt(r, a, room, size))
}

// 整圈的标称角（0 号在正上方）
function roundAngles (n) {
  const arr = []
  const full = (Math.PI * 2) / n
  for (let i = 0; i < n; i++) arr.push(-Math.PI / 2 + i * full)
  return arr
}

// 扇形展开时的角列表：1 个放弧中间，多个从靠正上方的一端排起
function fanAngles (n, arc, backward) {
  if (n === 1) return [arc.start + arc.span / 2]
  const step = arc.span / (n - 1)
  const arr = []
  for (let i = 0; i < n; i++) arr.push(backward ? arc.start + arc.span - i * step : arc.start + i * step)
  return arr
}

// 双层：外圈受空间约束更紧，扇形角度范围按外圈算，两圈共用同一段弧
function planTwo (ballBounds, workArea, ballRadius, n1, n2) {
  const s1 = SLOT_SIZE_IN
  const s2 = SLOT_SIZE_OUT
  const sep1 = s1 + 12
  const sep2 = s2 + 12
  const gap = (s1 + s2) / 2 + RING_GAP
  const room = roomAround(ballBounds, workArea)
  const minR1 = Math.max(ballRadius + s1 / 2 + 6, MIN_RING_RADIUS)
  // 整圈半径：内圈按自己的间距，外圈按 n2 的间距反推到内圈高度
  const round1 = n1 > 1 ? Math.max(minR1, sep1 / (2 * Math.sin(Math.PI / n1))) : minR1
  const round2 = n2 > 1 ? Math.max(sep2 / (2 * Math.sin(Math.PI / n2)) - gap, round1) : round1
  const aFull1 = roundAngles(n1)
  const aFull2 = roundAngles(n2)
  if (fitsRing(round2, aFull1, room, s1) && fitsRing(round2 + gap, aFull2, room, s2)) {
    return [{ r: round2, angles: aFull1, size: s1 }, { r: round2 + gap, angles: aFull2, size: s2 }]
  }
  let best = null
  for (let r1 = Math.max(minR1, Math.min(round2, RADIUS)); r1 + gap <= FAN_RADIUS_MAX; r1 += 8) {
    const r2 = r1 + gap
    // 联合弧：内圈半宽更大、外圈半径更大，两个都放得下的角段才可用
    const arc = bestRunArc((a) => fitsAt(r1, a, room, s1) && fitsAt(r2, a, room, s2))
    if (!arc) break
    if (arc.span >= Math.PI * 2 - 1e-9) {
      if (fitsRing(r1, aFull1, room, s1) && fitsRing(r2, aFull2, room, s2)) {
        return [{ r: r1, angles: aFull1, size: s1 }, { r: r2, angles: aFull2, size: s2 }]
      }
      continue
    }
    const end = arc.start + arc.span
    const backward = toTop(end) < toTop(arc.start)
    const a1 = fanAngles(n1, arc, backward)
    const a2 = fanAngles(n2, arc, backward)
    if (!fitsRing(r1, a1, room, s1) || !fitsRing(r2, a2, room, s2)) continue
    const g1 = n1 > 1 ? minGap(r1, Math.abs(a1[1] - a1[0])) : Infinity
    const g2 = n2 > 1 ? minGap(r2, Math.abs(a2[1] - a2[0])) : Infinity
    const cand = { score: Math.min(g1 / sep1, g2 / sep2), rings: [{ r: r1, angles: a1, size: s1 }, { r: r2, angles: a2, size: s2 }] }
    if (!best || cand.score > best.score) best = cand
    if (cand.score >= 1) return best.rings
  }
  if (best) return best.rings
  // 实在放不下（球缩在极小的角落）：保内圈，外圈叠着也无所谓
  return [{ r: round1, angles: aFull1, size: s1 }, { r: round1 + gap, angles: aFull2, size: s2 }]
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
  // 空槽位展开时不出现；一个都没绑时至少把内圈 10 个占位点亮出来，免得点了没反应
  const inner = []
  const outer = []
  slots.forEach((s, i) => {
    if (s.kind === 'empty') return
    if (i < SLOT_COUNT) inner.push(i)
    else outer.push(i)
  })
  visible = inner.concat(outer)
  let rings
  if (!visible.length) {
    visible = slots.slice(0, SLOT_COUNT).map((s, i) => i)
    const { r, angles } = plan(ballBounds, workArea, ballRadius, visible.length, SLOT_SIZE)
    rings = [{ r, angles, size: SLOT_SIZE }]
  } else if (inner.length && outer.length) {
    rings = planTwo(ballBounds, workArea, ballRadius, inner.length, outer.length)
  } else if (inner.length) {
    const { r, angles } = plan(ballBounds, workArea, ballRadius, inner.length, SLOT_SIZE)
    rings = [{ r, angles, size: SLOT_SIZE }]
  } else {
    // 只剩外圈有内容（内圈后来被清空）：单层照旧，只是图标用外圈尺寸
    const { r, angles } = plan(ballBounds, workArea, ballRadius, outer.length, SLOT_SIZE_OUT)
    rings = [{ r, angles, size: SLOT_SIZE_OUT }]
  }

  // pts 顺序与 visible 一致：先内圈后外圈
  const pts = []
  for (const ring of rings) {
    for (const a of ring.angles) pts.push({ x: ring.r * Math.cos(a), y: ring.r * Math.sin(a), size: ring.size })
  }

  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const p of pts) {
    left = Math.min(left, p.x - p.size / 2)
    top = Math.min(top, p.y - p.size / 2)
    right = Math.max(right, p.x + p.size / 2)
    bottom = Math.max(bottom, p.y + p.size / 2)
  }
  const raw = {
    x: cx + left - PAD - TIP_PAD_X,
    y: cy + top - PAD - TIP_PAD_Y,
    width: right - left + (PAD + TIP_PAD_X) * 2,
    height: bottom - top + (PAD + TIP_PAD_Y) * 2
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
    points: pts.map((p) => ({ x: Math.round(cx + p.x - box.x), y: Math.round(cy + p.y - box.y), size: p.size }))
  }
}

// 贴边展开时图标可能挨得很近，所以取最近的而不是第一个命中的；返回真正的槽位下标
function hitSlot (lx, ly) {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]
    const d = Math.hypot(lx - p.x, ly - p.y)
    if (d < p.size / 2 + 6 && d < bestD) { bestD = d; best = visible[i] }
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
  // 空槽位不出现，所以位置要带上自己对应的槽位下标（0~9 内圈、10~21 外圈）
  items: visible.map((index, i) => ({ index, x: positions[i].x, y: positions[i].y, size: positions[i].size }))
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
