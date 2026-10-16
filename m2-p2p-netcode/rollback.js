/**
 * ============================================================
 * Rollback Netcode 会话（M2）
 * ------------------------------------------------------------
 * 基于确定性引擎的「回滚重放」：
 *   - 本地施力立即生效（零输入延迟，手感最好）
 *   - 收到对方「落后 tick」的输入时，回滚到该 tick 重放
 *   - 因为引擎确定性，回滚重放结果与对方逐位一致
 *
 * 为什么选 rollback 而非固定锁步：
 *   指尖足球是离散施力（几秒一次），rollback 极少触发，
 *   且不需要处理「空输入歧义」，实现更干净、手感更佳。
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./deterministic-game.js"), require("./protocol.js"));
  } else {
    root.Rollback = factory(root.DetGame, root.Protocol);
  }
})(typeof self !== "undefined" ? self : this, function (DetGame, Protocol) {
  "use strict";

  /**
   * @param {object} opts
   *   - seed       32 位整数种子（双方 commit-reveal 共同决定）
   *   - matchId    32 字节 hex
   *   - player     本端玩家编号 0 或 1
   *   - signer     签名器（{ signInput(ev) -> signature }）
   *   - onSend     回调 (signedEvent) => void，把事件广播给对方
   */
  function RollbackSession(opts) {
    this.game = new DetGame.DeterministicGame(opts.seed);
    this.matchId = opts.matchId;
    this.me = opts.player;
    this.signer = opts.signer;
    this.onSend = opts.onSend;

    this.history = [];       // history[tick] = 该 tick step 前的完整快照
    this.localEvents = {};   // tick -> [event]（本端施力）
    this.remoteEvents = {};  // tick -> [event]（对方施力，已验签）
    this.pendingLocal = [];  // 本 tick 待广播的本地事件
    this.appliedCount = 0;   // 已应用（生效）的施力次数统计
  }

  // ---------------- 每帧推进（渲染循环调用，60Hz） ----------------
  RollbackSession.prototype.advance = function () {
    var tick = this.game.tick;
    // 保存快照（供回滚）
    this.history[tick] = this.game.snapshot();

    // 本 tick 输入 = 本地 + 远端（都按 tick 索引）
    var inputs = [];
    var le = this.localEvents[tick];
    var re = this.remoteEvents[tick];
    if (le) for (var i = 0; i < le.length; i++) inputs.push(le[i]);
    if (re) for (var j = 0; j < re.length; j++) inputs.push(re[j]);

    this.game.step(inputs);

    // 广播本 tick 的本地事件（已签名）
    var mine = this.pendingLocal;
    this.pendingLocal = [];
    for (var k = 0; k < mine.length; k++) {
      this.onSend(mine[k]);
    }
  };

  // ---------------- 本地施力 ----------------
  RollbackSession.prototype.flick = function (dx, dy, power) {
    var ev = Protocol.createInputEvent(
      this.matchId, this.game.tick, this.me, dx, dy, power
    );
    ev.signature = this.signer.signInput(ev);
    if (!this.localEvents[ev.tick]) this.localEvents[ev.tick] = [];
    this.localEvents[ev.tick].push(ev);
    this.pendingLocal.push(ev);
    return ev;
  };

  // ---------------- 收到对方事件（网络回调触发） ----------------
  RollbackSession.prototype.onRemoteEvent = function (ev) {
    if (!Protocol.isValidInput(ev)) return; // 非法输入直接丢弃
    if (ev.player === this.me) return;      // 不是对方发来的
    if (ev.matchId !== this.matchId) return;

    if (!this.remoteEvents[ev.tick]) this.remoteEvents[ev.tick] = [];
    this.remoteEvents[ev.tick].push(ev);

    // 如果事件 tick 落后于当前已执行 tick → 回滚重放
    if (ev.tick < this.game.tick) {
      this._rollback(ev.tick);
    }
  };

  // ---------------- 回滚重放 ----------------
  RollbackSession.prototype._rollback = function (fromTick) {
    var snap = this.history[fromTick];
    if (!snap) return; // 快照缺失（异常），放弃回滚
    var currentTick = this.game.tick; // 回滚前的当前 tick（必须先记住，restore 会覆盖）
    this.game.restore(snap);
    // 从 fromTick 重放到回滚前的当前 tick（此时新到的远端输入已并入 remoteEvents）
    for (var t = fromTick; t < currentTick; t++) {
      this.history[t] = this.game.snapshot(); // 刷新快照，支持后续再次回滚
      var inputs = [];
      var le = this.localEvents[t];
      var re = this.remoteEvents[t];
      if (le) for (var i = 0; i < le.length; i++) inputs.push(le[i]);
      if (re) for (var j = 0; j < re.length; j++) inputs.push(re[j]);
      this.game.step(inputs);
    }
  };

  // ---------------- 状态查询 ----------------
  RollbackSession.prototype.isFinished = function () {
    return this.game.finished;
  };
  RollbackSession.prototype.stateHash = function () {
    return this.game.stateHash();
  };
  RollbackSession.prototype.score = function () {
    return [this.game.score0, this.game.score1];
  };
  RollbackSession.prototype.currentTick = function () {
    return this.game.tick;
  };

  return {
    RollbackSession: RollbackSession
  };
});
