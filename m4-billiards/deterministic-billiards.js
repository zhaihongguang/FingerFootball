/**
 * ============================================================
 * 台球式指尖足球 — 确定性物理引擎（11 球：双方各 5 母球 + 1 足球，回合制）
 * ------------------------------------------------------------
 * 玩法（回合制，只算足球进球）：
 *   - 玩家 0（人类）5 颗母球在右半场，攻左门；玩家 1（AI）5 颗在左半场，攻右门
 *   - 每回合选择自己一颗未进袋的母球，用它撞「足球」，把足球撞进对方球门
 *   - 足球进左门 → 玩家0 得分；足球进右门 → 玩家1 得分
 *   - 任一母球进任意门 → 犯规，对方得分
 *   - 无进球无犯规 → 球停在原地，换对方（借力布局多回合）
 *   - 先到 WIN_SCORE 分胜
 *
 * 硬约束（确定性生死线，全程整数，禁浮点）：
 *   - 位置/速度整数，除法一律 Math.trunc 向零取整
 *   - 碰撞响应等质量完全弹性，冲量 = dot/distSq（定点），无需开方
 *   - 位置分离用整数开方 isqrt（牛顿迭代，确定性）
 *   - 确定性 PRNG（xorshift32）
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Billiards = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------- 物理常量（整数，1 米 = 1000 单元） ----------------
  var PHYS = {
    FIELD_W: 8000,          // 场宽 8 米
    FIELD_H: 4500,          // 场高 4.5 米
    BALL_R: 110,            // 球半径 0.11 米（母球与足球同尺寸）
    GOAL_HALF_H: 750,       // 球门半高 0.75 米
    FRICTION_NUM: 97,       // 摩擦分子
    FRICTION_DEN: 100,      // 摩擦分母
    RESTITUTION_NUM: 8,     // 墙弹性分子
    RESTITUTION_DEN: 10,    // 墙弹性分母
    MAX_SPEED: 180,         // 击球最大初速（单位/tick），必须 < 2*BALL_R(220) 防隧穿
    STOP_EPS: 30,           // 低于此速度视为静止（单位/tick）
    WIN_SCORE: 5,           // 先到 5 分胜
    FIXED: 1000000,         // 碰撞冲量定点精度
    SUBSTEPS: 8,            // 每 tick 分成多少子步做碰撞检测，消除高速跨格隧穿
    CUE_COUNT: 5,           // 每方母球数量
    FOOTBALL_INDEX: 10,     // 足球在 balls 数组中的索引（0-4=玩家0母球, 5-9=玩家1母球, 10=足球）
    TOTAL_BALLS: 11,        // 0-4 P0母球, 5-9 P1母球, 10 足球
    // 开局足球位置
    START_BALL: { x: 4000, y: 2250 },
    // 母球进袋后的放回点（玩家0 在右半场，玩家1 在左半场；分散且不重叠）
    CUE_SPOTS: [
      { x: 5800, y: 1800 },
      { x: 6100, y: 2700 },
      { x: 5400, y: 2250 },
      { x: 6500, y: 1300 },
      { x: 6500, y: 3200 }
    ]
  };

  // 进球侧（用于区分左右门）
  var GOAL_NONE = 0, GOAL_LEFT = 1, GOAL_RIGHT = 2;

  // ---------------- 确定性 PRNG：xorshift32（可快照） ----------------
  function XorShift32(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  XorShift32.prototype.next = function () {
    this.s ^= this.s << 13; this.s >>>= 0;
    this.s ^= this.s >> 17;
    this.s ^= this.s << 5;  this.s >>>= 0;
    return this.s >>> 0;
  };
  XorShift32.prototype.getState = function () { return this.s >>> 0; };
  XorShift32.prototype.setState = function (s) { this.s = s >>> 0; };

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

  // ---------------- 整数开方（牛顿迭代，确定性） ----------------
  function isqrt(n) {
    if (n <= 0) return 0;
    var x = n;
    var y = (x + 1) >> 1;
    while (y < x) {
      x = y;
      y = (x + Math.trunc(n / x)) >> 1;
    }
    return x;
  }

  // ---------------- 游戏对象 ----------------
  /**
   * @param {number} seed 32 位种子（当前布局固定，seed 保留供未来随机开局）
   */
  function BilliardsGame(seed) {
    this.seed = seed >>> 0;
    this.rng = new XorShift32(this.seed);
    this.turn = 0;         // 当前击球方 0 或 1
    this.score0 = 0;
    this.score1 = 0;
    this.finished = false;
    this.phase = "aiming"; // aiming（瞄准）| moving（运动）
    this.shotCount = 0;    // 累计击球次数（纳入指纹）
    this.winner = -1;      // -1 未结束，0/1 胜者
    this.selectedCue = 0;  // 当前选择的母球编号 0..4（本回合用哪颗）
    // 球数组：[0-4]=玩家0母球, [5-9]=玩家1母球, [10]=足球
    this.balls = [];
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      this.balls.push({ x: 0, y: 0, vx: 0, vy: 0, pocketed: false, pocketSide: GOAL_NONE, player: i < 5 ? 0 : (i < 10 ? 1 : -1), cueNo: i < 10 ? (i % 5) : -1 });
    }
    this.resetPositions();
  }

  // 复位到开局布局（进球/犯规后调用）
  BilliardsGame.prototype.resetPositions = function () {
    // 玩家0（攻左门）5 颗母球分布在右半场；玩家1（攻右门）5 颗在左半场；足球居中
    var p0 = [
      { x: 5800, y: 1800 },
      { x: 5800, y: 2700 },
      { x: 5200, y: 2250 },
      { x: 6400, y: 1300 },
      { x: 6400, y: 3200 }
    ];
    var p1 = [
      { x: 2200, y: 1800 },
      { x: 2200, y: 2700 },
      { x: 2800, y: 2250 },
      { x: 1600, y: 1300 },
      { x: 1600, y: 3200 }
    ];
    for (var i = 0; i < 5; i++) {
      this.balls[i].x = p0[i].x; this.balls[i].y = p0[i].y;
      this.balls[i].vx = 0; this.balls[i].vy = 0;
      this.balls[i].pocketed = false; this.balls[i].pocketSide = GOAL_NONE;
    }
    for (var j = 0; j < 5; j++) {
      this.balls[5 + j].x = p1[j].x; this.balls[5 + j].y = p1[j].y;
      this.balls[5 + j].vx = 0; this.balls[5 + j].vy = 0;
      this.balls[5 + j].pocketed = false; this.balls[5 + j].pocketSide = GOAL_NONE;
    }
    this.balls[PHYS.FOOTBALL_INDEX].x = PHYS.START_BALL.x;
    this.balls[PHYS.FOOTBALL_INDEX].y = PHYS.START_BALL.y;
    this.balls[PHYS.FOOTBALL_INDEX].vx = 0; this.balls[PHYS.FOOTBALL_INDEX].vy = 0;
    this.balls[PHYS.FOOTBALL_INDEX].pocketed = false; this.balls[PHYS.FOOTBALL_INDEX].pocketSide = GOAL_NONE;
    this.phase = "aiming";
    this.selectedCue = 0;
  };

  /**
   * 击球（仅在 aiming 阶段、且轮到该玩家时有效）
   * @param {number} cueIndex 要击出的母球编号 0..4（未传默认当前 selectedCue）
   * @param {number} vx 母球初速 x 分量（-MAX_SPEED..MAX_SPEED）
   * @param {number} vy 母球初速 y 分量
   * @returns {boolean} 是否成功击出
   */
  BilliardsGame.prototype.shoot = function (cueIndex, vx, vy) {
    if (this.phase !== "aiming" || this.finished) return false;
    if (typeof cueIndex === "undefined" || cueIndex === null) cueIndex = this.selectedCue;
    if (cueIndex < 0 || cueIndex >= PHYS.CUE_COUNT) return false;
    var ballIndex = this.turn === 0 ? cueIndex : PHYS.CUE_COUNT + cueIndex;
    var cue = this.balls[ballIndex];
    if (cue.pocketed) return false;
    vx = Math.max(-PHYS.MAX_SPEED, Math.min(PHYS.MAX_SPEED, Math.trunc(vx)));
    vy = Math.max(-PHYS.MAX_SPEED, Math.min(PHYS.MAX_SPEED, Math.trunc(vy)));
    cue.vx = vx;
    cue.vy = vy;
    this.phase = "moving";
    this.shotCount++;
    return true;
  };

  /**
   * 推进一个 tick（moving 阶段调用）
   * 内部拆成 SUBSTEPS 个子步，每子步只移动速度/SUBSTEPS，
   * 这样每个子步位移远小于球径，消除「母球跨过足球」的隧穿。
   */
  BilliardsGame.prototype.step = function () {
    if (this.phase !== "moving" || this.finished) return;
    for (var s = 0; s < PHYS.SUBSTEPS; s++) {
      this._stepSub(s === PHYS.SUBSTEPS - 1);
      if (this.phase !== "moving" || this.finished) break;
    }
    // 摩擦每 tick 只施加一次（不会误伤子步内位移，也避免 8 倍减速）
    if (this.phase === "moving" && !this.finished) {
      for (var i2 = 0; i2 < PHYS.TOTAL_BALLS; i2++) {
        var b2 = this.balls[i2];
        if (b2.pocketed) continue;
        b2.vx = Math.trunc((b2.vx * PHYS.FRICTION_NUM) / PHYS.FRICTION_DEN);
        b2.vy = Math.trunc((b2.vy * PHYS.FRICTION_NUM) / PHYS.FRICTION_DEN);
      }
    }
  };

  BilliardsGame.prototype._stepSub = function (isLast) {
    var sub = PHYS.SUBSTEPS;

    // 1. 位置积分（每子步移动速度/sub，最后子步补余数）
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      var b = this.balls[i];
      if (b.pocketed) continue;
      b.x += Math.trunc(b.vx / sub);
      b.y += Math.trunc(b.vy / sub);
      if (isLast) {
        b.x += b.vx % sub;
        b.y += b.vy % sub;
      }
    }

    // 2. 球-球碰撞（每子步检测，全量两两配对）
    this._collideAll();

    // 3. 墙碰撞 + 进球检测
    for (var i3 = 0; i3 < PHYS.TOTAL_BALLS; i3++) {
      if (!this.balls[i3].pocketed) this._handleWall(i3);
    }

    // 4. 静止检测
    if (this._allStopped()) this._resolveTurn();
  };

  BilliardsGame.prototype._collideAll = function () {
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      for (var j = i + 1; j < PHYS.TOTAL_BALLS; j++) {
        this._collidePair(i, j);
      }
    }
  };

  // 一直推进到回合结束（供自测/快速结算用）
  BilliardsGame.prototype.runToRest = function () {
    var guard = 0;
    while (this.phase === "moving" && !this.finished && guard < 100000) {
      this.step();
      guard++;
    }
    return this.phase;
  };

  // ---------------- 碰撞：等质量完全弹性（定点冲量，无需开方） ----------------
  BilliardsGame.prototype._collidePair = function (i, j) {
    var a = this.balls[i];
    var b = this.balls[j];
    if (a.pocketed || b.pocketed) return;

    var dx = b.x - a.x;         // 从 a 指向 b
    var dy = b.y - a.y;
    var minDist = PHYS.BALL_R * 2;
    var distSq = dx * dx + dy * dy;
    if (distSq === 0 || distSq >= minDist * minDist) return; // 未碰撞

    // 相对速度 a - b，沿 d 的投影；>0 表示正在接近
    var rvx = a.vx - b.vx;
    var rvy = a.vy - b.vy;
    var dot = rvx * dx + rvy * dy;
    if (dot <= 0) return; // 正在分离

    // 冲量 j = dot / distSq（定点），等质量完全弹性
    var j = Math.trunc((dot * PHYS.FIXED) / distSq);
    var dvx = Math.trunc((j * dx) / PHYS.FIXED);
    var dvy = Math.trunc((j * dy) / PHYS.FIXED);
    a.vx -= dvx; a.vy -= dvy;
    b.vx += dvx; b.vy += dvy;

    // 位置分离：把两球沿 d 分开到刚好 minDist（消除穿透）
    var dist = isqrt(distSq);
    if (dist === 0) return;
    var overlap = minDist - dist;
    if (overlap > 0) {
      var ox = Math.trunc((dx * overlap) / (dist * 2));
      var oy = Math.trunc((dy * overlap) / (dist * 2));
      a.x -= ox; a.y -= oy;
      b.x += ox; b.y += oy;
    }
  };

  // ---------------- 墙碰撞 + 进球 ----------------
  BilliardsGame.prototype._handleWall = function (i) {
    var b = this.balls[i];
    var centerY = PHYS.FIELD_H / 2;
    var inGoalY = b.y >= centerY - PHYS.GOAL_HALF_H && b.y <= centerY + PHYS.GOAL_HALF_H;

    // 左右球门 / 边线
    if (b.x < PHYS.BALL_R) {
      if (inGoalY) { this._pocket(i, GOAL_LEFT); return; }
      b.x = PHYS.BALL_R + (PHYS.BALL_R - b.x);
      b.vx = Math.trunc(-(b.vx * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    } else if (b.x > PHYS.FIELD_W - PHYS.BALL_R) {
      if (inGoalY) { this._pocket(i, GOAL_RIGHT); return; }
      b.x = PHYS.FIELD_W - PHYS.BALL_R - (b.x - (PHYS.FIELD_W - PHYS.BALL_R));
      b.vx = Math.trunc(-(b.vx * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    }

    // 上下边线
    if (b.y < PHYS.BALL_R) {
      b.y = PHYS.BALL_R + (PHYS.BALL_R - b.y);
      b.vy = Math.trunc(-(b.vy * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    } else if (b.y > PHYS.FIELD_H - PHYS.BALL_R) {
      b.y = PHYS.FIELD_H - PHYS.BALL_R - (b.y - (PHYS.FIELD_H - PHYS.BALL_R));
      b.vy = Math.trunc(-(b.vy * PHYS.RESTITUTION_NUM) / PHYS.RESTITUTION_DEN);
    }
  };

  // 进袋：移出场外，记录进的是哪个门
  BilliardsGame.prototype._pocket = function (i, side) {
    var b = this.balls[i];
    b.pocketed = true;
    b.pocketSide = side;
    b.x = -100000;
    b.y = -100000;
    b.vx = 0;
    b.vy = 0;
  };

  BilliardsGame.prototype._allStopped = function () {
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      var b = this.balls[i];
      if (b.pocketed) continue;
      if (b.vx > PHYS.STOP_EPS || b.vx < -PHYS.STOP_EPS) return false;
      if (b.vy > PHYS.STOP_EPS || b.vy < -PHYS.STOP_EPS) return false;
    }
    return true;
  };

  // ---------------- 回合结算 ----------------
  BilliardsGame.prototype._resolveTurn = function () {
    // 无论是否有进球/犯规，回合结束时都必须把残余速度清零。
    for (var vi = 0; vi < PHYS.TOTAL_BALLS; vi++) {
      this.balls[vi].vx = 0;
      this.balls[vi].vy = 0;
    }

    var football = this.balls[PHYS.FOOTBALL_INDEX];

    // 母球进网：只标记需要放回场地，不判犯规、不加分
    var cuePocketed = false;
    for (var c = 0; c < PHYS.TOTAL_BALLS - 1; c++) {
      if (this.balls[c].pocketed) { cuePocketed = true; break; }
    }

    var scored = false;

    // 足球进球（映射：玩家0 在右半场攻左门，玩家1 在左半场攻右门）
    if (football.pocketed) {
      if (football.pocketSide === GOAL_LEFT) {
        this.score0++; // 足球进左门 → 玩家0 得分
        scored = true;
      } else if (football.pocketSide === GOAL_RIGHT) {
        this.score1++; // 足球进右门 → 玩家1 得分
        scored = true;
      }
    }

    // 胜负判定
    if (this.score0 >= PHYS.WIN_SCORE) { this.winner = 0; this.finished = true; }
    else if (this.score1 >= PHYS.WIN_SCORE) { this.winner = 1; this.finished = true; }

    if (!this.finished) {
      // 足球得分 → 整场复位（所有母球 + 足球回开局位置）
      // 仅母球进网 → 只把进袋母球放回球座，保留其他球位置
      if (scored) {
        this.resetPositions();
      } else if (cuePocketed) {
        this.spotPocketedCues();
      }
      this.turn = 1 - this.turn;
    } else {
      this.phase = "finished";
    }
  };

  // 把进袋母球放回各自半场球座，并清理残留速度
  BilliardsGame.prototype.spotPocketedCues = function () {
    for (var i = 0; i < PHYS.TOTAL_BALLS - 1; i++) {
      var b = this.balls[i];
      if (!b.pocketed) continue;
      var spot = PHYS.CUE_SPOTS[i % PHYS.CUE_COUNT];
      var player = i < PHYS.CUE_COUNT ? 0 : 1;
      b.x = player === 1 ? PHYS.FIELD_W - spot.x : spot.x;
      b.y = spot.y;
      b.vx = 0;
      b.vy = 0;
      b.pocketed = false;
      b.pocketSide = GOAL_NONE;
    }
  };

  // 5 分钟对局到点结束：按当前比分判定胜负，平局 winner=-1
  BilliardsGame.prototype.finishByScore = function () {
    if (this.finished) return;
    this.winner = this.score0 === this.score1 ? -1 : (this.score0 > this.score1 ? 0 : 1);
    this.finished = true;
    this.phase = "finished";
    for (var vi = 0; vi < PHYS.TOTAL_BALLS; vi++) {
      this.balls[vi].vx = 0;
      this.balls[vi].vy = 0;
    }
  };

  // ---------------- 状态指纹 ----------------
  BilliardsGame.prototype.stateHash = function () {
    var ints = [
      this.seed,
      this.turn,
      this.score0, this.score1,
      this.shotCount,
      this.selectedCue
    ];
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      var b = this.balls[i];
      ints.push(b.x, b.y, b.vx, b.vy, b.pocketed ? 1 : 0, b.pocketSide);
    }
    return fnv1a(intsToBytes(ints));
  };

  // 快照 / 恢复
  BilliardsGame.prototype.snapshot = function () {
    return {
      rngState: this.rng.getState(),
      turn: this.turn,
      score0: this.score0,
      score1: this.score1,
      finished: this.finished,
      winner: this.winner,
      phase: this.phase,
      shotCount: this.shotCount,
      selectedCue: this.selectedCue,
      balls: this.balls.map(function (b) {
        return { x: b.x, y: b.y, vx: b.vx, vy: b.vy, pocketed: b.pocketed, pocketSide: b.pocketSide, player: b.player, cueNo: b.cueNo };
      })
    };
  };
  BilliardsGame.prototype.restore = function (s) {
    this.rng.setState(s.rngState);
    this.turn = s.turn;
    this.score0 = s.score0;
    this.score1 = s.score1;
    this.finished = s.finished;
    this.winner = s.winner;
    this.phase = s.phase;
    this.shotCount = s.shotCount;
    this.selectedCue = s.selectedCue;
    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      this.balls[i].x = s.balls[i].x;
      this.balls[i].y = s.balls[i].y;
      this.balls[i].vx = s.balls[i].vx;
      this.balls[i].vy = s.balls[i].vy;
      this.balls[i].pocketed = s.balls[i].pocketed;
      this.balls[i].pocketSide = s.balls[i].pocketSide;
      this.balls[i].player = s.balls[i].player;
      this.balls[i].cueNo = s.balls[i].cueNo;
    }
  };

  return {
    PHYS: PHYS,
    GOAL_NONE: GOAL_NONE,
    GOAL_LEFT: GOAL_LEFT,
    GOAL_RIGHT: GOAL_RIGHT,
    XorShift32: XorShift32,
    fnv1a: fnv1a,
    isqrt: isqrt,
    BilliardsGame: BilliardsGame
  };
});
