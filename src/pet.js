const T = window.__TAURI__;
const appWindow = T && T.window ? T.window.getCurrentWindow() : null;

const BASE = { w: 200, h: 320 };
const SCALE_MIN = 0.45;
const SCALE_MAX = 0.75;
const SIZE = { w: BASE.w, h: BASE.h };
const CARD = { w: 260, h: 220 };
const TOAST = { w: 180, h: 90 };
const PANEL = { w: 240, h: 96 };

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');

const LEGACY_SCALES = { xs: 0.5, s: 0.65, m: 0.75, l: 0.75 };
const DEFAULT_SETTINGS = { scale: 0.5, walk: true, topmost: true, passthrough: false, autoPopupMin: 5, gameBroadcast: true, musicBroadcast: true };
// 走路帧原始朝向：本套素材朝右，向左走时水平镜像
const SPRITE_FACES_RIGHT = true;

function normalizeScale(v) {
  const n = Number(v);
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(n) ? n : 0.5));
}

const settings = (() => {
  try {
    const raw = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('yukipet-settings') || '{}') };
    if (typeof raw.scale !== 'number') {
      raw.scale = LEGACY_SCALES[raw.sizeKey] || 0.5;
    }
    raw.scale = normalizeScale(raw.scale);
    delete raw.sizeKey;
    return raw;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
})();
function saveSettings() {
  localStorage.setItem('yukipet-settings', JSON.stringify(settings));
}

const CFG = {
  idle: { fps: 6, loop: true },
  work: { fps: 8, loop: true },
  success: { fps: 10, loop: false, holdMs: 2600 },
  fail: { fps: 10, loop: false, holdMs: 2600 },
  walk: { fps: 14, loop: true },
  drag: { fps: 12, loop: true },
  game_open: { fps: 8, loop: false, holdMs: 300 },
  game_idle: { fps: 8, loop: true },
  game_win: { fps: 10, loop: false, holdMs: 500 },
  game_lose: { fps: 10, loop: false, holdMs: 500 },
  game_pat: { fps: 10, loop: false, holdMs: 300 },
  music_on: { fps: 10, loop: false, holdMs: 200 },
  music_default: { fps: 1, loop: true },
};

const frames = {};
const stateSize = {};
let actionKeys = [];
let state = 'idle';
let frame = 0;
let lastTick = 0;
let acc = 0;
let holdTimer = null;
let idleTimer = null;
let dragging = false;
let scaleFactor = 1;
let posX = 0;
let posY = 0;
let facing = -1;
let walk = { dx: 0, dy: 0, remain: 0, bounds: null };
let windowBounds = null;
let dragBounds = null;
let agentWorking = false;
let workStartedAt = 0;
let breakReminded = false;
let cardShown = false;
let lastAgentEventAt = 0;
let gamePlaying = false;
let gameName = '';
let gameTimer = null;
let pendingGameStop = false;
let musicPlaying = false;
let musicTitle = '';
let musicArtist = '';
let lastAgentToastAt = 0;

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(SIZE.w * dpr);
  canvas.height = Math.round(SIZE.h * dpr);
  canvas.style.width = SIZE.w + 'px';
  canvas.style.height = SIZE.h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function applyBodySize() {
  document.body.style.width = SIZE.w + 'px';
  document.body.style.height = SIZE.h + 'px';
}

async function loadSprites() {
  const res = await fetch('assets/sprites/manifest.json');
  const manifest = await res.json();
  await Promise.all(Object.entries(manifest).map(async ([name, items]) => {
    const imgs = await Promise.all(items.map(item => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`frame load failed: ${item.file}`));
      img.src = `assets/sprites/${item.file}`;
    })));
    const bitmaps = await Promise.all(imgs.map(async (img) => {
      try {
        return await createImageBitmap(img);
      } catch {
        return img;
      }
    }));
    frames[name] = bitmaps;
    stateSize[name] = {
      maxW: Math.max(...bitmaps.map(i => i.width)),
      maxH: Math.max(...bitmaps.map(i => i.height)),
    };
  }));
  actionKeys = Object.keys(frames).filter((k) => k.startsWith('action'));
  for (const key of actionKeys) CFG[key] = { fps: 9, loop: false, holdMs: 700 };
}

function draw(img) {
  ctx.clearRect(0, 0, SIZE.w, SIZE.h);
  const maxH = SIZE.h - 8;
  const maxW = SIZE.w - 8;
  // 同一状态内共用缩放比例，避免逐帧缩放造成呼吸/抖动
  const meta = stateSize[state];
  const scale = meta
    ? Math.min(maxH / meta.maxH, maxW / meta.maxW)
    : Math.min(maxH / img.height, maxW / img.width);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (SIZE.w - w) / 2;
  const y = SIZE.h - h - 4;
  const mirrored = SPRITE_FACES_RIGHT ? facing === -1 : facing === 1;
  if (mirrored) {
    ctx.save();
    ctx.translate(SIZE.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, SIZE.w - x - w, y, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
}

function scheduleNextIdleEvent() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (dragging || state !== 'idle') return;
    if (settings.walk && Math.random() < 0.5) startWalk();
    else playRandomAction();
  }, 15000 + Math.random() * 45000);
}

function setState(next, opts = {}) {
  if (!frames[next]) return;
  if (dragging && next !== 'drag' && !opts.force) return;
  if (state === next && !opts.restart) return;
  const prev = state;
  clearTimeout(holdTimer);
  holdTimer = null;
  state = next;
  frame = 0;
  lastTick = 0;
  acc = 0;
  if (next === 'idle') scheduleNextIdleEvent();
  else clearTimeout(idleTimer);
  if (prev === 'walk' && next !== 'walk') {
    savePosition();
    stopWalkMovement();
  }
  if (next === 'game_open') {
    showToast(`游戏：${gameName || '游戏中'}`, { autoHideMs: 4000 });
  }
  if (next === 'game_idle') {
    scheduleGameAction();
  } else {
    clearTimeout(gameTimer);
    gameTimer = null;
  }
  updateToast(prev, next);
}

function onAnimEnd() {
  if (holdTimer) return;
  const cfg = CFG[state];
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (dragging || state === 'walk' || state === 'drag') return;
    let target;
    if (musicPlaying) target = 'music_default';
    else if (agentWorking) target = 'work';
    else if (gamePlaying) target = 'game_idle';
    else target = 'idle';
    setState(target, { force: true });
  }, cfg.holdMs || 0);
}

function tick(t) {
  requestAnimationFrame(tick);
  const list = frames[state];
  if (!list || !list.length) return;
  const cfg = CFG[state];
  if (!lastTick) lastTick = t;
  const dt = Math.min(100, t - lastTick);
  lastTick = t;
  acc += dt;
  const interval = 1000 / cfg.fps;
  while (acc >= interval) {
    acc -= interval;
    if (frame < list.length - 1) frame++;
    else if (cfg.loop) frame = 0;
    else {
      acc = 0;
      onAnimEnd();
      break;
    }
  }
  draw(list[frame]);
}

async function moveTo(x, y) {
  posX = x;
  posY = y;
  if (!appWindow) return;
  try {
    await appWindow.setPosition(new T.dpi.PhysicalPosition(Math.round(x), Math.round(y)));
  } catch (err) {
    console.error('setPosition failed', err);
  }
}

function clampToBounds(x, y, bounds, w, h) {
  if (!bounds) return { x, y };
  const minX = bounds.x;
  const minY = bounds.y;
  const maxX = Math.max(minX, bounds.x + bounds.width - w);
  const maxY = Math.max(minY, bounds.y + bounds.height - h);
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

async function refreshBounds() {
  try {
    windowBounds = await T.core.invoke('virtual_bounds');
  } catch (err) {
    console.error('virtual_bounds failed', err);
  }
  return windowBounds;
}

function loadSavedPosition() {
  try {
    const p = JSON.parse(localStorage.getItem('yukipet-pos') || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {
    // ignore
  }
  return null;
}

function savePosition() {
  localStorage.setItem('yukipet-pos', JSON.stringify({ x: Math.round(posX), y: Math.round(posY) }));
}

async function startWalk() {
  if (!appWindow || dragging) return;
  const bounds = await refreshBounds();
  const angle = Math.floor(Math.random() * 8) * (Math.PI / 4) + (Math.random() - 0.5) * 0.35;
  walk = {
    dx: Math.cos(angle),
    dy: Math.sin(angle),
    remain: 120 + Math.random() * 220,
    bounds,
  };
  if (Math.abs(walk.dx) > 0.15) facing = walk.dx > 0 ? 1 : -1;
  setState('walk', { force: true, restart: true });
  scheduleWalkMovement();
}

let walkTimer = null;

function stopWalkMovement() {
  if (walkTimer) {
    clearTimeout(walkTimer);
    walkTimer = null;
  }
}

function scheduleWalkMovement() {
  stopWalkMovement();
  walkTimer = setTimeout(async () => {
    walkTimer = null;
    await walkMoveTick();
    if (state === 'walk') scheduleWalkMovement();
  }, 33);
}

async function walkMoveTick() {
  if (!appWindow || state !== 'walk') return;
  if (walk.remain <= 0) {
    savePosition();
    setState('idle', { force: true });
    return;
  }
  // 位移与帧动画解耦，约 30Hz 小步移动，观感更顺
  const step = Math.min(1.8, walk.remain);
  let nx = posX + walk.dx * step;
  let ny = posY + walk.dy * step;
  const b = walk.bounds || windowBounds;
  if (b) {
    const margin = 8 * scaleFactor;
    const minX = b.x + margin;
    const maxX = b.x + b.width - SIZE.w * scaleFactor - margin;
    const minY = b.y + margin;
    const maxY = b.y + b.height - SIZE.h * scaleFactor - 64 * scaleFactor;
    if (nx < minX || nx > maxX) { walk.dx *= -1; nx = Math.min(maxX, Math.max(minX, nx)); }
    if (ny < minY || ny > maxY) { walk.dy *= -1; ny = Math.min(maxY, Math.max(minY, ny)); }
  }
  walk.remain -= step;
  if (Math.abs(walk.dx) > 0.15) facing = walk.dx > 0 ? 1 : -1;
  await moveTo(nx, ny);
  if (walk.remain <= 0) {
    savePosition();
    setState('idle', { force: true });
  }
}

function baseState() {
  return agentWorking ? 'work' : gamePlaying ? 'game_idle' : 'idle';
}

function musicToast() {
  if (!settings.musicBroadcast) return;
  const name = musicTitle + (musicArtist ? ` - ${musicArtist}` : '');
  if (!name) return;
  showToast(`正在播放：${name}`, { autoHideMs: 5000, source: 'music' });
}

function handleMusicState(p) {
  if (!p) return;
  const playing = !!p.playing;
  const title = typeof p.title === 'string' ? p.title : '';
  const artist = typeof p.artist === 'string' ? p.artist : '';
  if (!settings.musicBroadcast) {
    if (musicPlaying) {
      musicPlaying = false;
      musicTitle = '';
      musicArtist = '';
      if (state.startsWith('music_')) setState(baseState(), { force: true });
    }
    return;
  }
  if (playing) {
    const changed = title !== musicTitle || artist !== musicArtist;
    musicPlaying = true;
    musicTitle = title;
    musicArtist = artist;
    if (changed) musicToast();
    if (!dragging && !state.startsWith('music_')) {
      setState('music_on', { force: true, restart: true });
    }
  } else {
    if (!musicPlaying) return;
    musicPlaying = false;
    musicTitle = '';
    musicArtist = '';
    if (state.startsWith('music_')) setState(baseState(), { force: true });
  }
}

function playRandomAction() {
  if (!actionKeys.length || gamePlaying || musicPlaying) return;
  const key = actionKeys[Math.floor(Math.random() * actionKeys.length)];
  setState(key, { force: true, restart: true });
}

function clearGameAction() {
  clearTimeout(gameTimer);
  gameTimer = null;
}

function scheduleGameAction() {
  clearGameAction();
  if (!gamePlaying) return;
  // 打游戏期间：胜利/失败/被打扰 在 1~5 分钟内随机触发
  gameTimer = setTimeout(() => {
    gameTimer = null;
    if (state === 'game_idle' && gamePlaying) {
      const pool = ['game_win', 'game_lose', 'game_pat'];
      const key = pool[Math.floor(Math.random() * pool.length)];
      setState(key, { force: true, restart: true });
    }
  }, 60000 + Math.random() * 240000);
}

function handleGameState(p) {
  if (!p) return;
  const playing = !!p.playing;
  const name = typeof p.name === 'string' ? p.name : '';
  if (!settings.gameBroadcast) {
    if (gamePlaying) {
      gamePlaying = false;
      gameName = '';
      clearGameAction();
      if (state.startsWith('game_')) setState(agentWorking ? 'work' : 'idle', { force: true });
    }
    return;
  }
  if (playing) {
    pendingGameStop = false;
    gamePlaying = true;
    gameName = name;
    if (!agentWorking && !dragging && !musicPlaying && !state.startsWith('game_')) {
      setState('game_open', { force: true, restart: true });
    }
  } else {
    if (dragging) {
      // 拖动期间先不结束游戏状态，放下后再决定
      pendingGameStop = true;
      return;
    }
    const was = gamePlaying;
    gamePlaying = false;
    gameName = '';
    clearGameAction();
    if (was && !musicPlaying && state.startsWith('game_')) {
      setState(agentWorking ? 'work' : 'idle', { force: true });
    }
  }
}

async function applyScale() {
  const factor = normalizeScale(settings.scale);
  SIZE.w = Math.round(BASE.w * factor);
  SIZE.h = Math.round(BASE.h * factor);
  applyBodySize();
  setupCanvas();
  if (!appWindow) return;
  try {
    scaleFactor = await appWindow.scaleFactor();
    const phys = new T.dpi.PhysicalSize(
      Math.round(SIZE.w * scaleFactor),
      Math.round(SIZE.h * scaleFactor),
    );
    await appWindow.setSize(phys);
    const bounds = windowBounds || (await refreshBounds());
    const target = clampToBounds(posX, posY, bounds, SIZE.w * scaleFactor, SIZE.h * scaleFactor);
    await moveTo(target.x, target.y);
    savePosition();
  } catch (err) {
    console.error('applyScale failed', err);
  }
}

async function applyTopmost() {
  if (!appWindow) return;
  try {
    await appWindow.setAlwaysOnTop(settings.topmost);
  } catch (err) {
    console.error('setAlwaysOnTop failed', err);
  }
}

async function applyPassthrough() {
  if (!appWindow) return;
  try {
    await appWindow.setIgnoreCursorEvents(!!settings.passthrough);
  } catch (err) {
    console.error('setIgnoreCursorEvents failed', err);
  }
}

async function showSizePanel() {
  if (!T || !T.window.Window) return;
  try {
    const panel = await T.window.Window.getByLabel('panel');
    if (!panel) return;
    if (await panel.isVisible()) {
      await panel.hide();
      return;
    }
    const pos = await appWindow.outerPosition();
    const size = await appWindow.outerSize();
    const sf = await appWindow.scaleFactor();
    const bounds = windowBounds || (await refreshBounds());
    const w = PANEL.w * sf;
    const h = PANEL.h * sf;
    let x = pos.x + (size.width - w) / 2;
    let y = pos.y - h - 8 * sf;
    if (bounds) {
      const margin = 8 * sf;
      x = Math.min(Math.max(x, bounds.x + margin), bounds.x + bounds.width - w - margin);
      y = Math.min(Math.max(y, bounds.y + margin), bounds.y + bounds.height - h - margin);
    }
    await panel.setPosition(new T.dpi.PhysicalPosition(Math.round(x), Math.round(y)));
    await panel.show();
    await panel.setFocus();
    if (T.event && T.event.emitTo) {
      await T.event.emitTo('panel', 'panel-init', { scale: settings.scale, min: SCALE_MIN, max: SCALE_MAX });
    }
  } catch (err) {
    console.error('showSizePanel failed', err);
  }
}

async function showContextMenu() {
  if (!T || !T.menu) return;
  const { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem } = T.menu;
  const items = [];
  items.push(await MenuItem.new({
    text: '调整大小…',
    action: () => showSizePanel(),
  }));
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  items.push(await CheckMenuItem.new({
    text: '允许随机走动',
    checked: settings.walk,
    action: () => {
      settings.walk = !settings.walk;
      saveSettings();
      if (!settings.walk && state === 'walk') setState('idle', { force: true });
    },
  }));
  items.push(await CheckMenuItem.new({
    text: '总在最前',
    checked: settings.topmost,
    action: async () => {
      settings.topmost = !settings.topmost;
      saveSettings();
      await applyTopmost();
    },
  }));
  items.push(await CheckMenuItem.new({
    text: '点击穿透（从托盘关闭）',
    checked: settings.passthrough,
    action: async () => {
      settings.passthrough = !settings.passthrough;
      saveSettings();
      await applyPassthrough();
    },
  }));
  items.push(await CheckMenuItem.new({
    text: '音乐播报',
    checked: settings.musicBroadcast,
    action: () => {
      settings.musicBroadcast = !settings.musicBroadcast;
      saveSettings();
      if (!settings.musicBroadcast) {
        musicPlaying = false;
        musicTitle = '';
        musicArtist = '';
        if (state.startsWith('music_')) setState(agentWorking ? 'work' : gamePlaying ? 'game_idle' : 'idle', { force: true });
      }
    },
  }));
  items.push(await CheckMenuItem.new({
    text: '游戏播报',
    checked: settings.gameBroadcast,
    action: () => {
      settings.gameBroadcast = !settings.gameBroadcast;
      saveSettings();
      if (!settings.gameBroadcast) {
        gamePlaying = false;
        gameName = '';
        pendingGameStop = false;
        clearGameAction();
        if (state.startsWith('game_')) setState(agentWorking ? 'work' : 'idle', { force: true });
      }
    },
  }));
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  for (const [min, label] of [[5, '播报：每 5 分钟'], [10, '播报：每 10 分钟'], [30, '播报：每 30 分钟'], [0, '播报：关闭']]) {
    items.push(await CheckMenuItem.new({
      text: label,
      checked: Number(settings.autoPopupMin) === min,
      action: () => {
        settings.autoPopupMin = min;
        saveSettings();
        scheduleAutoPopup();
      },
    }));
  }
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  items.push(await CheckMenuItem.new({
    text: '开机自启（打包版有效）',
    checked: false,
    action: async () => {
      try {
        await T.core.invoke('set_autostart', { enabled: true });
        showToast('已设置开机自启', { autoHideMs: 2000 });
      } catch (err) {
        console.error('set_autostart failed', err);
        showToast('设置开机自启失败', { autoHideMs: 2500, alert: true });
      }
    },
  }));
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  items.push(await MenuItem.new({
    text: '退出',
    action: () => T.core.invoke('quit_app'),
  }));
  const menu = await Menu.new({ items });
  await menu.popup();
}

async function hideCard() {
  if (!T || !T.core) return;
  try {
    await T.core.invoke('hide_native', { label: 'card' });
  } catch (err) {
    console.error('hideCard failed', err);
  }
  cardShown = false;
}

function currentHeadBox() {
  const img = frames[state] && frames[state][frame];
  if (!img) return { left: 0, right: SIZE.w, top: 0 };
  const scale = Math.min((SIZE.h - 8) / img.height, (SIZE.w - 8) / img.width);
  const w = img.width * scale;
  const x = (SIZE.w - w) / 2;
  return { left: x, right: x + w, top: SIZE.h - img.height * scale - 4, width: w };
}

async function showToast(text, opts = {}) {
  if (!T || !T.window.Window || !appWindow) return;
  // 音乐播报让位给 agent 状态：最近 3 秒内刚播过 agent 气泡则跳过
  if (opts.source === 'music' && Date.now() - lastAgentToastAt < 3000) return;
  if (opts.agent) lastAgentToastAt = Date.now();
  try {
    const toast = await T.window.Window.getByLabel('toast');
    if (!toast) return;
    const pos = await appWindow.outerPosition();
    const sf = await appWindow.scaleFactor();
    const w = TOAST.w * sf;
    // 按文字长度估算气泡高度：越长越高，字号由 toast.js 自适应缩小
    const weight = [...String(text)].reduce((acc, ch) => acc + (/[\u3400-\u9fff]/.test(ch) ? 1 : 0.55), 0);
    const toastH = weight > 34 ? 150 : weight > 22 ? 128 : weight > 10 ? 108 : TOAST.h;
    const h = toastH * sf;
    try {
      await toast.setSize(new T.dpi.PhysicalSize(Math.round(TOAST.w * sf), Math.round(h)));
    } catch (err) {
      console.error('toast setSize failed', err);
    }
    const bounds = windowBounds || (await refreshBounds());
    const margin = 8 * sf;
    const gap = 8 * sf;
    const head = currentHeadBox();
    const headLeft = pos.x + head.left * sf;
    const headRight = pos.x + head.right * sf;
    const headTop = pos.y + head.top * sf;

    // 默认贴在头部右上角上方，冒泡向左下；右侧放不下时切到左上角，冒泡向右下
    let x = headRight - w / 2 - 4 * sf;
    let dots = 'left';
    if (bounds && x + w > bounds.x + bounds.width - margin) {
      x = headLeft - w / 2 + 4 * sf;
      dots = 'right';
    }
    // 气泡底边距头顶一小段缝，尾巴朝下指向头部（气泡底部距窗口底 18px）
    let y = headTop - gap - (toastH - 18) * sf;
    if (bounds) {
      x = Math.min(Math.max(x, bounds.x + margin), bounds.x + bounds.width - w - margin);
      y = Math.min(Math.max(y, bounds.y + margin), bounds.y + bounds.height - h - margin);
    }
    await toast.setPosition(new T.dpi.PhysicalPosition(Math.round(x), Math.round(y)));
    await T.core.invoke('show_no_activate', { label: 'toast' });
    if (T.event && T.event.emitTo) {
      await T.event.emitTo('toast', 'toast-text', { text, tail: dots, alert: !!opts.alert });
    }
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
    if (opts.autoHideMs) {
      toastHideTimer = setTimeout(() => hideToast(), opts.autoHideMs);
    }
  } catch (err) {
    console.error('showToast failed', err);
  }
}

async function hideToast() {
  clearTimeout(toastHideTimer);
  toastHideTimer = null;
  if (!T || !T.core) return;
  try {
    await T.core.invoke('hide_native', { label: 'toast' });
  } catch (err) {
    console.error('hideToast failed', err);
  }
}

function updateToast(prev, next) {
  if (next === 'success') return showToast('任务成功', { agent: true });
  if (next === 'fail') return showToast('任务失败', { agent: true });
  if (prev === 'work' || prev === 'success' || prev === 'fail' || prev === 'drag') hideToast();
}

async function positionCard(card) {
  const pos = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const sf = await appWindow.scaleFactor();
  const bounds = windowBounds || (await refreshBounds());
  const w = CARD.w * sf;
  const h = CARD.h * sf;
  let x = pos.x + (size.width - w) / 2;
  let y = pos.y - h + 20 * sf;
  if (bounds) {
    const margin = 8 * sf;
    x = Math.min(Math.max(x, bounds.x + margin), bounds.x + bounds.width - w - margin);
    y = Math.min(Math.max(y, bounds.y + margin), bounds.y + bounds.height - h - margin);
  }
  await card.setPosition(new T.dpi.PhysicalPosition(Math.round(x), Math.round(y)));
}

async function showCardNative() {
  await T.core.invoke('show_no_activate', { label: 'card' });
  cardShown = true;
}

async function toggleCard() {
  if (!T || !T.window.Window) return;
  try {
    const card = await T.window.Window.getByLabel('card');
    if (!card) return;
    if (cardShown) {
      await hideCard();
      return;
    }
    // 卡片刚关闭时，这次点击不再把它重新打开
    const closedAt = Number(localStorage.getItem('cardClosedAt') || 0);
    if (Date.now() - closedAt < 700) return;
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
    await positionCard(card);
    await showCardNative();
    // 手动打开同样只停留 10 秒
    autoHideTimer = setTimeout(async () => {
      autoHideTimer = null;
      if (cardShown) await hideCard();
    }, AUTO_POPUP_STAY);
  } catch (err) {
    console.error('toggleCard failed', err);
  }
}

const AUTO_POPUP_STAY = 10 * 1000;
let autoHideTimer = null;
let toastHideTimer = null;
let autoPopupTimer = null;
let panelScaleTimer = null;

function scheduleAutoPopup() {
  clearTimeout(autoPopupTimer);
  autoPopupTimer = null;
  const min = Number(settings.autoPopupMin);
  if (!min || min <= 0) return;
  autoPopupTimer = setTimeout(async () => {
    await showAutoCard();
    scheduleAutoPopup();
  }, min * 60 * 1000);
}

async function showAutoCard() {
  if (!T || !T.window.Window || dragging) return;
  try {
    const card = await T.window.Window.getByLabel('card');
    if (!card || cardShown) return;
    await positionCard(card);
    await showCardNative();
    if (T.event && T.event.emitTo) {
      await T.event.emitTo('card', 'card-refresh', {});
    }
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(async () => {
      autoHideTimer = null;
      if (cardShown) await hideCard();
    }, AUTO_POPUP_STAY);
  } catch (err) {
    console.error('showAutoCard failed', err);
  }
}

function bindPointer() {
  let drag = null;
  canvas.addEventListener('pointerdown', async (e) => {
    if (!appWindow || e.button === 2) return;
    try {
      scaleFactor = await appWindow.scaleFactor();
      const pos = await appWindow.outerPosition();
      const bounds = await refreshBounds();
      drag = { sx: e.screenX, sy: e.screenY, ox: pos.x, oy: pos.y, moved: false, bounds };
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      console.error('pointerdown failed', err);
    }
  });

  canvas.addEventListener('pointermove', async (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) * scaleFactor > 4) {
      drag.moved = true;
      dragging = true;
      document.body.classList.add('dragging');
      hideCard();
      hideToast();
      setState('drag', { force: true, restart: true });
    }
    if (!drag.moved) return;
    const target = clampToBounds(
      drag.ox + dx * scaleFactor,
      drag.oy + dy * scaleFactor,
      drag.bounds,
      SIZE.w * scaleFactor,
      SIZE.h * scaleFactor,
    );
    await moveTo(target.x, target.y);
  });

  let clickTimer = null;
  let lastClickAt = 0;
  const playAction = (key) => {
    if (frames[key]) setState(key, { force: true, restart: true });
  };

  const finish = async (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
      if (!e) return;
      const now = Date.now();
      if (now - lastClickAt < 400) {
        clearTimeout(clickTimer);
        clickTimer = null;
        lastClickAt = 0;
        playAction('action6'); // 双击：惊讶
        return;
      }
      lastClickAt = now;
      const rect = canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      clickTimer = setTimeout(async () => {
        clickTimer = null;
        const inGame = gamePlaying && state.startsWith('game_');
        if (y < SIZE.h * 0.42) playAction(inGame ? 'game_pat' : 'action8'); // 点头：摸头/打断游戏
        else if (inGame) showToast(`正在玩：${gameName || '游戏'}`, { autoHideMs: 4000 });
        else await toggleCard();
      }, 260);
      return;
    }
    dragging = false;
    document.body.classList.remove('dragging');
    if (pendingGameStop) {
      pendingGameStop = false;
      gamePlaying = false;
      gameName = '';
      clearGameAction();
    }
    // 放下后：agent 工作中回到工作，否则仍在玩游戏就回游戏循环
    const target = musicPlaying ? 'music_default' : agentWorking ? 'work' : gamePlaying ? 'game_idle' : 'idle';
    setState(target, { force: true, restart: true });
    if (agentWorking) showToast('工作中…');
    savePosition();
  };
  canvas.addEventListener('pointerup', (e) => finish(e));
  canvas.addEventListener('pointercancel', () => finish(null));

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu();
  });
}

function prettyTool(name) {
  if (!name) return '执行中';
  const last = String(name).split('__').pop();
  return last.length > 14 ? `${last.slice(0, 14)}…` : last;
}

const sessionErrors = new Map();

function handleAgentEvent(p) {
  if (!p || !p.event) return;
  lastAgentEventAt = Date.now();
  const sid = p.session_id || 'default';
  // 听歌时音乐动画优先，但 agent 状态气泡照常提示
  const setAgentState = (next, opts) => { if (!musicPlaying) setState(next, opts); };
  switch (p.event) {
    case 'SessionStart':
      agentWorking = false;
      workStartedAt = 0;
      breakReminded = false;
      setAgentState('idle', { force: true });
      break;
    case 'UserPromptSubmit':
      sessionErrors.set(sid, false);
      agentWorking = true;
      if (!workStartedAt) workStartedAt = Date.now();
      setAgentState('work', { force: true, restart: true });
      showToast('工作中…', { agent: true });
      break;
    case 'PreToolUse':
      agentWorking = true;
      if (!workStartedAt) workStartedAt = Date.now();
      setAgentState('work', { force: true });
      showToast(`${prettyTool(p.tool)}…`, { agent: true });
      break;
    case 'PostToolUse':
      if (p.tool_error) sessionErrors.set(sid, true);
      agentWorking = true;
      setAgentState('work', { force: true });
      showToast(`${prettyTool(p.tool)}…`, { agent: true });
      break;
    case 'Notification': {
      const msg = String(p.message || '');
      const permission = /permission|approve|confirm|授权|确认/i.test(msg);
      const waitingInput = /waiting for your input|waiting for input|idle/i.test(msg);
      if (permission) {
        agentWorking = true;
        if (!workStartedAt) workStartedAt = Date.now();
        setAgentState('work', { force: true });
        showToast('等你确认', { alert: true, agent: true });
      } else if (waitingInput) {
        // 空闲等待用户输入：agent 实际上已经停止工作
        agentWorking = false;
        workStartedAt = 0;
        breakReminded = false;
        setAgentState('idle', { force: true });
        hideToast();
      }
      break;
    }
    case 'Stop':
      agentWorking = false;
      workStartedAt = 0;
      breakReminded = false;
      if (musicPlaying) {
        showToast(sessionErrors.get(sid) ? '任务失败' : '任务成功', { agent: true });
      }
      setAgentState(sessionErrors.get(sid) ? 'fail' : 'success', { force: true, restart: true });
      break;
    case 'SessionEnd':
      agentWorking = false;
      workStartedAt = 0;
      breakReminded = false;
      setAgentState('idle', { force: true });
      // 等 idle 的收起逻辑先跑完，再显示“结束”气泡
      setTimeout(() => showToast('任务结束', { autoHideMs: 2500, agent: true }), 300);
      break;
  }
}

async function listenAgentEvents() {
  if (!T || !T.event) return;
  await T.event.listen('agent-event', (ev) => handleAgentEvent(ev.payload));
  await T.event.listen('tray-passthrough-toggle', async () => {
    settings.passthrough = !settings.passthrough;
    saveSettings();
    await applyPassthrough();
    showToast(settings.passthrough ? '点击穿透：开' : '点击穿透：关', { autoHideMs: 1500 });
  });
  await T.event.listen('card-closed', () => {
    cardShown = false;
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  });
  await T.event.listen('game-state', (ev) => handleGameState(ev.payload));
  await T.event.listen('music-state', (ev) => handleMusicState(ev.payload));
  await T.event.listen('panel-scale', (ev) => {
    const v = Number(ev.payload && ev.payload.value);
    if (!Number.isFinite(v)) return;
    settings.scale = normalizeScale(v);
    clearTimeout(panelScaleTimer);
    panelScaleTimer = setTimeout(() => {
      applyScale();
      saveSettings();
    }, 60);
  });
  await T.event.listen('global-outside-click', async () => {
    if (!cardShown) return;
    localStorage.setItem('cardClosedAt', String(Date.now()));
    await hideCard();
  });
}

async function initPosition() {
  if (!appWindow) return;
  try {
    scaleFactor = await appWindow.scaleFactor();
    const bounds = await refreshBounds();
    const saved = loadSavedPosition();
    if (saved) {
      const target = clampToBounds(saved.x, saved.y, bounds, SIZE.w * scaleFactor, SIZE.h * scaleFactor);
      await moveTo(target.x, target.y);
      return;
    }
    await T.core.invoke('place_pet');
    const pos = await appWindow.outerPosition();
    posX = pos.x;
    posY = pos.y;
  } catch (err) {
    console.error('initPosition failed', err);
  }
}

function checkAgentStale() {
  if (agentWorking && lastAgentEventAt && Date.now() - lastAgentEventAt > 10 * 60 * 1000) {
    agentWorking = false;
    workStartedAt = 0;
    breakReminded = false;
    setState('idle', { force: true });
    hideToast();
  }
}

async function start() {
  applyBodySize();
  setupCanvas();
  try {
    await loadSprites();
  } catch (err) {
    console.error(err);
    return;
  }
  await initPosition();
  await applyScale();
  await applyTopmost();
  await applyPassthrough();
  bindPointer();
  await listenAgentEvents();
  window.addEventListener('beforeunload', savePosition);
  saveSettings();
  requestAnimationFrame(tick);
  scheduleNextIdleEvent();
  scheduleAutoPopup();
  setInterval(() => {
    // 进程被强杀等情况下收不到 Stop/SessionEnd，长时间无事件则回到空闲
    checkAgentStale();
    if (!agentWorking || breakReminded || !workStartedAt) return;
    if (Date.now() - workStartedAt >= 45 * 60 * 1000) {
      breakReminded = true;
      showToast('已经连续工作 45 分钟，起来活动一下', { alert: true, autoHideMs: 10000, agent: true });
    }
  }, 60000);

  const params = new URLSearchParams(location.search);
  const forced = params.get('state');
  if (forced) setState(forced, { force: true, restart: true });

  window.__pet = {
    settings,
    setState: (s) => setState(s, { force: true, restart: true }),
    startWalk,
    playRandomAction,
    applyScale,
    applyPassthrough,
    scheduleAutoPopup,
    showContextMenu,
    showAutoCard,
    showSizePanel,
    handleGameState,
    handleMusicState,
    getMusic: () => ({ playing: musicPlaying, title: musicTitle, artist: musicArtist }),
    getGame: () => ({ playing: gamePlaying, name: gameName }),
    showToast,
    hideToast,
    getToastPending: () => !!toastHideTimer,
    getAutoHidePending: () => !!autoHideTimer,
    getAutoPopupMin: () => settings.autoPopupMin,
    getCardShown: () => cardShown,
    getState: () => state,
    getFrame: () => frame,
    getFacing: () => facing,
    getWorking: () => agentWorking,
    getLastEventAge: () => (lastAgentEventAt ? Date.now() - lastAgentEventAt : -1),
    checkAgentStale,
    setLastEventAge: (ms) => { lastAgentEventAt = Date.now() - ms; },
    getBounds: () => windowBounds,
    setWorking: (v) => { agentWorking = !!v; },
    setFacing: (v) => { facing = v > 0 ? 1 : -1; },
    getPos: () => ({ x: posX, y: posY, w: SIZE.w, h: SIZE.h }),
  };
}

start();
