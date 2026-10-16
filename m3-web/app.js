/**
 * M3 可玩闭环（台球式回合制）— 应用状态机 + 渲染 + 触控瞄准 + 机器人对手 + 结算
 * ------------------------------------------------------------------
 * 玩法：拖拽你的母球（右半场白球）出现方向+力度箭头，松手击球。
 *       用母球借力撞「足球」，把足球撞进对方球门得分；母球进袋犯规。
 *       回合制：无进球换对方；进球/犯规复位并换边。先到 5 分胜。
 */
(function () {
  "use strict";

  var Billiards = window.Billiards;
  var PHYS = Billiards.PHYS;
  var PvpNet = window.PvpNet; // 真人 PvP netcode（index.html 引入）
  var Chain = window.ContractConfig || { tokenAddress: "", vaultAddress: "", matchAddress: "", relayerUrl: "", chainId: 97, rpcUrl: "" };

  // ---------------- 全局状态 ----------------
  var state = {
    address: null,
    nickname: "",
    demo: false,         // 演示模式：模拟地址，不上链
    siwe: null,          // 真实钱包 SIWE 登录结果
    walletType: "",      // 当前钱包类型：metamask | binance | okx | tronlink
    walletProviderObj: null, // 当前登录选中的钱包 provider
    field: null,
    matchTimer: null,
    remaining: 60,
    game: null,          // BilliardsGame（单实例，双方共用；真实 P2P 时各自实例重放）
    rafId: null,
    botTimer: null,      // 机器人出杆延迟定时器
    aiming: null,        // { ballX, ballY, curX, curY } 指针瞄准
    resultShown: false,
    mode: "bot",         // bot | pvp
    botDiff: "easy",     // 本地机器人难度：easy | normal | hard
    pvp: null,           // PvpSession（真人模式）
    peerLeft: false,     // 对手是否已退出/掉线（质押后用于锁定提示和退款入口）
    peerLeftStaked: false, // 对手退出时，我已确认链上质押（决定是否显示退款入口）
    myPlayer: 0,         // 真人模式下我是玩家0还是1
    stakeReady: false,   // 我是否已完成链上质押
    peerStakeReady: false, // 对手是否已完成链上质押
    refundInProgress: false, // 退款流程防重复/防递归
    stakeWaitDeadline: 0,  // 我方质押后，等待对方质押的截止时间
    refundTimer: null,     // 150 秒退款倒计时定时器
    statsTimer: null,      // 在线人数轮询定时器
    pvpReady: false,     // DataChannel ready 已收到
    pvpReadyMsg: null,   // DataChannel ready 消息，开局时复用
    lastShotPlayer: -1,  // 兼容字段（可保留）
    currentTurn: 0,      // 当前应操作玩家（唯一权威；只由服务器 turn 消息更新）
    turnVersion: -1,     // 已应用的最大服务器回合版本，防止旧广播/每秒同步覆盖
    turnPending: false,  // 本地已发起操作、等待服务器 turn 确认期间禁止重启计时器
    turnTimer: null,     // 真人模式：当前回合倒计时定时器
    turnDeadline: 0,     // 当前回合截止时间（性能）
    turnTimeoutSec: 30,  // 每回合限时 30 秒
    resultRecorded: false, // 本局结果是否已提交上链
    reqId: 0,            // 本地发送序号（递增，仅用于防重放，不推导回合）
    lastRemoteReqId: 0,  // 已处理远端最大 reqId（防重放/乱序）
    chainCache: {},      // 链上状态短缓存：{paidOn, balance, allowance, ts}
    startTime: 0,        // 对局开始时间（历史时长）
    matchDeadline: 0,    // 对局硬截止时间（5 分钟）
    opponent: "AI",      // 对手昵称（PvP 握手时更新）
    remoteHash: undefined, // 对方结果指纹（防抖字段）
  };

  var MATCH_DURATION_MS = 5 * 60 * 1000;
  var STAKE_WAIT_MS = 150 * 1000;

  var FIELDS = [
    { id: "free", name: "免费场", stake: "0 代币（纯积分）", amount: 0, usd: "$0" },
    { id: "t1", name: "0.01 代币", stake: "0.01 代币/人", amount: "0.01", usd: "≈ $0.38" },
    { id: "t2", name: "0.1 代币", stake: "0.1 代币/人", amount: "0.1", usd: "≈ $3.80" },
  ];

  var SEED = 0x12345678; // 演示固定种子（正式版双方 commit-reveal）
  var MATCH_ID = "0x" + "cd".repeat(32);

  // ---------------- 工具 ----------------
  function $(id) { return document.getElementById(id); }
  function show(screen) {
    ["login", "lobby", "matching", "timeout", "playing", "finished", "history"].forEach(function (s) {
      var el = $("screen-" + s);
      if (el) el.classList.toggle("active", s === screen);
    });
  }
  function shortAddr(a) { return a ? a.slice(0, 10) + "..." + a.slice(-6) : ""; }
  function mockAddress() {
    var h = "0x";
    for (var i = 0; i < 40; i++) h += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    return h;
  }
  function historyFieldName(amountWei) {
    if (!amountWei) return "免费场";
    var amount = ethers.utils.formatEther(amountWei);
    if (amount === "0.01") return "0.01 场";
    if (amount === "0.1") return "0.1 场";
    return amount + " 场";
  }

  // 获取当前玩家的母球真实索引：玩家0 → cueNo，玩家1 → CUE_COUNT+cueNo
  function myCueBallIndex(cueNo) {
    var my = state.mode === "pvp" ? state.myPlayer : 0;
    return (my === 1 ? PHYS.CUE_COUNT : 0) + cueNo;
  }

  // 世界坐标 -> 画布坐标：按画布比例缩放并居中，保证上下左右边界完整可见
  var FIELD_PX_SCALE = 0.1;
  function fieldLeftPx() {
    return (canvas.width - PHYS.FIELD_W * FIELD_PX_SCALE) / 2;
  }
  function fieldRightPx() {
    return fieldLeftPx() + PHYS.FIELD_W * FIELD_PX_SCALE;
  }
  function fieldTopPx() {
    return (canvas.height - PHYS.FIELD_H * FIELD_PX_SCALE) / 2;
  }
  function fieldBottomPx() {
    return fieldTopPx() + PHYS.FIELD_H * FIELD_PX_SCALE;
  }
  function worldXToPx(x) { return fieldLeftPx() + x * FIELD_PX_SCALE; }
  function worldYToPx(y) { return fieldTopPx() + y * FIELD_PX_SCALE; }

// ---------------- 登录（真实钱包 SIWE / 演示模式） ----------------
  function enterLobby() {
    var addrEl = $("lobby-address");
    if (addrEl) addrEl.textContent = state.demo ? (shortAddr(state.address) + "（演示）") : shortAddr(state.address);
    var logoutBtn = $("btn-logout");
    if (logoutBtn) logoutBtn.style.display = "inline-block";
    renderModes();
    renderFields();
    refreshVaultUI();
    observeOnlineStats();
    show("lobby");
  }
  // 完整 PvP 会话：真人匹配/对局使用，包含对局回调
  function buildPvpSession() {
    return new PvpNet.PvpSession({
      serverUrl: state.signalUrl || defaultSignalUrl(),
      address: state.demo ? "" : (state.address || ""),
      nickname: state.nickname || (state.demo ? "演示玩家" : shortAddr(state.address) || "未命名玩家"),
      field: state.field ? state.field.id : "",
      onStatus: function (msg) {
        if (msg.status === "matched") {
          if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
          state.myPlayer = msg.you;
          if (!state.demo) state.opponent = msg.nickname || (state.myPlayer === 0 ? "玩家 1" : "玩家 0");
          $("match-countdown").textContent = "配对成功，处理链上锁仓…";
          lockPvPStake().then(function () {}).catch(function (err) {
            console.error("lock stake error", err);
            $("match-countdown").textContent = "锁仓失败（仍可普通开局）：" + (err.message || err);
          });
        }
        if (msg.status === "connected") {
          $("match-countdown").textContent = "匹配成功，请质押筹码...";
        }
        if (msg.status === "peer_left" || msg.status === "disconnected") {
          if (state.game && !state.game.finished) {
            // 对局中：对手主动退出或断线，明确提示“对方已退出对局”
            handleOpponentLeft(msg);
            return;
          }
          if (!state.game) {
            handlePeerLeftRace(true);
          }
        }
      },
      onReady: function (msg) {
        if (state.demo || !state.field || state.field.id === "free") {
          startPvpGame(msg);
          return;
        }
        state.pvpReady = true;
        state.pvpReadyMsg = msg;
        maybeStartPvpGame();
      },
      onStakeReady: function (msg) {
        if (!msg || !msg.chainMatchId) return;
        state.chainMatchId = String(msg.chainMatchId);
        state.peerStakeReady = true;
        clearStakeWaitTimer();
        hideRefundButton();
        // 只有双方都完成质押才显示确认中
        if (state.stakeReady) {
          $("match-countdown").textContent = "双方质押确认中…";
        } else {
          $("match-countdown").textContent = "对方已质押，等待您完成质押…";
        }
        maybeStartPvpGame();
      },
      onMatchInfo: function (msg) {
        if (msg.chainMatchId && state.myPlayer === 1) {
          // 玩家一创建对局时已质押，先标记对手已质押，避免本地状态依赖消息时序
          state.peerStakeReady = true;
          $("match-countdown").textContent = "对手已创建对局，链上确认中…";
          acceptChainMatch(msg.chainMatchId).catch(function (err) {
            console.error("accept match error", err);
            $("match-countdown").textContent = "接受对局失败（仍可普通开局）：" + (err.message || err);
          });
        }
      },
      onTurn: function (turn, version, deadline) {
        handleServerTurn(turn, version, deadline);
      },
      onTurnTimeout: function (msg) {
        handleServerTurnTimeout(msg);
      },
      onShot: function (msg) {
        handleRemoteShot(msg);
      },
      onSkip: function (msg) {
        handleRemoteSkip(msg);
      },
      onResult: function (hash) {
        handleRemoteResult(hash);
      },
      onResultSignature: function (msg) {
        if (!msg || !msg.chainMatchId || !msg.signature) return;
        if (state.chainMatchId !== String(msg.chainMatchId)) return;
        state.peerResultSignature = msg.signature;
        state.peerResultHash = msg.resultHash;
        state.peerResultWinner = msg.winner;
        state.peerScore0 = msg.score0;
        state.peerScore1 = msg.score1;
        state.peerDuration = msg.duration;
        autoSubmitResultToRelayer();
      },
      onError: function (err) {
        console.error("pvp error", err);
        $("match-countdown").textContent = "连接失败";
        var msg = $("mode-hint");
        if (msg) msg.textContent = err.message || "真人连接失败，请用 http:// 打开页面并启动 pvp-server";
      }
    });
  }
  function observeOnlineStats() {
    if (state.statsTimer) clearInterval(state.statsTimer);
    loadOnlineCount();
    state.statsTimer = setInterval(loadOnlineCount, 10000);
  }
  async function loadOnlineCount() {
    var el = $("online-count");
    if (!el) return;
    try {
      var base = (Chain && Chain.relayerUrl) || state.signalUrl || "";
      if (!base) { el.textContent = "-"; return; }
      var url = base.replace(/\/+$/, "") + "/api/stats";
      var resp = await fetch(url, { cache: "no-store" });
      var data = await resp.json();
      el.textContent = data && typeof data.online === "number" ? String(data.online) : "-";
    } catch (_) {
      el.textContent = "-";
    }
  }
  function logout() {
    closePvpSession();
    state.address = null;
    state.demo = false;
    state.siwe = null;
    state.walletType = "";
    state.walletProviderObj = null;
    localStorage.removeItem("ff_session");
    var logoutBtn = $("btn-logout");
    if (logoutBtn) logoutBtn.style.display = "none";
    var addrEl = $("lobby-address");
    if (addrEl) addrEl.textContent = "未连接钱包";
    show("login");
  }

  // 确保 MetaMask 已切换到 BSC 测试网（Chain 97）
  async function ensureBscTestnet() {
    var hex = "0x" + (Chain.chainId || 97).toString(16);
    var w = window;
    var provider = w.ethereum || w.BinanceChain || w.BinanceWallet || w.okxwallet || (w.tronLink && w.tronLink.ethereum);
    if (!provider) return true;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      return true;
    } catch (err) {
      if (err && err.code === 4902) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: "BSC Testnet",
            nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
            rpcUrls: [Chain.rpcUrl || "https://bsc-testnet-rpc.publicnode.com"],
            blockExplorerUrls: ["https://testnet.bscscan.com"]
          }]
        });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        return true;
      }
      if (err && (err.code === -32603 || err.code === 4001)) {
        // 部分钱包不支持添加自定义链，退回检查当前链
        return true;
      }
      throw err;
    }
  }

  function getWalletProvider(name) {
    var w = window;
    if (name === "metamask") return w.ethereum || null;
    if (name === "binance") return binanceProvider();
    if (name === "okx") return w.okxwallet || null;
    if (name === "tronlink") return (w.tronLink && (w.tronLink.ethereum || w.tronLink)) || null;
    return null;
  }
  // Binance 钱包可能以不同全局名注入：优先官方 BinanceChain/BinanceWallet，
  // 兼容 Binance Web3 Wallet 的 binancew3w.ethereum，以及明确标记 isBinance 的 ethereum。
  function binanceProvider() {
    var w = window;
    if (w.BinanceChain) return w.BinanceChain;
    if (w.BinanceWallet) return w.BinanceWallet;
    if (w.binance && w.binance.request) return w.binance;
    if (w.binancew3w && w.binancew3w.ethereum && typeof w.binancew3w.ethereum.request === "function") return w.binancew3w.ethereum;
    if (w.ethereum && (w.ethereum.isBinance || w.ethereum.isBinanceWallet || w.ethereum.isBinanceChain)) return w.ethereum;
    return null;
  }

  function onLogin() {
    var options = $("wallet-options");
    var loginBtn = $("btn-login");
    if (loginBtn) loginBtn.style.display = "none";
    if (options) options.style.display = "block";
  }

  async function loginWithWallet(name) {
    var status = $("wallet-status");
    try {
      if (typeof window.ethers === "undefined") {
        if (status) status.textContent = "未加载 ethers，无法登录。";
        return;
      }
      var providerObj = getWalletProvider(name);
      if (!providerObj) {
        var walletName = name === "metamask" ? "MetaMask" : name === "binance" ? "Binance Wallet" : name === "okx" ? "OKX Wallet" : "TronLink";
        var extra = "";
        if (name === "binance") {
          var keys = [];
          if (window.BinanceChain) keys.push("BinanceChain");
          if (window.BinanceWallet) keys.push("BinanceWallet");
          if (window.binance) keys.push("binance");
          if (window.ethereum) keys.push("ethereum");
          extra = keys.length ? "已识别：" + keys.join(", ") + "，但未成功注入 provider。" : "未找到 BinanceChain/BinanceWallet/binance 全局对象。";
        }
        if (status) status.textContent = "未检测到 " + walletName + "，请先安装/打开浏览器插件。" + (extra ? " " + extra : "");
        return;
      }
      state.walletProviderObj = providerObj;
      if (status) status.textContent = "等待钱包授权…";
      var provider = new ethers.providers.Web3Provider(providerObj, "any");
      var accounts = await provider.send("eth_requestAccounts", []);
      if (!accounts || !accounts.length) throw new Error("no accounts");
      var address = accounts[0];
      var signer = provider.getSigner();
      await ensureBscTestnet();
      var chainId = await signer.getChainId();
      if (chainId !== (Chain.chainId || 97)) {
        throw new Error("当前网络不是 BSC 测试网（Chain 97）");
      }
      var nonce = Date.now().toString(16);
      var message = "指尖足球 PvP 登录\n\n" +
        "地址: " + address + "\n" +
        "链 ID: " + chainId + "\n" +
        "时间戳: " + nonce + "\n\n" +
        "签名此消息仅用于登录会话，不会花费 gas。";
      var signature = await signer.signMessage(message);
      state.address = address;
      state.walletType = name;
      state.siwe = { message: message, signature: signature, chainId: chainId };
      state.demo = false;
      localStorage.setItem("ff_session", JSON.stringify({ address: address, demo: false, walletType: name, siwe: state.siwe, time: Date.now() }));
      if (status) status.textContent = "✓ 已连接 " + shortAddr(address) + "（链 " + chainId + "）";
      enterLobby();
    } catch (err) {
      console.error("wallet login error", err);
      if (status) status.textContent = "钱包登录失败：" + (err && err.message ? err.message : err) + "。可用演示模式进入。";
    }
  }

  function onDemoLogin() {
    state.address = mockAddress();
    state.demo = true;
    state.siwe = null;
    localStorage.setItem("ff_session", JSON.stringify({ address: state.address, demo: true, siwe: null, time: Date.now() }));
    var status = $("wallet-status");
    if (status) status.textContent = "演示模式：模拟地址，不上链。";
    enterLobby();
  }

  // ---------------- 链上资金（Token + Match 直接锁仓） ----------------
  function isChainConfigured() {
    return !!(Chain && Chain.tokenAddress && Chain.matchAddress);
  }
  function getProvider() {
    var providerObj = state.walletProviderObj || window.ethereum;
    if (!providerObj) return null;
    return new ethers.providers.Web3Provider(providerObj, "any");
  }
  function getContracts() {
    if (!isChainConfigured()) return null;
    var provider = getProvider();
    if (!provider) return null;
    var signer = provider.getSigner();
    return {
      token: new ethers.Contract(Chain.tokenAddress, [
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)"
      ], signer),
      match: new ethers.Contract(Chain.matchAddress, [
        "function createMatchWithStake(uint256,address)",
        "function acceptMatchWithStake(uint256)",
        "function cancelMatch(uint256)",
        "function claimTimeout(uint256)",
        "function games(uint256) view returns (address player1,address player2,uint256 amount,uint256 feeBps,uint256 minFee,uint8 state,bytes32 resultHash1,address winner1,bool submitted1,bytes32 resultHash2,address winner2,bool submitted2,uint256 createdAt,uint256 activeAt)",
        "function nextMatchId() view returns (uint256)",
        "function paidEnabled() view returns (bool)",
        "function recordResult(uint256,bytes32,address,uint256,uint256,uint256,bytes)",
        "function claimReward(uint256)",
        "function registerMatchRecord(uint256)",
        "function claimRefund(uint256)",
        "function forfeit(uint256)",
        "function records(uint256) view returns (tuple(uint256 matchId,bool exists,address player1,address player2,address winner,address loser,uint256 score0,uint256 score1,uint256 duration,uint256 timestamp,uint256 amount,uint256 fee,uint256 claimable,bool claimed,bool refundClaimed1,bool refundClaimed2,bool noFeeRefund,uint8 status))",
        "function getUserMatchIds(address) view returns (uint256[])",
        "function getUserMatches(address) view returns (tuple(uint256 matchId,bool exists,address player1,address player2,address winner,address loser,uint256 score0,uint256 score1,uint256 duration,uint256 timestamp,uint256 amount,uint256 fee,uint256 claimable,bool claimed,bool refundClaimed1,bool refundClaimed2,bool noFeeRefund,uint8 status)[])"
      ], signer)
    };
  }
  async function ensureTokenAllowance(c, amount) {
    var allowed = await c.token.allowance(state.address, Chain.matchAddress);
    if (allowed.gte(amount)) return;
    var tx = await c.token.approve(Chain.matchAddress, amount);
    await tx.wait();
  }
  // 质押完成后通过 Relayer 登记链上历史记录；即使后续没有人签名，历史里也能看到这场对局
  async function registerMatchOnChain(chainMatchId) {
    if (!chainMatchId) return;
    var relayerUrl = Chain.relayerUrl || (window.RelayerConfig && window.RelayerConfig.url) || state.relayerUrl || "";
    if (!relayerUrl) {
      // 没有 Relayer 时，玩家可以自己补登记
      var c = getContracts();
      if (c) {
        var tx = await c.match.registerMatchRecord(chainMatchId);
        await tx.wait();
      }
      return;
    }
    var resp = await fetch(relayerUrl.replace(/\/+$/, "") + "/api/registerMatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId: String(chainMatchId) })
    });
    var json = await resp.json();
    if (!json.ok) throw new Error(json.error || "registerMatch failed");
  }
  // 真人收费场认输：玩家钱包直接调 Match.forfeit，调用者视为败方
  async function forfeitOnChain(chainMatchId) {
    if (!chainMatchId) return;
    var c = getContracts();
    if (!c) throw new Error("合约未配置");
    var tx = await c.match.forfeit(chainMatchId);
    await tx.wait();
  }
  // 链上余额/授权/开关短缓存 + 并行读取，减少开始匹配延迟
  const CHAIN_CACHE_TTL = 3000; // 3 秒
  async function readChainState(force) {
    var now = Date.now();
    var cache = state.chainCache || {};
    if (!force && cache.ts && (now - cache.ts) < CHAIN_CACHE_TTL) return cache;
    var c = getContracts();
    if (!c) return null;
    // 余额/授信始终读取，不再依赖是否选择收费场
    var results = await Promise.all([
      c.match.paidEnabled(),
      c.token.balanceOf(state.address),
      c.token.allowance(state.address, Chain.matchAddress)
    ]);
    var fresh = { paidOn: results[0], balance: results[1], allowance: results[2], ts: now };
    state.chainCache = fresh;
    return fresh;
  }
  async function refreshVaultUI() {
    var balEl = $("vault-balance"), lockedEl = $("vault-locked"), statusEl = $("vault-status");
    if (!balEl || !lockedEl || !statusEl) return;
    var approveBtn = $("btn-vault-deposit");
    var approveInput = $("vault-amount");
    var isPaidField = state.field && state.field.id !== "free";
    // 演示模式不能授权真钱，按钮置灰
    if (state.demo && approveBtn) {
      approveBtn.disabled = true;
      if (approveInput) approveInput.disabled = true;
    } else {
      if (approveBtn) approveBtn.disabled = false;
      if (approveInput) approveInput.disabled = false;
    }
    // 真实钱包 + 合约配置完整时，右上角始终显示余额/授信，不再只在选收费场后读取
    if (!state.demo && isChainConfigured() && window.ethereum && state.address) {
      try {
        var vals = await readChainState(false);
        if (!vals) return;
        balEl.textContent = vals.balance === null ? "—" : ethers.utils.formatEther(vals.balance);
        lockedEl.textContent = vals.allowance === null ? "—" : ethers.utils.formatEther(vals.allowance);
        statusEl.textContent = isPaidField
          ? "余额和 BEM 授权额度。开局时由 Match 直接锁仓。"
          : "已连接钱包，右上角展示当前余额和 BEM 授权额度。";
      } catch (e) {
        console.error("refresh vault error", e);
        statusEl.textContent = "读取资金失败：" + (e.message || e);
      }
    } else {
      balEl.textContent = "—";
      lockedEl.textContent = "—";
      statusEl.textContent = state.demo
        ? "演示模式，不读取链上余额。"
        : (isChainConfigured()
          ? "需要连接真实钱包后才能使用代币场。"
          : "合约地址未配置，代币场暂不可用。");
    }
  }
  async function onVaultDeposit() {
    var status = $("vault-status");
    if (state.demo) {
      if (status) status.textContent = "演示模式不能授权 BEM。";
      return;
    }
    try {
      var amtInput = $("vault-amount");
      var amount = amtInput ? ethers.utils.parseEther(amtInput.value || "0") : ethers.BigNumber.from(0);
      if (amount.lte(0)) throw new Error("请输入大于 0 的数量");
      var c = getContracts();
      var tx = await c.token.approve(Chain.matchAddress, amount);
      status.textContent = "等待授权确认…";
      await tx.wait();
      status.textContent = "授权成功";
      await refreshVaultUI();
    } catch (e) {
      console.error("approve error", e);
      status.textContent = "授权失败：" + (e.message || e);
    }
  }
  // 链上锁仓：PvP + 非演示 + 付费场 + 地址配置时，代币直接锁定到 Match
  async function lockPvPStake() {
    if (state.demo) return;
    if (!state.field || state.field.id === "free") return;
    if (!isChainConfigured() || !state.address || !window.ethereum) return;
    var c = getContracts();
    if (!c) return;
    var tierIndex = state.field.id === "t1" ? 0 : 1;
    var opponent = state.pvp && state.pvp.opponentAddress ? state.pvp.opponentAddress : "";
    if (!opponent) return;
    var amount = ethers.utils.parseEther(state.field.amount);
    await ensureTokenAllowance(c, amount);

    if (state.myPlayer === 0) {
      var tx = await c.match.createMatchWithStake(tierIndex, opponent);
      var receipt = await tx.wait();
      // 从 MatchCreated 事件解析 matchId；解析不到就回退 nextMatchId-1
      var chainMatchId = null;
      if (receipt && receipt.events) {
        for (var i = 0; i < receipt.events.length; i++) {
          var ev = receipt.events[i];
          if (ev.event === "MatchCreated") {
            chainMatchId = ev.args && ev.args[0] ? ev.args[0].toString() : null;
            break;
          }
        }
      }
      if (chainMatchId === null) {
        var next = await c.match.nextMatchId();
        chainMatchId = next.sub(1).toString();
      }
      state.chainMatchId = chainMatchId;
      state.chainMatchReady = true;
      state.stakeReady = true;
      startStakeWaitTimer();
      if (state.pvp && state.pvp.sendMatchInfo) {
        state.pvp.sendMatchInfo(chainMatchId);
      }
      if (state.pvp && state.pvp.sendStakeReady) {
        state.pvp.sendStakeReady(chainMatchId);
      }
      registerMatchOnChain(chainMatchId).catch(function (err) {
        console.error("register match record error", err);
      });
      maybeStartPvpGame();
    } else {
      // player1：等 P2P 收到 chainMatchId 后 accept
      state.chainMatchId = null;
      state.chainMatchReady = false;
      state.stakeReady = false;
    }
  }

  async function acceptChainMatch(chainMatchId) {
    if (state.demo || !state.field || state.field.id === "free") return;
    if (!isChainConfigured() || !state.address || !window.ethereum) return;
    var c = getContracts();
    if (!c) return;
    var amount = ethers.utils.parseEther(state.field.amount);
    await ensureTokenAllowance(c, amount);
    var tx = await c.match.acceptMatchWithStake(chainMatchId);
    await tx.wait();
    state.chainMatchId = chainMatchId;
    state.chainMatchReady = true;
    state.stakeReady = true;
    // 玩家一已通过 match_info 质押；这里补一次防止消息丢失导致本地状态卡住
    state.peerStakeReady = true;
    if (state.pvp && state.pvp.sendStakeReady) {
      state.pvp.sendStakeReady(chainMatchId);
    }
    registerMatchOnChain(chainMatchId).catch(function (err) {
      console.error("register match record error", err);
    });
    maybeStartPvpGame();
  }

  // ---------------- 结算签名（EIP-712 + 赢家单笔上链） ----------------
  function getMatchDomain() {
    return {
      name: "FingertipFootballMatch",
      version: "1",
      chainId: Chain.chainId || 97,
      verifyingContract: Chain.matchAddress
    };
  }
  function getResultTypes() {
    return {
      MatchRecord: [
        { name: "matchId", type: "uint256" },
        { name: "resultHash", type: "bytes32" },
        { name: "winner", type: "address" },
        { name: "score0", type: "uint256" },
        { name: "score1", type: "uint256" },
        { name: "duration", type: "uint256" }
      ]
    };
  }
  async function signMatchResult(chainMatchId, resultHash, winner, score0, score1, duration) {
    var provider = getProvider();
    var signer = provider.getSigner();
    return await signer._signTypedData(
      getMatchDomain(),
      getResultTypes(),
      { matchId: chainMatchId, resultHash: resultHash, winner: winner, score0: score0, score1: score1, duration: duration }
    );
  }
  async function settlePvpResult(chainMatchId, resultHash, winner, sig1, sig2) {
    if (!isChainConfigured() || !state.address) return;
    var c = getContracts();
    if (!c) return;
    var tx = await c.match.settleWithSignatures(chainMatchId, resultHash, winner, sig1, sig2);
    await tx.wait();
    return true;
  }

  // ---------------- 场次 / 机器人档位 ----------------
  var BOT_DIFFS = [
    { id: "easy", name: "新手场", stake: "简单难度 · 机器人出杆较慢", meta: "适合熟悉规则" },
    { id: "normal", name: "标准场", stake: "普通难度 · 机器人稳定出杆", meta: "适合正常对局" },
    { id: "hard", name: "高手场", stake: "困难难度 · 机器人更准", meta: "适合进阶玩家" }
  ];
  function renderFields() {
    var list = $("field-list");
    if (!list) return;
    var titleEl = document.querySelector("#screen-lobby .right-panel .panel-title");
    list.innerHTML = "";
    var isPvp = state.mode === "pvp";
    var items = isPvp ? FIELDS : BOT_DIFFS;
    var levelNames = ["初级场", "中级场", "高级场"];
    if (titleEl) titleEl.textContent = isPvp ? "选择场次" : "选择机器人难度";
    items.forEach(function (f, i) {
      var div = document.createElement("div");
      var selected = isPvp
        ? (state.field && state.field.id === f.id)
        : (state.botDiff === f.id);
      div.className = "room" + (selected ? " selected" : "");
      div.dataset.id = f.id;
      div.dataset.kind = isPvp ? "field" : "bot";
      div.innerHTML =
        '<span class="level">' + (levelNames[i] || ("档位 " + (i + 1))) + '</span>' +
        '<div class="room-name">' + f.name + '</div>' +
        '<div class="stake">' + f.stake + '</div>' +
        '<div class="meta">' + (f.meta || '<span class="dot"></span>空闲可进') + '</div>';
      div.addEventListener("click", function () { selectField(f.id); });
      list.appendChild(div);
    });
    // 本地机器人默认已有难度时，直接启用开始按钮
    var btn = $("btn-match");
    if (btn) btn.disabled = !isPvp && !state.botDiff ? true : (isPvp && !state.field);
  }

  // ---------------- 模式切换（本地机器人 / 真人匹配） ----------------
  function renderModes() {
    document.querySelectorAll("#screen-lobby .menu-item[data-mode]").forEach(function (el) {
      var isDemoPvp = state.demo && el.dataset.mode === "pvp";
      el.classList.toggle("selected", el.dataset.mode === state.mode);
      if (isDemoPvp) {
        el.disabled = true;
        el.classList.add("disabled");
        el.title = "演示模式仅支持本地机器人";
      } else {
        el.disabled = false;
        el.classList.remove("disabled");
        el.title = "";
      }
    });
    updateModeHint();
  }
  function selectMode(m) {
    // 演示地址不能进入真人匹配
    if (state.demo && m === "pvp") return;
    state.mode = m;
    // 切换模式后重置场次/难度，并重新渲染右侧列表
    state.field = null;
    var btn = $("btn-match");
    if (btn) btn.disabled = true;
    document.querySelectorAll("#screen-lobby .menu-item[data-mode]").forEach(function (el) {
      el.classList.toggle("selected", el.dataset.mode === m);
    });
    hideInlineHistory();
    renderFields();
    updateModeHint();
  }
  function updateModeHint() {
    var el = $("mode-hint");
    if (!el) return;
    if (state.mode === "bot") {
      var diff = BOT_DIFFS.find(function (d) { return d.id === state.botDiff; });
      var diffName = diff ? diff.name : "未选择难度";
      el.innerHTML = "<span class='ico'>📌</span>当前模式：本地机器人 · 难度：" + diffName;
    } else {
      var fieldName = state.field ? state.field.name : "未选择场次";
      el.innerHTML = "<span class='ico'>📌</span>当前模式：真人匹配 · 场次：" + fieldName;
    }
  }
  function selectField(id) {
    if (state.mode === "pvp") {
      state.field = FIELDS.find(function (f) { return f.id === id; });
      document.querySelectorAll("#field-list .room").forEach(function (el) {
        el.classList.toggle("selected", el.dataset.id === id);
      });
    } else {
      state.botDiff = id;
      state.field = null;
      document.querySelectorAll("#field-list .room").forEach(function (el) {
        el.classList.toggle("selected", el.dataset.id === id);
      });
    }
    var btn = $("btn-match");
    if (btn) btn.disabled = false;
    updateModeHint();
    refreshVaultUI();
  }

  // 从页面配置的 Relayer/PvP 地址派生 WebSocket 地址，与在线统计保持同源
  function defaultSignalUrl() {
    try {
      var configured = (Chain && Chain.relayerUrl) || state.signalUrl || "";
      if (configured) {
        var u = new URL(configured);
        u.protocol = "ws:";
        return u.href.replace(/\/+$/, "");
      }
    } catch (_) {}
    return "ws://localhost:8790";
  }

  // ---------------- 匹配 ----------------
  // 通用提示弹框：用于开始匹配等关键操作的报错
  function showMessageModal(title, text) {
    var modal = $("message-modal");
    if (!modal) {
      alert(title + "\n" + text);
      return;
    }
    var titleEl = $("message-modal-title");
    var textEl = $("message-modal-text");
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    modal.style.display = "flex";
  }
  function closeMessageModal() {
    var modal = $("message-modal");
    if (modal) modal.style.display = "none";
  }
  async function startMatch() {
    // 根据大厅选择的模式进入匹配
    if (state.mode === "pvp") {
      // 付费场 + 真实钱包 + 合约已配置时必须先满足余额/授权
      if (state.field && state.field.id !== "free" && !state.demo && isChainConfigured() && state.address && window.ethereum) {
        try {
          var vals = await readChainState(true); // 点开始匹配时强制刷新最新状态
          var need = ethers.utils.parseEther(state.field.amount);
          if (!vals.paidOn) {
            showMessageModal("无法匹配", "收费场已关闭，请稍后再试或选择免费场。");
            return;
          }
          if (vals.balance === null || vals.balance.lt(need)) {
            showMessageModal("余额不足", "BEM 余额不足，无法开启收费场匹配。请先领取/转入 BEM 代币。");
            return;
          }
          if (vals.allowance === null || vals.allowance.lt(need)) {
            showMessageModal("授权不足", "BEM 授权额度不足。请先输入数量并点击「授权 BEM」。(建议用多少授权多少)");
            return;
          }
        } catch (e) {
          console.error("paid field guard error", e);
          showMessageModal("读取失败", "读取链上余额/授权失败：" + (e.message || e));
          return;
        }
      } else if (state.field && state.field.id !== "free" && !state.demo) {
        showMessageModal("无法匹配", "收费场需真实钱包 + 配置合约地址后才能匹配。");
        return;
      }
      startPvpMatch();
      return;
    }
    if (state.mode === "bot") {
      startGame();
      return;
    }
    state.remaining = 60;
    updateCountdown();
    show("matching");
    state.matchTimer = setInterval(function () {
      state.remaining--;
      updateCountdown();
      if (state.remaining <= 0) { clearInterval(state.matchTimer); state.matchTimer = null; show("timeout"); }
    }, 1000);
  }
  function startPvpMatch() {
    // 真人匹配直接建立完整 PvP 会话
    state.pvp = buildPvpSession();
    state.remaining = 60;
    clearStakeWaitTimer();
    hideRefundButton();
    // 重置被取消提示状态
    state.peerLeft = false;
    state.peerLeftStaked = false;
    var extraHint = $("match-extra-hint");
    if (extraHint) extraHint.textContent = "1 分钟内匹配不到将提示";
    var cancelBtn = $("btn-cancel-match");
    if (cancelBtn) cancelBtn.textContent = "取消匹配";
    updateCountdown();
    show("matching");
    state.matchTimer = setInterval(function () {
      state.remaining--;
      updateCountdown();
      if (state.remaining <= 0) {
        clearInterval(state.matchTimer); state.matchTimer = null;
        if (state.pvp) state.pvp.leaveQueue();
        show("timeout");
      }
    }, 1000);

    state.pvp.joinQueue();
  }
  function updateCountdown() { $("match-countdown").textContent = state.remaining; }

  // 我方质押成功后开始 150 秒等待；对方 150 秒内未质押才显示退款按钮
  function startStakeWaitTimer() {
    clearStakeWaitTimer();
    state.stakeWaitDeadline = Date.now() + STAKE_WAIT_MS;
    if (!state.peerLeft) hideRefundButton();
    state.refundTimer = setInterval(function () {
      var remain = Math.max(0, Math.ceil((state.stakeWaitDeadline - Date.now()) / 1000));
      if (state.peerLeft) {
        // 对手已退出：只有确认我已质押才提示退款；否则保持“取消”状态
        if (state.peerLeftStaked) {
          var extra = $("match-extra-hint");
          if (extra) extra.textContent = "等待倒计时结束，可点击退款。" + (remain > 0 ? " 剩余 " + remain + "s" : "");
          if (remain <= 0) {
            clearStakeWaitTimer();
            showRefundButton();
          }
        } else {
          var extra2 = $("match-extra-hint");
          if (extra2) extra2.textContent = "未检测到您的质押，匹配已取消，可返回大厅。";
        }
      } else {
        $("match-countdown").textContent = "等待对方质押… " + remain + "s";
        if (remain <= 0) {
          clearStakeWaitTimer();
          if (!state.peerStakeReady && !state.game) {
            showRefundButton();
            $("match-countdown").textContent = "对方 150 秒内未质押，可取消匹配并退出质押";
          }
        }
      }
    }, 200);
  }
  function clearStakeWaitTimer() {
    if (state.refundTimer) { clearInterval(state.refundTimer); state.refundTimer = null; }
    state.stakeWaitDeadline = 0;
  }
  function showRefundButton() {
    var btn = $("btn-refund-match");
    if (btn) {
      btn.style.display = "inline-block";
      // 对手已退出：明确是“退款”，不再写“取消匹配”
      btn.textContent = state.peerLeft ? "退款并返回大厅" : "取消匹配并退出质押";
    }
  }
  function hideRefundButton() {
    var btn = $("btn-refund-match");
    if (btn) btn.style.display = "none";
  }

  function showPeerLeftNotice() {
    var countdown = $("match-countdown");
    if (countdown) countdown.textContent = "对方已取消匹配";
    var hint = $("match-extra-hint");
    if (hint) hint.textContent = "双方还未质押，匹配已取消，可返回大厅重新匹配。";
    var cancelBtn = $("btn-cancel-match");
    if (cancelBtn) cancelBtn.textContent = "返回大厅";
  }

  // 对手退出时可能刚好卡在对方质押交易确认前后，必须以链上状态为准
  async function handlePeerLeftRace(peerLeft) {
    // 不清空倒计时，只标记 peerLeft；由 startStakeWaitTimer 结束后显示退款按钮
    state.peerLeft = true;
    if (!state.refundTimer) {
      startStakeWaitTimer();
    }
    if (!state.stakeReady || !state.chainMatchId) {
      showPeerLeftNotice();
      return;
    }
    if (!isChainConfigured() || !state.address || !window.ethereum || state.demo || !state.field || state.field.id === "free") {
      showPeerLeftNotice();
      return;
    }
    try {
      var c = getContracts();
      if (!c) { showPeerLeftNotice(); return; }
      var id = String(state.chainMatchId);
      var g = await c.match.games(id);
      var stateNum = Number(g.state);
      // 只有链上确认为 Pending/Active/Submitted 才算已质押
      state.peerLeftStaked = stateNum === 0 || stateNum === 1 || stateNum === 2;
      var countdown = $("match-countdown");
      var hint = $("match-extra-hint");
      if (stateNum === 0) {
        // Pending：我已质押但对局还没激活，等对方接受/超时可退款
        if (countdown) countdown.textContent = "您已完成质押，等待确认…";
        if (hint) hint.textContent = "对方已退出或掉线，等待确认结束后可在此页退款。";
      } else if (stateNum === 1 || stateNum === 2) {
        // Active/Submitted：对方已质押成功，资金已锁定
        if (countdown) countdown.textContent = "您已完成质押，对方已退出对局";
        if (hint) hint.textContent = "资金已锁定不会丢失，等待倒计时结束后可在此页退款。";
      } else {
        state.peerLeftStaked = false;
        showPeerLeftNotice();
      }
      // 退款按钮由 startStakeWaitTimer 倒计时结束后显示，且仅在 peerLeftStaked 时显示
      if (!state.peerLeftStaked) {
        hideRefundButton();
      }
    } catch (e) {
      console.error("peer left race check error", e);
      state.peerLeftStaked = false;
      showPeerLeftNotice();
    }
  }

  function cancelMatch() {
    if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
    clearStakeWaitTimer();
    hideRefundButton();
    if (state.pvp) state.pvp.leaveQueue();
    state.pvp = null;
    show("lobby");
  }

  function leaveMatchingAfterRefund() {
    if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
    clearStakeWaitTimer();
    hideRefundButton();
    if (state.pvp) state.pvp.leaveQueue();
    state.pvp = null;
    state.peerLeft = false;
    state.peerLeftStaked = false;
    state.stakeReady = false;
    state.peerStakeReady = false;
    state.pvpReady = false;
    state.pvpReadyMsg = null;
    state.refundInProgress = false;
    show("lobby");
  }

  function closePvpSession() {
    if (state.pvp) {
      try { state.pvp.leaveQueue(); } catch (_) {}
      state.pvp = null;
    }
  }
  // 真人场：对手主动退出/认输后给出明确提示，并清理对局状态
  function handleOpponentLeft(msg) {
    var isForfeit = msg && msg.reason === "opponent_left";
    var reasonText = isForfeit ? "对方认输退出，您获得本局胜利" : "对手已断开连接";
    state.opponentLeftText = reasonText;
    var hint = $("hint-text");
    if (hint) hint.textContent = reasonText;
    if (state.game && !state.game.finished) {
      state.opponentLeft = true;
      // 对手退出即认输：直接把当前玩家设为胜者
      if (isForfeit && state.mode === "pvp") {
        state.game.winner = state.myPlayer;
        state.game.finished = true;
      } else if (typeof state.game.finishByScore === "function") {
        state.game.finishByScore();
      }
    }
    // 收费场：稍后刷新链上记录，让历史/结算页显示可领取奖金
    if (isForfeit && state.chainMatchId) {
      setTimeout(function () {
        refreshHistoryStatus();
      }, 1200);
    }
  }

  // 对手认输后刷新链上记录状态，让胜方看到已直接到账
  async function refreshHistoryStatus() {
    if (!state.chainMatchId || !isChainConfigured() || !state.address) return;
    try {
      var c = getContracts();
      if (!c) return;
      var rec = await c.match.records(state.chainMatchId);
      if (rec && rec.exists) {
        state.peerResultSignature = null;
        state.chainMatchReady = true;
        var claimArea = $("claim-area");
        if (claimArea) claimArea.style.display = "block";
        var claimBtn = $("btn-claim-reward");
        if (claimBtn) claimBtn.style.display = "none";
        var claimStatus = $("claim-status");
        if (claimStatus) claimStatus.textContent = "对方已认输，奖金已直接到账，可返回大厅。";
      }
    } catch (e) {
      console.error("refresh history status error", e);
    }
  }

  async function refundStuckMatch() {
    var status = $("match-countdown");
    if (!status) status = document.createElement("div");

    if (state.refundInProgress) return;
    state.refundInProgress = true;

    if (!isChainConfigured() || !state.address || !window.ethereum || state.demo || !state.field || state.field.id === "free") {
      state.refundInProgress = false;
      cancelMatch();
      return;
    }

    var c = getContracts();
    if (!c || !state.chainMatchId) {
      state.refundInProgress = false;
      cancelMatch();
      return;
    }
    try {
      var id = String(state.chainMatchId);
      status.textContent = "正在检查链上对局并退款…";

      var g = await c.match.games(id);
      var amActive = String(g.state) === "1";
      var amPlayer1 = String(g.player1).toLowerCase() === String(state.address).toLowerCase();
      var amPlayer2 = String(g.player2).toLowerCase() === String(state.address).toLowerCase();

      if (!amActive) {
        if (!amPlayer1 && !amPlayer2) {
          status.textContent = "链上没有你参与的待退款对局。";
          state.refundInProgress = false;
          return;
        }
        if (amPlayer1) {
          var cancelTx = await c.match.cancelMatch(id);
          status.textContent = "等待取消确认…";
          await cancelTx.wait();
          status.textContent = "✅ 已取消对局，质押已退回。";
        } else {
          status.textContent = "你尚未质押该对局，没有可退款资金。";
          state.refundInProgress = false;
          leaveMatchingAfterRefund();
          return;
        }
      } else if (amPlayer1 || amPlayer2) {
        try {
          var timeoutTx = await c.match.claimTimeout(id);
          status.textContent = "等待超时退款确认…";
          await timeoutTx.wait();
          status.textContent = "✅ 已触发退款，双方质押已退回。";
        } catch (timeoutErr) {
          status.textContent = "尚未达到退款超时时间，不能立即退款：" + (timeoutErr.reason || timeoutErr.message || timeoutErr);
          state.refundInProgress = false;
          return;
        }
      } else {
        status.textContent = "你不是该对局参与方，无法退款。";
        state.refundInProgress = false;
        return;
      }

      leaveMatchingAfterRefund();
    } catch (e) {
      console.error("refund stuck match error", e);
      status.textContent = "退款失败：" + (e.reason || e.message || e);
      state.refundInProgress = false;
    }
  }
  function keepWaiting() {
    state.remaining = 60;
    clearStakeWaitTimer();
    hideRefundButton();
    updateCountdown(); show("matching");
    state.matchTimer = setInterval(function () {
      state.remaining--; updateCountdown();
      if (state.remaining <= 0) { clearInterval(state.matchTimer); state.matchTimer = null; show("timeout"); }
    }, 1000);
    if (state.pvp && state.pvp.joinQueue) state.pvp.joinQueue();
  }
  function widenRange() {
    if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
    if (state.mode === "pvp") { startPvpMatch(); return; }
    startGame();
  }
  function exitMatch() { cancelMatch(); }
  function exitGame() {
    // 退出对局前弹出确认框，真人场额外提示对手会收到通知
    var modal = $("exit-confirm-modal");
    var titleEl = $("exit-confirm-title");
    var textEl = $("exit-confirm-text");
    if (!modal) {
      doExitGame();
      return;
    }
    if (titleEl) titleEl.textContent = state.mode === "bot" ? "确认退出本局？" : "确认认输退出？";
    if (textEl) textEl.textContent = state.mode === "bot"
      ? "退出后本局进度不会保留。"
      : "现在退出对局，则代表认输，您将失去质押的BEM，对手将获得奖金。";
    modal.style.display = "flex";
  }
  function closeExitConfirm() {
    var modal = $("exit-confirm-modal");
    if (modal) modal.style.display = "none";
  }
  async function doExitGame() {
    closeExitConfirm();
    if (state.mode === "pvp" && state.pvp) {
      var isPaid = state.field && state.field.id !== "free" && !state.demo && isChainConfigured() && state.chainMatchId;
      if (isPaid) {
        // 以链上状态为准：Pending 视为还没正式开局，取消即可；Active/Submitted 才认输
        try {
          var c = getContracts();
          if (c && state.chainMatchId) {
            var g = await c.match.games(String(state.chainMatchId));
            var stateNum = Number(g.state);
            if (stateNum === 1 || stateNum === 2) {
              await forfeitOnChain(state.chainMatchId);
            } else if (stateNum === 0 && state.stakeReady) {
              // 还在 Pending：链上已有一方质押，调用取消合约退回
              var cancelTx = await c.match.cancelMatch(String(state.chainMatchId));
              await cancelTx.wait();
              if (state.pvp.leaveQueue) state.pvp.leaveQueue();
            } else {
              // 还未 Active 且本地未质押：不认输，直接清理本地匹配
              if (state.pvp.leaveQueue) state.pvp.leaveQueue();
              closePvpSession();
            }
          } else {
            if (state.pvp.leaveQueue) state.pvp.leaveQueue();
            closePvpSession();
          }
        } catch (err) {
          console.error("exit game chain check error", err);
          alert("退出处理失败：" + (err.message || err));
          return;
        }
      }
      closePvpSession();
    }
    saveCurrentMatchIfFinished();
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (state.botTimer) { clearTimeout(state.botTimer); state.botTimer = null; }
    clearTurnTimer();
    clearStakeWaitTimer();
    state.game = null;
    show("lobby");
  }
  function matchSuccess() {
    saveCurrentMatchIfFinished();
    if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
    if (state.mode === "pvp") { startPvpMatch(); return; }
    startGame();
  }

  // ---------------- 对局 ----------------
  function startGame() {
    state.nickname = state.demo ? "演示玩家" : (shortAddr(state.address) || "未命名玩家");
    localStorage.setItem("ff_nickname", state.nickname);
    state.mode = "bot";
    state.opponent = "AI";
    state.remoteHash = undefined;
    state.startTime = Date.now();
    state.matchDeadline = state.startTime + MATCH_DURATION_MS;

    state.game = new Billiards.BilliardsGame(SEED);
    state.resultShown = false;
    state.aiming = null;
    if (state.botTimer) clearTimeout(state.botTimer);
    if (state.rafId) cancelAnimationFrame(state.rafId);

    show("playing");
    loop();
  }

  // 真人模式开局：双方用同一 seed（matchId 派生）创建各自实例
  // 收费场：双方都完成质押并且 DataChannel ready 后才开局
  function maybeStartPvpGame() {
    if (!state.game && state.pvpReady && state.stakeReady && state.peerStakeReady && state.pvpReadyMsg) {
      startPvpGame(state.pvpReadyMsg);
    }
  }

  function startPvpGame(msg) {
    clearStakeWaitTimer();
    hideRefundButton();
    state.mode = "pvp";
    state.opponent = msg.playerIndex === 1 ? "玩家 1" : "玩家 0";
    // 收费场正式开局时通知服务器启动首回合；免费场服务器配对时已开局
    if (state.pvp && state.pvp.sendGameStart && state.field && state.field.id !== "free") {
      state.pvp.sendGameStart();
    }
    // 对方 ready.playerIndex 是远端索引，据此推导我自己的索引
    var myIndex = msg.playerIndex === 1 ? 0 : 1;
    state.myPlayer = myIndex;
    var p0Label = "玩家 0（青绿色母球）";
    var p1Label = "玩家 1（橙色母球）";
    var selfLabel = "你";
    var oppLabel = "对手";
    if (state.demo) {
      selfLabel = "演示玩家";
      oppLabel = "AI";
    }
    var p0Text = (myIndex === 0 ? selfLabel : oppLabel) + "（青绿色母球）";
    var p1Text = (myIndex === 1 ? selfLabel : oppLabel) + "（橙色母球）";
    $("hud-player0").textContent = p0Text;
    $("hud-player1").textContent = p1Text;
    $("hud-player0").title = p0Label;
    $("hud-player1").title = p1Label;
    state.remoteHash = undefined;
    state.startTime = Date.now();
    state.matchDeadline = state.startTime + MATCH_DURATION_MS;
    state.game = new Billiards.BilliardsGame(state.pvp.seed >>> 0);
    state.game.autoSwitchTurn = false; // PvP：回合完全由服务器 turn 控制
    state.resultShown = false;
    state.aiming = null;
    state.currentTurn = 0; // 服务器配对后广播 turn=0
    state.turnVersion = 0; // 全新对局，接受服务器第一回合广播
    state.lastShotPlayer = -1;
    state.turnPending = false;
    state.turnTimer = null;
    if (state.botTimer) clearTimeout(state.botTimer);
    if (state.rafId) cancelAnimationFrame(state.rafId);
    show("playing");
    loop();
  }

  // 真人回合倒计时：按服务器 deadline 显示；归零时向服务器请求跳过当前回合
  function startTurnTimer() {
    clearTurnTimer();
    state.turnTimer = setInterval(function () {
      var remain = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
      var el = $("turn-timeout");
      if (el) {
        el.textContent = "限时 " + remain + "s";
        el.style.color = remain <= 5 ? "#f87171" : "#fb923c";
      }
      if (remain <= 0) {
        // 服务器权威回合：请求服务器跳过本轮（服务器会广播新 turn）
        clearTurnTimer();
        onTurnTimeout();
      }
    }, 200);
  }
  function clearTurnTimer() {
    if (state.turnTimer) { clearInterval(state.turnTimer); state.turnTimer = null; }
    var el = $("turn-timeout");
    if (el) el.textContent = "";
  }
  // 真人：轮到我时启动计时；轮不到我时停止。currentTurn 是唯一权威。
  function refreshTurnTimer() {
    // 比赛总倒计时（5 分钟）
    var matchEl = $("match-timeout");
    if (matchEl) {
      if (state.game && !state.game.finished && state.matchDeadline) {
        var remainSec = Math.max(0, Math.ceil((state.matchDeadline - Date.now()) / 1000));
        matchEl.textContent = "对局 " + Math.floor(remainSec / 60) + ":" + ("0" + (remainSec % 60)).slice(-2) + "  ";
      } else {
        matchEl.textContent = "";
      }
    }
    if (state.mode !== "pvp" || !state.game || state.game.finished) return;
    var isAiming = state.game.phase === "aiming";
    if (isMyPvpTurn() && isAiming) {
      state.game.turn = state.myPlayer;
      if (!state.turnTimer) startTurnTimer();
    } else {
      clearTurnTimer();
    }
  }
  // 超时：跳过本轮，换对方击球（不判负）。只在确实轮到我时生效。
  function onTurnTimeout() {
    if (state.mode !== "pvp" || !state.game || state.game.finished) return;
    if (!isMyPvpTurn()) return;
    if (state.game.phase !== "aiming") return;
    clearTurnTimer();
    // 只通知服务器；回合完全由服务器广播 turn 驱动，本地绝不自行切回合
    if (state.pvp) state.pvp.sendSkip(state.myPlayer, 0);
    state.lastShotPlayer = state.myPlayer;
    state.turnPending = true;
    console.log("[PvP] local timeout, sent skip", { myPlayer: state.myPlayer, turnPending: state.turnPending });
    var el = $("hint-text");
    if (el) el.textContent = "本轮超时，已跳过，等待对手击球…";
  }

  // PvP：是否轮到我操作。完全由服务器 currentTurn 驱动；等待服务器确认期间不可操作。
  function isMyPvpTurn() {
    return state.currentTurn === state.myPlayer && !state.turnPending;
  }

  // 服务器回合权威：收到 turn 时解锁 pending，按服务器 deadline 显示倒计时
  function handleServerTurn(turn, version, deadline) {
    version = version || 0;
    // 每秒 sync_turn 会返回同一 version；只有版本确实更新才重置回合和倒计时
    if (version < state.turnVersion) return;
    var changed = version > state.turnVersion;
    state.turnVersion = version;
    state.currentTurn = turn;
    state.turnPending = false;
    if (deadline) state.turnDeadline = deadline;
    if (changed) {
      clearTurnTimer();
      refreshTurnTimer();
    }
  }

  // 服务器广播的回合超时（仅供提示，不参与回合切换）
  function handleServerTurnTimeout(msg) {
    var el = $("hint-text");
    if (el) el.textContent = "本轮超时，已转交对手…";
    clearTurnTimer();
  }

  // 收到对方击球（DataChannel，只做物理重放；回合状态只由服务器 turn 广播驱动）
  function handleRemoteShot(msg) {
    var g = state.game;
    if (!g || g.finished) return;
    var shooter = (typeof msg.player === "number") ? msg.player : (1 - state.myPlayer);
    var cue = msg.cue;
    if (cue === undefined || cue === null) cue = 0;
    g.selectedCue = cue;
    g.shootFor(shooter, cue, msg.vx, msg.vy);
    state.lastShotPlayer = shooter;
    clearTurnTimer();
  }

  // 收到对方跳过（DataChannel，仅提示；回合只由服务器 turn 广播驱动）
  function handleRemoteSkip(msg) {
    var g = state.game;
    if (!g || g.finished) return;
    var shooter = (typeof msg.player === "number") ? msg.player : (1 - state.myPlayer);
    state.lastShotPlayer = shooter;
    clearTurnTimer();
    refreshTurnTimer();
    var el = $("hint-text");
    if (el) el.textContent = "对手超时跳过，等待服务器切回合…";
  }

  // 收到对方结束指纹
  function handleRemoteResult(hash) {
    if (!state.game || !state.game.finished) return;
    state.remoteHash = hash;
    var mine = state.game.stateHash();
    if (state.resultShown) {
      $("hash-b").textContent = "对方指纹 = 0x" + hash.toString(16);
      $("hash-check").innerHTML = (hash === mine)
        ? '<span class="ok">✔ 双端指纹一致 → 链上可结算</span>'
        : '<span class="bad">✘ 指纹不一致 → 触发挑战仲裁</span>';
    }
  }

  var lastTime = 0;
  var lastTurnSync = 0;
  var lastPhase = "";
  function loop(ts) {
    state.rafId = requestAnimationFrame(loop);
    if (!ts) ts = 0;
    var g = state.game;

    // 物理推进：moving 阶段每帧步进一次（最终静止态确定性，与帧率无关）
    if (g.phase === "moving") {
      g.step();
      // 刚停球回 aiming 时刷新回合倒计时（消除"没读秒"问题）
      if (g.phase === "aiming" && state.mode === "pvp") {
        refreshTurnTimer();
      }
    }

    // 机器人模式：AI 回合静止后延时出杆
    if (state.mode === "bot" && g.phase === "aiming" && g.turn === 1 && !g.finished && !state.botTimer) {
      state.botTimer = setTimeout(botShoot, 800);
    }

    // 真人模式：每帧刷新回合倒计时；每 1 秒主动请求服务器权威回合，防止广播丢失卡死
    refreshTurnTimer();
    if (state.mode === "pvp" && state.pvp && (ts - lastTurnSync >= 1000)) {
      lastTurnSync = ts;
      state.pvp.syncTurn();
    }

    // 5 分钟对局硬截止：到点按当前比分结束，平局 winner=-1
    if (!g.finished && state.matchDeadline && Date.now() >= state.matchDeadline && typeof g.finishByScore === "function") {
      g.finishByScore();
    }

    draw();

    if (g.finished && !state.resultShown) {
      state.resultShown = true;
      if (state.botTimer) clearTimeout(state.botTimer);
      if (state.mode === "pvp" && state.pvp) {
        state.pvp.sendResult(g.stateHash());
        // 代币场：对局结束后双方各签同一结果，仅 P2P 交换，不自动 settle
        if (state.field && state.field.id !== "free" && !state.demo && isChainConfigured() && state.chainMatchId && window.ethereum) {
          var resultHash = ethers.utils.hexZeroPad("0x" + g.stateHash().toString(16), 32);
          var winner = g.winner === -1
            ? ethers.constants.AddressZero
            : (g.winner === state.myPlayer ? state.address : (state.pvp.opponentAddress || state.address));
          var score0 = g.score0;
          var score1 = g.score1;
          var duration = Math.max(1, Math.round((Date.now() - state.startTime) / 1000));
          signMatchResult(state.chainMatchId, resultHash, winner, score0, score1, duration).then(function (sig) {
            state.myResultSignature = sig;
            state.myResultHash = resultHash;
            state.myResultWinner = winner;
            state.myScore0 = score0;
            state.myScore1 = score1;
            state.myDuration = duration;
            // 签名持久化到本地历史，刷新后也能恢复并重发
            var hist = loadHistory();
            var item = hist.find(function (h) { return h.chainMatchId === String(state.chainMatchId); });
            if (item) {
              item.resultHash = String(resultHash);
              item.winner = String(winner);
              item.score0 = score0;
              item.score1 = score1;
              item.duration = duration;
              item.myResultSignature = String(sig);
              saveHistoryItem(item);
            }
            if (state.pvp.sendResultSignature) {
              state.pvp.sendResultSignature(state.chainMatchId, resultHash, winner, score0, score1, duration, sig);
            }
            // 如果对方签名已先到，本端签名完成后自动把结果上链
            autoSubmitResultToRelayer();
            // 启动签名重发：P2P 断开前每 2 秒重发一次，防止中继丢包
            if (state.signRetryTimer) clearInterval(state.signRetryTimer);
            state.signRetryTimer = setInterval(function () {
              if (state.pvp && state.pvp.connected && state.pvp.sendResultSignature) {
                state.pvp.sendResultSignature(state.chainMatchId, resultHash, winner, score0, score1, duration, sig);
              } else {
                clearInterval(state.signRetryTimer);
                state.signRetryTimer = null;
              }
            }, 2000);
          }).catch(function (err) {
            console.error("sign result error", err);
          });
        }
      }
      // 先切结算页，避免对局结束后还停留在击球页/等待提示
      onFinish();
    }
  }

  // ---------------- 机器人 AI：从 5 颗母球里挑最合适的一颗，把足球撞向右门 ----------------
  function botShoot() {
    state.botTimer = null;
    var g = state.game;
    if (g.finished || g.turn !== 1 || g.phase !== "aiming") return;

    var fb = g.balls[PHYS.FOOTBALL_INDEX];
    if (fb.pocketed) { g.shoot(0, 0, 0); return; }

    // 期望足球去向：右门中心 (8000, 2250)
    var gx = PHYS.FIELD_W - fb.x;
    var gy = (PHYS.FIELD_H / 2) - fb.y;
    var mag = Billiards.isqrt(gx * gx + gy * gy);
    if (mag === 0) mag = 1;

    // 幽灵球位置
    var ghostX = fb.x - Math.trunc((gx * (PHYS.BALL_R * 2)) / mag);
    var ghostY = fb.y - Math.trunc((gy * (PHYS.BALL_R * 2)) / mag);

    // 遍历 AI 的 5 颗母球（索引 5..9），选离幽灵球最近且未进袋的一颗
    var best = -1, bestDist = Infinity, bestVx = 0, bestVy = 0;
    for (var c = 0; c < PHYS.CUE_COUNT; c++) {
      var bi = PHYS.CUE_COUNT + c;
      var cue = g.balls[bi];
      if (cue.pocketed) continue;
      var dx = ghostX - cue.x;
      var dy = ghostY - cue.y;
      var dmag = Billiards.isqrt(dx * dx + dy * dy);
      if (dmag === 0) dmag = 1;
      var dist = dmag;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
        // 按右侧选择的机器人难度调整力度：新手偏弱且带随机误差，高手更准
        var power = 140;
        if (state.botDiff === "easy") {
          power = 95 + Math.floor(Math.random() * 35);
        } else if (state.botDiff === "hard") {
          power = 160;
        }
        var aimJitter = state.botDiff === "easy" ? Math.floor(Math.random() * 25) - 12 : 0;
        bestVx = Math.trunc((dx * power) / dmag) + aimJitter;
        bestVy = Math.trunc((dy * power) / dmag) + aimJitter;
      }
    }
    if (best === -1) { g.shoot(0, 0, 0); return; }

    g.selectedCue = best;
    g.shoot(best, bestVx, bestVy);
  }

  // ---------------- 触控瞄准（拖拽出现箭头） ----------------
  var canvas = null;
  function initTouch() {
    canvas = $("field");
    canvas.addEventListener("touchstart", onPointerDown, { passive: false });
    canvas.addEventListener("touchmove", onPointerMove, { passive: false });
    canvas.addEventListener("mousedown", onPointerDown);
    canvas.addEventListener("mousemove", onPointerMove);
    // 母球贴近边界时，拖拽可能超出 canvas；mousemove/touchend 需要在 window 上兜底，确保边界外松开也能释放
    canvas.addEventListener("mouseup", onPointerUp);
    canvas.addEventListener("touchend", onPointerUp, { passive: false });
    canvas.addEventListener("touchcancel", onPointerUp, { passive: false });
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("touchend", onPointerUp, { passive: false });
    window.addEventListener("touchcancel", onPointerUp, { passive: false });
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("touchmove", onPointerMove, { passive: false });
  }
  function getPos(e) {
    var rect = canvas.getBoundingClientRect();
    // 把 CSS 坐标换算到 canvas 内部坐标，消除 CSS 拉伸导致的错位
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var point = e.touches && e.touches.length ? e.touches[0] :
      (e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : e);
    var cx = (point.clientX - rect.left) * scaleX;
    var cy = (point.clientY - rect.top) * scaleY;
    return { x: cx, y: cy };
  }
  function onPointerDown(e) {
    var g = state.game;
    if (!g || g.finished) return;
    if (g.phase !== "aiming") return;
    var isMyTurn = state.mode === "pvp" ? isMyPvpTurn() : (g.turn === 0);
    if (!isMyTurn) return;
    if (e.cancelable) e.preventDefault();
    var p = getPos(e);
    var S = FIELD_PX_SCALE;
    var r = Math.max(14, PHYS.BALL_R * S);

    // 目标：优先命中我方未进袋母球。机器人模式=0..4（左半场），真人模式按 myPlayer 取对应半场
    var myOffset = (state.mode === "pvp" && state.myPlayer === 1) ? PHYS.CUE_COUNT : 0;
    for (var i = 0; i < PHYS.CUE_COUNT; i++) {
      var bi = myOffset + i;
      var b = g.balls[bi];
      if (b.pocketed) continue;
      var bxp = worldXToPx(b.x);
      var byp = worldYToPx(b.y);
      var d = Math.sqrt((p.x - bxp) * (p.x - bxp) + (p.y - byp) * (p.y - byp));
      if (d <= r + 20) {
        g.selectedCue = i;
        state.aiming = { ballX: bxp, ballY: byp, curX: p.x, curY: p.y };
        return;
      }
    }
  }
  function onPointerMove(e) {
    if (!state.aiming) return;
    if (e.cancelable) e.preventDefault();
    var p = getPos(e);
    state.aiming.curX = p.x;
    state.aiming.curY = p.y;
  }
  function onPointerUp(e) {
    if (!state.aiming) return;
    if (e.cancelable) e.preventDefault();
    var a = state.aiming;
    state.aiming = null;
    var g = state.game;
    if (!g || g.finished || g.phase !== "aiming") return;
    var isMyTurn = state.mode === "pvp" ? isMyPvpTurn() : (g.turn === 0);
    if (!isMyTurn) return;

    // 方向向量 = 鼠标 - 母球圆心（精确指向目标）
    var dx = a.curX - a.ballX;
    var dy = a.curY - a.ballY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 5) return; // 死区，视为取消

    // 力度：150px 距离 = 满力 MAX_SPEED(180)
    var maxPx = 150;
    var speed = Math.min(PHYS.MAX_SPEED, Math.round(dist * PHYS.MAX_SPEED / maxPx));
    if (speed < 5) return; // 拖动 < ~3% 才算误触；低力度也能击出

    // 方向单位向量（浮点仅用于这里的一次性换算，物理引擎内部仍全整数）
    var ux = dx / dist;
    var uy = dy / dist;
    var vx = Math.trunc(ux * speed);
    var vy = Math.trunc(uy * speed);
    if (state.mode === "pvp") {
      // 真人模式：本地击球用 shootFor；发消息后等待服务器 turn 确认
      g.shootFor(state.myPlayer, g.selectedCue, vx, vy);
      state.lastShotPlayer = state.myPlayer;
      state.pvp.sendShot(g.selectedCue, vx, vy, state.myPlayer, 0);
      state.turnPending = true;
      clearTurnTimer();
    } else {
      g.shoot(g.selectedCue, vx, vy);
    }
  }

  // ---------------- 渲染 ----------------
  function draw() {
    if (!state.game) return;
    var ctx = canvas.getContext("2d");
    drawField(ctx);
    drawBalls(ctx);
    drawAimArrow(ctx);
    drawHUD();
  }

  // 真实足球场背景（电视转播质感；场地居中，左右留白放球网/看台）
  function drawField(ctx) {
    var W = canvas.width, H = canvas.height;
    var S = FIELD_PX_SCALE;
    var left = fieldLeftPx(), right = fieldRightPx();
    var top = fieldTopPx(), bottom = fieldBottomPx();
    var in0 = left, in1 = right, inTop = top, inBottom = bottom;
    var cx = W / 2, cy = H / 2;

    // ---- 看台/深色底（外部留白，只放球门/球网）----
    ctx.fillStyle = "#08120f";
    ctx.fillRect(0, 0, W, H);

    // ---- 草皮底色 + 横向修剪条纹：只在场地范围内绘制 ----
    var band = Math.round((bottom - top) / 9);
    for (var y = top; y < bottom; y += band) {
      ctx.fillStyle = Math.floor((y - top) / band) % 2 === 0 ? "#2f8f4e" : "#288544";
      ctx.fillRect(left, y, right - left, band + 1);
    }

    // 草皮整体光照渐变（横向，指向左右球门）
    var g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.08, "rgba(86,178,108,0.18)");
    g.addColorStop(0.5, "rgba(255,255,255,0.03)");
    g.addColorStop(0.92, "rgba(86,178,108,0.18)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(left, top, right - left, bottom - top);

    // ---- 场地标线 ----
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 2;
    ctx.strokeRect(in0, inTop, in1 - in0, inBottom - inTop);

    // 中线
    ctx.beginPath(); ctx.moveTo((left + right) / 2, inTop); ctx.lineTo((left + right) / 2, inBottom); ctx.stroke();

    // 中圈 + 中点
    var midX = (left + right) / 2;
    ctx.beginPath(); ctx.arc(midX, cy, 75, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(midX, cy, 4, 0, Math.PI * 2); ctx.fill();

    // 禁区与球门区（U 形）
    drawArea(ctx, in0, 160, 360, cy, true);
    drawArea(ctx, in1, 160, 360, cy, false);
    drawArea(ctx, in0, 50, 180, cy, true);
    drawArea(ctx, in1, 50, 180, cy, false);

    // 禁区弧（罚球弧）
    ctx.beginPath(); ctx.arc(in0 + 160, cy, 90, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(in1 - 160, cy, 90, Math.PI / 2, -Math.PI / 2); ctx.stroke();

    // 罚球点
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(in0 + 110, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(in1 - 110, cy, 4, 0, Math.PI * 2); ctx.fill();

    // 角球区弧线
    ["TL","TR","BL","BR"].forEach(function (k, i) {
      var x = k.indexOf("R") >= 0 ? in1 : in0;
      var y = k.indexOf("B") >= 0 ? inBottom : inTop;
      cornerArc(ctx, x, y, 12, i);
    });

    // ---- 球门 + 球网（放在场地外左右两侧，门线=场地边线）----
    var goalHalfPx = PHYS.GOAL_HALF_H * S;
    drawGoal(ctx, W, in0, cy, goalHalfPx, true);
    drawGoal(ctx, W, in1, cy, goalHalfPx, false);

    // ---- 草皮颗粒噪点（最后画在标线/球之下，仅遮罩场地区域）----
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    drawGrassNoise(ctx, W, H);
    ctx.restore();
  }

  // 低透明度随机短草纹噪点：用确定性伪随机（避免每帧闪烁）
  var _grassRandState = 0x9e3779b9;
  function _nextGrassRand() {
    var s = _grassRandState;
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    _grassRandState = s;
    return s;
  }
  function drawGrassNoise(ctx, W, H) {
    // 每次调用重置，保证渲染稳定
    _grassRandState = 0x9e3779b9;
    ctx.lineWidth = 1;
    for (var i = 0; i < 180; i++) {
      var x = _nextGrassRand() % W;
      var y = _nextGrassRand() % H;
      var len = 3 + (_nextGrassRand() % 5); // 3~7 px
      var ang = (_nextGrassRand() % 628) / 100; // 0~6.28
      var dx = Math.cos(ang) * len;
      var dy = Math.sin(ang) * len;
      // 深浅交替，非常低透明度
      ctx.strokeStyle = (_nextGrassRand() % 2 === 0)
        ? "rgba(255,255,255,0.045)"
        : "rgba(12,45,25,0.06)";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    }
  }

  function cornerArc(ctx, x, y, r, cornerIndex) {
    ctx.beginPath();
    if (cornerIndex === 0) ctx.arc(x, y, r, 0, Math.PI / 2);          // TL
    else if (cornerIndex === 1) ctx.arc(x, y, r, Math.PI / 2, Math.PI); // TR
    else if (cornerIndex === 2) ctx.arc(x, y, r, -Math.PI / 2, 0);     // BL
    else ctx.arc(x, y, r, Math.PI, Math.PI * 1.5);                     // BR
    ctx.stroke();
  }

  function drawArea(ctx, goalLinePx, depthPx, heightPx, cy, isLeft) {
    var halfH = heightPx / 2;
    var innerX = isLeft ? goalLinePx + depthPx : goalLinePx - depthPx;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(goalLinePx, cy - halfH);
    ctx.lineTo(innerX, cy - halfH);
    ctx.lineTo(innerX, cy + halfH);
    ctx.lineTo(goalLinePx, cy + halfH);
    ctx.stroke();
  }

  function drawGoal(ctx, W, goalLinePx, cy, goalHalfPx, isLeft) {
    // 网兜从门线向外延伸；留白 50px，尽量铺满外侧区域，网与门线看成一个整体
    var margin = isLeft ? goalLinePx : W - goalLinePx;
    var netDepth = Math.max(22, Math.min(46, margin - 2));
    var x0 = isLeft ? goalLinePx - netDepth : goalLinePx;
    var x1 = x0 + netDepth;

    // 球门后侧深色背景，让网更突出
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(x0, cy - goalHalfPx - 4, netDepth, goalHalfPx * 2 + 8);

    // 网兜背景（提亮，让球网更明显）
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    ctx.fillRect(x0, cy - goalHalfPx - 4, netDepth, goalHalfPx * 2 + 8);

    // 网眼：白色、更粗、更密
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1.4;
    for (var gx = 0; gx <= netDepth; gx += 4) {
      ctx.beginPath(); ctx.moveTo(x0 + gx, cy - goalHalfPx - 4); ctx.lineTo(x0 + gx, cy + goalHalfPx + 4); ctx.stroke();
    }
    for (var gy = -goalHalfPx - 4; gy <= goalHalfPx + 4; gy += 5) {
      ctx.beginPath(); ctx.moveTo(x0, cy + gy); ctx.lineTo(x1, cy + gy); ctx.stroke();
    }

    // 门柱：加粗、亮白，顶部和底部用横杆连接，像球门框
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(goalLinePx, cy - goalHalfPx);
    ctx.lineTo(goalLinePx, cy + goalHalfPx);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(goalLinePx, cy - goalHalfPx);
    ctx.lineTo(isLeft ? x0 : x1, cy - goalHalfPx);
    ctx.moveTo(goalLinePx, cy + goalHalfPx);
    ctx.lineTo(isLeft ? x0 : x1, cy + goalHalfPx);
    ctx.stroke();
    ctx.lineWidth = 2;
  }

  function drawBalls(ctx) {
    var g = state.game;
    var S = FIELD_PX_SCALE;
    var r = Math.max(8, PHYS.BALL_R * S);

    for (var i = 0; i < PHYS.TOTAL_BALLS; i++) {
      var b = g.balls[i];
      if (b.pocketed) continue;
      var px = worldXToPx(b.x), py = worldYToPx(b.y);

      if (i === PHYS.FOOTBALL_INDEX) {
        // 足球：白色 + 黑色五边形斑块
        drawFootball(ctx, px, py, r);
      } else {
        // 母球：按玩家填充高对比纯色，再用高光/暗面做出浮雕立体感
        var isP0 = i < PHYS.CUE_COUNT;
        var cueNo = i < PHYS.CUE_COUNT ? i : i - PHYS.CUE_COUNT;
        var base = isP0 ? "#06b6d4" : "#f97316";
        var dark = isP0 ? "#155e75" : "#9a3412";
        var light = isP0 ? "#a5f3fc" : "#fed7aa";

        // 球体底色
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = base;
        ctx.fill();

        // 浮雕暗面：右下角半圆弧
        ctx.beginPath();
        ctx.arc(px + r * 0.18, py + r * 0.2, r * 0.82, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fill();

        // 浮雕主色：回填中心亮区
        ctx.beginPath();
        ctx.arc(px, py, r * 0.82, 0, Math.PI * 2);
        ctx.fillStyle = base;
        ctx.fill();

        // 浮雕高光
        var grad = ctx.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
        grad.addColorStop(0, light);
        grad.addColorStop(0.55, base);
        grad.addColorStop(1, dark);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // 顶部高光点
        ctx.beginPath();
        ctx.arc(px - r * 0.3, py - r * 0.35, r * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fill();

        // 底部暗边
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // 编号文字（用高对比色，保证在纯色球面上清晰）
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold " + Math.max(10, r * 0.75) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cueNo + 1, px, py + 1);
      }
    }
  }

  function drawFootball(ctx, px, py, r) {
    // 主体白色
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.strokeStyle = "#222"; ctx.lineWidth = 1.5; ctx.stroke();
    // 中心黑色五边形
    ctx.beginPath();
    for (var k = 0; k < 5; k++) {
      var ang = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      var x = px + Math.cos(ang) * r * 0.45;
      var y = py + Math.sin(ang) * r * 0.45;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "#111"; ctx.fill();
    // 五个黑色小斑块
    for (var k = 0; k < 5; k++) {
      var ang2 = -Math.PI / 2 + (k * 2 * Math.PI) / 5 + Math.PI / 5;
      var x2 = px + Math.cos(ang2) * r * 0.85;
      var y2 = py + Math.sin(ang2) * r * 0.85;
      ctx.beginPath(); ctx.arc(x2, y2, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = "#111"; ctx.fill();
    }
  }

  function drawAimArrow(ctx) {
    if (!state.aiming) return;
    var g = state.game;
    var S = FIELD_PX_SCALE;
    // 箭头从「当前选中的母球」指向鼠标；真人模式下必须用当前玩家的真实球索引
    var b = g.balls[myCueBallIndex(g.selectedCue)];
    if (!b || b.pocketed) return;
    var bx = worldXToPx(b.x), by = worldYToPx(b.y);
    // 方向 = 鼠标 - 母球圆心，精确指向目标
    var dx = state.aiming.curX - bx;
    var dy = state.aiming.curY - by;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 5) return;
    var ux = dx / len, uy = dy / len;

    // 箭头长度 = 力度映射（150px = 满力），但显示上限制一个最大长度
    var maxPx = 150;
    var speed = Math.min(PHYS.MAX_SPEED, Math.round(len * PHYS.MAX_SPEED / maxPx));
    var arrowLen = Math.min(len, maxPx);
    var tipX = bx + ux * arrowLen;
    var tipY = by + uy * arrowLen;

    // 引导线（母球到目标方向，半透明）
    ctx.strokeStyle = "rgba(34,211,238,0.45)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(state.aiming.curX, state.aiming.curY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 力度箭头（实心，活力橙）
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // 箭头头部
    var headLen = 16;
    var headAng = 0.5;
    var backX = tipX - ux * headLen;
    var backY = tipY - uy * headLen;
    var px1 = backX + (-uy) * headLen * Math.sin(headAng);
    var py1 = backY + (ux) * headLen * Math.sin(headAng);
    var px2 = backX + (uy) * headLen * Math.sin(headAng);
    var py2 = backY + (-ux) * headLen * Math.sin(headAng);
    ctx.fillStyle = "#fb923c";
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.closePath();
    ctx.fill();

    // 力度百分比
    var power = Math.min(100, Math.round(speed / PHYS.MAX_SPEED * 100));
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("力度 " + power + "%", tipX + 10, tipY - 6);
  }

  function drawHUD() {
    var g = state.game;
    $("score").textContent = g.score0 + " : " + g.score1;
    var badge = $("turn-badge");
    var isMyTurn = state.mode === "pvp" ? isMyPvpTurn() : (g.turn === 0);
    if (g.finished) {
      badge.textContent = "已结束";
      badge.className = "turn-badge";
    } else if (isMyTurn) {
      badge.textContent = "你的回合";
      badge.className = "turn-badge me";
    } else {
      badge.textContent = state.mode === "pvp" ? "对手回合" : "机器人回合";
      badge.className = "turn-badge opp";
    }
    $("hint-text").textContent = (isMyTurn && g.phase === "aiming" && !g.finished)
      ? "点击你的编号母球选中它，拖动鼠标瞄准 + 力度箭头，松手击球"
      : (state.mode === "pvp" ? "等待对手击球…" : "等待中…");

    // 真人模式显示回合倒计时；其他模式隐藏
    var timerEl = $("turn-timeout");
    if (!timerEl) return;
    if (state.mode !== "pvp") {
      timerEl.textContent = "";
      return;
    }
    if (g.finished) { timerEl.textContent = ""; return; }
    if (!isMyTurn || g.phase !== "aiming") {
      timerEl.textContent = "";
      return;
    }
    if (!state.turnTimer) {
      timerEl.textContent = "限时 " + state.turnTimeoutSec + "s";
    }
  }

  // ---------------- 历史记录 ----------------
  var HISTORY_KEY = "ff_history_v1";
  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }
  function saveHistoryItem(item) {
    var list = loadHistory();
    // 同一次对局只保留一条本地记录（按 matchId 去重，优先更新签名/领取状态）
    var idx = list.findIndex(function (h) { return h.matchId === item.matchId; });
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(item);
    if (list.length > 100) list.length = 100;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  }
  function addCurrentMatchToHistory() {
    var g = state.game;
    if (!g) return;
    var meWin = state.mode === "pvp" ? (g.winner === state.myPlayer) : (g.winner === 0);
    var drawGame = g.winner === -1;
    var duration = Math.max(1, Math.round((Date.now() - state.startTime) / 1000));
    var matchId = state.pvp && state.pvp.matchId ? state.pvp.matchId : ("local-" + (state.startTime || Date.now()).toString(16));
    var prev = loadHistory().find(function (h) { return h.matchId === matchId; });
    saveHistoryItem({
      matchId: matchId,
      chainMatchId: state.chainMatchId ? String(state.chainMatchId) : (prev ? prev.chainMatchId : ""),
      resultHash: state.myResultHash ? String(state.myResultHash) : (prev ? prev.resultHash : ""),
      winner: state.myResultWinner ? String(state.myResultWinner) : (prev ? prev.winner : ""),
      peerResultSignature: state.peerResultSignature ? String(state.peerResultSignature) : (prev ? prev.peerResultSignature : ""),
      opponent: state.opponent,
      field: state.field ? state.field.id : "free",
      fieldName: state.field ? state.field.name : "免费场",
      result: drawGame ? "平局" : (meWin ? "胜" : "负"),
      score: g.score0 + " : " + g.score1,
      duration: duration,
      deltaScore: meWin ? 15 : drawGame ? 0 : -15,
      timestamp: state.startTime || Date.now(),
      claimed: prev ? prev.claimed : false,
      loserExited: prev ? prev.loserExited : false
    });
  }
  function saveCurrentMatchIfFinished() {
    var g = state.game;
    if (!g || !g.finished) return;
    addCurrentMatchToHistory();
  }
  var HISTORY_PAGE_SIZE = 8;
  var historyPage = 1;
  async function renderHistory() {
    var el = $("history-list");
    if (!el) return;

    var allRows = [];
    var seenChainIds = {};

    // 链上记录是资金结算的权威来源；本地记录补全免费场、未上链、演示和机器人对局
    if (!state.demo && isChainConfigured() && state.address && window.ethereum) {
      try {
        var c = getContracts();
        var matches = await c.match.getUserMatches(state.address);
        if (matches && matches.length) {
          matches.forEach(function (r) {
            var id = r.matchId.toString();
            seenChainIds[id] = true;
            var status = Number(r.status);
            var winnerIsMe = String(r.winner).toLowerCase() === String(state.address).toLowerCase();
            var amPlayer1 = String(r.player1).toLowerCase() === String(state.address).toLowerCase();
            var amPlayer2 = String(r.player2).toLowerCase() === String(state.address).toLowerCase();
            var claimHtml = "";
            var statusText = "";
            if (status === 0) {
              statusText = "待结算";
              // 双方已质押但未进入对局时可手动申请免手续费兜底退款
              if (amPlayer1 || amPlayer2) {
                claimHtml = "<div><button class='ghost no-game-refund' data-chain='" + id + "'>↩ 未开局退款</button></div>";
              }
            } else if (status === 1) {
              statusText = "已结算";
              if (winnerIsMe && !r.claimed && r.claimable > 0) {
                claimHtml = "<div><button class='ghost claim-from-history' data-chain='" + id + "'>💰 提取奖金</button></div>";
              }
            } else if (status === 2) {
              statusText = r.noFeeRefund ? "已退款（未开局，不扣手续费）" : "已退款";
              var refundLabel = r.noFeeRefund ? "🪙 领取全额本金" : "🪙 领取本金";
              if (amPlayer1 && !r.refundClaimed1) {
                claimHtml = "<div><button class='ghost refund-from-history' data-chain='" + id + "'>" + refundLabel + "</button></div>";
              }
              if (amPlayer2 && !r.refundClaimed2) {
                claimHtml = "<div><button class='ghost refund-from-history' data-chain='" + id + "'>" + refundLabel + "</button></div>";
              }
            }
            var score = r.score0.toString() + " : " + r.score1.toString();
            var duration = r.duration.toString() + "s";
            var time = new Date(Number(r.timestamp) * 1000).toLocaleString();
            var fieldName = historyFieldName(r.amount);
            var resultLine = status === 0
              ? "双方已质押，等待结算"
              : "赢家 " + (winnerIsMe ? "你" : shortAddr(String(r.winner))) + " · 输家 " + (amPlayer1 || amPlayer2 ? "你" : shortAddr(String(r.loser))) + " · " + score;
            allRows.push({
              ts: Number(r.timestamp) * 1000,
              html: "<div style='padding:8px 0;border-bottom:1px solid var(--line);'>" +
                "<div style='display:flex;justify-content:space-between;'><b>" + fieldName + " · 对局 #" + id + "</b>" +
                "<span class='muted'>" + statusText + (r.claimed ? " · 已领取" : "") + "</span></div>" +
                "<div class='muted'>" + resultLine + "</div>" +
                "<div class='muted'>时长：" + duration + " · " + time + "</div>" +
                claimHtml +
                "</div>"
            });
          });
        }
      } catch (e) {
        console.error("chain history error", e);
      }
    }

    // 本地历史始终展示，避免链上有记录时隐藏免费场/未上链对局
    loadHistory().forEach(function (h) {
      if (h.chainMatchId && seenChainIds[String(h.chainMatchId)]) return;
      var d = new Date(h.timestamp);
      var time = d.toLocaleString();
      var claimHtml = "";
      if (h.field && h.field !== "free" && h.result === "胜" && h.chainMatchId && !h.claimed) {
        claimHtml = "<div><button class='ghost claim-from-history' data-chain='" + h.chainMatchId + "'>💰 提取奖金</button></div>";
      }
      allRows.push({
        ts: h.timestamp || 0,
        html: "<div style='padding:8px 0;border-bottom:1px solid var(--line);'>" +
          "<div style='display:flex;justify-content:space-between;'><b>" + h.fieldName + "</b>" +
          "<span class='muted'>" + h.result + "  " + h.score + "</span></div>" +
          "<div class='muted'>对手：" + h.opponent + " · " + h.duration + "s · " + time + "</div>" +
          claimHtml +
          "</div>"
      });
    });

    allRows.sort(function (a, b) { return b.ts - a.ts; });

    if (!allRows.length) {
      el.innerHTML = '<div class="muted">暂无对局记录。</div>';
      return;
    }

    var totalPages = Math.max(1, Math.ceil(allRows.length / HISTORY_PAGE_SIZE));
    if (historyPage > totalPages) historyPage = totalPages;
    var start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    var pageRows = allRows.slice(start, start + HISTORY_PAGE_SIZE);

    el.innerHTML = pageRows.map(function (r) { return r.html; }).join("") +
      "<div style='display:flex;justify-content:center;align-items:center;gap:10px;padding-top:10px;'>" +
      "<button class='ghost history-page' data-page='" + (historyPage - 1) + "' " + (historyPage <= 1 ? "disabled" : "") + ">上一页</button>" +
      "<span class='muted'>" + historyPage + " / " + totalPages + "</span>" +
      "<button class='ghost history-page' data-page='" + (historyPage + 1) + "' " + (historyPage >= totalPages ? "disabled" : "") + ">下一页</button>" +
      "</div>";

    el.querySelectorAll(".claim-from-history").forEach(function (btn) {
      btn.addEventListener("click", function () {
        claimFromHistory(btn.dataset.chain);
      });
    });
    el.querySelectorAll(".refund-from-history").forEach(function (btn) {
      btn.addEventListener("click", function () {
        refundFromHistory(btn.dataset.chain);
      });
    });
    el.querySelectorAll(".no-game-refund").forEach(function (btn) {
      btn.addEventListener("click", function () {
        refundNoGameFromHistory(btn.dataset.chain);
      });
    });
    el.querySelectorAll(".history-page").forEach(function (btn) {
      btn.addEventListener("click", function () {
        historyPage = parseInt(btn.dataset.page, 10);
        renderHistory();
      });
    });
  }
  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }

  // ---------------- 结算 ----------------
  // 对局结果自动上链（Relayer 优先，其次胜方自己上链）
  async function submitResultOnChain(chainMatchId, resultHash, winner, score0, score1, duration, loserSignature) {
    var relayerUrl = Chain.relayerUrl || (window.RelayerConfig && window.RelayerConfig.url) || state.relayerUrl || "";
    if (relayerUrl) {
      var resp = await fetch(relayerUrl + "/api/recordResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId: chainMatchId,
          resultHash: resultHash,
          winner: winner,
          score0: score0,
          score1: score1,
          duration: duration,
          loserSignature: loserSignature
        })
      });
      var json = await resp.json();
      if (!json.ok) throw new Error(json.error || "recordResult failed");
      return;
    }
    var c = getContracts();
    if (c) {
      var txr = await c.match.recordResult(chainMatchId, resultHash, winner, score0, score1, duration, loserSignature);
      await txr.wait();
    }
  }

  // 双方签名都齐后自动把结果提交上链，不等胜方手动领取
  async function autoSubmitResultToRelayer() {
    if (!state.chainMatchId || !state.myResultSignature || !state.peerResultSignature) return;
    if (!state.peerResultHash || !state.peerResultWinner) return;
    if (state.resultRecorded) return;
    // 必须使用败方签名附带的值，因为 loserSignature 绑定的是败方签的原文
    var resultHash = state.peerResultHash;
    var winner = state.peerResultWinner;
    var score0 = state.peerScore0;
    var score1 = state.peerScore1;
    var duration = state.peerDuration;
    if (!winner || score0 === undefined || score1 === undefined || !duration) return;
    var zeroAddr = "0x0000000000000000000000000000000000000000";
    var isTie = String(winner).toLowerCase() === zeroAddr;
    // 平局：任一玩家提交都有效；正常对局只有胜方提交，Relayer 只接受败方签名
    if (!isTie && (!state.address || String(winner).toLowerCase() !== String(state.address).toLowerCase())) return;
    state.resultRecorded = true;
    try {
      console.log("[result-submit] payload", {
        chainMatchId: state.chainMatchId,
        resultHash: resultHash,
        winner: winner,
        score0: score0,
        score1: score1,
        duration: duration,
        loserSignature: state.peerResultSignature
      });
      await submitResultOnChain(state.chainMatchId, resultHash, winner, score0, score1, duration, state.peerResultSignature);
      var claimStatus = $("claim-status");
      if (claimStatus) claimStatus.textContent = isTie ? "✅ 平局结果已上链，双方可在历史中领取退款" : "✅ 结果已上链，等待胜方领取奖励";
    } catch (e) {
      console.error("auto submit result error", e);
      state.resultRecorded = false;
      var st = $("claim-status");
      if (st) st.textContent = "结果上链失败，可点击提取奖金重试：" + (e.message || e);
    }
  }

  // 胜方提取奖金：链上已有记录时直接领取
  async function claimReward() {
    var status = $("claim-status");
    if (!status) return;
    try {
      if (!state.chainMatchId) {
        status.textContent = "没有对局 ID，无法提取。";
        return;
      }
      var c = getContracts();
      if (!c) return;

      // 先检查链上是否已有记录
      var rec = await c.match.records(state.chainMatchId);
      var hasRecord = rec && rec.winner && rec.winner !== ethers.constants.AddressZero;

      if (!hasRecord) {
        // 链上记录还没有，先看对局是否已终态，避免对刚结算/上链未完成的对局再调 recordResult
        var game = await c.match.games(state.chainMatchId);
        var gameState = Number(game && game.state);
        if (gameState === 3 || gameState === 4) {
          status.textContent = "结果处理中或已完成，请稍后刷新重试；若仍无法提取请检查历史状态。";
          return;
        }
        // 链上还没有记录且非终态：先提交结果（Relayer 优先），再领取
        if (!state.peerResultSignature || !state.myResultHash || !state.myResultWinner) {
          status.textContent = "还没有收到败方签名，无法记录结果。";
          return;
        }
        var resultHash = state.myResultHash || state.peerResultHash;
        var winner = state.myResultWinner || state.peerResultWinner;
        var score0 = state.myScore0 !== undefined ? state.myScore0 : state.peerScore0;
        var score1 = state.myScore1 !== undefined ? state.myScore1 : state.peerScore1;
        var duration = state.myDuration !== undefined ? state.myDuration : state.peerDuration;
        status.textContent = "提交结果给 Relayer 记录…";
        await submitResultOnChain(state.chainMatchId, resultHash, winner, score0, score1, duration, state.peerResultSignature);
      }

      // 领取：胜方钱包直接调用
      var tx = await c.match.claimReward(state.chainMatchId);
      status.textContent = "等待领取确认…";
      await tx.wait();
      status.textContent = "✅ 奖金已领取，历史已上链";
      $("hash-check").innerHTML = '<span class="ok">✔ 链上结算完成</span>';

      var hist = loadHistory();
      var item = hist.find(function (h) { return h.chainMatchId === String(state.chainMatchId); });
      if (item) { item.claimed = true; saveHistoryItem(item); }
    } catch (e) {
      console.error("claim reward error", e);
      var msg = (e && e.message) || String(e);
      status.textContent = /wrong state|already|record exists/i.test(msg)
        ? "提取失败：结果可能仍在处理或已结算，请稍后刷新重试。"
        : "提取失败：" + msg;
    }
  }

  // 历史记录中未提取的胜局，点击提取奖金
  async function claimFromHistory(chainMatchId) {
    var status = $("claim-status");
    if (!status) status = document.createElement("div");
    if (!isChainConfigured() || !state.address || !window.ethereum) {
      status.textContent = "需要连接真实钱包且配置合约后才能提取。";
      return;
    }

    try {
      var c = getContracts();
      if (!c) return;

      // 链上已有记录：胜方钱包直接领取
      var rec = await c.match.records(chainMatchId);
      if (rec && rec.winner && rec.winner !== ethers.constants.AddressZero) {
        if (rec.claimed) {
          status.textContent = "该对局奖金已领取。";
          return;
        }
        if (String(rec.winner).toLowerCase() !== String(state.address).toLowerCase()) {
          status.textContent = "只有获胜方钱包能领取。";
          return;
        }
        var tx = await c.match.claimReward(chainMatchId);
        status.textContent = "等待链上确认…";
        await tx.wait();
        status.textContent = "✅ 奖金已领取";
        renderHistory();
        return;
      }

      // 链上记录还没生成时，先看对局状态；终态说明结果刚上链/处理中，不要再 recordResult
      var game = await c.match.games(chainMatchId);
      var gameState = Number(game && game.state);
      if (gameState === 3 || gameState === 4) {
        status.textContent = "结果处理中或已完成，请稍后刷新重试；若仍无法提取请检查历史状态。";
        renderHistory();
        return;
      }

      // 链上没有记录：需要本地结果证据，先 recordResult 再领取
      var hist = loadHistory();
      var item = hist.find(function (h) { return h.chainMatchId === String(chainMatchId); });
      if (!item || !item.peerResultSignature || !item.resultHash || !item.winner) {
        status.textContent = "该历史记录缺少败方签名，暂时无法记录结果。";
        return;
      }

      var relayerUrl = Chain.relayerUrl || (window.RelayerConfig && window.RelayerConfig.url) || state.relayerUrl || "";
      if (relayerUrl) {
        var recordResp = await fetch(relayerUrl + "/api/recordResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchId: chainMatchId,
            resultHash: item.resultHash,
            winner: item.winner,
            score0: item.score0 || 0,
            score1: item.score1 || 0,
            duration: item.duration || 0,
            loserSignature: item.peerResultSignature
          })
        });
        var recordJson = await recordResp.json();
        if (!recordJson.ok) throw new Error(recordJson.error || "recordResult failed");
      } else {
        var txr = await c.match.recordResult(
          chainMatchId,
          item.resultHash,
          item.winner,
          item.score0 || 0,
          item.score1 || 0,
          item.duration || 0,
          item.peerResultSignature
        );
        status.textContent = "等待记录确认…";
        await txr.wait();
      }

      // 领取：胜方钱包直接调用
      var txc = await c.match.claimReward(chainMatchId);
      status.textContent = "等待领取确认…";
      await txc.wait();
      status.textContent = "✅ 奖金已领取，历史已上链";

      item.claimed = true;
      saveHistoryItem(item);
      renderHistory();
    } catch (e) {
      console.error("claim from history error", e);
      var msg = (e && e.message) || String(e);
      status.textContent = /wrong state|already|record exists/i.test(msg)
        ? "提取失败：结果可能仍在处理或已结算，请稍后刷新重试。"
        : "提取失败：" + msg;
    }
  }

  // 双方未签名、记录已标记 Refunded 时，从历史领取自己锁定的本金
  async function refundFromHistory(chainMatchId) {
    var status = $("claim-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "claim-status";
      var claimArea = $("claim-area");
      if (claimArea) claimArea.appendChild(status);
    }
    if (!isChainConfigured() || !state.address || !window.ethereum) {
      status.textContent = "需要连接真实钱包且配置合约后才能领取退款。";
      return;
    }
    try {
      var c = getContracts();
      if (!c) return;
      var tx = await c.match.claimRefund(chainMatchId);
      status.textContent = "等待退款确认…";
      await tx.wait();
      status.textContent = "✅ 本金已退回钱包";
      renderHistory();
    } catch (e) {
      console.error("refund from history error", e);
      status.textContent = "退款领取失败：" + (e.message || e);
    }
  }

  // 双方已质押但未进入对局：由 Relayer 调用合约 refundNoGame 标记免手续费退款
  async function refundNoGameFromHistory(chainMatchId) {
    var status = $("claim-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "claim-status";
      var claimArea = $("claim-area");
      if (claimArea) claimArea.appendChild(status);
    }
    if (!isChainConfigured() || !state.address || !window.ethereum) {
      status.textContent = "需要连接真实钱包且配置合约后申请退款。";
      return;
    }
    var relayerUrl = Chain.relayerUrl || (window.RelayerConfig && window.RelayerConfig.url) || state.relayerUrl || "";
    if (!relayerUrl) {
      status.textContent = "未配置 Relayer，无法自动申请未开局退款。";
      return;
    }
    try {
      var c = getContracts();
      if (!c) return;
      var game = await c.match.games(chainMatchId);
      var stateNum = Number(game.state);
      if (stateNum !== 1) {
        status.textContent = "该对局不是激活中的未开局对局，无法申请无条件退款。";
        renderHistory();
        return;
      }
      if (game.submitted1 || game.submitted2) {
        status.textContent = "该对局已提交结果，不能走未开局退款，请按正常结算处理。";
        renderHistory();
        return;
      }
      status.textContent = "正在提交未开局退款…";
      var resp = await fetch(relayerUrl + "/api/refundNoGame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: String(chainMatchId) })
      });
      var json = await resp.json();
      if (!json.ok) throw new Error(json.error || "refundNoGame failed");
      status.textContent = "✅ 未开局退款已标记，双方可领取全额本金";
      renderHistory();
    } catch (e) {
      console.error("refund no game error", e);
      var msg = (e && e.message) || String(e);
      status.textContent = /wrong state|record exists|not relayer/i.test(msg)
        ? "退款失败：该对局状态不允许未开局退款，或 Relayer 未授权。"
        : "退款失败：" + msg;
    }
  }

  function onFinish() {
    var g = state.game;
    var meWin = state.mode === "pvp" ? (g.winner === state.myPlayer) : (g.winner === 0);
    var drawGame = g.winner === -1;

    var title = drawGame ? "🤝 平局" : (meWin ? "🏆 你赢了" : "💔 你输了");
    if (state.opponentLeftText) title += " · " + state.opponentLeftText;
    $("result-title").textContent = title;
    $("settle-score").textContent = "比分 " + g.score0 + " : " + g.score1;

    var hash = g.stateHash();
    $("hash-a").textContent = "我方状态指纹 = 0x" + hash.toString(16);
    if (state.mode === "pvp" && state.remoteHash !== undefined) {
      var same = state.remoteHash === hash;
      $("hash-b").textContent = "对方状态指纹 = 0x" + state.remoteHash.toString(16);
      $("hash-check").innerHTML = same
        ? '<span class="ok">✔ 双端指纹一致，请进行签名校验后 → 链上可结算</span>'
        : '<span class="bad">✘ 指纹不一致/平局 → 触发挑战仲裁</span>';
    } else {
      $("hash-b").textContent = state.mode === "pvp"
        ? "（等待对方指纹…）"
        : "（本地机器人模式，单端演示）";
      $("hash-check").innerHTML = state.mode === "pvp"
        ? '<span class="muted">等待对手提交结果</span>'
        : '<span class="muted">本地机器人模式</span>';
    }

    var table = $("settle-table");
    var rows = "";
    if (state.mode === "bot") {
      var diff = BOT_DIFFS.find(function (d) { return d.id === state.botDiff; });
      rows = "<tr><td>模式</td><td>本地机器人 · " + (diff ? diff.name : "标准场") + "</td></tr>" +
        "<tr><td>积分</td><td>" + (meWin ? "+15" : drawGame ? "+0" : "-15") + "（本地）</td></tr>";
    } else if (state.field && state.field.id === "free") {
      rows = "<tr><td>场次</td><td>免费场（无资金结算）</td></tr>" +
        "<tr><td>积分</td><td>" + (meWin ? "+15" : drawGame ? "+0" : "-15") + "（本地）</td></tr>";
    } else if (state.field) {
      var amt = parseFloat(state.field.amount);
      var pot = amt * 2;
      var fee = pot * 300 / 10000;
      var net = meWin ? (pot - fee) : 0;
      var refundEach = amt - fee / 2;
      rows = "<tr><td>场次</td><td>" + state.field.name + "</td></tr>" +
        "<tr><td>底池</td><td>" + pot + " 代币</td></tr>" +
        "<tr><td>手续费(3%)</td><td>" + fee.toFixed(6) + " 代币</td></tr>" +
        "<tr><td>" + (meWin ? "赢家入账" : drawGame ? "平局退款" : "输家支出") + "</td><td>" +
        (meWin ? "+" + net.toFixed(6) + " 代币" : drawGame ? "退回 " + refundEach.toFixed(6) + " 代币（已扣 3% 手续费）" : "-" + amt + " 代币") + "</td></tr>";
    }
    table.innerHTML = rows;

    // 每局结算后写入本地历史（免费场纯本地；代币场后续由链上事件补充）
    addCurrentMatchToHistory();

    // 收费场：胜方显示提取奖金，败方显示退出
    var claimArea = $("claim-area");
    if (claimArea) {
      if (state.field && state.field.id !== "free" && !state.demo && isChainConfigured()) {
        claimArea.style.display = "block";
        var claimBtn = $("btn-claim-reward");
        if (claimBtn) {
          claimBtn.style.display = meWin ? "block" : "none";
          if (meWin) {
            startClaimCountdown(claimBtn);
          }
        }
        var claimStatus = $("claim-status");
        if (claimStatus) claimStatus.textContent = meWin ? "等待接收败方签名后可提取奖金。" : "对局已结束，可退出。";
      } else {
        claimArea.style.display = "none";
      }
    }

    clearTurnTimer();
    show("finished");
  }

  var claimTimer = null;
  function clearClaimCountdown() {
    if (claimTimer) { clearInterval(claimTimer); claimTimer = null; }
  }
  // 比赛结束后 15 秒内不能立即提取，避免链上记录尚未确认就点击
  function startClaimCountdown(btn) {
    clearClaimCountdown();
    var remain = 15;
    btn.disabled = true;
    btn.textContent = remain + "s 后可提取";
    claimTimer = setInterval(function () {
      remain--;
      if (remain <= 0) {
        clearClaimCountdown();
        btn.disabled = false;
        btn.textContent = "提取奖金";
      } else {
        btn.textContent = remain + "s 后可提取";
      }
    }, 1000);
  }

  // ---------------- 绑定事件 ----------------
  function showInlineHistory() {
    var rules = $("rules-panel");
    var hist = $("history-inline");
    if (rules) rules.style.display = "none";
    if (hist) hist.style.display = "flex";
    // 历史记录视图中禁用右下角开始匹配
    var matchBtn = $("btn-match");
    if (matchBtn) matchBtn.disabled = true;
    // 左侧菜单：历史记录高亮，模式按钮取消高亮
    document.querySelectorAll("#screen-lobby .menu-item").forEach(function (el) {
      var isHistory = el.id === "btn-history";
      el.classList.toggle("selected", isHistory);
    });
    renderHistory();
  }
  function hideInlineHistory() {
    var rules = $("rules-panel");
    var hist = $("history-inline");
    if (rules) rules.style.display = "";
    if (hist) hist.style.display = "none";
    // 退出历史后按当前选择恢复开始匹配状态
    var matchBtn = $("btn-match");
    if (matchBtn) matchBtn.disabled = !(state.mode === "bot" && state.botDiff || state.mode === "pvp" && state.field);
    // 恢复当前模式按钮高亮
    document.querySelectorAll("#screen-lobby .menu-item").forEach(function (el) {
      if (el.id === "btn-history") {
        el.classList.remove("selected");
      } else {
        el.classList.toggle("selected", el.dataset.mode === state.mode);
      }
    });
  }

  function bind() {
    hideRefundButton();
    $("btn-login").addEventListener("click", onLogin);
    $("btn-demo-login").addEventListener("click", onDemoLogin);
    var logoutBtn = $("btn-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);
    document.querySelectorAll(".wallet-choice").forEach(function (btn) {
      btn.addEventListener("click", function () {
        loginWithWallet(btn.dataset.wallet);
      });
    });
    $("btn-match").addEventListener("click", startMatch);
    $("btn-cancel-match").addEventListener("click", cancelMatch);
    $("btn-refund-match").addEventListener("click", refundStuckMatch);
    $("btn-keep-wait").addEventListener("click", keepWaiting);
    $("btn-widen").addEventListener("click", widenRange);
    $("btn-exit-match").addEventListener("click", exitMatch);
    var exitGameBtn = $("btn-exit-game");
    if (exitGameBtn) exitGameBtn.addEventListener("click", exitGame);
    var exitCancelBtn = $("btn-exit-cancel");
    if (exitCancelBtn) exitCancelBtn.addEventListener("click", closeExitConfirm);
    var exitOkBtn = $("btn-exit-confirm");
    if (exitOkBtn) exitOkBtn.addEventListener("click", doExitGame);
    var messageOkBtn = $("btn-message-ok");
    if (messageOkBtn) messageOkBtn.addEventListener("click", closeMessageModal);
    $("btn-again").addEventListener("click", function () {
      clearClaimCountdown();
      matchSuccess();
    });
    $("btn-claim-reward").addEventListener("click", claimReward);
    $("btn-back-lobby").addEventListener("click", function () {
      clearClaimCountdown();
      saveCurrentMatchIfFinished();
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (state.botTimer) clearTimeout(state.botTimer);
      clearTurnTimer();
      show("lobby");
    });
    $("btn-history").addEventListener("click", function () {
      showInlineHistory();
    });
    $("btn-clear-history").addEventListener("click", clearHistory);
    $("btn-vault-deposit").addEventListener("click", onVaultDeposit);

    // 左侧模式菜单：本地机器人 / 真人匹配
    document.querySelectorAll("#screen-lobby .menu-item[data-mode]").forEach(function (el) {
      el.addEventListener("click", function () {
        selectMode(el.dataset.mode);
      });
    });

    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", function (accounts) {
        if (!accounts || !accounts.length) return;
        state.address = accounts[0];
        if (!state.demo && $("lobby-address")) {
          $("lobby-address").textContent = shortAddr(state.address);
        }
      });
    }
    initTouch();
  }

  // 从本地历史恢复最近一局的签名并重发，防止败方刷新后中继丢失
  function resendPendingResultSignature() {
    try {
      var list = loadHistory();
      var item = list.find(function (h) {
        return h.chainMatchId && h.myResultSignature && !h.loserExited && !h.claimed;
      });
      if (!item) return;
      state.chainMatchId = item.chainMatchId;
      state.myResultSignature = item.myResultSignature;
      state.myResultHash = item.resultHash;
      state.myResultWinner = item.winner;
      if (state.pvp && state.pvp.sendResultSignature) {
        state.pvp.sendResultSignature(item.chainMatchId, item.resultHash, item.winner, item.myResultSignature);
      }
    } catch (e) {
      console.error("resend pending signature error", e);
    }
  }

  bind();
  // 恢复本地登录会话：刷新后不再要求重新签名
  try {
    var saved = JSON.parse(localStorage.getItem("ff_session") || "null");
    if (saved && saved.address) {
      state.address = saved.address;
      state.demo = !!saved.demo;
      state.siwe = saved.siwe || null;
      state.walletType = saved.walletType || "";
      state.walletProviderObj = state.walletType ? getWalletProvider(state.walletType) : null;
      enterLobby();
      resendPendingResultSignature();
    } else {
      show("login");
    }
  } catch (_) {
    show("login");
  }
})();
