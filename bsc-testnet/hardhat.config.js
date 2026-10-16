require("@nomicfoundation/hardhat-toolbox");

// BSC 测试链（Chapel）：Chain ID 97
// 私钥通过环境变量 PRIVATE_KEY 注入，不要写死在代码里。
// Windows PowerShell:  $env:PRIVATE_KEY="你的私钥"
// Windows CMD:         set PRIVATE_KEY=你的私钥
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  networks: {
    bscTestnet: {
      url: "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
