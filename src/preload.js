const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (handler) => {
  ipcRenderer.on(channel, (_event, payload) => handler(payload))
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getLimits: () => ipcRenderer.invoke('settings:limits'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: on('settings:changed'),

  chooseIcon: () => ipcRenderer.invoke('icon:choose'),
  resetIcon: () => ipcRenderer.invoke('icon:reset'),

  pickSlot: (index, kind, p) => ipcRenderer.invoke('slot:pick', { index, kind, path: p }),
  clearSlot: (index) => ipcRenderer.invoke('slot:clear', index),
  listApps: (force) => ipcRenderer.invoke('apps:list', force),
  iconsBatch: (paths) => ipcRenderer.invoke('icons:batch', paths),

  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag:end'),
  onFloatHover: on('float:hover'),

  openSettings: () => ipcRenderer.send('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  openMenu: () => ipcRenderer.send('float:menu'),
  newDoc: () => ipcRenderer.send('doc:new'),
  openRing: () => ipcRenderer.send('ring:open'),

  getRing: () => ipcRenderer.invoke('ring:get'),
  pickRing: (index) => ipcRenderer.send('ring:pick', index),
  reorderRing: (from, to) => ipcRenderer.send('ring:reorder', { from, to }),
  draggingRing: (on) => ipcRenderer.send('ring:dragging', on),
  dismissRing: () => ipcRenderer.send('ring:dismiss'),
  onRingHover: on('ring:hover'),
  onRingSlots: on('ring:slots'),

  onPinState: on('pin:state'),
  unmark: (hwnd) => ipcRenderer.send('pin:unmark', hwnd),

  saveDoc: (payload) => ipcRenderer.invoke('doc:save', payload),
  openDoc: () => ipcRenderer.invoke('doc:open'),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  closeWindow: () => ipcRenderer.send('win:close'),
  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  resizeStart: () => ipcRenderer.send('editor:resize-start'),
  resizeBy: (dx, dy) => ipcRenderer.send('editor:resize', { dx, dy }),
  resizeEnd: () => ipcRenderer.send('editor:resize-end')
})
