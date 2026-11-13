const opacityInput = document.getElementById('opacity')
const sizeInput = document.getElementById('size')
const opacityOut = document.getElementById('opacityOut')
const sizeOut = document.getElementById('sizeOut')
const preview = document.getElementById('preview')
const launch = document.getElementById('launch')
const error = document.getElementById('error')
const slotsBox = document.getElementById('slots')
const slots2Box = document.getElementById('slots2')
const slots2Tip = document.getElementById('slots2Tip')
const chooser = document.getElementById('chooser')
const picker = document.getElementById('picker')
const filter = document.getElementById('filter')
const list = document.getElementById('list')
const noteMode = document.getElementById('noteMode')

let programs = null
let pickFor = -1

const KINDS = [
  { kind: 'note', label: '快捷文本框', icon: 'file-text' },
  { kind: 'pin', label: '窗口置顶', icon: 'pin' },
  { kind: 'app', label: '程序', icon: 'app-window' },
  { kind: 'folder', label: '文件夹', icon: 'folder-open' },
  { kind: 'file', label: '文件', icon: 'file' }
]

let active = null
let innerCount = 10
let current = { opacity: 0.85, size: 64, autoLaunch: false, iconDataUrl: null, slots: [] }

function svgFor (icon) {
  return window.iconSvg(icon, 'linear')
}

function fill (input) {
  const min = Number(input.min), max = Number(input.max)
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`)
}

function render (s) {
  current = s
  if (active !== 'opacity') opacityInput.value = String(Math.round(s.opacity * 100))
  if (active !== 'size') sizeInput.value = String(s.size)
  opacityOut.textContent = `${Math.round(Number(opacityInput.value))}%`
  sizeOut.textContent = `${sizeInput.value}px`
  fill(opacityInput)
  fill(sizeInput)

  preview.innerHTML = s.iconDataUrl
    ? `<img alt="" src="${s.iconDataUrl}">`
    : svgFor('layout-grid')
  preview.classList.toggle('has-icon', !!s.iconDataUrl)

  launch.classList.toggle('on', !!s.autoLaunch)
  launch.setAttribute('aria-checked', String(!!s.autoLaunch))

  const mode = s.noteMode || 'built-in'
  for (const btn of noteMode.querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.mode === mode)

  renderSlots()
}

function slotRow (slot, g, num, pickLocked) {
  const row = document.createElement('div')
  row.className = 'slot-row' + (slot.kind === 'empty' ? ' empty' : '')
  row.innerHTML = `<span class="slot-n"></span><span class="slot-icon"></span>
    <span class="slot-name"><b></b></span>
    <span class="slot-acts"><button data-pick>更换</button><button data-clear>清空</button></span>`
  row.querySelector('.slot-n').textContent = String(num)
  row.querySelector('.slot-icon').innerHTML = slot.iconDataUrl
    ? `<img class="appicon" src="${slot.iconDataUrl}" alt="">`
    : svgFor(slot.icon)
  row.querySelector('.slot-name b').textContent = slot.label
  if (slot.path) {
    const sub = document.createElement('span')
    sub.textContent = slot.path
    row.querySelector('.slot-name').appendChild(sub)
  }
  const pick = row.querySelector('[data-pick]')
  if (pickLocked) {
    pick.disabled = true
    pick.title = `先填满第一层 ${innerCount} 格`
  }
  pick.addEventListener('click', (event) => openChooser(g, event.currentTarget))
  row.querySelector('[data-clear]').addEventListener('click', () => window.api.clearSlot(g))
  return row
}

// 全局下标 0~9 是第一层，10~21 是第二层；两层分开渲染但共用一套行模板
function renderSlots () {
  slotsBox.textContent = ''
  slots2Box.textContent = ''
  const locked = current.slots.slice(0, innerCount).some((s) => s.kind === 'empty')
  slots2Tip.style.display = locked ? '' : 'none'
  current.slots.forEach((slot, i) => {
    const outer = i >= innerCount
    const row = slotRow(slot, i, outer ? i - innerCount + 1 : i + 1, outer && locked && slot.kind === 'empty')
    ;(outer ? slots2Box : slotsBox).appendChild(row)
  })
}

function usedKinds () {
  return new Set(current.slots.filter((s) => s.kind === 'note' || s.kind === 'pin').map((s) => s.kind))
}

function usedTargets () {
  return new Set(current.slots.filter((s) => s.target).map((s) => s.target.toLowerCase()))
}

function openChooser (index, anchor) {
  const box = anchor.getBoundingClientRect()
  const taken = usedKinds()
  chooser.innerHTML = KINDS.map((k) => {
    const isTaken = taken.has(k.kind)
    return `<button data-kind="${k.kind}"${isTaken ? ' disabled' : ''}>${svgFor(k.icon)}${k.label}${isTaken ? '<i>已添加</i>' : ''}</button>`
  }).join('')
  chooser.style.top = `${Math.min(box.bottom + 4, window.innerHeight - KINDS.length * 34 - 12)}px`
  chooser.style.left = `${Math.max(8, box.left - 128)}px`
  chooser.classList.add('show')
  chooser.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      chooser.classList.remove('show')
      // 程序用内置列表选，省得在文件夹里层层找
      if (btn.dataset.kind === 'app') {
        openPicker(index)
        return
      }
      const result = await window.api.pickSlot(index, btn.dataset.kind)
      if (result && !result.ok && !result.canceled) error.textContent = result.error || '设置失败'
    })
  })
}

function openPicker (index) {
  pickFor = index
  picker.classList.add('show')
  filter.value = ''
  renderList()
  if (!programs) window.api.listApps(false).then((p) => { programs = p; renderList() })
  filter.focus()
}

function closePicker () {
  picker.classList.remove('show')
  pickFor = -1
}

function renderList () {
  list.textContent = ''
  if (!programs) {
    list.innerHTML = '<div class="empty-tip">正在读取程序列表…</div>'
    return
  }
  const q = filter.value.trim().toLowerCase()
  const hits = q
    ? programs.filter((p) => p.name.toLowerCase().includes(q) || (p.target || '').toLowerCase().includes(q))
    : programs
  if (!hits.length) {
    const tip = document.createElement('div')
    tip.className = 'empty-tip'
    tip.textContent = `没有匹配「${filter.value.trim()}」的程序`
    list.appendChild(tip)
    return
  }
  const shown = hits.slice(0, 300)
  const used = usedTargets()
  const rowEls = []
  for (const p of shown) {
    const key = (p.target || p.path).toLowerCase()
    const isUsed = used.has(key)
    const row = document.createElement('div')
    row.className = 'prog' + (isUsed ? ' used' : '')
    row.dataset.path = p.path
    row.innerHTML = `<span class="ic">${svgFor('app-window')}</span><div class="txt"><b></b><span class="sub"></span></div><span class="tag"></span>`
    row.querySelector('b').textContent = p.name
    row.querySelector('.sub').textContent = p.target || '商店应用'
    if (isUsed) row.querySelector('.tag').textContent = '已添加'
    else {
      row.addEventListener('click', async () => {
        await window.api.pickSlot(pickFor, 'app', p.path)
        closePicker()
      })
    }
    list.appendChild(row)
    rowEls.push(row)
  }
  fillIcons(rowEls)
}

// 图标按小批取，边取边填，避免一次抽 200 个把列表卡住
let iconToken = 0
async function fillIcons (rowEls) {
  const token = ++iconToken
  for (let i = 0; i < rowEls.length && token === iconToken; i += 12) {
    const chunk = rowEls.slice(i, i + 12)
    const urls = await window.api.iconsBatch(chunk.map((r) => r.dataset.path))
    if (token !== iconToken) return
    chunk.forEach((row, j) => {
      if (!urls[j]) return
      row.querySelector('.ic').innerHTML = `<img class="appicon" src="${urls[j]}" alt="">`
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

filter.addEventListener('input', renderList)
document.getElementById('pcancel').addEventListener('click', closePicker)
document.getElementById('browse').addEventListener('click', async () => {
  const index = pickFor
  closePicker()
  await window.api.pickSlot(index, 'app')
})

for (const btn of noteMode.querySelectorAll('button')) {
  btn.addEventListener('click', () => window.api.setSettings({ noteMode: btn.dataset.mode }))
}

document.addEventListener('click', (event) => {
  if (!chooser.contains(event.target) && !event.target.matches('[data-pick]')) chooser.classList.remove('show')
})

// 透明度改了要立刻作用到悬浮球：它只是换个 CSS 变量，直接实时下发。
// 尺寸要重建球窗口，所以拖动中节流到 ~80ms 一次，松手再补最后一次。
let sizeTimer = null
let sizePending = null
for (const [input, name] of [[opacityInput, 'opacity'], [sizeInput, 'size']]) {
  input.addEventListener('pointerdown', () => { active = name })
  input.addEventListener('input', () => {
    error.textContent = ''
    const next = { ...current, opacity: Number(opacityInput.value) / 100, size: Number(sizeInput.value) }
    render(next)
    window.api.setSettings({ opacity: next.opacity })
    if (name === 'size') {
      sizePending = next.size
      if (!sizeTimer) {
        sizeTimer = setTimeout(() => {
          sizeTimer = null
          window.api.setSettings({ size: sizePending })
        }, 80)
      }
    }
  })
}

window.addEventListener('pointerup', () => {
  if (!active) return
  active = null
  window.api.setSettings({ opacity: Number(opacityInput.value) / 100, size: Number(sizeInput.value) })
})

launch.addEventListener('click', async () => render(await window.api.setSettings({ autoLaunch: !current.autoLaunch })))
launch.addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') launch.click()
})

document.getElementById('upload').addEventListener('click', async () => {
  const result = await window.api.chooseIcon()
  if (result.canceled) return
  if (!result.ok) error.textContent = result.error || '图标替换失败'
})

document.getElementById('default').addEventListener('click', async () => {
  error.textContent = ''
  render(await window.api.resetIcon())
})

document.getElementById('close').addEventListener('click', () => window.api.closeSettings())
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (picker.classList.contains('show')) closePicker()
  else if (chooser.classList.contains('show')) chooser.classList.remove('show')
  else window.api.closeSettings()
})

window.api.onSettings(render)

;(async () => {
  const [s, limits] = await Promise.all([window.api.getSettings(), window.api.getLimits()])
  innerCount = limits.slotInner || 10
  opacityInput.min = String(Math.round(limits.opacity.min * 100))
  opacityInput.max = String(Math.round(limits.opacity.max * 100))
  sizeInput.min = String(limits.size.min)
  sizeInput.max = String(limits.size.max)
  document.getElementById('version').textContent = `v${s.version}`
  render(s)
})()
