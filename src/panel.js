const T = window.__TAURI__;
const appWindow = T && T.window ? T.window.getCurrentWindow() : null;
const slider = document.getElementById('scale');
const valEl = document.getElementById('val');

function closeSelf() {
  if (T && T.core) {
    if (appWindow) {
      appWindow.hide().catch(() => {});
    } else {
      T.core.invoke('hide_native', { label: 'panel' }).catch(() => {});
    }
    if (T.event && T.event.emitTo) {
      T.event.emitTo('pet', 'panel-closed', {}).catch(() => {});
    }
  }
}

if (T && T.event) {
  await T.event.listen('panel-init', (ev) => {
    const p = ev.payload || {};
    if (typeof p.min === 'number') slider.min = String(Math.round(p.min * 100));
    if (typeof p.max === 'number') slider.max = String(Math.round(p.max * 100));
    if (typeof p.scale === 'number') slider.value = String(Math.round(p.scale * 100));
    valEl.textContent = `${slider.value}%`;
  });

  slider.addEventListener('input', () => {
    valEl.textContent = `${slider.value}%`;
    T.event.emitTo('pet', 'panel-scale', { value: Number(slider.value) / 100 }).catch(() => {});
  });
}

document.getElementById('close').addEventListener('click', closeSelf);
