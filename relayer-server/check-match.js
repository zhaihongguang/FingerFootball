const { ethers } = require("ethers");
(async () => {
  const provider = new ethers.JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com");
  const addr = "0xC3625818319Dd45c71072b1dA000c3345B4f7038";
  const abi = [
    "function paidEnabled() view returns (bool)",
    "function relayer() view returns (address)",
    "function nextMatchId() view returns (uint256)"
  ];
  const m = new ethers.Contract(addr, abi, provider);
  try { console.log("paidEnabled", await m.paidEnabled()); } catch(e) { console.log("paidEnabled ERR", e.reason || e.message); }
  try { console.log("relayer", await m.relayer()); } catch(e) { console.log("relayer ERR", e.reason || e.message); }
  try { console.log("nextMatchId", (await m.nextMatchId()).toString()); } catch(e) { console.log("nextMatchId ERR", e.reason || e.message); }
})();