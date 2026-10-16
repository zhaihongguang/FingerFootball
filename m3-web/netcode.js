/**
 * ============================================================
 * 指尖足球 PvP — 回合制 P2P Netcode（11 球）
 * ------------------------------------------------------------
 * 职责：
 *   1. 与信令服务器 WebSocket 通信（进队/配对/SDP/ICE）
 *   2. WebRTC DataChannel 直连，交换「选球 + 击球」事件
 *   3. 双方各自用同一确定性引擎重放事件，保证结束 stateHash 一致
 *   4. 结束提交 stateHash 给对方核对
 *
 * 消息协议（DataChannel JSON）：
 *   { type: "ready", seed }                       双方确认开始
 *   { type: "shot", cue, vx, vy, sig }            某方击球（可选签名）
 *   { type: "result", stateHash }                 结束提交指纹
 *
 * 本文件不依赖钱包，先用 mock 签名；后续接 ethers 真实签名。
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./deterministic-billiards.js"));
  } else {
    root.PvpNet = factory(root.Billiards);
  }
})(typeof self !== "undefined" ? self : this, function (Billiards) {
  "use strict";

  function createMockSigner(seedHex) {
    return {
      seed: seedHex,
      sign: function (obj) {
        var s = JSON.stringify(obj) + "|" + seedHex;
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = (h * 16777619) >>> 0;
        }
        return "mock:" + (h >>> 0).toString(16);
      }
    };
  }

  /**
   * @param {object} opts
   *   - serverUrl    WebSocket 信令地址（默认从 ContractConfig.relayerUrl 派生）
   *   - seed         matchId / room 派生的确定性种子
   *   - onStatus     (status) => void  状态回调（匹配中/已配对/对局中/结束）
   *   - onShot       (msg) => void     收到对方击球事件
   *   - onResult     (hash) => void    对方结束指纹
   *   - onError      (err) => void
   */
  function PvpSession(opts) {
    this.opts = opts || {};
    this.serverUrl = this.opts.serverUrl || deriveDefaultServerUrl();
    this.ws = null;
    this.dc = null;
    this.peer = null;
    this.matchId = null;
    this.playerIndex = null; // 0 或 1
    this.seed = this.opts.seed || 0x12345678;
    this.connected = false;
    this.queueStatus = "idle";
    this.signer = this.opts.signer || createMockSigner("pvp");
    this.log = this.opts.onStatus || function () {};
  }

  // ---------------- 匹配 ----------------
  PvpSession.prototype.joinQueue = function () {
    this.queueStatus = "matching";
    this.log({ status: "matching" });
    if (typeof WebSocket === "undefined") {
      this.onError(new Error("当前环境不支持 WebSocket"));
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      const sendJoin = () => {
        this.sendToServer({
          type: "join_queue",
          address: this.opts.address || "",
          nickname: this.opts.nickname || "",
          field: this.opts.field || ""
        });
      };
      if (this.ws.readyState === WebSocket.OPEN) sendJoin();
      else this.ws.addEventListener("open", sendJoin);
      return;
    }
    this.ws = new WebSocket(this.serverUrl);
    this.ws.onopen = () => {
      this.sendToServer({
        type: "join_queue",
        address: this.opts.address || "",
        nickname: this.opts.nickname || "",
        field: this.opts.field || ""
      });
    };
    this.ws.onmessage = (e) => {
      try {
        this.onServerMessage(JSON.parse(e.data));
      } catch (err) {
        this.onError(err);
      }
    };
    this.ws.onclose = () => this.onDisconnect("server_closed");
    this.ws.onerror = (e) => {
      // file:// 页面连接 ws:// 会被浏览器拦截，给用户明确提示
      this.onError(new Error("无法连接信令服务器。真人模式请用 http:// 打开页面并启动 pvp-server"));
      this.onDisconnect("server_error");
    };
  };

  PvpSession.prototype.leaveQueue = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendToServer({ type: "leave_queue" });
    }
  };

  PvpSession.prototype.close = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendToServer({ type: "leave_queue" });
    }
    this.closeChannels();
  };

  // 主动请求服务器当前权威回合，防止广播丢失后卡死
  PvpSession.prototype.syncTurn = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.matchId) {
      this.sendToServer({ type: "sync_turn" });
    }
  };

  // 收费场双方质押完成后，通知服务器正式开局并启动首回合倒计时
  PvpSession.prototype.sendGameStart = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.matchId) {
      this.sendToServer({ type: "game_start" });
    }
  };

  PvpSession.prototype.sendToServer = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  };

  // ---------------- 服务器消息 ----------------
  PvpSession.prototype.onServerMessage = function (msg) {
    switch (msg.type) {
      case "queued":
        this.queueStatus = "queued";
        this.log({ status: "queued", remaining: msg.remaining });
        break;
      case "matched":
        this.queueStatus = "matched";
        this.matchId = msg.matchId;
        this.playerIndex = msg.you;
        this.peer = msg.peer;
        this.seed = hashStr(msg.matchId) >>> 0;
        this.opponentAddress = msg.address || "";
        this.opponentNickname = msg.nickname || "";
        this.field = msg.field || "";
        this.log({ status: "matched", matchId: msg.matchId, you: msg.you, opponentAddress: this.opponentAddress });
        this.initPeerConnection();
        break;
      case "turn":
        // 服务器权威回合：谁该操作；带版本号 + 服务器 deadline 供前端显示倒计时
        if (this.opts.onTurn) this.opts.onTurn(msg.turn, msg.version || 0, msg.deadline || 0);
        break;
      case "turn_timeout":
        if (this.opts.onTurnTimeout) this.opts.onTurnTimeout(msg);
        break;
      case "result_signature":
        // 服务器中继的败方结果签名（DataChannel 断开时也能送达）
        if (this.opts.onResultSignature) this.opts.onResultSignature(msg);
        break;
      case "stake_ready":
        // 服务器中继的对手质押确认（DataChannel 未建立时也能送达）
        if (this.opts.onStakeReady) this.opts.onStakeReady(msg);
        break;
      case "signal":
        // 转发 WebRTC 信号给 RTCPeerConnection
        if (msg.from === this.peer) {
          this.handleSignal(msg.data);
        }
        break;
      case "peer_left":
        this.log({ status: "peer_left", reason: msg.reason || "" });
        this.closeChannels();
        break;
      default:
        break;
    }
  };

  // ---------------- WebRTC ----------------
  PvpSession.prototype.initPeerConnection = function () {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this.pc = pc;

    // 主叫方（player 0）创建 DataChannel
    if (this.playerIndex === 0) {
      const dc = pc.createDataChannel("game");
      this.setupDataChannel(dc);
      pc.createOffer().then((offer) => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        // 必须把 offer 发给对方，否则对方没有远端 SDP，DataChannel 永远无法建立
        this.sendToServer({ type: "signal", to: this.peer, data: { offer: this.pc.localDescription } });
      }).catch((e) => this.onError(e));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendToServer({ type: "signal", to: this.peer, data: { candidate: e.candidate } });
      }
    };
    pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel);
    };
    this.pc = pc;
  };

  PvpSession.prototype.setupDataChannel = function (dc) {
    this.dc = dc;
    dc.onopen = () => {
      this.connected = true;
      this.log({ status: "connected", playerIndex: this.playerIndex });
      // 开局通知：带上地址/昵称/场次，供双方链上锁仓和本地历史
      this.sendToPeer({
        type: "ready",
        seed: this.seed,
        playerIndex: this.playerIndex,
        address: this.opts.address || "",
        nickname: this.opts.nickname || "",
        field: this.opts.field || ""
      });
    };
    dc.onmessage = (e) => this.onPeerMessage(JSON.parse(e.data));
    dc.onclose = () => this.onDisconnect("channel_closed");
  };

  PvpSession.prototype.handleSignal = function (data) {
    if (!this.pc) return;
    if (data.offer) {
      this.pc.setRemoteDescription(data.offer).then(() => {
        return this.pc.createAnswer();
      }).then((answer) => {
        return this.pc.setLocalDescription(answer);
      }).then(() => {
        this.sendToServer({ type: "signal", to: this.peer, data: { answer: this.pc.localDescription } });
      }).catch((e) => this.onError(e));
    } else if (data.answer) {
      this.pc.setRemoteDescription(data.answer).catch((e) => this.onError(e));
    } else if (data.candidate) {
      this.pc.addIceCandidate(data.candidate).catch((e) => this.onError(e));
    }
  };

  PvpSession.prototype.sendToPeer = function (obj) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    }
  };

  PvpSession.prototype.sendMatchInfo = function (chainMatchId) {
    this.sendToPeer({ type: "match_info", chainMatchId: chainMatchId });
  };

  // 通知对方：我已完成链上质押
  PvpSession.prototype.sendStakeReady = function (chainMatchId) {
    this.sendToPeer({ type: "stake_ready", chainMatchId: String(chainMatchId) });
    this.sendToServer({ type: "stake_ready", chainMatchId: String(chainMatchId) });
  };

  // ---------------- 对局消息 ----------------
  PvpSession.prototype.onPeerMessage = function (msg) {
    switch (msg.type) {
      case "ready":
        if (this.opts.onReady) this.opts.onReady(msg);
        break;
      case "match_info":
        if (this.opts.onMatchInfo) this.opts.onMatchInfo(msg);
        break;
      case "stake_ready":
        if (this.opts.onStakeReady) this.opts.onStakeReady(msg);
        break;
      case "shot":
        if (this.opts.onShot) this.opts.onShot(msg);
        break;
      case "skip":
        if (this.opts.onSkip) this.opts.onSkip(msg);
        break;
      case "result":
        if (this.opts.onResult) this.opts.onResult(msg.stateHash);
        break;
      case "result_signature":
        if (this.opts.onResultSignature) this.opts.onResultSignature(msg);
        break;
      default:
        break;
    }
  };

  // 击球：DataChannel 传事件（对方重放），WebSocket 通知服务器切换回合
  PvpSession.prototype.sendShot = function (cue, vx, vy, player, seq) {
    const obj = {
      type: "shot", cue, vx, vy,
      player: player !== undefined ? player : this.playerIndex,
      seq: (seq !== undefined && seq !== null) ? seq : (this._seq = (this._seq || 0) + 1)
    };
    obj.sig = this.signer.sign(obj);
    this.sendToPeer(obj);
    this.sendToServer({ type: "shot", player: (player !== undefined ? player : this.playerIndex), seq: obj.seq });
    return obj;
  };

  PvpSession.prototype.sendSkip = function (player, seq) {
    const obj = {
      type: "skip",
      player: player !== undefined ? player : this.playerIndex,
      seq: (seq !== undefined && seq !== null) ? seq : (this._seq = (this._seq || 0) + 1)
    };
    this.sendToPeer(obj);
    this.sendToServer({ type: "skip", player: (player !== undefined ? player : this.playerIndex), seq: obj.seq });
    return obj;
  };

  PvpSession.prototype.sendResult = function (stateHash) {
    this.sendToPeer({ type: "result", stateHash });
  };

  PvpSession.prototype.sendResultSignature = function (chainMatchId, resultHash, winner, score0, score1, duration, signature) {
    const obj = {
      type: "result_signature",
      chainMatchId: String(chainMatchId),
      resultHash,
      winner,
      score0,
      score1,
      duration,
      signature
    };
    this.sendToPeer(obj);
    this.sendToServer(obj);
  };

  // ---------------- 清理 ----------------
  PvpSession.prototype.closeChannels = function () {
    if (this.dc) { try { this.dc.close(); } catch (_) {} }
    if (this.pc) { try { this.pc.close(); } catch (_) {} }
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
    this.dc = null; this.pc = null; this.ws = null;
  };

  PvpSession.prototype.onDisconnect = function (reason) {
    this.closeChannels();
    this.log({ status: "disconnected", reason });
  };

  PvpSession.prototype.onError = function (err) {
    if (this.opts.onError) this.opts.onError(err);
  };

  // ---------------- 工具 ----------------
  // 优先使用页面配置的 Relayer/PvP 地址派生 WebSocket；否则回到 8790（与 server 默认端口一致）
  function deriveDefaultServerUrl() {
    try {
      var configured = (root.ContractConfig && root.ContractConfig.relayerUrl) || "";
      if (configured) {
        var u = new URL(configured);
        u.protocol = "ws:";
        return u.href.replace(/\/+$/, "");
      }
    } catch (_) {}
    return "ws://localhost:8790";
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }

  return {
    PvpSession: PvpSession,
    createMockSigner: createMockSigner
  };
});
