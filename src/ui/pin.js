document.getElementById('tack').innerHTML = window.renderTack()

window.api.onPinState((state) => {
  document.body.classList.toggle('off', !state.on)
  document.body.classList.toggle('done', !!state.on)
})
