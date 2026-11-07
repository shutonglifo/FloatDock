// 生成 build/icon.png：和悬浮球同一套画法的黑白版本（白球 + 黑色 grid 图形）。
// 用法：npx electron scripts/make-icon.cjs
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const iconsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'icons.js'), 'utf8')
const found = iconsSrc.match(/"layout-grid": \{ linear: ("(?:[^"\\]|\\.)*")/)
if (!found) throw new Error('icons.js 里找不到 layout-grid')
const glyph = JSON.parse(found[1])

// 球体直径 720，四周留出阴影的扩散范围（模糊 σ=26 → 最暗处约 3σ=78px），不然边缘会被裁
const ball = 720
const cx = SIZE / 2
const cy = 496
const blur = 26
const shadow = { rx: ball / 2 - 16, ry: ball / 2 - 32, cy: cy + 32 }
const art = ball * 0.54
const glyphScale = art / 24
const glyphX = cx - art / 2
const glyphY = cy - art / 2

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>
  <linearGradient id="body" x1="0" y1="0" x2="0.42" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="0.52" stop-color="#f0f1f3"/><stop offset="1" stop-color="#dcdfe4"/>
  </linearGradient>
  <radialGradient id="gloss" cx="0.32" cy="0.26" r="0.58">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
  <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="${blur}"/>
  </filter>
</defs>
<ellipse cx="${cx}" cy="${shadow.cy}" rx="${shadow.rx}" ry="${shadow.ry}" fill="#000" opacity="0.24" filter="url(#soft)"/>
<circle cx="${cx}" cy="${cy}" r="${ball / 2}" fill="url(#body)"/>
<circle cx="${cx}" cy="${cy}" r="${ball / 2}" fill="url(#gloss)"/>
<circle cx="${cx}" cy="${cy}" r="${ball / 2 - 4}" fill="none" stroke="#ffffff" stroke-opacity="0.7" stroke-width="8"/>
<g transform="translate(${glyphX},${glyphY}) scale(${glyphScale})" style="color:#14171a" fill="none" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
</svg>`

// data URL 里的 # 会被当成片段，必须整段编码
const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;overflow:hidden;background:transparent">${svg}</body>`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  await win.loadURL(html)
  await new Promise((r) => setTimeout(r, 500))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  const png = image.toPNG()
  fs.writeFileSync(out, png)
  console.log(`写入 ${out}  ${image.getSize().width}x${image.getSize().height}  ${(png.length / 1024).toFixed(0)}KB`)
  app.quit()
})
