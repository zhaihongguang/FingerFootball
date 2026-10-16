/**
 * 确定性引擎自测：证明「同一输入序列 → 逐位一致的状态指纹」。
 *
 * 运行：
 *   node selftest.js
 *
 * 验证内容：
 *   1. 确定性：同一 seed + 同一输入，跑 N 次结果完全相同
 *   2. 敏感性：不同 seed / 不同输入，结果不同（防止碰撞）
 *   3. 双端一致性：模拟「两个玩家各自独立跑同一份输入」比对指纹
 */
const Det = require("./deterministic-engine.js");

let pass = 0;
let fail = 0;

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    pass++;
    console.log(`  ✔ ${label}: ${actual}`);
  } else {
    fail++;
    console.log(`  ✘ ${label}: 期望 ${expected}，实际 ${actual}`);
  }
}

function assertNotEqual(actual, unexpected, label) {
  if (actual !== unexpected) {
    pass++;
    console.log(`  ✔ ${label}: ${actual} (≠ ${unexpected})`);
  } else {
    fail++;
    console.log(`  ✘ ${label}: 意外相同 ${actual}`);
  }
}

console.log("=== M0 确定性引擎自测 ===\n");

// 构造一个模拟输入序列：交替两方施力，覆盖整数运算路径
function makeInputs(rng) {
  const inputs = [];
  for (let tick = 0; tick < 600; tick += 30) {
    // 玩家 0 在偶数段施力，玩家 1 在奇数段施力
    const player = (tick / 30) % 2;
    inputs.push({
      tick,
      player,
      dx: (rng() % 2000) - 1000, // [-1000, 1000] 整数
      dy: (rng() % 2000) - 1000,
      power: rng() % 1001
    });
  }
  return inputs;
}

// ---- 1. 确定性：同一输入跑多次 ----
console.log("[1] 确定性：同一 seed + 同一输入跑 3 次应完全一致");
{
  const seed = 0x12345678;
  const inputs = makeInputs(Det.XorShift32(0xdeadbeef));
  const r1 = Det.runSimulation(seed, inputs);
  const r2 = Det.runSimulation(seed, inputs);
  const r3 = Det.runSimulation(seed, inputs);
  assertEqual(r1.stateHash, r2.stateHash, "第 1 次 == 第 2 次");
  assertEqual(r2.stateHash, r3.stateHash, "第 2 次 == 第 3 次");
  console.log(`    stateHash = 0x${r1.stateHash.toString(16)}`);
  console.log(`    score = ${r1.score[0]} : ${r1.score[1]}, lastTick = ${r1.lastTick}\n`);
}

// ---- 2. 敏感性：不同 seed ----
console.log("[2] 敏感性：不同 seed 结果应不同");
{
  const inputs = makeInputs(Det.XorShift32(0xdeadbeef));
  const ra = Det.runSimulation(0x11111111, inputs);
  const rb = Det.runSimulation(0x22222222, inputs);
  assertNotEqual(ra.stateHash, rb.stateHash, "不同 seed 的 stateHash");
  console.log(`    seedA hash = 0x${ra.stateHash.toString(16)}`);
  console.log(`    seedB hash = 0x${rb.stateHash.toString(16)}\n`);
}

// ---- 3. 敏感性：不同输入 ----
console.log("[3] 敏感性：不同输入结果应不同");
{
  const seed = 0x12345678;
  const inputsA = makeInputs(Det.XorShift32(0xaaaa));
  const inputsB = makeInputs(Det.XorShift32(0xbbbb));
  const ra = Det.runSimulation(seed, inputsA);
  const rb = Det.runSimulation(seed, inputsB);
  assertNotEqual(ra.stateHash, rb.stateHash, "不同输入的 stateHash");
  console.log("");
}

// ---- 4. 双端一致性模拟 ----
console.log("[4] 双端一致性：两个独立进程各跑一次应得到同一指纹");
{
  // 模拟两个玩家各自本地独立计算
  const seed = Det.combineSeeds(0x0badf00d, 0x5eedcafe);
  const inputs = makeInputs(Det.XorShift32(0x1234));

  // 模拟「玩家 A 端」与「玩家 B 端」各自运行
  const playerA = Det.runSimulation(seed, inputs);
  const playerB = Det.runSimulation(seed, inputs);

  assertEqual(playerA.stateHash, playerB.stateHash, "A 端 == B 端");
  console.log(`    双端指纹 = 0x${playerA.stateHash.toString(16)}`);
  console.log(`    比分 = ${playerA.score[0]} : ${playerA.score[1]}\n`);
}

// ---- 5. combineSeeds 对称性（双方异或顺序无关）----
console.log("[5] combineSeeds 对称性：A^B == B^A");
{
  const s1 = Det.combineSeeds(0xabcdef01, 0x10fedcba);
  const s2 = Det.combineSeeds(0x10fedcba, 0xabcdef01);
  assertEqual(s1, s2, "异或顺序无关");
  console.log("");
}

// ---- 汇总 ----
console.log("=== 结果 ===");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) {
  console.log("✅ 确定性引擎验证通过：双端可逐位一致，架构生死线成立。");
  process.exitCode = 0;
} else {
  console.log("❌ 存在失败项，请检查引擎实现。");
  process.exitCode = 1;
}
