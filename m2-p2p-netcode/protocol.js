/**
 * ============================================================
 * 消息协议 + 规范化序列化（M2）
 * ------------------------------------------------------------
 * 定义 P2P 对局中交换的消息结构与「签名内容」的确定性编码。
 *
 * 签名内容的编码必须跨端、跨语言一致，否则验签失败。
 * 这里用 FNV-1a（自测确定性够用）；正式版签名应换成
 * keccak256(abi.encodePacked(matchId, tick, player, dx, dy, power))，
 * 用 ethers 的 solidityPackedKeccak256 实现，防碰撞攻击。
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Protocol = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MATCH_ID_BYTES = 32; // matchId = bytes32

  // ---------------- FNV-1a 32bit（与引擎一致的确定性哈希） ----------------
  function fnv1a(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // ---------------- hex <-> bytes ----------------
  function hexToBytes(hex) {
    var s = hex.replace(/^0x/, "");
    if (s.length % 2) s = "0" + s;
    var out = [];
    for (var i = 0; i < s.length; i += 2) {
      out.push(parseInt(s.substr(i, 2), 16));
    }
    return out;
  }
  function bytesToHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) {
      s += ("0" + bytes[i].toString(16)).slice(-2);
    }
    return "0x" + s;
  }

  // ---------------- 大端 push（与引擎 intsToBytes 一致） ----------------
  function pushU32(bytes, v) {
    var x = v >>> 0;
    bytes.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  }
  function pushI32(bytes, v) {
    pushU32(bytes, v >>> 0); // 有符号转补码无符号
  }

  // ---------------- 施力输入事件 ----------------
  /**
   * 创建一条施力输入事件（未签名）。
   * @param {string} matchId 32 字节 hex
   * @param {number} tick    生效 tick
   * @param {number} player  0 或 1
   * @param {number} dx      -1000..1000
   * @param {number} dy      -1000..1000
   * @param {number} power   0..1000
   */
  function createInputEvent(matchId, tick, player, dx, dy, power) {
    return {
      type: "input",
      matchId: matchId,
      tick: tick | 0,
      player: player | 0,
      dx: dx | 0,
      dy: dy | 0,
      power: power | 0,
      signature: null
    };
  }

  // 规范化序列化（不含 signature 字段本身）
  function serializeInputEvent(ev) {
    var bytes = [];
    var mid = hexToBytes(ev.matchId);
    // 补齐/截断到 32 字节
    while (mid.length < MATCH_ID_BYTES) mid.unshift(0);
    mid = mid.slice(0, MATCH_ID_BYTES);
    for (var i = 0; i < mid.length; i++) bytes.push(mid[i]);

    pushU32(bytes, ev.tick);
    bytes.push(ev.player & 0xff);
    pushI32(bytes, ev.dx);
    pushI32(bytes, ev.dy);
    pushI32(bytes, ev.power);
    return bytes;
  }

  // 签名内容摘要（确定性 32-bit hex）
  function inputDigest(ev) {
    var h = fnv1a(serializeInputEvent(ev));
    return "0x" + ("00000000" + h.toString(16)).slice(-8);
  }

  // 输入范围校验（防非法操作注入）
  function isValidInput(ev) {
    if (ev.type !== "input") return false;
    if (ev.player !== 0 && ev.player !== 1) return false;
    if (ev.dx < -1000 || ev.dx > 1000) return false;
    if (ev.dy < -1000 || ev.dy > 1000) return false;
    if (ev.power < 0 || ev.power > 1000) return false;
    if (ev.tick < 0) return false;
    return true;
  }

  // ---------------- 消息类型常量 ----------------
  var MSG = {
    SEED_COMMIT: "seed_commit",
    SEED_REVEAL: "seed_reveal",
    INPUT: "input",
    RESULT: "result"
  };

  return {
    MSG: MSG,
    MATCH_ID_BYTES: MATCH_ID_BYTES,
    fnv1a: fnv1a,
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    createInputEvent: createInputEvent,
    serializeInputEvent: serializeInputEvent,
    inputDigest: inputDigest,
    isValidInput: isValidInput
  };
});
