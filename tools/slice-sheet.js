// 切分原始精灵表：idle / work / success / fail / drag（走路与随机动作见 slice-extra.js）
// 版式：上三带各含左右两组；底部第 7 组不再使用
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { estimateBg, applyDefringe } = require('./defringe');

const SRC = path.join(__dirname, '..', '紫发校园女孩表情动作精灵表.png');
const OUT = path.join(__dirname, '..', 'src', 'assets', 'sprites');
const EXPECTED = { idle: 6, work: 6, success: 6, fail: 6, drag: 6 };

const png = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, height: H, data } = png;
const bg = estimateBg(png);

const isBg = (x, y) => data[(y * W + x) * 4 + 3] < 128;

// 连通域
const label = new Int32Array(W * H);
const stack = new Int32Array(W * H);
const comps = [];
let next = 0;
for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
  if (label[sy * W + sx] || isBg(sx, sy)) continue;
  next++;
  let sp = 0, minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
  stack[sp++] = sy * W + sx; label[sy * W + sx] = next;
  while (sp) {
    const p = stack[--sp];
    const x = p % W, y = (p - x) / W;
    area++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x > 0 && !label[p - 1] && !isBg(x - 1, y)) { label[p - 1] = next; stack[sp++] = p - 1; }
    if (x < W - 1 && !label[p + 1] && !isBg(x + 1, y)) { label[p + 1] = next; stack[sp++] = p + 1; }
    if (y > 0 && !label[p - W] && !isBg(x, y - 1)) { label[p - W] = next; stack[sp++] = p - W; }
    if (y < H - 1 && !label[p + W] && !isBg(x, y + 1)) { label[p + W] = next; stack[sp++] = p + W; }
  }
  comps.push({ x0: minX, x1: maxX, y0: minY, y1: maxY, area });
}

const sprites = comps
  .filter(c => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    return h >= 60 && w >= 45 && c.area >= 1000;
  })
  .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

// 横带
const bands = [];
for (const s of sprites) {
  const band = bands.find(b => s.y0 - b.maxY <= 60);
  if (band) { band.items.push(s); band.maxY = Math.max(band.maxY, s.y1); }
  else bands.push({ maxY: s.y1, items: [s] });
}

const byX = arr => arr.slice().sort((a, b) => a.x0 - b.x0);
const groups = [];
bands.forEach((band, bi) => {
  const items = byX(band.items);
  if (bi === 0) {
    groups.push({ state: 'idle', items: items.filter(c => (c.x0 + c.x1) / 2 < 700) });
    groups.push({ state: 'work', items: items.filter(c => (c.x0 + c.x1) / 2 >= 700) });
  } else if (bi === 1) {
    groups.push({ state: 'success', items: items.filter(c => (c.x0 + c.x1) / 2 < 700) });
    groups.push({ state: 'fail', items: items.filter(c => (c.x0 + c.x1) / 2 >= 700) });
  } else if (bi === 2) {
    groups.push({ state: 'drag', items: items.slice(8) });
  }
});

const PAD = 2;
const manifest = {};
let allOk = true;
for (const g of groups) {
  const ok = EXPECTED[g.state] === g.items.length;
  if (!ok) allOk = false;
  console.log(`${g.state}: ${g.items.length} frames ${ok ? 'OK' : `MISMATCH expect ${EXPECTED[g.state]}`}`);
  const dir = path.join(OUT, g.state);
  fs.mkdirSync(dir, { recursive: true });
  manifest[g.state] = g.items.map((c, fi) => {
    const x0 = Math.max(0, c.x0 - PAD), y0 = Math.max(0, c.y0 - PAD);
    const x1 = Math.min(W - 1, c.x1 + PAD), y1 = Math.min(H - 1, c.y1 + PAD);
    const out = new PNG({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
    PNG.bitblt(png, out, x0, y0, out.width, out.height, 0, 0);
    applyDefringe(out, bg);
    const name = `${g.state}/${String(fi + 1).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
    return { file: name, w: out.width, h: out.height };
  });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(allOk ? 'base sprites OK' : 'base sprite count mismatch');
