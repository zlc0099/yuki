// 切分 ziyuan 新素材：
//   八组动作精灵表 -> action1..8（每组 7~8 帧，完整小动作序列）
//   动作与走路动画图集 -> walk/01..16（右侧 4x4 走路循环）
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { estimateBg, applyDefringe } = require('./defringe');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'assets', 'sprites');
const BG_THRESHOLD = 128;

function load(name) {
  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'ziyuan', name)));
  return { png, bg: estimateBg(png) };
}

function components(png) {
  const { width: W, height: H, data } = png;
  const isBg = (x, y) => data[(y * W + x) * 4 + 3] < BG_THRESHOLD;
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
  return comps;
}

function crop(png, c, bg, pad = 2) {
  const x0 = Math.max(0, c.x0 - pad), y0 = Math.max(0, c.y0 - pad);
  const x1 = Math.min(png.width - 1, c.x1 + pad), y1 = Math.min(png.height - 1, c.y1 + pad);
  const out = new PNG({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
  PNG.bitblt(png, out, x0, y0, out.width, out.height, 0, 0);
  applyDefringe(out, bg);
  return out;
}

function save(out, state, index) {
  const dir = path.join(OUT, state);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${state}/${String(index).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
  return { file: name, w: out.width, h: out.height };
}

// eslint-disable-next-line no-console
const log = (...a) => console.log(...a);

// ---------- 1) 八组小动作 ----------
const act = load('紫发少女八组动作精灵表.png');
const actSprites = components(act.png)
  .filter(c => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    return h >= 55 && w >= 35 && c.area >= 700;
  })
  .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

const bands = [];
for (const s of actSprites) {
  const band = bands.find(b => s.y0 - b.maxY <= 40);
  if (band) { band.items.push(s); band.maxY = Math.max(band.maxY, s.y1); }
  else bands.push({ maxY: s.y1, items: [s] });
}
log(`actions bands=${bands.length} sprites=${actSprites.length}`);

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const SPLIT_X = 810;
let actionIndex = 0;
for (const band of bands) {
  const items = band.items.slice().sort((a, b) => a.x0 - b.x0);
  const halves = [items.filter(c => (c.x0 + c.x1) / 2 < SPLIT_X), items.filter(c => (c.x0 + c.x1) / 2 >= SPLIT_X)];
  for (const half of halves) {
    actionIndex++;
    const key = `action${actionIndex}`;
    manifest[key] = half.map((c, i) => save(crop(act.png, c, act.bg), key, i + 1));
    log(`${key}: ${half.length} frames`);
  }
}

// ---------- 1b) 图集左栏 5 组小动作 ----------
const act2 = load('紫发少女动作与走路动画图集.png');
const leftSprites = components(act2.png)
  .filter(c => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    return c.x1 <= 800 && h >= 100 && w >= 60 && c.area >= 2000;
  })
  .sort((a, b) => a.y0 - b.y0);
const rows2 = [];
for (const s of leftSprites) {
  const row = rows2.find(r => Math.abs(r.y0 - s.y0) <= 40);
  if (row) row.items.push(s);
  else rows2.push({ y0: s.y0, items: [s] });
}
rows2.sort((a, b) => a.y0 - b.y0);
log(`sheet2 actions rows=${rows2.length} sprites=${leftSprites.length}`);
for (const row of rows2) {
  actionIndex++;
  const key = `action${actionIndex}`;
  const items = row.items.slice().sort((a, b) => a.x0 - b.x0);
  manifest[key] = items.map((c, i) => save(crop(act2.png, c, act2.bg), key, i + 1));
  log(`${key}: ${items.length} frames (sheet2)`);
}

// ---------- 2) 16 帧走路循环 ----------
const walk = load('长门有希风格Q版行走动画帧表.png');
const walkSprites = components(walk.png)
  .filter(c => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    return h >= 150 && w >= 100 && c.area >= 4000;
  })
  .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

const rows = [];
for (const s of walkSprites) {
  const row = rows.find(r => Math.abs(r.y0 - s.y0) <= 40);
  if (row) row.items.push(s);
  else rows.push({ y0: s.y0, items: [s] });
}
rows.sort((a, b) => a.y0 - b.y0);
const walkFrames = rows.flatMap(r => r.items.slice().sort((a, b) => a.x0 - b.x0));
log(`walk rows=${rows.length} frames=${walkFrames.length}`);

fs.rmSync(path.join(OUT, 'walk'), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'random'), { recursive: true, force: true });
delete manifest.random;
manifest.walk = walkFrames.map((c, i) => save(crop(walk.png, c, walk.bg), 'walk', i + 1));

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
log('manifest updated:', Object.keys(manifest).join(', '));
