# 指尖足球 PvP — 匹配 + 信令服务器

轻量、零权威的信令服务：只负责「匹配 + 转发 WebRTC 信号」，不碰游戏状态/结果/资金。

同时它也托管 `m3-web` 静态页面，方便真人模式通过 HTTP 打开（`file://` 无法连 WebSocket）。

## 启动

```bash
cd pvp-server
node server.js
# 默认端口 8790
```

启动后：
- 游戏页：`http://localhost:8790/index.html`
- 信令：`ws://localhost:8790/`
- 匹配中/对局中：`http://localhost:8790/api/stats`

## 真人 PvP 使用（重要）

1. 启动服务器：`node server.js`
2. **必须用浏览器打开 `http://localhost:8790/index.html`，不要双击 `file://` 页面**
   - `file://` 页面无法连接 WebSocket，真人模式会一直卡在匹配
3. 开两个窗口（或两台设备）打开同一页面
4. 两个窗口都选「🌐 真人匹配」→ 选场次 → 点「开始匹配」
5. 服务器 FIFO 配对，建立 WebRTC DataChannel
6. 双方各自跑确定性引擎，交换 `shot` 事件，结束比对 `stateHash`

## 通信协议

WebSocket 信令：
```jsonc
{ "type": "join_queue" }                 // 进队
{ "type": "leave_queue" }                // 退队
{ "type": "matched", "matchId", "you": 0|1, "peer" }  // 服务器配对
{ "type": "signal", "to": "peerId", "data": { sdp / candidate } }  // 转发 WebRTC 信号
```

DataChannel（对局）：
```jsonc
{ "type": "ready", "seed", "playerIndex" }
{ "type": "shot", "cue", "vx", "vy", "sig" }
{ "type": "result", "stateHash" }
```

## 当前限制

- 内存队列，服务重启会清空
- 简单 FIFO，暂不分段位/场次
- 默认同源 `ws://`，部署时改 `serverUrl`
