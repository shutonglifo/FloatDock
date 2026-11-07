const { app, BrowserWindow, ipcMain, dialog, Menu, screen, globalShortcut, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile, spawn } = require('node:child_process')
const { Store, LIMITS, BALL_PAD } = require('./store')
const ring = require('./ring')
const pin = require('./pin')
const apps = require('./apps')
const icon = require('./icon')
const native = require('./native')

const UI = path.join(__dirname, '..', 'ui')
const PRELOAD = path.join(__dirname, '..', 'preload.js')
const MARGIN = 48
const PANEL_W = 360
const PANEL_H = 560

let store
let floatWin = null
let settingsWin = null
let dialogBusy = false
const docs = new Map()
let docSeq = 0

const ballPx = (size) => size + BALL_PAD * 2
const webPrefs = () => ({
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
})

// ---------------------------------------------------------------- 悬浮球

function defaultBallPosition (winSize) {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + wa.width - winSize - MARGIN,
    y: wa.y + wa.height - winSize - MARGIN
  }
}

function isInsideAnyDisplay (x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.bounds
    return x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height
  })
}

function createFloatWindow () {
  const winSize = ballPx(store.data.size)
  const saved = store.data
  const pos = saved.ballX !== null && saved.ballY !== null && isInsideAnyDisplay(saved.ballX, saved.ballY, winSize, winSize)
    ? { x: saved.ballX, y: saved.ballY }
    : defaultBallPosition(winSize)

  floatWin = new BrowserWindow({
    ...pos,
    width: winSize,
    height: winSize,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPrefs()
  })

  floatWin.setAlwaysOnTop(true, 'screen-saver')
  floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  floatWin.loadFile(path.join(UI, 'float.html'))
  floatWin.once('ready-to-show', () => {
    floatWin.showInactive()
    startPassthrough()
  })
}

// 窗口比球本身大一圈（留白是留给阴影的），指针不落在球上时点击要穿到下面的窗口。
// Electron 的 forward 模式在这台机器上收不到任何移动事件，只能自己轮询指针位置；
// 也正因为收不到事件，页面里的 :hover 会慢半拍，所以 hover 状态由这里直接推给渲染层。
let passthroughTimer = null
let passthroughOn = null
let hoverOn = null

function overBall (dip) {
  const b = floatWin.getBounds()
  const dx = dip.x - (b.x + b.width / 2)
  const dy = dip.y - (b.y + b.height / 2)
  return Math.hypot(dx, dy) <= store.data.size / 2 + 4
}

function pollPassthrough () {
  if (!floatWin || floatWin.isDestroyed() || dragOrigin) return
  const pt = native.cursorPoint()
  // 提权窗口占焦点时读不到指针，保持现状，免得乱切
  if (!pt) return
  const over = overBall(screen.screenToDipPoint(pt))
  const want = !over
  if (want !== passthroughOn) {
    passthroughOn = want
    floatWin.setIgnoreMouseEvents(want, want ? { forward: true } : {})
  }
  if (over !== hoverOn) {
    hoverOn = over
    floatWin.webContents.send('float:hover', over)
  }
}

function startPassthrough () {
  if (passthroughTimer || !native.api.available) return
  pollPassthrough()
  passthroughTimer = setInterval(pollPassthrough, 40)
}

function setBallSize (size) {
  const next = store.set({ size }).size
  if (!floatWin || floatWin.isDestroyed()) return next
  const before = floatWin.getBounds()
  const after = ballPx(next)
  floatWin.setBounds({
    x: Math.round(before.x + (before.width - after) / 2),
    y: Math.round(before.y + (before.height - after) / 2),
    width: after,
    height: after
  })
  persistBallPosition()
  return next
}

function persistBallPosition () {
  if (!floatWin || floatWin.isDestroyed()) return
  const [x, y] = floatWin.getPosition()
  store.set({ ballX: x, ballY: y })
}

// ---------------------------------------------------------------- 设置面板

function placeSettings (win) {
  if (!floatWin || floatWin.isDestroyed()) return
  const W = PANEL_W
  const H = PANEL_H
  const anchor = floatWin.getBounds()
  const display = screen.getDisplayMatching(anchor)
  const wa = display.workArea
  const gap = 14
  let x = anchor.x - W - gap
  if (x < wa.x) x = anchor.x + anchor.width + gap
  if (x + W > wa.x + wa.width) x = wa.x + wa.width - W
  let y = anchor.y + Math.round(anchor.height / 2) - Math.round(H / 2)
  if (y < wa.y) y = wa.y
  if (y + H > wa.y + wa.height) y = wa.y + wa.height - H
  win.setPosition(Math.round(x), Math.round(y))
}

function openSettings () {
  if (settingsWin && !settingsWin.isDestroyed()) {
    placeSettings(settingsWin)
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: webPrefs()
  })
  settingsWin.setAlwaysOnTop(true, 'screen-saver')
  settingsWin.on('closed', () => { settingsWin = null })
  // 弹出式面板：点到别处就销毁，不常驻一个渲染进程
  settingsWin.on('blur', () => { if (!dialogBusy && settingsWin && !settingsWin.isDestroyed()) settingsWin.close() })

  placeSettings(settingsWin)
  settingsWin.loadFile(path.join(UI, 'settings.html'))
  settingsWin.once('ready-to-show', () => { settingsWin.show(); settingsWin.focus() })
}

// ---------------------------------------------------------------- 编辑窗

function createDoc () {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  docSeq += 1
  const id = docSeq
  const step = ((docSeq - 1) % 8) * 26
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(820, Math.max(520, wa.width - 160))
  const height = Math.min(620, Math.max(420, wa.height - 160))

  const win = new BrowserWindow({
    width,
    height,
    x: wa.x + Math.round(wa.width / 2 - width / 2) + step,
    y: wa.y + 40 + step,
    minWidth: 420,
    minHeight: 300,
    frame: false,
    show: false,
    backgroundColor: '#fbfbfa',
    title: '未命名.txt',
    webPreferences: webPrefs()
  })

  const doc = { id, win, filePath: null, name: '未命名.txt', dirty: false }
  docs.set(id, doc)

  win.on('close', (event) => {
    if (!doc.dirty || doc.allowClose) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: '未保存的更改',
      message: `「${doc.name}」还没有保存`,
      detail: '关闭后这次编辑的内容会丢失。',
      buttons: ['继续编辑', '放弃并关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (choice === 0) event.preventDefault()
    else doc.allowClose = true
  })
  win.on('closed', () => { docs.delete(id) })
  win.once('ready-to-show', () => win.show())

  win.loadFile(path.join(UI, 'editor.html'), { search: new URLSearchParams({ id: String(id) }).toString() })
  win.focus()
  return id
}

function docFromSender (event) {
  for (const doc of docs.values()) if (doc.win.webContents === event.sender) return doc
  return null
}

function markDirty (doc, dirty) {
  doc.dirty = dirty
}

async function saveDoc (doc, { text, saveAs }) {
  let target = doc.filePath
  if (!target || saveAs) {
    const result = await withDialog(() => dialog.showSaveDialog(doc.win, {
      title: '保存文本文档',
      defaultPath: path.join(app.getPath('documents'), doc.name),
      filters: [{ name: '文本文档', extensions: ['txt'] }]
    }))
    if (result.canceled || !result.filePath) return null
    target = result.filePath
  }
  fs.writeFileSync(target, text, 'utf8')
  doc.filePath = target
  doc.name = path.basename(target)
  markDirty(doc, false)
  doc.win.setTitle(doc.name)
  return { filePath: target, name: doc.name }
}

// ---------------------------------------------------------------- 状态同步

async function withDialog (run) {
  dialogBusy = true
  try {
    return await run()
  } finally {
    dialogBusy = false
  }
}

// 绑了程序/文件夹/文件的槽位用程序自己的图标，一眼能认出来
function slotsWithIcons () {
  return store.slotDescriptions().map((s) => {
    if (s.kind === 'app' || s.kind === 'folder' || s.kind === 'file') {
      s.iconDataUrl = icon.iconDataUrl(s.path)
      s.target = icon.launchTarget(s.path)
    }
    return s
  })
}

function snapshot () {
  const { slots, ...rest } = store.all()
  return { ...rest, slots: slotsWithIcons(), iconDataUrl: store.iconDataUrl(), version: app.getVersion() }
}

function pushSettings () {
  const payload = snapshot()
  for (const win of [floatWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', payload)
  }
}

function applyLoginItem (on) {
  if (process.platform !== 'win32') return
  try {
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [] })
  } catch { /* 开发模式下可能被拒绝，不影响其它功能 */ }
}

// 改名后旧键会指向已经不存在的 FloatNote.exe，开机时报错；只在确认是我们的旧项时删
function dropLegacyLoginItem () {
  if (!store.migrated) return
  execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'com.yuer.floatnote'], (error, stdout) => {
    if (error || !/floatnote/i.test(stdout)) return
    execFile('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'com.yuer.floatnote', '/f'])
  })
}

function setAutoLaunch (on) {
  store.set({ autoLaunch: on })
  applyLoginItem(on)
  pushSettings()
}

function openRing () {
  if (!floatWin || floatWin.isDestroyed()) return
  // 球原地不动，由 ring 自己按可用空间变形，避免贴边时球跳来跳去
  ring.open(floatWin.getBounds(), slotsWithIcons(), {
    ballRadius: store.data.size / 2,
    action: runSlot,
    reorder: (from, to) => {
      store.swapSlots(from, to)
      pushSettings()
      return slotsWithIcons()
    }
  })
}

function showLaunchError (error) {
  if (!error || !floatWin || floatWin.isDestroyed()) return
  dialog.showMessageBox(floatWin, { type: 'warning', title: '启动失败', message: String(error), buttons: ['知道了'] })
}

function openTarget (p) {
  if (!p) return
  shell.openPath(p).then(showLaunchError).catch(() => {})
}

function openSystemNotepad () {
  const child = spawn('notepad.exe', { detached: true, stdio: 'ignore' })
  child.on('error', () => createDoc()) // 系统记事本被替换或缺失时退回内置窗口
  child.unref()
}

function runSlot (slot) {
  if (slot.kind === 'note') {
    if (store.data.noteMode === 'system') openSystemNotepad()
    else createDoc()
    return
  }
  if (slot.kind === 'pin') {
    if (pin.start()) return
    dialog.showMessageBox(floatWin, {
      type: 'info',
      title: '窗口置顶',
      message: '这个功能需要 Win32 接口，当前运行环境没有加载成功。',
      buttons: ['知道了']
    })
    return
  }
  // app / folder / file 统一交给 ShellExecute，它同时认 .lnk、商店别名和普通文件
  openTarget(slot.path)
}

function floatMenu () {
  Menu.buildFromTemplate([
    { label: '新建文本文档', click: () => createDoc() },
    { label: '取消全部置顶', enabled: pin.pinnedCount() > 0, click: () => pin.unpinAll() },
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: '开机自启', type: 'checkbox', checked: store.data.autoLaunch, click: (item) => setAutoLaunch(item.checked) },
    { type: 'separator' },
    { role: 'quit', label: '退出' }
  ]).popup({ window: floatWin })
}

// ---------------------------------------------------------------- IPC

let dragOrigin = null
let resizeOrigin = null

function registerIpc () {
  ipcMain.handle('settings:get', () => snapshot())
  ipcMain.handle('settings:limits', () => LIMITS)

  ipcMain.handle('settings:set', (_event, patch) => {
    const { size, ...rest } = patch
    if (Object.keys(rest).length) store.set(rest)
    if (size !== undefined) setBallSize(size)
    if (patch.autoLaunch !== undefined) setAutoLaunch(!!patch.autoLaunch)
    pushSettings()
    return snapshot()
  })

  ipcMain.handle('settings:close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close() })
  ipcMain.on('settings:open', openSettings)
  ipcMain.on('float:menu', floatMenu)
  ipcMain.on('doc:new', () => createDoc())
  ipcMain.on('ring:open', openRing)

  ipcMain.handle('icon:choose', async (event) => {
    const owner = event.sender
    const result = await withDialog(() => dialog.showOpenDialog(BrowserWindow.fromWebContents(owner) || undefined, {
      title: '选择图标',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'] }]
    }))
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    try {
      const iconDataUrl = store.importIcon(result.filePaths[0])
      pushSettings()
      return { ok: true, iconDataUrl }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle('icon:reset', (event) => {
    store.resetIcon()
    pushSettings()
    return snapshot()
  })

  ipcMain.handle('apps:list', (_event, force) => apps.list(!!force))
  ipcMain.handle('icons:batch', (_event, paths) => paths.map((p) => icon.iconDataUrl(p)))

  // 槽位换绑：内置功能直接写，程序/文件夹/文件走系统选择框；从程序列表选定则直接带 path 过来
  ipcMain.handle('slot:pick', async (event, { index, kind, path: chosenPath }) => {
    if (chosenPath) {
      store.setSlot(index, { kind, path: chosenPath })
      pushSettings()
      return { ok: true, path: chosenPath }
    }
    const owner = BrowserWindow.fromWebContents(event.sender) || undefined
    if (kind === 'note' || kind === 'pin') {
      store.setSlot(index, { kind })
      pushSettings()
      return { ok: true }
    }
    const options = kind === 'folder'
      ? { title: '选择文件夹', properties: ['openDirectory'] }
      : {
          title: kind === 'app' ? '选择程序' : '选择文件',
          properties: ['openFile'],
          filters: kind === 'app'
            ? [{ name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
            : [{ name: '所有文件', extensions: ['*'] }]
        }
    const result = await withDialog(() => dialog.showOpenDialog(owner, options))
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    store.setSlot(index, { kind, path: result.filePaths[0] })
    pushSettings()
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle('slot:clear', (_event, index) => {
    store.setSlot(index, { kind: 'empty' })
    pushSettings()
    return snapshot()
  })

  ipcMain.on('drag:start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const [x, y] = win.getPosition()
    dragOrigin = { win, x, y, w: win.getBounds().width, h: win.getBounds().height }
  })

  ipcMain.on('drag:move', (_event, { dx, dy }) => {
    if (!dragOrigin) return
    const display = screen.getDisplayMatching({ x: dragOrigin.x, y: dragOrigin.y, width: dragOrigin.w, height: dragOrigin.h })
    const wa = display.workArea
    const halfWin = dragOrigin.w / 2
    // 按球心夹取：球心最多贴到工作区边，也就是最多藏一半，不会只剩一条边
    const cx = Math.min(wa.x + wa.width, Math.max(wa.x, dragOrigin.x + halfWin + dx))
    const cy = Math.min(wa.y + wa.height, Math.max(wa.y, dragOrigin.y + halfWin + dy))
    dragOrigin.win.setPosition(Math.round(cx - halfWin), Math.round(cy - halfWin))
  })

  ipcMain.on('drag:end', () => {
    if (!dragOrigin) return
    dragOrigin = null
    persistBallPosition()
  })


  ipcMain.on('editor:resize-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const b = win.getBounds()
    resizeOrigin = { win, w: b.width, h: b.height }
  })

  ipcMain.on('editor:resize', (_event, { dx, dy }) => {
    if (!resizeOrigin) return
    resizeOrigin.win.setSize(Math.max(460, resizeOrigin.w + dx), Math.max(320, resizeOrigin.h + dy))
  })

  ipcMain.on('editor:resize-end', () => { resizeOrigin = null })

  // 编辑窗
  ipcMain.handle('doc:save', async (event, payload) => {
    const doc = docFromSender(event)
    if (!doc) return null
    return saveDoc(doc, payload)
  })

  ipcMain.handle('doc:open', async (event) => {
    const doc = docFromSender(event)
    if (!doc) return null
    const result = await withDialog(() => dialog.showOpenDialog(doc.win, {
      title: '打开文本文档',
      properties: ['openFile'],
      filters: [{ name: '文本文档', extensions: ['txt', 'md', 'log', 'csv'] }, { name: '所有文件', extensions: ['*'] }]
    }))
    if (result.canceled || !result.filePaths[0]) return null
    const target = result.filePaths[0]
    doc.filePath = target
    doc.name = path.basename(target)
    doc.win.setTitle(doc.name)
    return { filePath: target, name: doc.name, text: fs.readFileSync(target, 'utf8') }
  })

  ipcMain.on('doc:dirty', (event, dirty) => {
    const doc = docFromSender(event)
    if (doc) markDirty(doc, !!dirty)
  })

  ipcMain.on('win:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  ipcMain.on('win:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })
}

// ---------------------------------------------------------------- 生命周期

// 常驻内存优化（都在真机截图上验证过渲染没变）：
//   1) 关掉 GPU 合成进程：透明球 84px，软件合成足够，省约 10MB
//   2) 不预热备用渲染进程：省约 13MB，代价是首个编辑窗慢约 100ms
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (floatWin && !floatWin.isDestroyed()) createDoc()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.yuer.floatdock')
    Menu.setApplicationMenu(null)
    store = new Store()
    if (store.data.autoLaunch) applyLoginItem(true)
    dropLegacyLoginItem()
    registerIpc()
    createFloatWindow()
    globalShortcut.register('CommandOrControl+Alt+N', () => createDoc())
  })

  app.on('window-all-closed', () => { /* 悬浮球关掉后常驻，不退出 */ })
  app.on('before-quit', () => {
    for (const doc of docs.values()) doc.allowClose = true
    persistBallPosition()
    globalShortcut.unregisterAll()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createFloatWindow()
  })
}
