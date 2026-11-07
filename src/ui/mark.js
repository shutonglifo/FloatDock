const mark = document.getElementById('mark')
mark.innerHTML = window.renderTack()

const hwnd = Number(new URLSearchParams(location.search).get('hwnd'))
mark.addEventListener('click', () => window.api.unmark(hwnd))
