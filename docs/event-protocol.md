# 事件协议

YukiPet 通过一个只监听本机回环地址的 HTTP 服务接收 agent 事件。Claude Code 的 hooks 脚本就是该协议的一个参考实现（`hooks/claude-hook.js`），其它 agent 也可以直接接入。

## 服务地址与鉴权

桌宠启动时会：

1. 在 `127.0.0.1` 的 `34217–34226` 之间选择一个空闲端口；
2. 生成随机 token；
3. 把端口和 token 写入：

```
%LOCALAPPDATA%\yukipet\port.txt
%LOCALAPPDATA%\yukipet\token.txt
```

所有 `/event` 请求都必须带请求头：

```
x-pet-token: <token.txt 中的内容>
```

不带或错误的 token 会返回 `401 Unauthorized`。服务只绑定 `127.0.0.1`，不会暴露到局域网。

`GET /health` 返回 `ok`，不需要 token，用于单实例探活。

## 事件格式

```http
POST /event
Content-Type: application/json
x-pet-token: <token>
```

```json
{
  "agent": "claude",
  "event": "PreToolUse",
  "session_id": "session-123",
  "cwd": "D:\\work\\demo",
  "transcript": "C:\\Users\\me\\.claude\\projects\\demo\\session.jsonl",
  "tool": "Bash",
  "message": null,
  "tool_error": false,
  "ts": 1761388800000
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `agent` | string | 来源标识，如 `claude`、`codex`、`trae`；当前仅用于标识 |
| `event` | string | 事件名，见下表 |
| `session_id` | string \| null | 会话标识，用于按会话记录是否出现过工具错误 |
| `cwd` | string \| null | 工作目录，可选 |
| `transcript` | string \| null | 会话记录路径，可选 |
| `tool` | string \| null | 工具名，用于工作气泡透传（如 `Bash`、`Edit`） |
| `message` | string \| null | 通知文案，`Notification` 事件用它区分权限等待与空闲等待 |
| `tool_error` | boolean | 本轮工具是否报错，`PostToolUse` / `Stop` 时使用 |
| `ts` | number | 毫秒时间戳，可选 |

## 事件语义

| `event` | 桌宠行为 |
| --- | --- |
| `SessionStart` | 回到空闲 |
| `UserPromptSubmit` | 进入工作态，气泡「工作中…」 |
| `PreToolUse` | 保持工作态，气泡显示工具名 |
| `PostToolUse` | 保持工作态；`tool_error=true` 时标记本会话有错误 |
| `Notification` | 文案命中权限关键词 → 红色「等你确认」；命中空闲等待关键词 → 回到空闲 |
| `Stop` | 本会话有错误 → 失败动画；否则成功动画 |
| `SessionEnd` | 回到空闲 |

`Notification` 的关键词规则：

- 权限/确认：`permission`、`approve`、`confirm`、`授权`、`确认`
- 空闲等待：`waiting for your input`、`waiting for input`、`idle`

无法判断的 `Notification` 不会改变状态。

超过 10 分钟没有收到任何事件，桌宠会自动回到空闲。

## 接入示例

### Bash / Git Bash

```bash
PORT=$(cat "$LOCALAPPDATA/yukipet/port.txt")
TOKEN=$(cat "$LOCALAPPDATA/yukipet/token.txt")

curl -s -X POST "http://127.0.0.1:$PORT/event" \
  -H "content-type: application/json" \
  -H "x-pet-token: $TOKEN" \
  -d '{"agent":"my-agent","event":"UserPromptSubmit","session_id":"demo"}'
```

### PowerShell

```powershell
$port = Get-Content "$env:LOCALAPPDATA\yukipet\port.txt"
$token = Get-Content "$env:LOCALAPPDATA\yukipet\token.txt"
$body = @{ agent = "my-agent"; event = "PreToolUse"; session_id = "demo"; tool = "Bash" } | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/event" `
  -Headers @{ "x-pet-token" = $token } -ContentType "application/json" -Body $body
```

### Node.js

```js
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.LOCALAPPDATA || '', 'yukipet');
const port = fs.readFileSync(path.join(dir, 'port.txt'), 'utf8').trim();
const token = fs.readFileSync(path.join(dir, 'token.txt'), 'utf8').trim();

fetch(`http://127.0.0.1:${port}/event`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pet-token': token },
  body: JSON.stringify({ agent: 'my-agent', event: 'Stop', session_id: 'demo', tool_error: false }),
}).catch(() => {});
```

## 注意事项

- 桌宠未启动时读取 `port.txt` / `token.txt` 会失败，建议在接入端静默忽略错误，不能阻塞 agent。
- token 每次启动都会重新生成，不要在配置文件里写死。
- 音乐/游戏检测是桌宠内部的 Tauri 事件，不经过这个 HTTP 服务。
