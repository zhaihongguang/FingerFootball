/**
 * 台球式引擎自测（11 球：双方各 5 母球 + 1 足球）
 * 运行：node selftest.js
 *
 * 注意：当前浏览器双击使用的是 m3-web/deterministic-billiards.js。
 * 本测试直接 require 那个同款文件，避免测旧引擎。
 */
var Billiards = require("../m3-web/deterministic-billiards.js");

var pass = 0, fail = 0;
function assertEqual(a, b, label) {
  if (a === b) { pass++; console.log("  ✔ " + label + ": " + a); }
  else { fail++; console.log("  ✘ " + label + ": 期望 " + b + "，实际 " + a); }
}

console.log("=== 台球式引擎自测（11 球）===\n");

// 固定击球序列：每回合用该方 0 号母球（接口: shoot(cueIndex, vx, vy)）
function playSequence(shots) {
  var g = new Billiards.BilliardsGame(0x12345678);
  for (var i = 0; i < shots.length; i++) {
    if (g.finished) break;
    if (g.phase === "aiming") {
      g.shoot(0, shots[i][0], shots[i][1]);
      g.runToRest();
    }
  }
  return g;
}

var SHOTS = [
  [-180, 0],    // P0 0号母球向左（攻左门）
  [170, 50],    // P1 0号母球向右（攻右门）
  [-150, -100], // P0
  [160, -80],   // P1
  [-170, 120],  // P0
  [150, 60],    // P1
  [-140, 0],    // P0
  [160, -40],   // P1
  [-180, -90],  // P0
  [170, 30]     // P1
];

console.log("[1] 确定性：同一击球序列跑 3 次指纹一致");
{
  var g1 = playSequence(SHOTS);
  var g2 = playSequence(SHOTS);
  var g3 = playSequence(SHOTS);
  assertEqual(g1.stateHash(), g2.stateHash(), "第1次 == 第2次");
  assertEqual(g2.stateHash(), g3.stateHash(), "第2次 == 第3次");
  console.log("    stateHash = 0x" + g1.stateHash().toString(16));
  console.log("    比分 = " + g1.score0 + " : " + g1.score1);
  console.log("    击球数 = " + g1.shotCount + "\n");
}

console.log("[2] 敏感性：不同击球序列结果不同");
{
  var ga = playSequence(SHOTS);
  var gb = playSequence([[180, 0], [-170, 50], [150, -100], [-160, -80]]);
  assertEqual(ga.stateHash() === gb.stateHash() ? 0 : 1, 1, "不同序列指纹不同");
  console.log("");
}

console.log("[3] 进球判定：玩家0 的 0 号母球把足球撞进左门 → 玩家0 得分");
{
  var g = new Billiards.BilliardsGame(0x1);
  g.balls[Billiards.PHYS.FOOTBALL_INDEX].x = 1000; g.balls[Billiards.PHYS.FOOTBALL_INDEX].y = 2250;
  g.balls[0].x = 2000; g.balls[0].y = 2250; // 玩家0 母球0 在足球右侧，向左撞
  g.turn = 0; g.phase = "aiming";
  var s0 = g.score0;
  g.shoot(0, -180, 0);
  g.runToRest();
  assertEqual(g.score0 > s0, true, "玩家0 得分增加");
  console.log("    比分 = " + g.score0 + " : " + g.score1 + "\n");
}

console.log("[4] 母球进网：只放回指定球座，不加分");
{
  var g = new Billiards.BilliardsGame(0x2);
  // 玩家0 的 0 号母球贴近右门（x>=7890 且 y 在门高内即进网），向右击
  g.balls[0].x = 7800; g.balls[0].y = 2250;
  g.turn = 0; g.phase = "aiming";
  var s0 = g.score0, s1 = g.score1;
  g.shoot(0, 180, 0);
  g.runToRest();
  assertEqual(g.balls[0].pocketed, false, "母球已放回场地（pocketed=false）");
  assertEqual(g.balls[0].x === 5800 && g.balls[0].y === 1800, true, "母球放回玩家0球座(5800,1800)");
  assertEqual(g.score0 === s0 && g.score1 === s1, true, "比分不变（母球进网不计分）");
  console.log("    比分 = " + g.score0 + " : " + g.score1 + "\n");
}

console.log("[5] 回合切换：无进球后换对方");
{
  var g = new Billiards.BilliardsGame(0x3);
  g.turn = 0;
  g.shoot(0, 100, 0); // 轻击，无进球
  g.runToRest();
  assertEqual(g.turn, 1, "无进球后换到玩家1");
  console.log("    当前回合 = 玩家" + g.turn + "\n");
}

console.log("[6] 双方各 5 颗母球，足球索引正确");
{
  var g = new Billiards.BilliardsGame(0x4);
  assertEqual(g.balls.length, 11, "balls 长度 = 11");
  assertEqual(g.balls[Billiards.PHYS.FOOTBALL_INDEX].player, -1, "足球 player=-1");
  var p0Count = 0, p1Count = 0;
  for (var i = 0; i < 11; i++) {
    if (g.balls[i].player === 0) p0Count++;
    if (g.balls[i].player === 1) p1Count++;
  }
  assertEqual(p0Count, 5, "玩家0 母球数 = 5");
  assertEqual(p1Count, 5, "玩家1 母球数 = 5");
  console.log("");
}

// ---- 汇总 ----
console.log("=== 结果 ===");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fail === 0) {
  console.log("✅ 台球式引擎验证通过（11 球）");
  process.exitCode = 0;
} else {
  console.log("❌ 存在失败项");
  process.exitCode = 1;
}
