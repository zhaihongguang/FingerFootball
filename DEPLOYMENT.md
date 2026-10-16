# 指尖足球 PvP 部署流程

本文档覆盖当前生产架构的三部分：

1. BSC 测试链合约部署与 Relayer 授权
2. `pvp-server` 部署（信令 + 静态托管前端 + Relayer 合并服务）
3. 前端合约/Relayer 配置与上线检查

> 旧版 `relayer-server/` 是独立 Relayer，已合并进 `pvp-server`，不建议再单独部署。

---

## 1. 部署 BSC 测试链合约

### 1.1 环境要求

- Node.js 22 或更高版本
- 一个用于部署的 BSC 测试网钱包私钥
- 部署钱包里有 tBNB 作为 gas

### 1.2 安装依赖

```powershell
cd bsc-testnet
npm install
```

### 1.3 设置部署私钥

不要在代码里写私钥，通过环境变量注入：

```powershell
$env:PRIVATE_KEY="0x你的部署钱包私钥"
```

### 1.4 编译合约

```powershell
& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js compile --force
```

### 1.5 部署合约

```powershell
npm run deploy
```

脚本会：

1. 部署 `TestToken`
2. 部署 `Match`（代币直锁模型，不部署 Vault）
3. 添加 0.01 和 0.1 两个场次
4. 把地址写入 `bsc-testnet/deployed.json`

### 1.6 设置链上 Relayer

部署完需要把 `pvp-server` 的 Relayer gas 钱包授权到合约：

```powershell
$env:RELAYER_ADDRESS="0x你的Relayer钱包地址"
$env:MATCH_ADDRESS="0x刚刚部署的Match合约地址"

& "C:\Users\86139\AppData\Roaming\nvm\v22.17.0\node.exe" node_modules/hardhat/internal/cli/cli.js run scripts/set-relayer.js --network bscTestnet
```

之后把这个地址写入 `m3-web/contract-config.js` 的 `relayerUrl` 对应服务。

---

## 2. 部署 pvp-server

### 2.1 准备源码

把以下目录同步到服务器：

```text
pvp-server/
m3-web/
```

`pvp-server` 会自动托管上级目录的 `m3-web`，所以两者必须放在同一级：

```text
/path/to/app/
├── pvp-server/
└── m3-web/
```

### 2.2 安装依赖

```powershell
cd pvp-server
npm install
```

### 2.3 配置环境变量

在服务器上设置：

```powershell
$env:PORT="8790"
$env:RELAYER_RPC_URL="https://bsc-testnet-rpc.publicnode.com"
$env:RELAYER_CHAIN_ID="97"
$env:RELAYER_MATCH_ADDRESS="0x部署的Match合约地址"
$env:RELAYER_PRIVATE_KEY="0xRelayer gas钱包私钥"
$env:RELAYER_RETRY_LIMIT="3"
$env:RELAYER_RETRY_DELAY_MS="5000"
$env:LOG_DIR="C:\path\to\logs"
```

生产环境建议使用进程管理器（PM2）或系统服务，并只把敏感变量写入服务配置，不写入源码。

启动：

```powershell
node server.js
```

启动成功后：

- 游戏页：`http://服务器地址:8790/index.html`
- PvP 信令：`ws://服务器地址:8790/`
- Relayer：`http://服务器地址:8790/api/recordResult`
- 兜底退款：`http://服务器地址:8790/api/refundNoGame`
- 在线统计：`http://服务器地址:8790/api/stats`
- 日志目录：`pvp-server/logs/pvp-YYYY-MM-DD.log`

### 2.4 PM2 示例（Linux 服务器）

```bash
cd /path/to/app/pvp-server
npm install
cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "fingertip-football",
    script: "server.js",
    cwd: "/path/to/app/pvp-server",
    env: {
      PORT: 8790,
      RELAYER_RPC_URL: "https://bsc-testnet-rpc.publicnode.com",
      RELAYER_CHAIN_ID: "97",
      RELAYER_MATCH_ADDRESS: "0x...",
      RELAYER_PRIVATE_KEY: "0x...",
      RELAYER_RETRY_LIMIT: "3",
      RELAYER_RETRY_DELAY_MS: "5000",
      LOG_DIR: "/path/to/app/logs"
    }
  }]
};
EOF
pm2 start ecosystem.config.cjs
pm2 save
```

---

## 3. 前端配置

编辑 `m3-web/contract-config.js`：

```js
root.ContractConfig = {
  tokenAddress: "0x部署的TestToken地址",
  vaultAddress: "",
  matchAddress: "0x部署的Match合约地址",
  relayerUrl: "http://服务器地址:8790",
  chainId: 97,
  rpcUrl: "https://bsc-testnet-rpc.publicnode.com"
};
```

关键点：

- `relayerUrl` 必须是前端浏览器能访问的公网地址，不能只写 `localhost`
- 如果前端走 HTTPS，Relayer 也要 HTTPS，否则浏览器会拦截混合内容
- 修改后浏览器强制刷新，因为服务端返回 `Cache-Control: no-store`

---

## 4. 上线检查清单

### 合约

- [ ] 部署钱包有足够 tBNB
- [ ] `deployed.json` 地址已更新
- [ ] Match 合约 Relayer 地址已设置为服务器 gas 钱包
- [ ] 0.01 / 0.1 场次已启用

### pvp-server

- [ ] `RELAYER_MATCH_ADDRESS` 等于前端 `contract-config.js` 的 `matchAddress`
- [ ] `RELAYER_PRIVATE_KEY` 是合约授权的 Relayer 钱包
- [ ] 服务器端口 8790 对公网开放
- [ ] `m3-web` 与 `pvp-server` 在同一上级目录
- [ ] 日志目录可写

### 前端

- [ ] `contract-config.js` 地址与最新部署一致
- [ ] `relayerUrl` 可从公网访问
- [ ] 浏览器能用 HTTP 打开 `http://服务器地址:8790/index.html`
- [ ] 免费场 / 机器人模式可正常开局
- [ ] 真人匹配可配对，双方质押后进入对局
- [ ] 平局后历史显示“已退款”，可领取
- [ ] 双方质押未开局时历史显示“未开局退款”，可全额退回
- [ ] 胜方提取奖金按钮 15 秒倒计时后可点击

---

## 5. 常见问题

### Relayer 一直 `bad signature`

通常是 `RELAYER_MATCH_ADDRESS` 和前端 `matchAddress` 不一致，或链上 Relayer 地址未授权。

### 匹配成功但双方质押后没进入对局

先看服务器日志是否有 `stake_ready` / `game_start` / `turn`；前端需要真实钱包 + HTTP 打开页面。

### 提取奖金报 `Match: wrong state`

通常是对局刚结束、链上记录还在处理。点击前有 15 秒倒计时，或者稍后刷新再领取。

### HTTPS 页面连不上 ws/Relayer

Relayer 需要与页面同协议：HTTPS 页面必须配 HTTPS Relayer 地址，或用反向代理转发。