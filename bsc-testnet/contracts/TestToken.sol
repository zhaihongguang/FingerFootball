// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestToken
 * @notice BSC 测试链调试用的 mock BEP-20 代币（BEP-20 与 ERC-20 接口兼容）。
 *         部署者初始获得 100 万枚，任何人可调 faucet 领测试币。
 */
contract TestToken is ERC20 {
    constructor() ERC20("Fingertip Football Token", "FFT") {
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    /// @notice 测试水龙头：任何人可给任意地址铸造测试币
    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
