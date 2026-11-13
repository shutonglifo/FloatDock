const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 悬浮球窗口四周的透明留白：要装得下 hover 时的阴影（模糊 18 + 下移 5），否则阴影被窗口边裁掉
const BALL_PAD = 28
const BALL_PAD_OLD = 10

const DEFAULTS = {
  size: 64,
  opacity: 0.85,
  iconFile: null,
  ballX: null,
  ballY: null,
  ballPad: null,
  autoLaunch: false,
  noteMode: 'built-in',
  slots: null
}

const LIMITS = {
  size: { min: 24, max: 180 },
  opacity: { min: 0.2, max: 1 }
}

const SLOT_COUNT = 10
const SLOT_COUNT2 = 12
// 两层共用一套全局下标：0~9 内圈，10~21 外圈
const SLOT_TOTAL = SLOT_COUNT + SLOT_COUNT2
const KINDS = ['empty', 'note', 'pin', 'app', 'folder', 'file']

// 槽位展示信息集中在这里，环形菜单和设置面板共用一份，加功能只改这一处
const SLOT_META = {
  note: { label: '快捷文本框', icon: 'file-text' },
  pin: { label: '窗口置顶', icon: 'pin' },
  app: { label: '程序', icon: 'app-window' },
  folder: { label: '文件夹', icon: 'folder-open' },
  file: { label: '文件', icon: 'file' },
  empty: { label: '待添加', icon: 'plus' }
}

function defaultSlots () {
  const slots = [{ kind: 'note' }, { kind: 'pin' }]
  while (slots.length < SLOT_TOTAL) slots.push({ kind: 'empty' })
  return slots
}

function clamp (value, { min, max }) {
  return Math.min(max, Math.max(min, value))
}

// 程序槽位显示成「电视时光」而不是「电视时光.lnk」；文件槽位保留后缀，靠后缀认类型
const APP_EXT = /\.(lnk|url|exe|appref-ms|msi|bat|cmd)$/i

function describe (slot) {
  const meta = SLOT_META[slot.kind] || SLOT_META.empty
  let name = slot.path ? path.basename(slot.path) : ''
  if (slot.kind === 'app') name = name.replace(APP_EXT, '')
  return {
    kind: slot.kind,
    path: slot.path || null,
    label: slot.kind === 'empty' ? meta.label : (name || meta.label),
    icon: meta.icon
  }
}

function normalizeSlots (input) {
  if (!Array.isArray(input)) return defaultSlots()
  const out = []
  for (let i = 0; i < SLOT_TOTAL; i++) {
    const raw = input[i]
    if (!raw || !KINDS.includes(raw.kind)) {
      out.push({ kind: 'empty' })
      continue
    }
    const slot = { kind: raw.kind }
    // 商店应用的 exe 别名（WindowsApps\）不给 stat 权限，只能用 ShellExecute 起，
    // 所以 app 类型不做存在性校验，folder/file 仍然校验
    if (typeof raw.path === 'string' && raw.path) {
      if (raw.kind === 'app' || fs.existsSync(raw.path)) slot.path = raw.path
    }
    if (raw.kind !== 'empty' && !slot.path && !['note', 'pin'].includes(raw.kind)) slot.kind = 'empty'
    out.push(slot)
  }
  return out
}

class Store {
  constructor () {
    this.dir = path.join(app.getPath('userData'), 'config')
    this.iconDir = path.join(this.dir, 'icons')
    this.file = path.join(this.dir, 'settings.json')
    this.#migrate()
    this.data = this.#read()
    this.#fixBallAnchor()
  }

  // 留白改过版：存的是窗口原点，留白变了原点要跟着挪，球心保持不动
  #fixBallAnchor () {
    const prev = this.data.ballPad ?? BALL_PAD_OLD
    if (prev === BALL_PAD) return
    if (this.data.ballX !== null && this.data.ballY !== null) {
      const shift = prev - BALL_PAD
      this.data.ballX = Math.round(this.data.ballX + shift)
      this.data.ballY = Math.round(this.data.ballY + shift)
    }
    this.data.ballPad = BALL_PAD
    this.#write()
  }

  // 改名前旧版本把设置放在 %APPDATA%\FloatNote\floatnote，这里一次性搬过来
  #migrate () {
    this.migrated = false
    if (fs.existsSync(this.file)) return
    const legacy = path.join(app.getPath('appData'), 'FloatNote', 'floatnote')
    const legacyFile = path.join(legacy, 'settings.json')
    if (!fs.existsSync(legacyFile)) return
    fs.mkdirSync(this.dir, { recursive: true })
    fs.copyFileSync(legacyFile, this.file)
    const legacyIcons = path.join(legacy, 'icons')
    if (fs.existsSync(legacyIcons)) {
      fs.cpSync(legacyIcons, this.iconDir, { recursive: true })
    }
    this.migrated = true
  }

  #read () {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { ...DEFAULTS, ...raw, slots: normalizeSlots(raw.slots) }
    } catch {
      return { ...DEFAULTS, slots: defaultSlots() }
    }
  }

  #write () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  all () {
    return { ...this.data }
  }

  set (patch) {
    const next = { ...this.data, ...patch }
    if (patch.size !== undefined) next.size = Math.round(clamp(patch.size, LIMITS.size))
    if (patch.opacity !== undefined) next.opacity = clamp(patch.opacity, LIMITS.opacity)
    if (patch.slots !== undefined) next.slots = normalizeSlots(patch.slots)
    this.data = next
    this.#write()
    return this.all()
  }

  slotDescriptions () {
    return this.data.slots.map(describe)
  }

  // 外圈第一格要等内圈 10 格全绑上才解锁；已绑的外圈格可以继续换/清
  outerLocked () {
    return this.data.slots.slice(0, SLOT_COUNT).some((s) => s.kind === 'empty')
  }

  setSlot (index, slot) {
    if (index < 0 || index >= SLOT_TOTAL) return this.all()
    const slots = this.data.slots.map((s) => ({ ...s }))
    const kind = KINDS.includes(slot.kind) ? slot.kind : 'empty'
    if (index >= SLOT_COUNT && kind !== 'empty' && slots[index].kind === 'empty' && this.outerLocked()) return this.all()
    slots[index] = { kind }
    if (slots[index].kind !== 'empty' && slot.path) slots[index].path = slot.path
    return this.set({ slots })
  }

  swapSlots (a, b) {
    if (a === b || a < 0 || b < 0 || a >= SLOT_TOTAL || b >= SLOT_TOTAL) return this.all()
    const slots = this.data.slots.map((s) => ({ ...s }))
    ;[slots[a], slots[b]] = [slots[b], slots[a]]
    return this.set({ slots })
  }

  // 图标存一份副本到 userData，避免用户删除原始文件后悬浮球变空白
  importIcon (srcPath) {
    const ext = (path.extname(srcPath) || '.png').toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif', '.bmp', '.svg'].includes(ext)) {
      throw new Error('不支持的图片格式')
    }
    const stat = fs.statSync(srcPath)
    if (stat.size > 4 * 1024 * 1024) throw new Error('图片请小于 4MB')
    fs.mkdirSync(this.iconDir, { recursive: true })
    const target = path.join(this.iconDir, `icon-${Date.now()}${ext}`)
    fs.copyFileSync(srcPath, target)
    for (const old of this.#otherIcons(target)) fs.rmSync(old, { force: true })
    this.set({ iconFile: path.basename(target) })
    return this.iconDataUrl()
  }

  iconPath () {
    return this.data.iconFile ? path.join(this.iconDir, this.data.iconFile) : null
  }

  iconDataUrl () {
    const p = this.iconPath()
    if (!p || !fs.existsSync(p)) return null
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[path.extname(p).toLowerCase()] || 'application/octet-stream'
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
  }

  resetIcon () {
    for (const old of this.#otherIcons(null)) fs.rmSync(old, { force: true })
    this.set({ iconFile: null })
    return null
  }

  #otherIcons (keep) {
    if (!fs.existsSync(this.iconDir)) return []
    return fs.readdirSync(this.iconDir)
      .map((f) => path.join(this.iconDir, f))
      .filter((p) => p !== keep)
  }
}

module.exports = { Store, DEFAULTS, LIMITS, SLOT_COUNT, SLOT_COUNT2, SLOT_TOTAL, KINDS, SLOT_META, describe, defaultSlots, BALL_PAD }
