// 切分《戴耳机女孩动作参考表.png》（棋盘格底，8 帧/组）
// 只保留第 1 组「戴上耳机」：music_on 播放入场 8 帧，music_default 固定第 8 帧
// 横向用数字标签中心定帧，纵向取「标题下沿 → 标签上方」，不加额外遮罩
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'assets', 'sprites');
const SRC = path.join(ROOT, 'ziyuan', '戴耳机女孩动作参考表.png');

const png = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, height: H, data } = png;

const lightNeutral = (x, y) => {
  const i = (y * W + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 30;
};
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
    bgMask[q] = 1; stack[sp++] = q;
  };
  visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
}
const opaque = (x, y) => bgMask[y * W + x] === 0;

// 标签（数字）连通域
const label = new Int32Array(W * H);
const comps = [];
let next = 0;
for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
  if (label[sy * W + sx] || !opaque(sx, sy)) continue;
  next++;
  let s2 = 0, minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
  stack[s2++] = sy * W + sx; label[sy * W + sx] = next;
  while (s2) {
    const p = stack[--s2];
    const x = p % W, y = (p - x) / W;
    area++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x > 0 && !label[p - 1] && opaque(x - 1, y)) { label[p - 1] = next; stack[s2++] = p - 1; }
    if (x < W - 1 && !label[p + 1] && opaque(x + 1, y)) { label[p + 1] = next; stack[s2++] = p + 1; }
    if (y > 0 && !label[p - W] && opaque(x, y - 1)) { label[p - W] = next; stack[s2++] = p - W; }
    if (y < H - 1 && !label[p + W] && opaque(x, y + 1)) { label[p + W] = next; stack[s2++] = p + W; }
  }
  comps.push({ minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1, area });
}
const digits = comps.filter(c => c.w >= 6 && c.w <= 30 && c.h >= 6 && c.h <= 30 && c.area >= 25);

const rows = [
  { top: 80, bottom: 235, groups: ['music_on', null] },
];

function saveFrame(key, cx0, cx1, y0, y1, index) {
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) for (let x = cx0; x < cx1; x++) {
    if (!opaque(x, y)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  const pad = 2;
  const x0 = Math.max(0, minX - pad), yy0 = Math.max(0, minY - pad);
  const x1 = Math.min(W - 1, maxX + pad), yy1 = Math.min(H - 1, maxY + pad);
  const out = new PNG({ width: x1 - x0 + 1, height: yy1 - yy0 + 1 });
  PNG.bitblt(png, out, x0, yy0, out.width, out.height, 0, 0);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    if (!opaque(x0 + x, yy0 + y)) out.data[(y * out.width + x) * 4 + 3] = 0;
  }
  // 只保留画面中央最大的连通块，去掉左右相邻帧的碎片
  {
    const w2 = out.width, h2 = out.height;
    const seen = new Uint8Array(w2 * h2);
    const st = new Int32Array(w2 * h2);
    let best = null;
    for (let sy2 = 0; sy2 < h2; sy2++) for (let sx2 = 0; sx2 < w2; sx2++) {
      const start = sy2 * w2 + sx2;
      if (seen[start] || out.data[start * 4 + 3] === 0) continue;
      let sp2 = 0, area = 0;
      const pixels = [];
      st[sp2++] = start; seen[start] = 1;
      while (sp2) {
        const p = st[--sp2];
        pixels.push(p);
        area++;
        const px = p % w2, py = (p - px) / w2;
        for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
          const q = ny * w2 + nx;
          if (seen[q] || out.data[q * 4 + 3] === 0) continue;
          seen[q] = 1; st[sp2++] = q;
        }
      }
      if (!best || area > best.area) best = { area, pixels };
    }
    if (best) {
      const keep = new Uint8Array(w2 * h2);
      for (const p of best.pixels) keep[p] = 1;
      for (let p = 0; p < w2 * h2; p++) {
        if (out.data[p * 4 + 3] !== 0 && !keep[p]) out.data[p * 4 + 3] = 0;
      }
    }
  }
  const snap = new Uint8Array(out.width * out.height);
  for (let p = 0; p < snap.length; p++) snap[p] = out.data[p * 4 + 3];
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const p = y * out.width + x;
    if (!snap[p]) continue;
    if ((x > 0 && !snap[p - 1]) || (x < out.width - 1 && !snap[p + 1]) || (y > 0 && !snap[p - out.width]) || (y < out.height - 1 && !snap[p + out.width])) {
      out.data[p * 4 + 3] = 0;
    }
  }
  const dir = path.join(OUT, key);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${key}/${String(index + 1).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
  return { file: name, w: out.width, h: out.height };
}

const groups = {};
for (const row of rows) {
  for (let gi = 0; gi < 2; gi++) {
    const key = row.groups[gi];
    if (!key) continue;
    const rx0 = gi === 0 ? 0 : 760;
    const rx1 = gi === 0 ? 760 : W;
    // 组内容 bbox
    let minX = 1e9, maxX = -1;
    for (let y = row.top; y < row.bottom; y++) for (let x = rx0; x < rx1; x++) {
      if (!opaque(x, y)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    if (maxX < 0) { console.log(key, 'EMPTY'); continue; }
    const cellW = (maxX - minX + 1) / 8;
    fs.rmSync(path.join(OUT, key), { recursive: true, force: true });
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const cx0 = Math.max(0, Math.floor(minX + i * cellW) - 1);
      const cx1 = Math.min(W, Math.ceil(minX + (i + 1) * cellW) + 1);
      const f = saveFrame(key, cx0, cx1, row.top, row.bottom, i);
      if (f) frames.push(f);
    }
    groups[key] = frames;
    console.log(key, frames.length);
  }
}

// 听歌默认姿势 = 第 1 组第 8 帧（戴好耳机后的静止姿势），不再播放随机动作
const onFrames = groups.music_on || [];
if (onFrames.length === 8) {
  const last = onFrames[7];
  fs.rmSync(path.join(OUT, 'music_default'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'music_default'), { recursive: true });
  fs.copyFileSync(path.join(OUT, last.file), path.join(OUT, 'music_default', '01.png'));
  groups.music_default = [{ file: 'music_default/01.png', w: last.w, h: last.h }];
  console.log('music_default 1');
}

const staleKeys = ['music_loop', 'music_lyrics', 'music_dance', 'music_down', 'music_relax', 'music_sway', 'music_tired'];
for (const stale of staleKeys) {
  fs.rmSync(path.join(OUT, stale), { recursive: true, force: true });
}
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const stale of staleKeys) delete manifest[stale];
Object.assign(manifest, groups);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('manifest updated');
