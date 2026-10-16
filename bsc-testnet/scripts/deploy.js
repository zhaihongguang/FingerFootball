// BSC 测试链部署脚本（Hardhat + ethers v6）
// 运行：npx hardhat run scripts/deploy.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // 1. 部署测试代币（mock BEP-20）
  const TestToken = await hre.ethers.getContractFactory("TestToken");
  const token = await TestToken.deploy();
  await token.waitForDeployment();
  console.log("TestToken deployed:", await token.getAddress());

  // 2. 部署 Match（代币直接锁定在 Match，不再使用 Vault）
  const Match = await hre.ethers.getContractFactory("Match");
  const match = await Match.deploy(await token.getAddress());
  await match.waitForDeployment();
  console.log("Match deployed:", await match.getAddress());

  // 3. 初始化场次：0.01 / 0.1 代币（18 位小数）
  const tier1 = hre.ethers.parseUnits("0.01", 18); // 10^16 wei
  const tier2 = hre.ethers.parseUnits("0.1", 18); // 10^17 wei
  await match.addTier(tier1);
  await match.addTier(tier2);
  console.log("Tiers added:", tier1.toString(), tier2.toString());

  const addresses = {
    tokenAddress: await token.getAddress(),
    vaultAddress: "", // 已废弃，保留空字符串兼容前端配置
    matchAddress: await match.getAddress(),
    chainId: hre.network.config.chainId || 97,
    rpcUrl: hre.network.config.url || ""
  };
  const outPath = path.join(__dirname, "..", "deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to:", outPath);

  console.log("\n=== 部署完成 ===");
  console.log("Token:", addresses.tokenAddress);
  console.log("Vault: (removed, direct lock in Match)");
  console.log("Match:", addresses.matchAddress);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
