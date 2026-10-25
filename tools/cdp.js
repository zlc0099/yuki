// 开发辅助：通过 WebView2 CDP 在运行中的应用内执行 JS / 截图
// 用法: node tools/cdp.js <pet|card> "<expression>" [out.png]
const fs = require('fs');

const [targetPart, expr, shotPath] = process.argv.slice(2);

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes(targetPart));
  if (!page) {
    console.error('target not found:', list.map((t) => t.url).join(', '));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((resolve) => { ws.onopen = resolve; });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const value = res.result && res.result.result ? res.result.result.value : res;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  if (shotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(require('path').dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot ->', shotPath);
  }
  ws.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
