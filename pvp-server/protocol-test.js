// 临时协议验证：两个 WebSocket 客户端连 pvp-server，走 超时→操作 流程
const net = require("net");
const crypto = require("crypto");

const PORT = 8787;
const HOST = "127.0.0.1";

function encodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const out = [];
  let i = 0;
  while (i + 2 <= buffer.length) {
    const b0 = buffer[i], b1 = buffer[i + 1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let offset = i + 2;
    if (len === 126) {
      if (offset + 2 > buffer.length) break;
      len = buffer.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset)); offset += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.slice(offset, offset + 4); offset += 4;
    }
    if (offset + len > buffer.length) break;
    let payload = buffer.slice(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let j = 0; j < len; j++) unmasked[j] = payload[j] ^ mask[j % 4];
      payload = unmasked;
    }
    if (opcode === 0x1) out.push(payload.toString("utf8"));
    else if (opcode === 0x9) out.push({ ping: true });
    else if (opcode === 0xa) out.push({ pong: true });
    i = offset + len;
  }
  return { messages: out, consumed: i };
}

class WsClient {
  constructor(id) {
    this.id = id;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.socket = new net.Socket();
    this.connected = false;
    this.matchId = null;
    this.you = null;
  }
  connect() {
    return new Promise((resolve) => {
      this.socket.connect(PORT, HOST, () => {
        const key = crypto.randomBytes(16).toString("base64");
        this.socket.write(
          "GET / HTTP/1.1\r\n" +
          "Host: " + HOST + ":" + PORT + "\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + key + "\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      this.socket.on("data", (d) => {
        if (!this.connected) {
          const s = d.toString("utf8");
          if (s.includes("101 Switching Protocols")) {
            this.connected = true;
            this.buffer = Buffer.alloc(0);
            resolve();
          }
          return;
        }
        this.buffer = Buffer.concat([this.buffer, d]);
        const res = decodeFrames(this.buffer);
        this.buffer = this.buffer.slice(res.consumed);
        for (const msg of res.messages) {
          if (msg && typeof msg === "string") this.messages.push(JSON.parse(msg));
          if (msg && msg.ping) {
            // 回 pong（opcode 0xA）
            this.socket.write(Buffer.from([0x8a, 0x00]));
          }
        }
      });
      this.socket.on("error", () => {});
    });
  }
  send(obj) { this.socket.write(encodeFrame(JSON.stringify(obj))); }
  sendMasked(obj) {
    // 浏览器客户端必须带 mask。这里也带 mask 更贴近真实
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    const maskedPayload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) maskedPayload[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }
  close() { this.socket.destroy(); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("connecting two clients...");
  const a = new WsClient("A");
  const b = new WsClient("B");
  await a.connect();
  await b.connect();
  console.log("connected");

  a.sendMasked({ type: "join_queue" });
  b.sendMasked({ type: "join_queue" });
  await delay(500);

  const matchedA = a.messages.find(m => m.type === "matched");
  const matchedB = b.messages.find(m => m.type === "matched");
  if (!matchedA || !matchedB) {
    console.log("NO_MATCH", a.messages, b.messages);
    a.close(); b.close(); return;
  }
  console.log("MATCHED", { a: matchedA, b: matchedB });

  // 查看 turn 广播
  const turnA = a.messages.filter(m => m.type === "turn").map(m => ({ turn: m.turn, version: m.version }));
  const turnB = b.messages.filter(m => m.type === "turn").map(m => ({ turn: m.turn, version: m.version }));
  console.log("INITIAL TURNS", { a: turnA, b: turnB });

  // P0(you=0) shot
  console.log("P0 sends shot...");
  a.sendMasked({ type: "shot", player: 0, seq: 1 });
  await delay(400);
  console.log("AFTER P0 SHOT", {
    a: a.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version),
    b: b.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version)
  });

  // P1(you=1) shot
  console.log("P1 sends shot...");
  b.sendMasked({ type: "shot", player: 1, seq: 1 });
  await delay(400);
  console.log("AFTER P1 SHOT", {
    a: a.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version),
    b: b.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version)
  });

  // 模拟 P0 超时发 skip
  console.log("P0 sends skip...");
  a.sendMasked({ type: "skip", player: 0, seq: 2 });
  await delay(400);
  console.log("AFTER P0 SKIP", {
    a: a.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version),
    b: b.messages.filter(m => m.type === "turn").map(m => m.turn + "v" + m.version)
  });

  // 同步请求
  a.sendMasked({ type: "sync_turn" });
  b.sendMasked({ type: "sync_turn" });
  await delay(400);
  console.log("SYNC", {
    a: a.messages.filter(m => m.type === "turn").slice(-1).map(m => m.turn + "v" + m.version),
    b: b.messages.filter(m => m.type === "turn").slice(-1).map(m => m.turn + "v" + m.version)
  });

  a.close(); b.close();
}

main().catch(e => { console.error("ERR", e); process.exit(1); });