// 把 Iconsax 免费集里选定的图标导出成 src/ui/icons.js。
// 用法：node scripts/vendor-icons.cjs   （iconsax 只在 devDependencies，打包产物里不带它）
const fs = require('node:fs')
const path = require('node:path')

const DATA = path.join(__dirname, '..', 'node_modules', 'iconsax', 'dist', 'data')
const OUT = path.join(__dirname, '..', 'src', 'ui', 'icons.js')

// Lucide v1.70.0（ISC）的图钉：Iconsax 免费集里没有图钉，跟随指针和钉在标题栏上的那颗都靠它
const LUCIDE_PIN = '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'

// 项目里用到的名字 -> Iconsax 图标名
const MAP = {
  'file-text': 'document-text',
  'app-window': 'monitor',
  'folder-open': 'folder-open',
  'file': 'document',
  'plus': 'add',
  'layout-grid': 'grid-1'
}
const STYLES = ['linear', 'bulk']

const icons = {}
for (const f of fs.readdirSync(DATA)) Object.assign(icons, JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')))

// 原始 SVG 里颜色写死成 white，clipPath 的 id 也是 Figma 导出的固定串
function clean (svg, key, style) {
  const id = `clip-${key}-${style}`
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/url\(#(clip0_[0-9_]+)\)/g, `url(#${id})`)
    .replace(/<clipPath id="clip0_[0-9_]+">/, `<clipPath id="${id}">`)
    .replace(/stroke="white"/g, 'stroke="currentColor"')
    .replace(/fill="white"/g, 'fill="currentColor"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const entries = []
const all = { ...MAP, pin: null }

for (const key of Object.keys(all).sort()) {
  const src = all[key]
  if (!src) {
    entries.push(
      `  ${JSON.stringify(key)}: { linear: ${JSON.stringify(LUCIDE_PIN)}, bulk: ${JSON.stringify(LUCIDE_PIN)}, filled: false }`
    )
    continue
  }
  if (!icons[src]) throw new Error('Iconsax 免费集里没有 ' + src)
  const byStyle = {}
  for (const s of STYLES) {
    if (!icons[src][s]) throw new Error(`${src} 没有 ${s} 风格`)
    byStyle[s] = clean(icons[src][s], key, s)
  }
  entries.push(
    `  ${JSON.stringify(key)}: { linear: ${JSON.stringify(byStyle.linear)}, bulk: ${JSON.stringify(byStyle.bulk)}, filled: true }`
  )
}

const out = `// 图标来源：Iconsax 免费集 v0.1.1（MIT，https://www.npmjs.com/package/iconsax）—— 由 scripts/vendor-icons.cjs 导出。
// linear 用于设置面板和悬浮球（描边 1.5），bulk 用于功能圈的 44px 圆底（实心）。
// 'pin'（图钉）仍取 Lucide v1.70.0（ISC，https://lucide.dev），因为 Iconsax 免费集里没有图钉。
// 每条形如 { linear, bulk, filled }；filled=false 的是 Lucide 线稿，只能按描边渲染。
window.ICONS = {
${entries.join(',\n')}
}

// 统一出口：按用途挑风格，并带上该风格需要的描边/填充属性
window.iconSvg = function (name, style) {
  const e = window.ICONS[name]
  if (!e) return ''
  const solid = style === 'bulk' && e.filled
  const inner = solid ? e.bulk : (e.linear || e.bulk)
  const attrs = solid
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="' + (e.filled ? 1.5 : 2) + '" stroke-linecap="round" stroke-linejoin="round"'
  return '<svg viewBox="0 0 24 24" ' + attrs + '>' + inner + '</svg>'
}
`

fs.writeFileSync(OUT, out)
console.log(`写入 ${OUT}\n${entries.length} 个图标：${entries.map((e) => e.match(/^ {2}"([^"]+)"/)[1]).join(', ')}`)
