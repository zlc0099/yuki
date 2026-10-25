#!/usr/bin/env node
// 把桌宠 hooks 合并进 ~/.claude/settings.json（幂等，先备份）
// 用法: node tools/install-claude-hooks.js [--uninstall]
const fs = require('fs');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const MARKER = 'hooks/claude-hook.js';
const settingsPath = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'settings.json');
const hookPath = path.join(__dirname, '..', 'hooks', 'claude-hook.js').replace(/\\/g, '/');
const commandFor = (event) => `node "${hookPath}" ${event}`;

const uninstall = process.argv.includes('--uninstall');

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const text = fs.readFileSync(settingsPath, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}

function isOurs(group) {
  return Array.isArray(group && group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));
}

function backup(text) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${settingsPath}.bak-${stamp}`;
  fs.writeFileSync(dest, text);
  return dest;
}

function main() {
  const settings = loadSettings();
  settings.hooks = settings.hooks || {};
  const changes = [];

  for (const event of EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const withoutOurs = list.filter((g) => !isOurs(g));
    if (uninstall) {
      if (withoutOurs.length !== list.length) changes.push(`移除 ${event}`);
      if (withoutOurs.length) settings.hooks[event] = withoutOurs;
      else delete settings.hooks[event];
      continue;
    }
    if (withoutOurs.length !== list.length) {
      changes.push(`更新 ${event}`);
    } else {
      changes.push(`添加 ${event}`);
    }
    settings.hooks[event] = [...withoutOurs, { hooks: [{ type: 'command', command: commandFor(event) }] }];
  }

  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  const next = JSON.stringify(settings, null, 2) + '\n';
  if (fs.existsSync(settingsPath)) {
    const current = fs.readFileSync(settingsPath, 'utf8');
    if (current.trim() === next.trim()) {
      console.log('settings.json 已是目标状态，无需修改');
      return;
    }
    console.log('已备份原文件:', backup(current));
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, next);
  console.log(`${uninstall ? '卸载完成' : '安装完成'} -> ${settingsPath}`);
  for (const c of changes) console.log(' -', c);
}

try {
  main();
} catch (err) {
  console.error('安装失败:', err.message);
  process.exit(1);
}
