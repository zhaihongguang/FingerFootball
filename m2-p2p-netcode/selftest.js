/**
 * ============================================================
 * M2 Rollback Netcode 自测
 * ------------------------------------------------------------
 * 验证内容：
 *   1. 双方各自独立运行 rollback 会话 → 结束时状态指纹一致
 *   2. 乱序/延迟到达的远端输入 → 回滚重放后仍一致
 *   3. 非法输入被丢弃，不影响一致性
 *
 * 运行：node selftest.js
 * ============================================================
 */
var DetGame = require("./deterministic-game.js");
var Protocol = require("./protocol.js");
var Signer = require("./signer.js");
var Rollback = require("./rollback.js");

var pass = 0, fail = 0;
function assertEqual(a, b, label) {
  if (a === b) { pass++; console.log("  ✔ " + label + ": " + a); }
  else { fail++; console.log("  ✘ " + label + ": 期望 " + b + "，实际 " + a); }
}

console.log("=== M2 Rollback Netcode 自测 ===\n");

// 固定参数
var SEED = 0x12345678;
var MATCH_ID = "0x" + "ab".repeat(32);

// 模拟双方
var signerA = Signer.createMockSigner("aaaa");
var signerB = Signer.createMockSigner("bbbb");

// 用一个队列模拟 P2P 通道（带可配置延迟）
function makeChannel() {
  return { queue: [], delay: 0 };
}

console.log("[1] 双方同步运行，结束时指纹一致");
{
  var chA = makeChannel();
  var chB = makeChannel();

  var sessionA = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 0, signer: signerA,
    onSend: function (ev) { chB.queue.push(ev); }
  });
  var sessionB = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 1, signer: signerB,
    onSend: function (ev) { chA.queue.push(ev); }
  });

  // 双方交替施力，推进相同 tick
  for (var t = 0; t < 3600; t++) {
    if (t % 60 === 0) sessionA.flick(500, -200, 800);   // A 施力
    if (t % 60 === 30) sessionB.flick(-500, 200, 800);  // B 施力
    // 传递对方消息（无延迟）
    while (chA.queue.length) sessionA.onRemoteEvent(chA.queue.shift());
    while (chB.queue.length) sessionB.onRemoteEvent(chB.queue.shift());
    sessionA.advance();
    sessionB.advance();
  }

  assertEqual(sessionA.stateHash(), sessionB.stateHash(), "双方状态指纹一致");
  console.log("    A 指纹 = 0x" + sessionA.stateHash().toString(16));
  console.log("    B 指纹 = 0x" + sessionB.stateHash().toString(16));
  console.log("    比分 = " + sessionA.score()[0] + " : " + sessionA.score()[1] + "\n");
}

console.log("[2] 乱序/延迟到达，回滚重放后仍一致");
{
  var chA = makeChannel();
  var chB = makeChannel();

  var sessionA = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 0, signer: signerA,
    onSend: function (ev) { chB.queue.push(ev); }
  });
  var sessionB = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 1, signer: signerB,
    onSend: function (ev) { chA.queue.push(ev); }
  });

  // 故意把 A 的消息延迟 10 tick 投递，制造「落后输入 → 回滚」
  var delayedA = [];
  for (var t = 0; t < 3600; t++) {
    if (t % 60 === 0) sessionA.flick(400, -300, 700);
    if (t % 60 === 30) sessionB.flick(-400, 300, 700);

    // 投递对方消息：A 的消息延迟，B 的消息即时
    while (chA.queue.length) {
      var ev = chA.queue.shift();
      delayedA.push({ ev: ev, deliverAt: ev.tick + 10 });
    }
    // 投递到期的延迟消息
    for (var i = delayedA.length - 1; i >= 0; i--) {
      if (delayedA[i].deliverAt <= t) {
        sessionA.onRemoteEvent(delayedA[i].ev);
        delayedA.splice(i, 1);
      }
    }
    while (chB.queue.length) sessionB.onRemoteEvent(chB.queue.shift());

    sessionA.advance();
    sessionB.advance();
  }

  assertEqual(sessionA.stateHash(), sessionB.stateHash(), "延迟+回滚后指纹一致");
  console.log("    A 指纹 = 0x" + sessionA.stateHash().toString(16));
  console.log("    B 指纹 = 0x" + sessionB.stateHash().toString(16));
  console.log("    比分 = " + sessionA.score()[0] + " : " + sessionA.score()[1] + "\n");
}

console.log("[3] 非法输入被丢弃，不影响一致性");
{
  var chA = makeChannel();
  var chB = makeChannel();

  var sessionA = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 0, signer: signerA,
    onSend: function (ev) { chB.queue.push(ev); }
  });
  var sessionB = new Rollback.RollbackSession({
    seed: SEED, matchId: MATCH_ID, player: 1, signer: signerB,
    onSend: function (ev) { chA.queue.push(ev); }
  });

  for (var t = 0; t < 3600; t++) {
    if (t % 60 === 0) sessionA.flick(500, -200, 800);
    if (t % 60 === 30) sessionB.flick(-500, 200, 800);

    // 注入非法输入（dx 超范围），应从 B 端被丢弃
    if (t === 1000) {
      sessionB.onRemoteEvent({
        type: "input", matchId: MATCH_ID, tick: t,
        player: 0, dx: 99999, dy: 0, power: 500, signature: "fake"
      });
    }

    while (chA.queue.length) sessionA.onRemoteEvent(chA.queue.shift());
    while (chB.queue.length) sessionB.onRemoteEvent(chB.queue.shift());
    sessionA.advance();
    sessionB.advance();
  }

  assertEqual(sessionA.stateHash(), sessionB.stateHash(), "非法输入丢弃后指纹一致");
  console.log("    A 指纹 = 0x" + sessionA.stateHash().toString(16));
  console.log("    B 指纹 = 0x" + sessionB.stateHash().toString(16) + "\n");
}

// ---- 汇总 ----
console.log("=== 结果 ===");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fail === 0) {
  console.log("✅ M2 Rollback Netcode 验证通过：双端乱序/延迟/非法输入下仍逐位一致。");
  process.exitCode = 0;
} else {
  console.log("❌ 存在失败项。");
  process.exitCode = 1;
}
