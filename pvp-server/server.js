/**
 * ============================================================
 * 指尖足球 PvP — 轻量匹配 + 信令服务器（零权威）
 * ------------------------------------------------------------
 * 职责：
 *   1. 匹配队列：进队/退队/配对，1 分钟超时提示
 *   2. WebSocket 信令：配对成功后转发 SDP/ICE，建立 WebRTC DataChannel
 *   3. 只做「让两人相遇 + 转发」，不碰游戏状态/结果/资金
 *
 * 运行：
 *   node server.js [port]
 * 默认端口 8790
 * ============================================================
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 合并 Relayer：仅用于验签 + gas 代付 recordResult
let ethers = null;
try {
  ethers = require("ethers");
} catch (_) {
  // 未安装 ethers 时 /api/recordResult 会返回未配置
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8790;

// ---------------- 持久化日志（按天生成） ----------------
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(__dirname, "logs");

function logDateString(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function logTimeString(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds());
}

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}

function getLogFilePath() {
  return path.join(LOG_DIR, "pvp-" + logDateString(new Date()) + ".log");
}

function writeDailyLog(level, args) {
  try {
    ensureLogDir();
    const now = new Date();
    const line = "[" + logDateString(now) + " " + logTimeString(now) + "] [" + level + "] " +
      args.map((a) => (a instanceof Error ? (a.stack || a.message) : (typeof a === "object" ? JSON.stringify(a) : String(a)))).join(" ") + "\n";
    fs.appendFileSync(getLogFilePath(), line, "utf8");
  } catch (_) {
    // 日志写盘失败不能影响业务
  }
}

const logger = {
  info: (...args) => {
    console.log(...args);
    writeDailyLog("INFO", args);
  },
  error: (...args) => {
    console.error(...args);
    writeDailyLog("ERROR", args);
  }
};

// 当前 WebSocket 连接集合：用于 /api/stats 匹配中/对局中连接数统计
const onlineClients = new Set();

function cleanProfileValue(v, maxLen) {
  if (typeof v !== "string") return "";
  return v.slice(0, maxLen).replace(/[\u0000-\u001f\u007f]/g, "");
}

function onlineStats() {
  return {
    ok: true,
    online: onlineClients.size
  };
}

// 简单 WebSocket 服务端（避免依赖 ws 库，便于直接运行）
// 只实现信令需要的帧类型：text、close、ping/pong
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAGIC_KEY = "Sec-WebSocket-Key";

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("base64");
}

function encodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const out = [];
  let i = 0;
  while (i + 2 <= buffer.length) {
    const b0 = buffer[i];
    const b1 = buffer[i + 1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let offset = i + 2;
    if (len === 126) {
      if (offset + 2 > buffer.length) break;
      len = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }
    if (offset + len > buffer.length) break;
    let payload = buffer.slice(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let j = 0; j < len; j++) unmasked[j] = payload[j] ^ mask[j % 4];
      payload = unmasked;
    }
    if (opcode === 0x1) {
      out.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      out.push({ close: true });
    } else if (opcode === 0x9) {
      out.push({ ping: true });
    } else if (opcode === 0xa) {
      out.push({ pong: true });
    }
    i = offset + len;
  }
  return { messages: out, consumed: i };
}

// ---------------- WebSocket 客户端包装 ----------------
class WsClient {
  constructor(socket, req) {
    this.socket = socket;
    this.id = crypto.randomBytes(8).toString("hex");
    this.matchId = null;
    this.room = null; // 'pvp' | null
    this.address = "";
    this.nickname = "";
    this.field = "";
    this.queueStatus = false;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    onlineClients.add(this);
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
    // 心跳：每 30 秒发一个 WebSocket ping（opcode 0x9），浏览器自动回 pong
    this.heartbeat = setInterval(() => {
      if (!this.alive) { this.close(); return; }
      this.alive = false;
      try {
        const ping = Buffer.from([0x89, 0x00]);
        this.socket.write(ping);
      } catch (_) {}
    }, 30000);
  }

  onData(data) {
    // 任何客户端数据都视为连接存活，避免浏览器标签页节流时被误杀
    this.alive = true;
    this.buffer = Buffer.concat([this.buffer, data]);
    const res = decodeFrames(this.buffer);
    if (res.consumed > 0) {
      this.buffer = this.buffer.slice(res.consumed);
    }
    for (const msg of res.messages) {
      if (msg && msg.close) { this.close(); continue; }
      if (msg && msg.ping) { this.pong(); continue; }
      if (msg && msg.pong) { continue; }
      if (msg && typeof msg === "string") this.onMessage(msg);
    }
  }

  pong() {
    try { this.socket.write(encodeFrame("")); } catch (_) {}
  }

  send(obj) {
    try {
      this.socket.write(encodeFrame(JSON.stringify(obj)));
    } catch (_) {}
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "join_queue":
        this.room = "pvp";
        this.matchId = null;
        this.address = cleanProfileValue(msg && msg.address, 64);
        this.nickname = cleanProfileValue(msg && msg.nickname, 40);
        this.field = cleanProfileValue(msg && msg.field, 16);
        this.queueStatus = true;
        const key = fieldKey(this);
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(this);
        logger.info("join_queue", { id: this.id, field: this.field, nickname: this.nickname, address: this.address, queue: key, size: queues.get(key).length });
        this.send({ type: "queued", remaining: matchTimeoutSec });
        tryPair();
        break;
      case "leave_queue":
        removeFromQueue(this);
        // 已配对时主动退赛：必须通知对方并清掉房间，否则对方会一直等质押/倒计时
        if (this.room === "pvp" && this.matchId) {
          const room = peers[this.matchId];
          if (room) {
            const other = room.a === this ? room.b : room.a;
            if (other && other !== this && typeof other.send === "function") {
              other.send({ type: "peer_left", matchId: this.matchId, reason: "opponent_left" });
              other.matchId = null;
              other.room = null;
              other.queueStatus = false;
            }
            delete peers[this.matchId];
          }
          this.matchId = null;
          this.room = null;
        }
        this.queueStatus = false;
        logger.info("leave_queue", { id: this.id, field: this.field, address: this.address });
        this.send({ type: "queue_left" });
        break;
      case "signal": // 信令中继：{ to: peerId, data: {sdp/ice} }
        relaySignal(this, msg);
        break;
      case "shot":
        handleGameAction(this, msg, "shot");
        break;
      case "skip":
        handleGameAction(this, msg, "skip");
        break;
      case "sync_turn":
        // 客户端主动请求当前权威回合（防广播丢失后自愈）
        if (this.matchId && peers[this.matchId]) {
          const r = peers[this.matchId];
          const syncMsg = { type: "turn", turn: r.turn, version: r.turnVersion, deadline: r.turnDeadline };
          this.send(syncMsg);
        }
        break;
      case "result_signature":
        // 服务器中继结果签名：即使 DataChannel 断开，也能让胜方拿到败方签名
        if (this.matchId && peers[this.matchId]) {
          const room = peers[this.matchId];
          const target = room.a === this ? room.b : room.a;
          if (target && target !== this) {
            target.send({
              type: "result_signature",
              from: this.id,
              chainMatchId: msg.chainMatchId,
              resultHash: msg.resultHash,
              winner: msg.winner,
              score0: msg.score0,
              score1: msg.score1,
              duration: msg.duration,
              signature: msg.signature
            });
          }
        }
        break;
      case "stake_ready":
        // 服务器中继质押确认：即使 DataChannel 未建立，也要让双方知道彼此已完成质押
        if (this.matchId && peers[this.matchId]) {
          const room = peers[this.matchId];
          if (room.a === this) room.stakeReadyA = true;
          if (room.b === this) room.stakeReadyB = true;
          const target = room.a === this ? room.b : room.a;
          if (target && target !== this) {
            target.send({ type: "stake_ready", from: this.id, chainMatchId: msg.chainMatchId });
          }
          // 收费场双方都质押完成后主动开局（免费场在配对时已开局）
          if (room.field !== "free" && !room.started && room.stakeReadyA && room.stakeReadyB) {
            room.started = true;
            broadcastTurn(room);
          }
        }
        break;
      case "game_start":
        // 客户端确认真正开局后才启动首回合（主要为收费场质押完成后的时点）
        if (this.matchId && peers[this.matchId]) {
          const room = peers[this.matchId];
          if (room.field !== "free" && !room.started && room.stakeReadyA && room.stakeReadyB) {
            room.started = true;
            broadcastTurn(room);
          }
        }
        break;
      case "heartbeat":
        this.alive = true;
        break;
      default:
        break;
    }
  }

  onClose() {
    clearInterval(this.heartbeat);
    onlineClients.delete(this);
    removeFromQueue(this);
    if (this.room === "pvp" && this.matchId) {
      const room = peers[this.matchId];
      if (room) {
        const other = room.a === this ? room.b : room.a;
        if (other && other !== this && typeof other.send === "function") {
          other.send({ type: "peer_left", matchId: this.matchId, reason: "opponent_left" });
          other.matchId = null;
          other.room = null;
          other.queueStatus = false;
        }
      }
      delete peers[this.matchId];
      this.matchId = null;
      this.room = null;
      logger.info("peer_left_on_close", { id: this.id, address: this.address, room: "pvp" });
    }
  }

  close() {
    try { this.socket.destroy(); } catch (_) {}
  }
}

// ---------------- 匹配状态 ----------------
const matchTimeoutSec = 60;
// 按场次分组队列：免费/0.01/0.1 互不匹配
const queues = new Map();
const peers = {}; // matchId -> { a, b }

function fieldKey(client) {
  return client.field || "free";
}

function removeFromQueue(client) {
  const key = fieldKey(client);
  const q = queues.get(key);
  if (!q) return;
  const i = q.indexOf(client);
  if (i !== -1) {
    q.splice(i, 1);
    if (q.length === 0) queues.delete(key);
  }
}

function tryPair() {
  for (const [key, q] of queues) {
    while (q.length >= 2) {
      const a = q.shift();
      const b = q.shift();
      if (!a || !b) continue;
      if (!a.alive || !b.alive) continue;
      const matchId = crypto.randomBytes(16).toString("hex");
      a.matchId = matchId;
      b.matchId = matchId;
      // 服务器维护当前应操作玩家：0 先手；turnVersion 单调递增防旧广播覆盖
      // 收费场需要双方质押完成后再开局，因此不立即启动回合
      const field = a.field || b.field || "free";
      peers[matchId] = { a, b, turn: 0, turnVersion: 0, turnDeadline: 0, timeoutTimer: null, field, stakeReadyA: false, stakeReadyB: false, started: field === "free" };
      logger.info("paired", { matchId, field: key, playerA: a.id, playerB: b.id });
      a.send({ type: "matched", matchId, you: 0, peer: b.id, address: b.address || "", nickname: b.nickname || "", field: b.field || "" });
      b.send({ type: "matched", matchId, you: 1, peer: a.id, address: a.address || "", nickname: a.nickname || "", field: a.field || "" });
      // 免费场配对即开局；收费场等 game_start
      if (field === "free") {
        broadcastTurn(peers[matchId]);
      }
    }
    if (q.length === 0) queues.delete(key);
  }
}

const TURN_TIMEOUT_MS = 30 * 1000;

function broadcastTurn(room) {
  room.turnVersion++;
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  const msg = { type: "turn", turn: room.turn, version: room.turnVersion, deadline: room.turnDeadline };
  room.a.send(msg);
  room.b.send(msg);
  // 每次广播回合（含操作切换）都重新起 30 秒超时，避免旧定时器错误触发
  armRoomTimeout(room);
}

// 服务器权威超时：当前回合玩家 30 秒无动作，自动跳过并切换
function armRoomTimeout(room) {
  if (room.timeoutTimer) clearTimeout(room.timeoutTimer);
  room.timeoutTimer = setTimeout(() => {
    room.timeoutTimer = null;
    const previous = room.turn;
    room.turn = 1 - room.turn;
    broadcastTurn(room);
    room.a.send({ type: "turn_timeout", player: previous, turn: room.turn });
    room.b.send({ type: "turn_timeout", player: previous, turn: room.turn });
  }, TURN_TIMEOUT_MS);
}

function relaySignal(sender, msg) {
  if (!sender.matchId) return;
  const room = peers[sender.matchId];
  if (!room) return;
  const target = room.a === sender ? room.b : room.a;
  if (!target) return;
  target.send({ type: "signal", from: sender.id, data: msg.data });
}

// 服务器回合仲裁：只允许当前回合玩家发起回合推进（shot/skip 表示本轮已行动）
// 物理事件本身仍走 WebRTC DataChannel；这里只负责同步“该谁操作”。
function handleGameAction(sender, msg, kind) {
  if (!sender.matchId) return;
  const room = peers[sender.matchId];
  if (!room) return;

  // 判断 sender 是 0 号还是 1 号
  const senderPlayer = room.a === sender ? 0 : 1;
  const actionPlayer = (typeof msg.player === "number") ? msg.player : senderPlayer;
  if (actionPlayer !== room.turn) return; // 非当前回合，忽略

  // 切换回合并广播给双方；turnVersion 单调递增
  room.turn = 1 - room.turn;
  broadcastTurn(room);
}

// ---------------- Relayer（合并到 PvP 服务） ----------------
const RELAYER_RPC_URL = process.env.RELAYER_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const RELAYER_CHAIN_ID = parseInt(process.env.RELAYER_CHAIN_ID || "97", 10);
const RELAYER_MATCH_ADDRESS = process.env.RELAYER_MATCH_ADDRESS || "";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "";
const RELAYER_RETRY_LIMIT = parseInt(process.env.RELAYER_RETRY_LIMIT || "3", 10);
const RELAYER_RETRY_DELAY = parseInt(process.env.RELAYER_RETRY_DELAY_MS || "5000", 10);

// 解码请求正文
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(obj));
}

// 本地验签：败方必须签 RECORD_TYPEHASH
async function verifyRecordSignature(payload) {
  if (!ethers) return false;
  if (!RELAYER_MATCH_ADDRESS) return false;

  const provider = new ethers.JsonRpcProvider(RELAYER_RPC_URL);
  const abi = [
    "function games(uint256) view returns (address player1,address player2,uint256 amount,uint256 feeBps,uint256 minFee,uint8 state,bytes32 resultHash1,address winner1,bool submitted1,bytes32 resultHash2,address winner2,bool submitted2,uint256 createdAt,uint256 activeAt)"
  ];
  const contract = new ethers.Contract(RELAYER_MATCH_ADDRESS, abi, provider);
  let game;
  try {
    game = await contract.games(payload.matchId);
  } catch (e) {
    logger.error("verifyRecordSignature: games read failed", e.reason || e.message);
    return false;
  }

  const winner = String(payload.winner).toLowerCase();
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  const p1 = String(game.player1).toLowerCase();
  const p2 = String(game.player2).toLowerCase();
  const isTie = winner === zeroAddr;
  if (!isTie && winner !== p1 && winner !== p2) {
    logger.error("verifyRecordSignature: winner not in game", { winner, p1, p2 });
    return false;
  }
  // 平局时双方都签 winner=0x0，任意一方的签名都有效；服务端只做恢复地址校验
  let allowedSigner;
  if (isTie) {
    allowedSigner = null;
  } else {
    allowedSigner = winner === p1 ? p2 : p1;
  }
  const expectedSigner = allowedSigner;

  const domain = {
    name: "FingertipFootballMatch",
    version: "1",
    chainId: RELAYER_CHAIN_ID,
    verifyingContract: RELAYER_MATCH_ADDRESS
  };
  const types = {
    MatchRecord: [
      { name: "matchId", type: "uint256" },
      { name: "resultHash", type: "bytes32" },
      { name: "winner", type: "address" },
      { name: "score0", type: "uint256" },
      { name: "score1", type: "uint256" },
      { name: "duration", type: "uint256" }
    ]
  };
  const value = {
    matchId: payload.matchId,
    resultHash: payload.resultHash,
    winner: payload.winner,
    score0: payload.score0,
    score1: payload.score1,
    duration: payload.duration
  };
  try {
    const recovered = ethers.verifyTypedData(domain, types, value, payload.loserSignature);
    if (isTie) {
      // 平局：双方签的都是 winner=0x0，接受任意一位玩家的签名
      if (recovered.toLowerCase() !== p1 && recovered.toLowerCase() !== p2) {
        logger.error("verifyRecordSignature: signer mismatch", { recovered, p1, p2, payload });
        return false;
      }
      return true;
    }
    if (recovered.toLowerCase() !== expectedSigner) {
      logger.error("verifyRecordSignature: signer mismatch", { recovered, expectedSigner, payload });
      return false;
    }
    return true;
  } catch (e) {
    logger.error("verifyRecordSignature: recovery error", e.message, { payload });
    return false;
  }
}

// 通用 Relayer 提交：先 staticCall 模拟，成功才用 gas 钱包提交；失败自动重试
async function submitRelayerCall(abi, method, args) {
  if (!ethers) throw new Error("ethers not installed");
  if (!RELAYER_MATCH_ADDRESS || !RELAYER_PRIVATE_KEY) {
    throw new Error("relayer not configured");
  }
  const provider = new ethers.JsonRpcProvider(RELAYER_RPC_URL);
  const contract = new ethers.Contract(RELAYER_MATCH_ADDRESS, abi, provider);
  const gasWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const connected = contract.connect(gasWallet);

  let lastErr = null;
  for (let i = 0; i < RELAYER_RETRY_LIMIT; i++) {
    try {
      await contract[method].staticCall(...args, { from: gasWallet.address });
      const tx = await connected[method](...args);
      const receipt = await tx.wait();
      return { ok: true, txHash: receipt.hash, attempts: i + 1 };
    } catch (e) {
      lastErr = e;
      if (i < RELAYER_RETRY_LIMIT - 1) {
        await new Promise((r) => setTimeout(r, RELAYER_RETRY_DELAY));
      }
    }
  }
  throw lastErr || new Error("submit failed");
}

// 保留原 recordResult 专用函数，兼容现有调用
async function submitRelayerTx(payload) {
  const abi = [
    "function recordResult(uint256 matchId,bytes32 resultHash,address winner,uint256 score0,uint256 score1,uint256 duration,bytes loserSignature)"
  ];
  const args = [
    payload.matchId,
    payload.resultHash,
    payload.winner,
    payload.score0,
    payload.score1,
    payload.duration,
    payload.loserSignature
  ];
  return submitRelayerCall(abi, "recordResult", args);
}

// Relayer 在双方质押完成后登记对局历史
async function handleRegisterMatch(req, res) {
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (_) {
      sendJson(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const matchId = payload && payload.matchId;
    if (!matchId) {
      sendJson(res, 400, { ok: false, error: "matchId required" });
      return;
    }
    const abi = ["function registerMatchRecord(uint256 matchId)"];
    const result = await submitRelayerCall(abi, "registerMatchRecord", [matchId]);
    logger.info("registerMatch success", { matchId, txHash: result.txHash });
    sendJson(res, 200, result);
  } catch (e) {
    logger.error("registerMatch error", e);
    sendJson(res, 500, { ok: false, error: e.message || "registerMatch error" });
  }
}

// 单方认输：调用者视为败方，Relayer 代付 gas 调合约 forfeit
async function handleForfeit(req, res) {
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (_) {
      sendJson(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const matchId = payload && payload.matchId;
    if (!matchId) {
      sendJson(res, 400, { ok: false, error: "matchId required" });
      return;
    }
    const abi = ["function forfeit(uint256 matchId)"];
    const result = await submitRelayerCall(abi, "forfeit", [matchId]);
    logger.info("forfeit success", { matchId, txHash: result.txHash });
    sendJson(res, 200, result);
  } catch (e) {
    logger.error("forfeit error", e);
    sendJson(res, 500, { ok: false, error: e.message || "forfeit error" });
  }
}

// 系统兜底：双方质押但始终未进入对局时，Relayer 标记记录为免手续费退款
async function handleRefundNoGame(req, res) {
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (_) {
      sendJson(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const matchId = payload && payload.matchId;
    if (!matchId) {
      sendJson(res, 400, { ok: false, error: "matchId required" });
      return;
    }
    const abi = ["function refundNoGame(uint256 matchId)"];
    const result = await submitRelayerCall(abi, "refundNoGame", [matchId]);
    logger.info("refundNoGame success", { matchId, txHash: result.txHash });
    sendJson(res, 200, result);
  } catch (e) {
    logger.error("refundNoGame error", e);
    sendJson(res, 500, { ok: false, error: e.message || "refundNoGame error" });
  }
}

async function handleRecordResult(req, res) {
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (_) {
      sendJson(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const required = ["matchId", "resultHash", "winner", "score0", "score1", "duration", "loserSignature"];
    if (!payload || typeof payload !== "object" || !required.every((k) => k in payload)) {
      sendJson(res, 400, { ok: false, error: "invalid payload" });
      return;
    }
    if (!(await verifyRecordSignature(payload))) {
      sendJson(res, 400, { ok: false, error: "bad signature" });
      return;
    }
    const result = await submitRelayerTx(payload);
    logger.info("recordResult success", { matchId: payload.matchId, txHash: result.txHash });
    sendJson(res, 200, result);
  } catch (e) {
    logger.error("recordResult error", e);
    sendJson(res, 500, { ok: false, error: e.message || "relayer error" });
  }
}

// ---------------- HTTP + WebSocket 握手 ----------------
const server = http.createServer((req, res) => {
  // 合并的 Relayer：/api/recordResult 代付上链
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (_) {
    res.writeHead(400); res.end("Bad Request"); return;
  }
  if (urlPath === "/api/forfeit") {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
    handleForfeit(req, res);
    return;
  }
  if (urlPath === "/api/registerMatch") {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
    handleRegisterMatch(req, res);
    return;
  }
  if (urlPath === "/api/refundNoGame") {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
    handleRefundNoGame(req, res);
    return;
  }
  if (urlPath === "/api/recordResult") {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
    handleRecordResult(req, res);
    return;
  }
  if (urlPath === "/api/stats") {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }
    if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
    sendJson(res, 200, onlineStats());
    return;
  }

  // 静态托管 m3-web，让用户通过 http://localhost:8787 打开游戏页（真人模式必需）
  try {
    if (urlPath === "/" || urlPath === "/index.html") urlPath = "/index.html";
    const root = path.resolve(__dirname, "..", "m3-web");
    const filePath = path.join(root, urlPath.replace(/^\/+/, ""));
    // 防止路径穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8"
      };
      // 禁用缓存，避免浏览器拿到旧的 app.js 造成回合逻辑分叉
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": "no-store, max-age=0"
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end("Server Error");
  }
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = sha1(key + WS_GUID);
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "", ""
  ].join("\r\n");
  socket.write(headers);
  new WsClient(socket, req);
});

server.listen(PORT, () => {
  logger.info("[pvp-server] listening on http://localhost:" + PORT);
  logger.info("[pvp-server] match timeout = " + matchTimeoutSec + "s");
});
