// 部署后设置 Relayer（gas 代付钱包白名单）
// 运行：
//   $env:PRIVATE_KEY="部署账号私钥"
//   $env:RELAYER_ADDRESS="0xgas钱包地址"
//   npx hardhat run scripts/set-relayer.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const relayerAddress = process.env.RELAYER_ADDRESS || "";
  if (!relayerAddress) {
    throw new Error("请设置 RELAYER_ADDRESS=0xgas钱包地址");
  }

  // 读取部署时保存的合约地址
  const deployedPath = path.join(__dirname, "..", "deployed.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error("未找到 deployed.json，请先运行 scripts/deploy.js");
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  if (!deployed.matchAddress) {
    throw new Error("deployed.json 缺少 matchAddress");
  }

  const [owner] = await hre.ethers.getSigners();
  console.log("Owner:", owner.address);
  console.log("Match:", deployed.matchAddress);
  console.log("Relayer:", relayerAddress);

  const Match = await hre.ethers.getContractFactory("Match");
  const match = Match.attach(deployed.matchAddress);

  const current = await match.relayer();
  if (current.toLowerCase() === relayerAddress.toLowerCase()) {
    console.log("Relayer already set, no tx needed.");
    return;
  }

  const tx = await match.setRelayer(relayerAddress);
  console.log("setRelayer tx:", tx.hash);
  await tx.wait();
  console.log("setRelayer done");

  const after = await match.relayer();
  console.log("Relayer now:", after);
  if (after.toLowerCase() !== relayerAddress.toLowerCase()) {
    throw new Error("Relayer verification failed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});