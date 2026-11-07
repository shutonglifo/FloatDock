// 图钉的唯一画法：跟随指针的图钉和钉在标题栏上的钉标共用，倾斜角度不会走偏
window.TACK_TILT = 24

window.renderTack = function (iconName) {
  const entry = window.ICONS[iconName || 'pin']
  const segments = (entry ? entry.linear : '').split('<path').filter(Boolean)
  return `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${
    segments.map((seg, i) => `<path${i === segments.length - 1 ? ' class="body"' : ''}${seg}`).join('')
  }</svg>`
}
