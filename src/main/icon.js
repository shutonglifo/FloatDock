const { nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const koffi = require('koffi')

const SIZE = 48
const ICON_EXPIRED = 0x00000010
const SHGFI_ICON = 0x00000100
const SHGFI_LARGEICON = 0x00000000
const DI_NORMAL = 0x0003

let user32 = null
let gdi32 = null
let shell32 = null
let fns = null
const cache = new Map()

try {
  user32 = koffi.load('user32.dll')
  gdi32 = koffi.load('gdi32.dll')
  shell32 = koffi.load('shell32.dll')
  fns = {
    PrivateExtractIconsW: user32.func('uint PrivateExtractIconsW(uint16 *file, int index, int cx, int cy, void *phicon, void *pid, int n, uint flags)'),
    GetIconInfo: user32.func('bool GetIconInfo(void *hicon, void *info)'),
    DrawIconEx: user32.func('bool DrawIconEx(void *dc, int x, int y, void *hicon, int w, int h, uint step, void *brush, uint usage)'),
    DestroyIcon: user32.func('bool DestroyIcon(void *hicon)'),
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *dc)'),
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *dc)'),
    CreateDIBSection: gdi32.func('void *CreateDIBSection(void *dc, void *bmi, uint usage, void *bits, void *section, uint offset)'),
    SelectObject: gdi32.func('void *SelectObject(void *dc, void *obj)'),
    DeleteObject: gdi32.func('bool DeleteObject(void *obj)'),
    DeleteDC: gdi32.func('bool DeleteDC(void *dc)'),
    GetObjectW: gdi32.func('int GetObjectW(void *obj, int count, void *pv)'),
    SHGetFileInfoW: shell32.func('uint SHGetFileInfoW(uint16 *file, uint attrs, void *info, uint size, uint flags)')
  }
} catch {
  fns = null
}

function u16 (s) {
  const b = Buffer.alloc((s.length + 1) * 2)
  b.write(s + '\0', 'utf16le')
  return b
}

// HICON 画进 32 位 DIB，再交给 Skia 出 PNG
function renderIcon (hicon) {
  if (!fns || !hicon) return null
  const info = Buffer.alloc(32)
  if (!fns.GetIconInfo(hicon, info)) return null
  const hbmColor = info.readBigUInt64LE(24)

  const bm = Buffer.alloc(32)
  let w = SIZE
  let h = SIZE
  if (hbmColor && fns.GetObjectW(hbmColor, 32, bm) === 32) {
    const gw = bm.readInt32LE(4)
    const gh = bm.readInt32LE(8)
    if (gw > 0 && gh > 0) { w = gw; h = gh }
  }

  const bmi = Buffer.alloc(40)
  bmi.writeUInt32LE(40, 0)
  bmi.writeInt32LE(w, 4)
  bmi.writeInt32LE(-h, 8)
  bmi.writeUInt16LE(1, 12)
  bmi.writeUInt16LE(32, 14)

  const bitsOut = Buffer.alloc(8)
  const screen = fns.GetDC(null)
  const dc = fns.CreateCompatibleDC(screen)
  const dib = fns.CreateDIBSection(dc, bmi, 0, bitsOut, null, 0)
  const addr = bitsOut.readBigUInt64LE(0)
  if (!dib || !addr) {
    fns.ReleaseDC(null, screen)
    return null
  }

  const prev = fns.SelectObject(dc, dib)
  const drew = fns.DrawIconEx(dc, 0, 0, hicon, w, h, 0, null, DI_NORMAL)
  let url = null
  if (drew) {
    const buf = Buffer.from(koffi.decode(addr, koffi.array('uint8', w * h * 4)))
    const image = nativeImage.createFromBitmap(buf, { width: w, height: h })
    if (!image.isEmpty()) url = image.toDataURL()
  }

  fns.SelectObject(dc, prev)
  fns.DeleteObject(dib)
  fns.DeleteDC(dc)
  fns.ReleaseDC(null, screen)
  if (hbmColor) fns.DeleteObject(hbmColor)
  return url
}

function fromExecutable (file, index) {
  const hiconOut = Buffer.alloc(8)
  const count = fns.PrivateExtractIconsW(u16(file), index, SIZE, SIZE, hiconOut, null, 1, 0)
  let hicon = hiconOut.readBigUInt64LE(0)
  if ((!count || !hicon) && index !== 0) {
    hiconOut.writeBigUInt64LE(0n, 0)
    const retry = fns.PrivateExtractIconsW(u16(file), 0, SIZE, SIZE, hiconOut, null, 1, 0)
    hicon = retry ? hiconOut.readBigUInt64LE(0) : 0n
  }
  if (!hicon) return null
  const url = renderIcon(hicon)
  fns.DestroyIcon(hicon)
  return url
}

// 文件夹和普通文件走 shell，能拿到资源管理器里看到的那种类型图标
function fromShell (file) {
  const info = Buffer.alloc(696)
  if (!fns.SHGetFileInfoW(u16(file), 0, info, info.length, SHGFI_ICON | SHGFI_LARGEICON)) return null
  const hicon = info.readBigUInt64LE(0)
  if (!hicon) return null
  const url = renderIcon(hicon)
  fns.DestroyIcon(hicon)
  return url
}

function resolveTarget (p) {
  if (!/\.lnk$/i.test(p)) return { file: p, index: 0 }
  let details
  try {
    details = shell.readShortcutLink(p)
  } catch {
    return { file: p, index: 0 }
  }
  const file = details.icon || details.target
  return { file, index: Number(details.iconIndex) || 0 }
}

// 槽位去重用：快捷方式统一折算成真实目标，避免同一个程序绑两次
function launchTarget (p) {
  if (!p) return null
  if (!/\.lnk$/i.test(p)) return p
  try {
    return shell.readShortcutLink(p).target || p
  } catch {
    return p
  }
}

function iconDataUrl (p) {
  if (!p || !fns) return null
  if (cache.has(p)) return cache.get(p)
  let url = null
  try {
    if (/\.(ico|png|jpg|jpeg|webp|gif|bmp)$/i.test(p) && fs.existsSync(p)) {
      const image = nativeImage.createFromPath(p)
      if (!image.isEmpty()) url = image.toDataURL()
    }
    if (!url && fs.existsSync(p)) {
      const { file, index } = resolveTarget(p)
      if (file && fs.existsSync(file)) url = fromExecutable(file, index)
    }
    if (!url) url = fromShell(p)
  } catch {
    url = null
  }
  cache.set(p, url)
  return url
}

module.exports = { iconDataUrl, launchTarget, SIZE }
