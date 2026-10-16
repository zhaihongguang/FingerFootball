/**
 * BSC 测试网合约地址配置（Chain 97）
 *
 * 部署后把实际地址填到这里即可：
 *   npx hardhat run scripts/deploy.js --network bscTestnet
 *
 * 地址为空时，前端资金面板显示“未部署/未配置”，不影响免费场与机器人模式。
 */
(function (root) {
  root.ContractConfig = {
    tokenAddress: "0xAEe253c3289ae267EEF039695D7d43E3691c415C", // 最新部署
    vaultAddress: "",
    matchAddress: "0xF5cBDd6e18aC4309194B5878f3c0670214E17C2B", // 最新部署
    relayerUrl: "http://43.155.144.136:8790", // Relayer 已合并到 PvP 服务 /api/recordResult
    chainId: 97,
    rpcUrl: "https://bsc-testnet-rpc.publicnode.com"
  };
})(typeof self !== "undefined" ? self : this);
