const ring = document.getElementById('ring')
const hint = document.getElementById('hint')

const nodes = []
// 这几个图标实心会糊成一团，在圈上也按线性画
const LINEAR_IN_RING = new Set(['file-text'])

function svgFor (icon) {
  return window.iconSvg(icon, LINEAR_IN_RING.has(icon) ? 'linear' : 'bulk')
}

function paint (slots) {
  nodes.forEach((node) => {
    const slot = slots[node.index]
    if (!node.el || !slot) return
    node.slot = slot
    node.el.classList.toggle('empty', slot.kind === 'empty')
    node.el.title = slot.label
    node.el.innerHTML = slot.kind === 'empty'
      ? ''
      : (slot.iconDataUrl ? `<img class="appicon" src="${slot.iconDataUrl}" alt="">` : svgFor(slot.icon))
  })
  const hot = nodes.findIndex((n) => n.el.classList.contains('hot'))
  showHint(hot >= 0 ? nodes[hot].index : -1)
}

async function init () {
  const data = await window.api.getRing()
  data.items.forEach((item) => {
    const slot = data.slots[item.index]
    const pos = { x: item.x, y: item.y }
    const el = document.createElement('div')
    el.className = 'slot' + (slot.kind === 'empty' ? ' empty' : '')
    el.style.left = `${pos.x}px`
    el.style.top = `${pos.y}px`
    ring.appendChild(el)
    const node = { el, pos, index: item.index, slot }
    nodes.push(node)
    bindDrag(node)
  })

  paint(data.slots)
  requestAnimationFrame(() => document.body.classList.add('open'))
}

function nearestSlot (x, y) {
  let best = -1
  let dist = Infinity
  for (const node of nodes) {
    const d = Math.hypot(x - node.pos.x, y - node.pos.y)
    if (d < dist) { dist = d; best = node.index }
  }
  return dist <= 80 ? best : -1
}

function resetDrag (node) {
  node.el.classList.remove('lifting')
  node.el.style.removeProperty('--drag-x')
  node.el.style.removeProperty('--drag-y')
}

function bindDrag (node) {
  let drag = null

  node.el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    node.el.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  })

  node.el.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) > 7) {
      drag.moved = true
      node.el.classList.add('lifting')
      // 拖动期间整圈接管鼠标，否则移出图标就会变成穿透、指针捕获丢失
      window.api.draggingRing(true)
    }
    if (drag.moved) {
      node.el.style.setProperty('--drag-x', `${dx}px`)
      node.el.style.setProperty('--drag-y', `${dy}px`)
    }
  })

  const finish = (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null
    resetDrag(node)
    if (!moved) {
      window.api.pickRing(node.index)
      return
    }
    window.api.draggingRing(false)
    const to = nearestSlot(event.clientX, event.clientY)
    if (to >= 0 && to !== node.index) window.api.reorderRing(node.index, to)
  }

  node.el.addEventListener('pointerup', finish)
  node.el.addEventListener('pointercancel', () => {
    if (!drag) return
    drag = null
    resetDrag(node)
    window.api.draggingRing(false)
  })
}

// 气泡贴在图标旁边：默认放右侧，放不下就翻到左侧，再夹回窗口内
function showHint (index) {
  nodes.forEach((node) => node.el.classList.toggle('hot', node.index === index))
  const node = nodes.find((n) => n.index === index)
  const label = node && node.slot ? node.slot.label : ''
  hint.textContent = label
  hint.classList.toggle('show', !!label)
  if (!node || !label) return
  const w = hint.offsetWidth
  const h = hint.offsetHeight
  const gap = 22 + 10
  let x = node.pos.x + gap
  if (x + w > innerWidth - 6) x = node.pos.x - gap - w
  x = Math.max(6, Math.min(x, innerWidth - w - 6))
  const y = Math.max(4, Math.min(node.pos.y - h / 2, innerHeight - h - 4))
  hint.style.left = `${Math.round(x)}px`
  hint.style.top = `${Math.round(y)}px`
}

window.api.onRingHover(showHint)
window.api.onRingSlots(paint)

document.body.addEventListener('click', (event) => {
  if (event.target === document.body || event.target === ring) window.api.dismissRing()
})

init()
