# 指尖足球 PvP 完整交接文档

本文件用于新窗口继续接手，不依赖会话历史。改代码前优先看这三个文件：

- `bsc-testnet/contracts/Match.sol`
- `pvp-server/server.js`
- `m3-web/app.js`

## 项目结构

```text
default-workspace/
├── m3-web/                 # 前端
│   ├── app.js              # 游戏 + PvP + 结算 + 领取 + 历史
│   ├── netcode.js          # WebRTC + WebSocket 信令
│   ├── contract-config.js  # 合约地址、Relayer URL、RPC
│   └── deterministic-billiards.js
├── pvp-server/             # 合并后的 PvP + Relayer 服务
│   ├── server.js
│   └── package.json        # 已加 ethers
├── bsc-testnet/            # 合约
│   ├── contracts/Match.sol
│   ├── scripts/deploy.js
│   ├── scripts/set-relayer.js
│   └── deployed.json
└── relayer-server/         # 旧独立 Relayer，已废弃，不要再使用
```

## 当前核心流程

```text
配对成功
→ 双方链上质押（createMatchWithStake / acceptMatchWithStake）
→ 双方质押确认后才会开局
→ 对局结束，双方各自生成结果签名并交换
→ 只有胜方自动调用 Relayer /api/recordResult
→ Relayer 本地验败方签名，用 gas 钱包 recordResult 上链
→ 胜方钱包直接 claimReward 领取
→ 历史从链上 getUserMatches 读取
```

## 历史注意事项

1. Node 版本
   - 项目需要 Node 22；系统默认可能是 Node 14/18。
   - 使用绝对路径：
     ```text
     C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe
     ```
   - ethers v6 在 Node 14 下会直接语法崩溃，不能用默认 `node` 启动 Relayer/PvP。

2. RPC
   - 使用 `https://bsc-testnet-rpc.publicnode.com`
   - 旧 BSC RPC 超时，不要用。

3. 合约编译
   - `Match.sol` 用 Hardhat + `viaIR: true` + optimizer 才能编译，否则 stack too deep。
   - 编译命令：
     ```powershell
     & "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js compile
     ```

4. 合约部署
   - 部署脚本：`bsc-testnet/scripts/deploy.js`
   - 自动写 `bsc-testnet/deployed.json`
   - 部署后必须手动设置 Relayer：`scripts/set-relayer.js`
   - 必须把新 `matchAddress` 填到前端 `m3-web/contract-config.js`

5. 收费场开关
   - 合约 `paidEnabled`，默认 `true`
   - owner 调用 `setPaidEnabled(bool)`
   - 只影响新收费场匹配，不影响已开始对局

6. Relayer 最小权限
   - 合约 `relayer` 白名单
   - gas 钱包只能代付 `recordResult`
   - `setRelayer` 只有 owner 能调
   - 不能把 gas 私钥写进前端/仓库

7. 旧 Relayer 已废弃
   - `relayer-server/` 不要继续使用
   - 已合并到 `pvp-server/server.js`
   - 路由：`/api/recordResult`
   - 服务器实际端口为 8790，启动时通过 `PORT=8790` 或服务器部署脚本设置

8. CORS
   - 前端从 `localhost:8787` 打开，Relayer 在 `43.155.144.136:8790`
   - 服务端必须返回 `Access-Control-Allow-Origin: *`
   - 支持 OPTIONS 预检
   - 之前缺少 CORS 导致 `NetworkError when attempting to fetch resource`

9. EIP-712 签名
   - Domain：`FingertipFootballMatch` / version `1` / chainId 97 / contract Match 地址
   - Type：`MatchRecord(matchId,resultHash,winner,score0,score1,duration)`
   - 签名人是**败方 loser**
   - Relayer 校验恢复地址 == loser
   - 自动提交必须使用败方签名附带的值，不能混用自己的 duration/score，否则 `bad signature`

10. 自动上链
    - 对局结束后双方都签名并交换
    - **只有胜方**自动调用 `/api/recordResult`
    - 败方不应调用，否则 `bad signature`
    - `resultRecorded` 防重复

11. 开局质押门控
    - 配对成功后双方都必须链上质押
    - 玩家 0 `createMatchWithStake`
    - 玩家 1 `acceptMatchWithStake`
    - 双方收到 `stake_ready` 且 DataChannel ready 后才开局
    - 免费场/演示模式直接开局

12. 匹配延迟
    - 已加 `readChainState()` 短缓存（3 秒）+ `Promise.all` 并行读取
    - 避免串行读 `paidEnabled/balance/allowance`

13. 历史读取
    - 优先从链上 `getUserMatches` 读取
    - 本地 `loadHistory()` 只是降级/缓存
    - 浏览器清缓存不丢奖励记录

14. Debug 日志
    - 前端：`[result-submit] payload` 打印提交值
    - 服务端：`verifyRecordSignature` 失败时打印
      `games read failed` / `winner not in game` / `signer mismatch`

## 当前部署/配置

`bsc-testnet/deployed.json` 与 `m3-web/contract-config.js` 当前一致：

```js
tokenAddress: 0x602d6eB30ef56137185D0497178C1c9E2862E2D4
matchAddress: 0xf2Fa97185C46E129FfdBf78a90Cb207BC6a8E3d2
relayerUrl: http://43.155.144.136:8790
rpcUrl: https://bsc-testnet-rpc.publicnode.com
chainId: 97
```

服务器环境变量模板：

```powershell
$env:RELAYER_MATCH_ADDRESS="0xf2Fa97185C46E129FfdBf78a90Cb207BC6a8E3d2"
$env:RELAYER_PRIVATE_KEY="0xgas钱包私钥"
$env:RELAYER_RPC_URL="https://bsc-testnet-rpc.publicnode.com"
$env:RELAYER_CHAIN_ID="97"
$env:PORT="8790"
```

## 在线人数功能（当前方案）

当前实现为“只统计 pvp-server 匹配/对局中的 WebSocket 连接数”，不做人员列表，也不做大堂常驻在线。

- `pvp-server/server.js`
  - `/api/stats` 只返回 `{\"ok\":true,\"online\":N}`
  - `online` = `onlineClients.size`，即当前连接信令服务的 WebSocket 数
  - 原生意义是“匹配中/对局中连接数”，不是“当前打开大厅的用户数”
  - 支持 GET + OPTIONS；CORS `Allowed-Methods` 已包含 `GET`
- `m3-web/index.html`
  - 右上角标签为“匹配中/对局中”
  - 只显示人数，无 `#online-users` 列表容器
- `m3-web/app.js`
  - `loadOnlineCount()` 每 10 秒读取 `relayerUrl + /api/stats`
  - 只写 `online-count`
- 已移除：
  - `/api/stats` 的 `users / byField`
  - WebSocket `register / update_profile` 协议
  - `netcode.js` 的 `connectPresence / updateProfile`
  - 本地 `presence` 会话与在线列表渲染

注意：实际配置 `relayerUrl` 是 `http://43.155.144.136:8790`，新逻辑默认连 `ws://43.155.144.136:8790`。本地联调需把 `contract-config.js` 改成 `http://localhost:8790`，或通过参数传入 `serverUrl`。

当前验证状态：

- Node 22 语法检查通过：`m3-web/app.js`、`m3-web/netcode.js`、`pvp-server/server.js`
- 本地启动服务后 `/api/stats` 返回 `{"ok":true,"online":0}`
- 匹配中的 WebSocket 连接会增加 `online` 值
- 尚未在浏览器里刷新确认“匹配中/对局中”标签最终样式

## 当前状态（已核对）

- 新 `Match.sol` 已部署：
  - `tokenAddress: 0x602d6eB30ef56137185D0497178C1c9E2862E2D4`
  - `matchAddress: 0xf2Fa97185C46E129FfdBf78a90Cb207BC6a8E3d2`
- 新合约链上配置：
  - `relayer = 0x0A272fd14472f094e0Bb32aF51E318D7AD665D60`
  - `paidEnabled = true`
  - `tierCount = 2`
- `m3-web/contract-config.js` 已指向新地址
- `pvp-server/server.js` 已包含 `/api/registerMatch`、`/api/recordResult`、`/api/stats`
- `Match.sol` 已包含记录生命周期：
  - `registerMatchRecord`
  - `claimRefund`
  - `MatchRecord` 带 `status / exists / player1 / player2 / refundClaimed1 / refundClaimed2`
- 前端历史已展示 `待结算 / 已结算 / 已退款`，支持“提取奖金”“领取本金”
- 前端质押成功后调用 Relayer `/api/registerMatch` 登记对局
- 合约强制编译通过；`app.js/server.js` 语法检查通过

## 仍需验证

1. 服务器环境变量：
   - `RELAYER_MATCH_ADDRESS=0x02b17184613A580030017e301a231E18bA69D6E6`
   - `RELAYER_PRIVATE_KEY` 必须对应 `0x0A272fd14472f094e0Bb32aF51E318D7AD665D60`
2. 真实收费场完整闭环：
   - 双方质押 → Relayer 登记 → 历史出现“待结算”
   - 双方都签名 → 结果上链 → 历史“已结算”，胜方可提取
   - 只有胜方签名 → 超时领取 → 历史同步“已结算”
   - 双方都没签名 → 超时退款 → 历史“已退款”，各自领取本金
3. 浏览器实测历史记录卡片和按钮交互

## 关键命令

```powershell
# 语法检查（建议用 Node 22）
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" --check m3-web/app.js
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" --check m3-web/netcode.js
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" --check pvp-server/server.js

# 启动 PvP + Relayer（服务器实际端口 8790）
cd pvp-server
$env:RELAYER_MATCH_ADDRESS="0xf2Fa97185C46E129FfdBf78a90Cb207BC6a8E3d2"
$env:RELAYER_PRIVATE_KEY="0xgas钱包私钥"
$env:RELAYER_RPC_URL="https://bsc-testnet-rpc.publicnode.com"
$env:RELAYER_CHAIN_ID="97"
$env:PORT="8790"
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" server.js

# 编译合约
cd bsc-testnet
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js compile

# 部署合约
cd bsc-testnet
$env:PRIVATE_KEY="部署私钥"
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js run scripts/deploy.js --network bscTestnet

# 设置 Relayer
cd bsc-testnet
$env:RELAYER_ADDRESS="0xgas钱包地址"
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js run scripts/set-relayer.js --network bscTestnet
```

## 需要带到服务器/新窗口的文件

- `m3-web/app.js`
- `m3-web/netcode.js`
- `m3-web/contract-config.js`
- `pvp-server/server.js`
- `pvp-server/package.json`
- `bsc-testnet/contracts/Match.sol`
- `bsc-testnet/scripts/set-relayer.js`
- `bsc-testnet/deployed.json`
