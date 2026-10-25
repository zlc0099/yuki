const T = window.__TAURI__;
const appWindow = T && T.window ? T.window.getCurrentWindow() : null;
const textEl = document.getElementById('toastText');
const dotBig = document.getElementById('toastDotBig');
const dotSmall = document.getElementById('toastDotSmall');

window.__toastReady = false;

try {
  if (appWindow && appWindow.setIgnoreCursorEvents) {
    await appWindow.setIgnoreCursorEvents(true);
  }
  if (appWindow && appWindow.setFocusable) {
    await appWindow.setFocusable(false);
  }
} catch (err) {
  console.error('toast init failed', err);
}

if (T && T.event) {
  await T.event.listen('toast-text', (ev) => {
    const payload = ev.payload || {};
    if (typeof payload.text === 'string') textEl.textContent = payload.text;
    const side = payload.tail === 'right' ? 'right' : 'left';
    dotBig.setAttribute('class', `tail-dot big ${side}`);
    dotSmall.setAttribute('class', `tail-dot small ${side}`);
    document.body.classList.toggle('alert', !!payload.alert);
    document.body.classList.remove('pop');
    void document.body.offsetWidth;
    document.body.classList.add('pop');
    // 放不下时逐步缩小字号，直到歌名和歌手完整显示
    requestAnimationFrame(() => {
      let size = 13;
      textEl.style.fontSize = `${size}px`;
      const fits = () => textEl.scrollHeight <= textEl.clientHeight + 1 && textEl.scrollWidth <= textEl.clientWidth + 1;
      while (size > 6 && !fits()) {
        size -= 0.5;
        textEl.style.fontSize = `${size}px`;
      }
    });
  });
}

window.__toastReady = true;
