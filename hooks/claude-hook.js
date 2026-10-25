#!/usr/bin/env node
// Claude Code hook -> 桌宠本地事件服务
// 用法: node claude-hook.js <EventName> ；事件负载从 stdin 读取
const fs = require('fs');
const http = require('http');
const path = require('path');

const event = process.argv[2] || 'Unknown';
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'yukipet');
    const port = parseInt(fs.readFileSync(path.join(dir, 'port.txt'), 'utf8').trim(), 10) || 34217;
    const token = fs.readFileSync(path.join(dir, 'token.txt'), 'utf8').trim();
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch {}

    const payload = {
      agent: 'claude',
      event,
      session_id: input.session_id || null,
      cwd: input.cwd || null,
      transcript: input.transcript_path || null,
      tool: input.tool_name || null,
      message: typeof input.message === 'string' ? input.message.slice(0, 200) : null,
      tool_error: !!(input.tool_response && input.tool_response.is_error),
      ts: Date.now(),
    };
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/event',
      method: 'POST',
      timeout: 1200,
      headers: {
        'content-type': 'application/json',
        'x-pet-token': token,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch {
    // 桌宠没启动时静默跳过，不能影响 agent
  }
});

setTimeout(() => process.exit(0), 1500).unref();
