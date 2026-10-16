# M2 P2P Rollback Netcode — 实现说明

把 M0 的「确定性引擎」升级成「真实可打的对局」——**双端各自独立模拟，通过网络交换签名输入，乱序/延迟靠回滚重放修正**。

---

## 为什么用 Rollback（回滚）而非固定锁步

| 方案 | 输入延迟 | 实现复杂度 | 适合 |
|---|---|---|---|
| 固定锁步 | 高（等对方输入） | 需处理"空输入"歧义 | 回合制 |
| **Rollback** | **零（本地立即生效）** | 需快照/恢复 | **实时，离散施力** |

指尖足球是**离散施力**（几秒点一下，不是连续摇杆），rollback 极少触发回滚，但手感是零延迟的——这最接近 Web2 指尖足球的体验。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `deterministic-game.js` | 增量式确定性引擎（可 step / snapshot / restore / stateHash） |
| `protocol.js` | 消息结构 + 输入事件规范化序列化 + 范围校验 |
| `signer.js` | 签名抽象（mock 自测 + 真实 ethers 示例） |
| `rollback.js` | RollbackSession：本地施力立即生效，远端落后输入触发回滚重放 |
| `selftest.js` | 自测（同步 / 延迟回滚 / 非法输入丢弃） |

---

## 核心机制

### 1. 回滚重放
```
本地施力 → 立即生效（手感零延迟）→ 广播签名事件给对方
收到对方「落后 tick」的事件 → 回滚到那个 tick 的快照 → 重放至今
（因为引擎确定性，重放结果与对方逐位一致）
```

### 2. 签名输入（防作弊）
每条输入 = `(matchId, tick, player, dx, dy, power)`，发送方签名。
- 无对手私钥 → 无法伪造对手操作
- 有范围校验 → 非法输入（dx 超 1000 等）直接丢弃
- 有 tick 编号 → 乱序/重放可检测

### 3. 确定性（从 M0 继承）
- 全程整数、无浮点、无 `Date.now`/`Math.random`
- xorshift32 PRNG（现在支持快照/恢复状态）
- FNV-1a 状态指纹

---

## 自测

```bash
cd m2-p2p-netcode
node selftest.js
```

预期：
```
[1] 双方同步运行，结束时指纹一致          ✔
[2] 乱序/延迟到达，回滚重放后仍一致        ✔
[3] 非法输入被丢弃，不影响一致性           ✔
=== 结果 ===
通过 3 项，失败 0 项
✅ M2 Rollback Netcode 验证通过
```

---

## 与真实链上 / 前端的接口

### 签名（正式版，前端）
```js
// 用 ethers.js 签输入（EIP-191 personal_sign）
const digest = Protocol.inputDigest(ev);      // 正式版换成 keccak256
const sig = await signer.signMessage(ethers.getBytes(digest));

// 验签
const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
```

### 结算（正式版）
结束时双方各自 `stateHash()` → 提交到 Match 合约 → 一致则结算。

`stateHash` 应包含：`seed + 比分 + 球最终状态 + tick + 累计施力次数`，防止任何一维被篡改。

---

## 已知简化（MVP，正式版再补）

1. **签名用 mock**（自测），正式版换成 ethers `signMessage` + `keccak256`。
2. **消息摘要用 FNV-1a（32bit）**，正式版换 `solidityPackedKeccak256`（防碰撞、可链上验）。
3. **无球员实体**：仍是"球 + 场地 + 球门"，正式版加球员碰撞、抢球。
4. **无真实 WebRTC 传输**：本目录只实现 netcode 逻辑，传输层（WebRTC/socket）在 M3 前端接入。
5. **回滚快照未剪枝**：`history[]` 全程保留，正式版按「已确认的远端输入」做快照剪枝省内存。
