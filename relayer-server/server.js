/**
 * 指尖足球 Relayer（gas 代付服务）
 *
 * 职责：
 *   - 接收前端提交的对局结果证据
 *   - 本地验签（败方必须签名同一内容）
 *   - 用 gas 钱包调用 Match.recordResult 记录结果
 *   - 提交失败自动重试（最多 RETRY_LIMIT 次）
 *
 * 领取奖励由获胜方钱包直接调用 Match.claimReward，本服务不代领。
 * 不提供业务接口、不存业务数据、不做裁判。历史/对局全部在链上读取。
 *
 * 运行：
 *   RPC_URL=https://bsc-testnet-rpc.publicnode.com \
 *   MATCH_ADDRESS=0x... \
 *   RELAYER_PRIVATE_KEY=0x... \
 *   node server.js
 */
const http = require("http");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 8790;
const RPC_URL = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const MATCH_ADDRESS = process.env.MATCH_ADDRESS || "";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "";
const RETRY_LIMIT = parseInt(process.env.RETRY_LIMIT || "3", 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "5000", 10);
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "97", 10);

// 最小 ABI：Relayer 只允许代付 recordResult，不包含 claimReward
const MATCH_ABI = [
  "function recordResult(uint256 matchId,bytes32 resultHash,address winner,uint256 score0,uint256 score1,uint256 duration,bytes loserSignature)"
];

// 链上只允许调用 recordResult（Relayer 最小权限）
const ALLOWED_FUNCTIONS = new Set(["recordResult"]);

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1024 * 1024) reject(new Error("payload too large")); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// 本地验签：败方必须签 RECORD_TYPEHASH
function verifyRecordSignature(payload, address) {
  const domain = {
    name: "FingertipFootballMatch",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: MATCH_ADDRESS
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
    return recovered.toLowerCase() === address.toLowerCase();
  } catch (e) {
    return false;
  }
}

// 用 eth_call 先模拟，成功才提交，避免 gas 钱包被垃圾请求刷费
async function simulate(contract, funcName, args, from) {
  const populated = await contract[funcName].populateTransaction(...args);
  await contract[funcName].staticCall(...args, { from });
}

async function submitWithRetry(contract, funcName, args) {
  const gasWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, contract.runner.provider);
  const connected = contract.connect(gasWallet);

  let lastError = null;
  for (let i = 0; i < RETRY_LIMIT; i++) {
    try {
      // 提交前先模拟
      await simulate(contract, funcName, args, gasWallet.address);
      const tx = await connected[funcName](...args);
      const receipt = await tx.wait();
      return { txHash: receipt.hash, attempts: i + 1 };
    } catch (e) {
      lastError = e;
      // 非交易类错误（验签失败/已领取）无需重试
      if (e && (e.reason || "").includes("not allowed")) throw e;
      if (i < RETRY_LIMIT - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError || new Error("submit failed");
}

function validateShape(o) {
  if (!o || typeof o !== "object") return false;
  return ["matchId", "resultHash", "winner", "score0", "score1", "duration", "loserSignature"].every((k) => k in o);
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    if (!MATCH_ADDRESS || !RELAYER_PRIVATE_KEY) {
      sendJson(res, 500, { ok: false, error: "relayer not configured" });
      return;
    }

    const urlPath = req.url ? req.url.split("?")[0] : "/";
    if (urlPath !== "/recordResult") {
      sendJson(res, 404, { ok: false, error: "unknown endpoint" });
      return;
    }

    let payload;
    try {
      payload = await parseJson(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "bad json" });
      return;
    }

    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(MATCH_ADDRESS, MATCH_ABI, provider);

      if (urlPath === "/recordResult") {
        if (!validateShape(payload)) {
          sendJson(res, 400, { ok: false, error: "invalid payload" });
          return;
        }
        // 本地先验败方签名；未通过直接拒绝，不用 gas 钱包
        if (!verifyRecordSignature(payload, payload.winner)) {
          sendJson(res, 400, { ok: false, error: "bad signature" });
          return;
        }
        const result = await submitWithRetry(contract, "recordResult", [
          payload.matchId,
          payload.resultHash,
          payload.winner,
          payload.score0,
          payload.score1,
          payload.duration,
          payload.loserSignature
        ]);
        sendJson(res, 200, { ok: true, txHash: result.txHash, attempts: result.attempts });
        return;
      }

      sendJson(res, 404, { ok: false, error: "unknown endpoint" });
    } catch (e) {
      console.error("relayer error", e);
      sendJson(res, 500, { ok: false, error: e.message || "relayer error" });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log("[relayer] listening on http://localhost:" + PORT);
  });
}

module.exports = { createServer, verifyRecordSignature };