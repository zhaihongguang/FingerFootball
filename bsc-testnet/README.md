# 指尖足球 PvP — BSC 测试链部署指南

这是「纯前端跑游戏逻辑 + 链上管资金结算」架构的链上部分。包含 3 个合约 + 部署脚本，可直接在 **BSC 测试链（Chapel，Chain ID 97）** 上部署调试。

> 完整产品架构见同级目录的 `指尖足球PvP-MVP开发计划.md`。

---

## 一、BSC 测试链信息

| 项 | 值 |
|---|---|
| 网络名 | BSC Testnet（BNB Smart Chain Testnet / Chapel） |
| Chain ID | **97** |
| RPC | `https://data-seed-prebsc-1-s1.binance.org:8545/` |
| 区块浏览器 | https://testnet.bscscan.com |
| gas 代币 | tBNB（水龙头免费领） |
| 代币标准 | BEP-20（与 ERC-20 接口完全兼容） |

**领 tBNB 水龙头**：https://www.bnbchain.org/en/testnet-faucet （需要钱包地址，可能需要登录）

---

## 二、合约清单

| 文件 | 职责 |
|---|---|
| `contracts/TestToken.sol` | mock BEP-20 测试代币（FFT），含水龙头 `faucet()` |
| `contracts/Vault.sol` | 充值池：充/提/锁/结算，费率可调 |
| `contracts/Match.sol` | 对局：开赛/提交/结算/挑战/超时，场次参数化 |

### 核心设计
- **资金只在一个方向流动**：Vault 是唯一资金池，Match 只是"裁判"，不碰钱。
- **费率快照**：`createMatch` 时把 `feeBps`/`minFee` 存进对局，之后 `setFeeBps` 调价不影响已开赛对局。
- **场次参数化**：`tiers` 数组，`addTier/removeTier/setTierEnabled` 随时调整档位。
- **RNG seed 不在链上**：seed 在 P2P 用 commit-reveal 完成，链上只存 `resultHash`（含 seed + 签名输入 + 比分）。
- **三种资金出口**：双方一致 / owner 仲裁 / 超时兜底。单方无法凭空划走资金。

---

## 三、部署步骤

### 1. 安装依赖
```bash
cd bsc-testnet
npm install
```

### 2. 配置私钥
```bash
# PowerShell
$env:PRIVATE_KEY="你的钱包私钥（去掉 0x 前缀也可以，脚本兼容）"

# 或 CMD
set PRIVATE_KEY=你的钱包私钥
```

### 3. 领测试币（tBNB 付 gas）
用部署钱包地址去水龙头领 tBNB，否则部署会失败。

### 4. 部署
```bash
npm run deploy
# 等价于 npx hardhat run scripts/deploy.js --network bscTestnet
```

脚本会依次：
1. 部署 `TestToken`
2. 部署 `Vault`（传入 token 地址）
3. 部署 `Match`（传入 vault 地址）
4. 调 `vault.setMatchContract(match)` 授权
5. 添加两个场次：`0.01` 和 `0.1` 代币（18 位小数）

### 5. 记录输出
部署完成后终端会打印 3 个合约地址，复制保存，后续前端要硬编码这些地址。

---

## 四、初始化参数说明

| 参数 | 值 | 说明 |
|---|---|---|
| 费率 `feeBps` | 300（=3%） | 总底池抽成，可 `setFeeBps` 调整 |
| 最低手续费 `minFee` | 0（默认） | 兜底极端小额场，可 `setMinFee` |
| 场次 `tiers` | 0.01 / 0.1 代币 | = 10^16 / 10^17 wei，可随时 addTier |
| Pending 超时 | 300s | 5 分钟无人接受可取消 |
| 结算超时 | 300s | 开赛 5 分钟未提交可索赔 |

---

## 五、测试流程（手动验证）

两个测试钱包 A、B，各领测试币，然后：

1. **A 充值**：`token.approve(vault, 1e18)` → `vault.deposit(1e17)`（充 0.1 代币）
2. **B 充值**：同上
3. **A 开赛**：`match.createMatch(1, B地址)`（tier 索引 1 = 0.1 代币场）
4. **B 接受**：`match.acceptMatch(1)`（matchId = 1）
5. **双方提交结果**：
   - A：`match.submitResult(1, hashA, B地址)`（假设 B 赢）
   - B：`match.submitResult(1, hashB, B地址)`（hashA == hashB，winner 都写 B）
6. **结算**：`match.finalize(1)`
7. **验证**：`vault.balanceOf(B)` 应增加 `2*0.1 - 手续费`，`vault.feePool()` 应等于手续费

---

## 六、金额精度（重要）

代币价 $38，场次必须用小数代币。合约里**所有金额都是 wei 整数（18 位小数）**，禁浮点：

| 场次 | 代币 | wei（18 位） | 美元（$38） |
|---|---|---|---|
| 0.01 | 0.01 | 10^16 | ≈ $0.38 |
| 0.1 | 0.1 | 10^17 | ≈ $3.80 |

前端展示时再换算成人类可读金额。

---

## 七、下一步

- 合约跑通后，接前端（钱包签名登录 + 确定性模拟对局 + 结算提交）。
- 前端只需三个合约 ABI + 地址，用 `ethers.js`/`viem` 交互。
