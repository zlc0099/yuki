const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => null;
const appWindow = T && T.window ? T.window.getCurrentWindow() : null;

// 账本不抢焦点，避免打断终端输入
if (appWindow && appWindow.setFocusable) {
  appWindow.setFocusable(false).catch((err) => console.error('setFocusable failed', err));
}

const quotaEl = document.getElementById('quota');
const quotaNoteEl = document.getElementById('quotaNote');
const spendEl = document.getElementById('spend');
const monthEl = document.getElementById('month');
const monthTokensEl = document.getElementById('monthTokens');
const bubbleEl = document.getElementById('bubble');

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function money(currency, value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  return `${symbol}${num.toFixed(2)}`;
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAYS_KEY = 'yukipet-balance-days';

function updateBalanceDays(bal) {
  let map = {};
  try {
    map = JSON.parse(localStorage.getItem(DAYS_KEY) || '{}') || {};
  } catch {
    map = {};
  }
  const key = todayKey();
  const rec = map[key] || { start: bal };
  rec.last = bal;
  map[key] = rec;
  // 兼容旧版单日记录，避免今天已发生的消费被漏掉
  try {
    const legacy = JSON.parse(localStorage.getItem('yukipet-balance-day') || 'null');
    if (legacy && typeof legacy.date === 'string' && typeof legacy.start === 'number') {
      const [y, m, d] = legacy.date.split('-').map(Number);
      const legacyKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (y && m && d && legacyKey === key) {
        // 旧记录是今天更早的余额快照，用作当日起点
        rec.start = legacy.start;
      }
    }
  } catch {
    // ignore
  }
  const cutoff = Date.now() - 31 * 86400 * 1000;
  for (const k of Object.keys(map)) {
    const t = new Date(`${k}T00:00:00`).getTime();
    if (!Number.isFinite(t) || t < cutoff) delete map[k];
  }
  localStorage.setItem(DAYS_KEY, JSON.stringify(map));
  return map;
}

function sumMonthSpend(map) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = new Date(start.getTime() - 29 * 86400 * 1000);
  let total = 0;
  for (const [k, rec] of Object.entries(map)) {
    const t = new Date(`${k}T00:00:00`).getTime();
    if (!Number.isFinite(t) || t < from.getTime()) continue;
    total += Math.max(0, Number(rec.start) - Number(rec.last));
  }
  return total;
}

async function refreshAll() {
  const [q, usage] = await Promise.all([
    invoke('quota_snapshot').catch(() => null),
    invoke('usage_snapshot').catch(() => []),
  ]);

  let currency = null;
  let bal = null;
  if (!q) {
    quotaEl.textContent = '—';
    quotaNoteEl.textContent = '余额查询不可用';
  } else {
    currency = q.currency || null;
    if (q.balance) {
      bal = Number(q.balance);
      quotaEl.textContent = money(q.currency, q.balance);
      quotaNoteEl.textContent = q.ok ? 'DeepSeek 账户余额' : `${q.message || '账户不可用'}（余额可能仍可查）`;
    } else {
      quotaEl.textContent = '—';
      quotaNoteEl.textContent = q.message || '暂不支持余额查询';
    }
  }

  let todaySpend = null;
  let monthSpend = null;
  if (bal !== null && Number.isFinite(bal)) {
    const map = updateBalanceDays(bal);
    todaySpend = Math.max(0, Number(map[todayKey()].start) - bal);
    monthSpend = sumMonthSpend(map);
  }
  spendEl.textContent = todaySpend === null ? '' : `今日消费 ${money(currency, todaySpend.toFixed(2))}`;

  const monthTokens = (usage || []).reduce((acc, s) => acc + (s.month || 0), 0);
  monthEl.textContent = monthSpend === null ? '' : `近 30 天消费 ${money(currency, monthSpend.toFixed(2))}`;
  monthTokensEl.textContent = monthTokens > 0 ? `近 30 天 ${fmt(monthTokens)} tokens` : '';
}

function noteClosed() {
  localStorage.setItem('cardClosedAt', String(Date.now()));
}

function hideSelf() {
  noteClosed();
  if (T && T.core) {
    T.core.invoke('hide_native', { label: 'card' }).catch(() => {});
    if (T.event && T.event.emitTo) {
      T.event.emitTo('pet', 'card-closed', {}).catch(() => {});
    }
  }
}

document.getElementById('close').addEventListener('click', hideSelf);
window.addEventListener('focus', refreshAll);

if (appWindow && appWindow.onFocusChanged) {
  let focusedAt = 0;
  appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      focusedAt = Date.now();
      return;
    }
    // 忽略显示瞬间的假失焦，避免卡片刚打开就被关掉
    if (!focusedAt || Date.now() - focusedAt < 400) return;
    hideSelf();
  });
}

// 点击椭圆外（含气泡透明角）→ 关闭
document.body.addEventListener('click', (e) => {
  const r = bubbleEl.getBoundingClientRect();
  const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  if (nx * nx + ny * ny > 1) hideSelf();
});

// 在卡片上拖动 → 关闭
let pressStart = null;
document.body.addEventListener('pointerdown', (e) => {
  pressStart = { x: e.screenX, y: e.screenY };
});
document.body.addEventListener('pointermove', (e) => {
  if (!pressStart) return;
  if (Math.hypot(e.screenX - pressStart.x, e.screenY - pressStart.y) > 5) {
    pressStart = null;
    hideSelf();
  }
});
window.addEventListener('pointerup', () => { pressStart = null; });

if (T && T.event) {
  T.event.listen('card-refresh', refreshAll);
}

refreshAll();
