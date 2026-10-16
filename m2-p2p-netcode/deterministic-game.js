/**
 * ============================================================
 * 增量式确定性游戏引擎（M2 用，与 M0 物理逻辑逐位一致）
 * ------------------------------------------------------------
 * 与 M0 的 runSimulation 不同，本引擎支持：
 *   - step(tickInputs)：逐 tick 推进（供 rollback 回滚重放用）
 *   - snapshot()/restore()：保存/恢复完整状态（含 RNG 状态）
 *   - stateHash()：确定性状态指纹（双端比对 / 上链比对用）
 *
 * 硬约束（与 M0 相同，必须遵守）：
 *   - 全程整数，禁浮点；除法一律 Math.trunc 向零取整
 *   - 确定性 PRNG（xorshift32，可快照状态）
 *   - 固定 tick，与墙钟无关
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DetGame = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------- 物理常量（整数，单位：内部单元，1 米 = 1000） ----------------
  var PHYS = {
    SCALE: 1000,
    FIELD_W: 8000,          // 场宽 8 米
    FIELD_H: 4500,          // 场高 4.5 米
    BALL_R: 110,            // 球半径 0.11 米
    GOAL_HALF_H: 750,       // 球门半高 0.75 米
    FRICTION_NUM: 97,       // 摩擦系数分子
    FRICTION_DEN: 100,      // 摩擦系数分母
    RESTITUTION_NUM: 8,     // 弹性分子
    RESTITUTION_DEN: 10,    // 弹性分母
    WIN_SCORE: 5,           // 先到 5 分胜
    MAX_TICKS: 60 * 60 * 10 // 10 分钟上限
  };

  // ---------------- 可快照的确定性 PRNG：xorshift32 ----------------
  function XorShift32(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  XorShift32.prototype.next = function () {
    this.s ^= this.s << 13; this.s >>>= 0;
    this.s ^= this.s >> 17;
    this.s ^= this.s << 5;  this.s >>>= 0;
    return this.s >>> 0;
  };
  XorShift32.prototype.getState = function () {
    return this.s >>> 0;
  };
  XorShift32.prototype.setState = function (s) {
    this.s = s >>> 0;
  };

  // ---------------- 确定性哈希：FNV-1a 32bit ----------------
  function fnv1a(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function intsToBytes(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i] >>> 0;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    }
    return out;
  }

  // ---------------- 增量式游戏对象 ----------------
  /**
   * @param {number} seed 32 位整数种子（双方 commit-reveal 共同决定）
   */
  function DeterministicGame(seed) {
    this.seed = seed >>> 0;
    this.rng = new XorShift32(this.seed);
    this.tick = 0;
    this.score0 = 0; // 玩家 0 得分（攻右门）
    this.score1 = 0; // 玩家 1 得分（攻左门）
    this.totalInputs = 0; // 累计应用的施力次数（纳入指纹，防输入数篡改）
    this.finished = false;
    this._resetBall();
  }

  // 进球/开局：球回中心，速度由 RNG 决定（seed 真正影响对局）
  DeterministicGame.prototype._resetBall = function () {
    this.ballX = PHYS.FIELD_W / 2;
    this.ballY = PHYS.FIELD_H / 2;
    this.vx = (this.rng.next() % 801) - 400; // [-400, 400]
    this.vy = (this.rng.next() % 801) - 400;
  };

  /**
   * 推进一个 tick。
   * @param {Array} tickInputs 本 tick 的施力输入数组 [{player, dx, dy, power}]
   */
  DeterministicGame.prototype.step = function (tickInputs) {
    if (this.finished) return;

    // ---- 1. 施力 ----
    if (tickInputs) {
      for (var i = 0; i < tickInputs.length; i++) {
        var ti = tickInputs[i];
        var canFlick =
          (ti.player === 0 && this.ballX >= PHYS.FIELD_W / 2) ||
          (ti.player === 1 && this.ballX <= PHYS.FIELD_W / 2);
        if (canFlick) {
          this.vx += Math.trunc((ti.dx * ti.power) / 1000);
          this.vy += Math.trunc((ti.dy * ti.power) / 1000);
          this.totalInputs++;
        }
      }
    }

    // ---- 2. 位置积分 ----
    this.ballX += this.vx;
    this.ballY += this.vy;

    // ---- 3. 摩擦 ----
    this.vx = Math.trunc((this.vx * PHYS.FRICTION_NUM) / PHYS.FRICTION_DEN);
    this.vy = Math.trunc((this.vy * PHYS.FRICTION_NUM) / PHYS.FRICTION_DEN);

    // ---- 4. 上下边界反弹 ----
    if (this.ballY < PHYS.BALL_R) {
      this.ballY = PHYS.BALL_R + (PHYS.BALL_R - this.ballY);
      this.vy = Math.trunc(-(this.vy * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    } else if (this.ballY > PHYS.FIELD_H - PHYS.BALL_R) {
      this.ballY = PHYS.FIELD_H - PHYS.BALL_R - (this.ballY - (PHYS.FIELD_H - PHYS.BALL_R));
      this.vy = Math.trunc(-(this.vy * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    }

    // ---- 5. 进球判定 ----
    var inGoalY =
      this.ballY >= PHYS.FIELD_H / 2 - PHYS.GOAL_HALF_H &&
      this.ballY <= PHYS.FIELD_H / 2 + PHYS.GOAL_HALF_H;

    if (this.ballX < PHYS.BALL_R) {
      if (inGoalY) {
        this.score1++; // 球进左门 → 玩家 1 得分
        this._resetBall();
      } else {
        this.ballX = PHYS.BALL_R + (PHYS.BALL_R - this.ballX);
        this.vx = Math.trunc(-(this.vx * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
      }
    } else if (this.ballX > PHYS.FIELD_W - PHYS.BALL_R) {
      if (inGoalY) {
        this.score0++; // 球进右门 → 玩家 0 得分
        this._resetBall();
      } else {
        this.ballX = PHYS.FIELD_W - PHYS.BALL_R - (this.ballX - (PHYS.FIELD_W - PHYS.BALL_R));
        this.vx = Math.trunc(-(this.vx * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
      }
    }

    // ---- 6. 推进 tick ----
    this.tick++;

    // ---- 7. 终止 ----
    if (this.score0 >= PHYS.WIN_SCORE || this.score1 >= PHYS.WIN_SCORE || this.tick >= PHYS.MAX_TICKS) {
      this.finished = true;
    }
  };

  // ---------------- 快照 / 恢复 ----------------
  DeterministicGame.prototype.snapshot = function () {
    return {
      rngState: this.rng.getState(),
      tick: this.tick,
      ballX: this.ballX,
      ballY: this.ballY,
      vx: this.vx,
      vy: this.vy,
      score0: this.score0,
      score1: this.score1,
      totalInputs: this.totalInputs,
      finished: this.finished
    };
  };

  DeterministicGame.prototype.restore = function (snap) {
    this.rng.setState(snap.rngState);
    this.tick = snap.tick;
    this.ballX = snap.ballX;
    this.ballY = snap.ballY;
    this.vx = snap.vx;
    this.vy = snap.vy;
    this.score0 = snap.score0;
    this.score1 = snap.score1;
    this.totalInputs = snap.totalInputs;
    this.finished = snap.finished;
  };

  // ---------------- 状态指纹 ----------------
  DeterministicGame.prototype.stateHash = function () {
    var ints = [
      this.seed,
      this.ballX, this.ballY, this.vx, this.vy,
      this.score0, this.score1,
      this.tick,
      this.totalInputs
    ];
    return fnv1a(intsToBytes(ints));
  };

  return {
    PHYS: PHYS,
    XorShift32: XorShift32,
    fnv1a: fnv1a,
    DeterministicGame: DeterministicGame
  };
});
