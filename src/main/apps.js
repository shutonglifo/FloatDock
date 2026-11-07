const { shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 开始菜单程序目录：当前用户 + 全体用户；再加商店应用的 exe 别名目录
function roots () {
  const out = []
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (process.env.ProgramData) out.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return out
}

function storeAliasDir () {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null
}

// 别名文件名常带包名后缀，如 Microsoft.WindowsCalculator_8wekyb3d8bbwe，取可读的那段
function prettyName (file) {
  const base = path.basename(file).replace(/\.exe$/i, '')
  const head = base.split('_')[0]
  const tail = head.split('.').pop()
  return tail || head
}

const NOISE = /(卸载|卸载程序|uninstall|uninstaller|readme|说明|license|website|访问)/i
const TTL_MS = 60 * 1000

let cache = null
let cachedAt = 0

function safeRead (dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function walk (dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(lnk|appref-ms)$/i.test(entry.name)) {
      out.push(full)
    }
  }
}

function resolve (shortcut) {
  const name = path.basename(shortcut).replace(/\.(lnk|appref-ms)$/i, '')
  if (NOISE.test(name)) return null
  if (/\.appref-ms$/i.test(shortcut)) {
    // UWP 别名没有可解析的目标路径，直接按 ShellExecute 启动别名本身
    return { name, path: shortcut, target: null }
  }
  let details
  try {
    details = shell.readShortcutLink(shortcut)
  } catch {
    return null
  }
  const target = details && details.target
  if (!target || !fs.existsSync(target)) return null
  return { name, path: shortcut, target }
}

function list (force) {
  if (cache && !force && Date.now() - cachedAt < TTL_MS) return cache
  const files = []
  for (const root of roots()) walk(root, files)

  const byKey = new Map()
  for (const file of files) {
    const item = resolve(file)
    if (!item) continue
    const key = `${item.name.toLowerCase()}|${(item.target || '').toLowerCase()}`
    if (!byKey.has(key)) byKey.set(key, item)
  }

  const alias = storeAliasDir()
  if (alias) {
    for (const entry of safeRead(alias)) {
      if (!/\.exe$/i.test(entry) || NOISE.test(entry)) continue
      const full = path.join(alias, entry)
      const name = prettyName(full)
      const key = `${name.toLowerCase()}|${full.toLowerCase()}`
      if (!byKey.has(key)) byKey.set(key, { name, path: full, target: full })
    }
  }

  cache = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  cachedAt = Date.now()
  return cache
}

module.exports = { list, roots }
