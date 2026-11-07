const ta = document.getElementById('ta')
const titleEl = document.getElementById('title')
const pathEl = document.getElementById('path')
const metaEl = document.getElementById('meta')
const stateEl = document.getElementById('state')
const markEl = document.getElementById('mark')

let baseline = ''
let name = '未命名.txt'
let savedPath = null
let dirty = false

function sync() {
  const wasDirty = dirty
  dirty = ta.value !== baseline
  titleEl.textContent = name
  document.title = name
  pathEl.textContent = savedPath || '尚未保存到文件'
  metaEl.textContent = `${ta.value.length} 字 · ${ta.value.split('\n').length} 行`
  stateEl.textContent = dirty ? '未保存' : '已保存'
  markEl.classList.toggle('dirty', dirty)
  if (dirty !== wasDirty) window.api.setDirty(dirty)
}

async function save(saveAs) {
  const result = await window.api.saveDoc({ text: ta.value, saveAs })
  if (!result) return
  baseline = ta.value
  name = result.name
  savedPath = result.filePath
  sync()
}

ta.addEventListener('input', sync)

document.getElementById('save').addEventListener('click', () => save(false))
document.getElementById('saveas').addEventListener('click', () => save(true))
document.getElementById('new').addEventListener('click', () => window.api.newDoc())
document.getElementById('open').addEventListener('click', async () => {
  const result = await window.api.openDoc()
  if (!result) return
  ta.value = result.text
  baseline = result.text
  name = result.name
  savedPath = result.filePath
  sync()
})
document.getElementById('min').addEventListener('click', () => window.api.minimizeWindow())
document.getElementById('close').addEventListener('click', () => window.api.closeWindow())

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return
  const key = event.key.toLowerCase()
  if (key === 's') { event.preventDefault(); save(event.shiftKey) }
  else if (key === 'o') { event.preventDefault(); document.getElementById('open').click() }
  else if (key === 'n') { event.preventDefault(); window.api.newDoc() }
  else if (key === 'w') { event.preventDefault(); window.api.closeWindow() }
})

const grip = document.getElementById('grip')
let gripState = null

grip.addEventListener('pointerdown', (event) => {
  grip.setPointerCapture(event.pointerId)
  gripState = { id: event.pointerId, dx: 0, dy: 0 }
  window.api.resizeStart()
})
grip.addEventListener('pointermove', (event) => {
  if (!gripState || event.pointerId !== gripState.id) return
  gripState.dx += event.movementX
  gripState.dy += event.movementY
  window.api.resizeBy(gripState.dx, gripState.dy)
})
function endGrip () {
  if (!gripState) return
  gripState = null
  window.api.resizeEnd()
}
grip.addEventListener('pointerup', endGrip)
grip.addEventListener('pointercancel', endGrip)

sync()
ta.focus()
