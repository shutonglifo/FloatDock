const ball = document.getElementById('ball')
const custom = document.getElementById('custom')
document.getElementById('art').innerHTML =
  `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${window.ICONS['layout-grid'].linear}</svg>`
const CLICK_SLOP = 5
const CLICK_MS = 450

let limits = { size: { min: 40, max: 180 }, opacity: { min: 0.2, max: 1 } }
let pointer = null

const HOVER_GROW = 7 // 悬停时直径多出的像素，固定值保证小球也能看出放大

function apply(s) {
  document.documentElement.style.setProperty('--size', `${s.size}px`)
  document.documentElement.style.setProperty('--opacity', String(s.opacity))
  document.documentElement.style.setProperty('--hover-scale', String((s.size + HOVER_GROW) / s.size))
  if (s.iconDataUrl) {
    custom.src = s.iconDataUrl
    ball.classList.add('has-icon')
  } else {
    custom.removeAttribute('src')
    ball.classList.remove('has-icon')
  }
}

async function init() {
  const [settings, fetchedLimits] = await Promise.all([window.api.getSettings(), window.api.getLimits()])
  limits = fetchedLimits
  apply(settings)
  window.api.onSettings(apply)
  // 窗口穿透时页面收不到鼠标事件，:hover 会慢半拍，hover 状态由主进程推过来
  window.api.onFloatHover((on) => ball.classList.toggle('hover', !!on))
}

function currentSize() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--size'), 10) || 64
}

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  ball.setPointerCapture(event.pointerId)
  // 窗口会跟随光标，clientX 的差值会被自我抵消，必须累加相对位移
  pointer = { id: event.pointerId, dx: 0, dy: 0, moved: false, at: performance.now() }
  ball.classList.add('press')
  window.api.dragStart()
})

ball.addEventListener('pointermove', (event) => {
  if (!pointer || event.pointerId !== pointer.id) return
  pointer.dx += event.movementX
  pointer.dy += event.movementY
  if (!pointer.moved && Math.hypot(pointer.dx, pointer.dy) > CLICK_SLOP) {
    pointer.moved = true
    ball.classList.add('dragging')
    ball.classList.remove('press')
  }
  if (pointer.moved) window.api.dragMove(pointer.dx, pointer.dy)
})

function release() {
  window.api.dragEnd()
  ball.classList.remove('dragging', 'press')
  pointer = null
}

ball.addEventListener('pointerup', (event) => {
  if (!pointer || event.pointerId !== pointer.id) return
  const wasClick = !pointer.moved && performance.now() - pointer.at < CLICK_MS
  release()
  if (wasClick) window.api.openRing()
})

ball.addEventListener('pointercancel', release)


ball.addEventListener('wheel', (event) => {
  event.preventDefault()
  const { min, max } = limits.size
  const next = Math.min(max, Math.max(min, currentSize() + (event.deltaY < 0 ? 4 : -4)))
  window.api.setSettings({ size: next })
}, { passive: false })

ball.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.api.openMenu()
})

init()
