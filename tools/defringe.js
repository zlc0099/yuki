// 去白边：估计背景色，按 alpha 反混合半透明边缘，消除浅色毛刺
function estimateBg(png) {
  const { data } = png;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [255, 255, 255];
}

function applyDefringe(png, bg = [255, 255, 255], minAlpha = 0.3) {
  const { data } = png;
  const cut = minAlpha * 255;
  for (let i = 0; i < data.length; i += 4) {
    const a255 = data[i + 3];
    if (a255 === 0) continue;
    if (a255 < cut) {
      data[i + 3] = 0;
      continue;
    }
    const a = a255 / 255;
    for (let c = 0; c < 3; c++) {
      const v = (data[i + c] - (1 - a) * bg[c]) / a;
      data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return png;
}

module.exports = { estimateBg, applyDefringe };
