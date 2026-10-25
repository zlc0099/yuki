// 切分游戏动作精灵表（使用无青色噪点的不透明版，棋盘格背景泛洪去底）
// 分组：1 开始/专注 | 2 按键操作 | 3 胜利 | 4 失败 | 5 被打扰
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { estimateBg } = require('./defringe');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'assets', 'sprites');
const SRC = path.join(ROOT, 'ziyuan', '紫发少女打游戏表情动作精灵表眼睛修复版.png');

const png = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, height: H, data } = png;

const lightNeutral = (x, y) => {
  const i = (y * W + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 30;
};

// 从四边泛洪，只去掉与边缘连通的浅色棋盘格
const bgMask = new Uint8Array(W * H);
const stack = new Int32Array(W * H);
let sp = 0;
for (let x = 0; x < W; x++) {
  for (const y of [0, H - 1]) if (lightNeutral(x, y) && !bgMask[y * W + x]) { bgMask[y * W + x] = 1; stack[sp++] = y * W + x; }
}
for (let y = 0; y < H; y++) {
  for (const x of [0, W - 1]) if (lightNeutral(x, y) && !bgMask[y * W + x]) { bgMask[y * W + x] = 1; stack[sp++] = y * W + x; }
}
while (sp) {
  const p = stack[--sp];
  const x = p % W, y = (p - x) / W;
  const visit = (nx, ny) => {
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
    const q = ny * W + nx;
    if (bgMask[q] || !lightNeutral(nx, ny)) return;
    bgMask[q] = 1;
    stack[sp++] = q;
  };
  visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
}

// 标题药丸（第 2 组标题与首帧粘连），用固定矩形遮掉
const titleRects = [
  { x0: 10, x1: 300, y0: 10, y1: 54 },
  { x0: 10, x1: 330, y0: 278, y1: 320 },
  { x0: 10, x1: 280, y0: 536, y1: 578 },
  { x0: 760, x1: 960, y0: 536, y1: 578 },
  { x0: 10, x1: 340, y0: 778, y1: 822 },
];
const inTitle = (x, y) => titleRects.some(t => x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1);
const isBg = (x, y) => bgMask[y * W + x] === 1 || inTitle(x, y);

// 背景均色（仅 bgMask 区域），用于边缘反混合
let br = 0, bgg = 0, bb = 0, bn = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!bgMask[y * W + x]) continue;
  const i = (y * W + x) * 4;
  br += data[i]; bgg += data[i + 1]; bb += data[i + 2]; bn++;
}
const bg = bn ? [br / bn, bgg / bn, bb / bn] : [255, 255, 255];
void estimateBg;

function labelComponents() {
  const label = new Int32Array(W * H);
  const comps = [];
  let next = 0;
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    if (label[sy * W + sx] || isBg(sx, sy)) continue;
    next++;
    let sp2 = 0, minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
    stack[sp2++] = sy * W + sx; label[sy * W + sx] = next;
    while (sp2) {
      const p = stack[--sp2];
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && !label[p - 1] && !isBg(x - 1, y)) { label[p - 1] = next; stack[sp2++] = p - 1; }
      if (x < W - 1 && !label[p + 1] && !isBg(x + 1, y)) { label[p + 1] = next; stack[sp2++] = p + 1; }
      if (y > 0 && !label[p - W] && !isBg(x, y - 1)) { label[p - W] = next; stack[sp2++] = p - W; }
      if (y < H - 1 && !label[p + W] && !isBg(x, y + 1)) { label[p + W] = next; stack[sp2++] = p + W; }
    }
    comps.push({ x0: minX, x1: maxX, y0: minY, y1: maxY, area });
  }
  return comps;
}

const sprites = labelComponents().filter(c => {
  const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
  return h >= 80 && w >= 40 && c.area >= 1000;
});

const rowRanges = [[50, 290], [300, 540], [580, 770], [810, 1010]];
const bands = rowRanges.map(([y0, y1]) => ({
  maxY: y1,
  items: sprites.filter(s => {
    const yc = (s.y0 + s.y1) / 2;
    return yc >= y0 && yc <= y1;
  }).sort((a, b) => a.x0 - b.x0),
}));

function bboxIn(xa, xb, ya, yb) {
  let minX = xb + 1, maxX = xa - 1, minY = yb + 1, maxY = ya - 1, area = 0;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    if (isBg(x, y)) continue;
    area++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return area > 0 ? { x0: minX, x1: maxX, y0: minY, y1: maxY, area } : null;
}

// 过宽连通域（两帧贴在一起）按列谷拆分
for (const band of bands) {
  const widths = band.items.map(c => c.x1 - c.x0 + 1).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] || 1;
  const out = [];
  for (const c of band.items) {
    const w = c.x1 - c.x0 + 1;
    if (w <= median * 1.6) { out.push(c); continue; }
    const counts = new Array(w).fill(0);
    for (let x = c.x0; x <= c.x1; x++) for (let y = c.y0; y <= c.y1; y++) if (!isBg(x, y)) counts[x - c.x0]++;
    let split = Math.floor(w * 0.5), bestVal = Infinity;
    for (let i = Math.floor(w * 0.33); i <= Math.ceil(w * 0.67); i++) {
      if (counts[i] < bestVal) { bestVal = counts[i]; split = i; }
    }
    const sx = c.x0 + split;
    const a = bboxIn(c.x0, sx - 1, c.y0, c.y1);
    const b = bboxIn(sx + 1, c.x1, c.y0, c.y1);
    if (a && b) out.push(a, b); else out.push(c);
  }
  band.items = out;
}

function saveGroup(key, items) {
  const dir = path.join(OUT, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sorted = items.slice().sort((a, b) => a.x0 - b.x0);
  return sorted.map((c, i) => {
    const pad = 2;
    const x0 = Math.max(0, c.x0 - pad), y0 = Math.max(0, c.y0 - pad);
    const x1 = Math.min(W - 1, c.x1 + pad), y1 = Math.min(H - 1, c.y1 + pad);
    const out = new PNG({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
    PNG.bitblt(png, out, x0, y0, out.width, out.height, 0, 0);
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const i4 = (y * out.width + x) * 4;
      if (bgMask[(y0 + y) * W + (x0 + x)]) {
        out.data[i4 + 3] = 0;
        continue;
      }
      const a = out.data[i4 + 3] / 255;
      if (a > 0 && a < 1) {
        for (let ch = 0; ch < 3; ch++) {
          const v = (out.data[i4 + ch] - (1 - a) * bg[ch]) / a;
          out.data[i4 + ch] = Math.max(0, Math.min(255, Math.round(v)));
        }
      }
    }
    // 收紧轮廓 2px：去掉素材自带的白色描边/混色外圈（深色背景下会看成都噪点）
    {
      const w2 = out.width, h2 = out.height;
      for (let pass = 0; pass < 2; pass++) {
        const snap = new Uint8Array(w2 * h2);
        for (let p = 0; p < w2 * h2; p++) snap[p] = out.data[p * 4 + 3];
        const remove = [];
        for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
          const p = y * w2 + x;
          if (!snap[p]) continue;
          if (
            (x > 0 && !snap[p - 1]) ||
            (x < w2 - 1 && !snap[p + 1]) ||
            (y > 0 && !snap[p - w2]) ||
            (y < h2 - 1 && !snap[p + w2])
          ) remove.push(p);
        }
        for (const p of remove) out.data[p * 4 + 3] = 0;
      }
    }
    let bx0 = out.width, by0 = out.height, bx1 = -1, by1 = -1;
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      if (out.data[(y * out.width + x) * 4 + 3] > 0) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    let finalPng = out;
    if (bx1 >= 0) {
      finalPng = new PNG({ width: bx1 - bx0 + 1, height: by1 - by0 + 1 });
      PNG.bitblt(out, finalPng, bx0, by0, finalPng.width, finalPng.height, 0, 0);
    }
    const name = `${key}/${String(i + 1).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(OUT, name), PNG.sync.write(finalPng));
    return { file: name, w: finalPng.width, h: finalPng.height };
  });
}

console.log(`bands=${bands.length} sizes=${bands.map(b => b.items.length).join('/')}`);

const groups = {};
groups.game_open = saveGroup('game_open', bands[0].items);
groups.game_idle = saveGroup('game_idle', bands[1].items);
const left = bands[2].items.filter(s => (s.x0 + s.x1) / 2 < 760);
const right = bands[2].items.filter(s => (s.x0 + s.x1) / 2 >= 760);
groups.game_win = saveGroup('game_win', left);
groups.game_lose = saveGroup('game_lose', right);
groups.game_pat = saveGroup('game_pat', bands[3].items);
for (const [k, v] of Object.entries(groups)) console.log(`${k}: ${v.length}`);

const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
Object.assign(manifest, groups);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('manifest updated');
