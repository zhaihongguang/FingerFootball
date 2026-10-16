/**
 * ============================================================
 * M0 确定性模拟引擎（指尖足球）
 * ------------------------------------------------------------
 * 目标：证明「纯前端 + 链上」架构的生死线——
 *       同一份输入序列，在任何设备/浏览器上跑出的状态逐位一致。
 *
 * 关键约束（全部满足）：
 *   1. 全程整数运算，禁用浮点与不可复现的数学函数
 *      （Math.sin/cos/sqrt/pow 一律不用；除法用 Math.trunc 做向零取整）
 *   2. 确定性 PRNG（xorshift32），种子固定即可复现
 *   3. 固定 tick（每 tick 一次推进），与真实墙钟无关
 *   4. 状态指纹用确定性哈希（FNV-1a）输出，供双端比对
 *
 * 本文件同时支持浏览器（挂 window.DetEngine）与 Node（module.exports）。
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DetEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------- 确定性 PRNG：xorshift32 ----------------
  // 返回 [0, 2^32) 的整数；从固定种子出发，序列完全可复现。
  function XorShift32(seed) {
    // seed 为 32 位无符号整数；0 会导致全 0 序列，需处理
    let s = (seed >>> 0) || 0x9e3779b9;
    return function next() {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s >>> 0;
    };
  }

  // ---------------- 确定性哈希：FNV-1a 32bit ----------------
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // 把整数数组序列化成字节（大端），供哈希。
  function intsToBytes(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      let v = arr[i] >>> 0;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    }
    return out;
  }

  // ---------------- 场地常量（全部整数，单位：内部单元） ----------------
  // 1 米 = SCALE 单元。所有位置/速度都是整数。
  var SCALE = 1000;

  // 场地：宽 8 米、高 4.5 米 → 整数单元
  var FIELD_W = 8000;
  var FIELD_H = 4500;

  // 球半径 0.11 米
  var BALL_R = 110;

  // 球门：半高 0.75 米，位于左右边线中央
  var GOAL_HALF_H = 750;

  // 摩擦力：每 tick 速度乘 FRICTION_NUM / FRICTION_DEN（向零取整）
  var FRICTION_NUM = 97;
  var FRICTION_DEN = 100;

  // 弹性：撞墙后速度取反再乘 RESTITUTION_NUM / RESTITUTION_DEN
  var RESTITUTION_NUM = 8;
  var RESTITUTION_DEN = 10;

  // 固定 tick 频率（与墙钟无关，纯逻辑步进）
  var TICKS_PER_SECOND = 60;

  // 一局最大 tick 数（防止无限循环）
  var MAX_TICKS = 60 * 60 * 10; // 10 分钟

  // ---------------- 输入结构 ----------------
  // 一条输入 = { tick, player, dx, dy, power }
  //   tick:   生效的 tick 编号（整数）
  //   player: 0 或 1
  //   dx, dy: 施力方向（整数，-1000..1000）
  //   power:  施力大小（整数，0..1000）
  // 全部整数，不做 sqrt 归一化（避免浮点）。

  // ---------------- 内部工具 ----------------
  // 进球/开局重置：球回中心，速度由 rng 决定（让 seed 真正影响对局）
  function _resetBall(rng) {
    var cx = FIELD_W / 2;
    var cy = FIELD_H / 2;
    var rvx = (rng() % 801) - 400; // [-400, 400]
    var rvy = (rng() % 801) - 400;
    return { x: cx, y: cy, vx: rvx, vy: rvy };
  }

  // ---------------- 模拟核心 ----------------
  /**
   * 运行一局模拟。
   * @param {number} seed      32 位整数种子（由双方 commit-reveal 共同决定）
   * @param {Array}  inputs    按 tick 升序排列的输入数组
   * @param {number} maxTicks  可选，最大 tick 数
   * @returns {object} { stateHash, score, ballX, ballY, vx, vy, lastTick, seed }
   */
  function runSimulation(seed, inputs, maxTicks) {
    maxTicks = maxTicks || MAX_TICKS;

    var rng = XorShift32(seed);

    // 初始状态：球在中心，速度由种子决定
    var init = _resetBall(rng);
    var ballX = init.x;
    var ballY = init.y;
    var vx = init.vx;
    var vy = init.vy;

    // 比分
    var score0 = 0; // 玩家 0 的得分
    var score1 = 0;

    // 按 tick 建立输入索引（同一 tick 两边可同时输入）
    var inputMap = {};
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var t = inp.tick;
      if (!inputMap[t]) inputMap[t] = [];
      inputMap[t].push(inp);
    }

    var lastTick = 0;

    for (var tick = 0; tick < maxTicks; tick++) {
      lastTick = tick;

      // ---- 1. 处理本 tick 的输入（施力）----
      var tickInputs = inputMap[tick];
      if (tickInputs) {
        for (var k = 0; k < tickInputs.length; k++) {
          var ti = tickInputs[k];
          // 简化为：持球方在己方半场即可施力
          // 玩家 0 攻右侧（x 增大），玩家 1 攻左侧（x 减小）
          var canFlick =
            (ti.player === 0 && ballX >= FIELD_W / 2) ||
            (ti.player === 1 && ballX <= FIELD_W / 2);
          if (canFlick) {
            // 施力：方向(dx,dy)按 power 缩放（整数，向零取整）
            var ax = Math.trunc((ti.dx * ti.power) / 1000);
            var ay = Math.trunc((ti.dy * ti.power) / 1000);
            vx += ax;
            vy += ay;
          }
        }
      }

      // ---- 2. 物理步进（整数）----
      ballX += vx;
      ballY += vy;

      // 摩擦力衰减（向零取整）
      vx = Math.trunc((vx * FRICTION_NUM) / FRICTION_DEN);
      vy = Math.trunc((vy * FRICTION_NUM) / FRICTION_DEN);

      // ---- 3. 上下边界反弹 ----
      if (ballY < BALL_R) {
        ballY = BALL_R + (BALL_R - ballY); // 镜像回场内
        vy = Math.trunc(-(vy * RESTITUTION_NUM) / RESTITUTION_DEN);
      } else if (ballY > FIELD_H - BALL_R) {
        ballY = FIELD_H - BALL_R - (ballY - (FIELD_H - BALL_R));
        vy = Math.trunc(-(vy * RESTITUTION_NUM) / RESTITUTION_DEN);
      }

      // ---- 4. 进球判定 ----
      // 球门在左右边线中央，高 GOAL_HALF_H*2
      var inGoalY = ballY >= FIELD_H / 2 - GOAL_HALF_H && ballY <= FIELD_H / 2 + GOAL_HALF_H;

      if (ballX < BALL_R) {
        if (inGoalY) {
          // 球进左侧球门 → 玩家 1 得分
          score1++;
          var r1 = _resetBall(rng);
          ballX = r1.x; ballY = r1.y; vx = r1.vx; vy = r1.vy;
        } else {
          ballX = BALL_R + (BALL_R - ballX);
          vx = Math.trunc(-(vx * RESTITUTION_NUM) / RESTITUTION_DEN);
        }
      } else if (ballX > FIELD_W - BALL_R) {
        if (inGoalY) {
          // 球进右侧球门 → 玩家 0 得分
          score0++;
          var r2 = _resetBall(rng);
          ballX = r2.x; ballY = r2.y; vx = r2.vx; vy = r2.vy;
        } else {
          ballX = FIELD_W - BALL_R - (ballX - (FIELD_W - BALL_R));
          vx = Math.trunc(-(vx * RESTITUTION_NUM) / RESTITUTION_DEN);
        }
      }

      // ---- 5. 终止条件：先到 5 分胜（演示用）----
      if (score0 >= 5 || score1 >= 5) {
        break;
      }
    }

    // ---- 计算状态指纹 ----
    // 把最终状态的所有相关整数串成字节序列再哈希。
    // 必须包含：种子、球位置、速度、比分、结束 tick、输入数，缺一不可。
    var stateInts = [
      seed >>> 0,
      ballX, ballY, vx, vy,
      score0, score1,
      lastTick,
      inputs.length
    ];
    var stateHash = fnv1a(intsToBytes(stateInts));

    return {
      stateHash: stateHash,
      score: [score0, score1],
      ballX: ballX,
      ballY: ballY,
      vx: vx,
      vy: vy,
      lastTick: lastTick,
      seed: seed >>> 0
    };
  }

  // ---------------- 导出 ----------------
  return {
    // 常量
    SCALE: SCALE,
    FIELD_W: FIELD_W,
    FIELD_H: FIELD_H,
    BALL_R: BALL_R,
    GOAL_HALF_H: GOAL_HALF_H,
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    // 工具
    XorShift32: XorShift32,
    fnv1a: fnv1a,
    combineSeeds: combineSeeds,
    // 核心
    runSimulation: runSimulation
  };

  // 双方种子合并：异或（对称，顺序无关）。
  // 正式版建议用 keccak256(a,b) 合并，防「异或抵消」攻击。
  function combineSeeds(a, b) {
    return ((a >>> 0) ^ (b >>> 0)) >>> 0;
  }
});
