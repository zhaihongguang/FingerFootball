# M0 确定性模拟引擎 — 验证指南

这是整个「纯前端 + 链上」架构的**生死线验证**：证明双端能跑出**逐位一致**的结果。如果这一关过不了，就必须退回「服务器权威」方案。

---

## 为什么这是生死线

纯前端方案里，**没有服务器做裁判**。双方各自在前端跑模拟，最终都提交一个 `stateHash` 到链上，链上只判断「两人算出来的是不是同一个」。

- 如果引擎有任何一处用了浮点 / 系统时间 / 不可复现运算，两个设备就会算出**不同的 hash**，导致"明明打完了却永远无法结算"。
- 所以本引擎强制：**全程整数、固定种子、固定 tick、确定性哈希**。

---

## 三个文件

| 文件 | 作用 |
|---|---|
| `deterministic-engine.js` | 核心引擎（UMD：同时支持浏览器和 Node） |
| `selftest.js` | Node 自测脚本 |
| `index.html` | 浏览器可视化验证 |

---

## 关键设计（必须遵守）

### 1. 全程整数，禁浮点
- ❌ `Math.sin / cos / sqrt / pow`
- ❌ `Math.random()`
- ❌ `Date.now()`
- ❌ 任何 `0.5`、`1e-3` 之类的小数字面量参与物理

### 2. 确定性 PRNG
- 用 `xorshift32`，从固定 32 位种子出发，序列可复现。
- **seed 由双方 commit-reveal 共同决定**（异或），谁都无法单方操控。

### 3. 固定 tick
- 每 tick 推进一次物理，与真实墙钟无关。
- 输入带 `tick` 编号，按 tick 顺序驱动。

### 4. 确定性哈希
- 用 `FNV-1a (32bit)` 把最终状态（比分、球位置、速度、种子、输入数）压缩成指纹。
- 双端比对这个指纹；链上也是比对这个 hash。

---

## 运行自测

```bash
cd m0-deterministic-demo
node selftest.js
```

预期输出（末尾）：
```
=== 结果 ===
通过 N 项，失败 0 项
✅ 确定性引擎验证通过：双端可逐位一致，架构生死线成立。
```

浏览器验证：直接用浏览器打开 `index.html`，点两个按钮即可。

---

## 引擎接口

```js
const Det = require("./deterministic-engine.js");

// 生成种子（双方各提交一个随机数，异或合并）
const seed = Det.combineSeeds(playerARandom, playerBRandom);

// 输入序列（按 tick 升序）
const inputs = [
  { tick: 0,   player: 0, dx: 500,  dy: -200, power: 800 },
  { tick: 30,  player: 1, dx: -600, dy: 100,  power: 700 },
  // ...
];

// 跑一局
const result = Det.runSimulation(seed, inputs);
// result.stateHash -> 状态指纹（双端比对/上链比对用）
// result.score     -> [player0得分, player1得分]
// result.ballX/ballY/vx/vy -> 最终球状态
// result.lastTick  -> 结束 tick
```

---

## 已知简化（MVP 演示用，正式版再补）

1. **无球员实体**：只有球 + 场地 + 球门，施力是"持球方在己方半场即可施力"。真实版要加球员碰撞、抢球。
2. **先到 5 分胜**：演示用终止条件，正式版可改为固定时长。
3. **碰撞只做边界反弹**：无球员-球、球-门柱的精确碰撞，正式版要补。
4. **FNV-1a 是 32 位哈希**：碰撞概率对演示够用；正式版若要更稳，可换成 `keccak256`（用 js 库，但注意也要确定性）。
5. **combineSeeds 用异或**：简单但正式版建议用 `keccak256(a, b)` 合并，防"异或抵消"攻击。

---

## 通过标准

- 自测 0 失败；
- 两台不同设备（不同浏览器/系统）跑同一 seed + inputs，`stateHash` 完全一致。

达到这两条，M0 通过，可以进入 M1（合约，已写好）→ M2（P2P 锁步）。
