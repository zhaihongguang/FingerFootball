// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Vault
 * @notice 充值池：用户充入代币后，比赛锁定/结算全部在内部记账完成。
 *         只有 Match 合约能调用 lock/unlock/settle/refund，保证资金只能按比赛结果划转。
 *
 * 费率可调整：
 *   - feeBps（基点，300 = 3%）+ minFee（最低手续费，wei）
 *   - 由 owner 通过 setFeeBps / setMinFee 修改
 *   - Match 合约在 createMatch 时读取并快照，结算时用快照值（保证已开赛对局不受调价影响）
 */
contract Vault is ReentrancyGuard, Ownable {
    IERC20 public immutable token;

    /// 可用余额（未锁定，可随时提现）
    mapping(address => uint256) public balanceOf;
    /// 锁定余额（比赛进行中，不可提现）
    mapping(address => uint256) public lockedOf;

    /// 平台累计手续费
    uint256 public feePool;

    /// 费率（基点，300 = 3%）
    uint256 public feeBps = 300;
    /// 最低手续费（wei，兜底极端小额场）
    uint256 public minFee;

    /// 唯一被授权的 Match 合约地址
    address public matchContract;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Locked(address indexed user, uint256 amount);
    event Unlocked(address indexed user, uint256 amount);
    event Settled(address indexed winner, address indexed loser, uint256 amount, uint256 fee);
    event FeeWithdrawn(address indexed owner, uint256 amount);

    modifier onlyMatch() {
        require(msg.sender == matchContract, "Vault: not match contract");
        _;
    }

    constructor(IERC20 _token) {
        token = _token;
    }

    // ---------- 用户操作 ----------

    /// @notice 充入金库（需先 approve 本合约）
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero");
        require(token.transferFrom(msg.sender, address(this), amount), "Vault: transfer failed");
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice 提取可用余额
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero");
        require(balanceOf[msg.sender] >= amount, "Vault: insufficient balance");
        balanceOf[msg.sender] -= amount;
        require(token.transfer(msg.sender, amount), "Vault: transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ---------- 仅 Match 合约调用 ----------

    function lock(address user, uint256 amount) external onlyMatch {
        require(balanceOf[user] >= amount, "Vault: insufficient balance to lock");
        balanceOf[user] -= amount;
        lockedOf[user] += amount;
        emit Locked(user, amount);
    }

    function unlock(address user, uint256 amount) external onlyMatch {
        require(lockedOf[user] >= amount, "Vault: insufficient locked");
        lockedOf[user] -= amount;
        balanceOf[user] += amount;
        emit Unlocked(user, amount);
    }

    /// @notice 结算：释放双方锁定，赢家拿 2*amount - fee，fee 进平台池。
    function settle(address winner, address loser, uint256 amount, uint256 fee) external onlyMatch {
        require(fee < 2 * amount, "Vault: fee too high");
        require(lockedOf[winner] >= amount, "Vault: winner locked insufficient");
        require(lockedOf[loser] >= amount, "Vault: loser locked insufficient");
        lockedOf[winner] -= amount;
        lockedOf[loser] -= amount;
        // 赢家：自己的 amount 回笼 + 输家的 amount - 手续费
        balanceOf[winner] += (2 * amount) - fee;
        feePool += fee;
        emit Settled(winner, loser, amount, fee);
    }

    /// @notice 平局退款：双方各自解锁。
    function refund(address player1, address player2, uint256 amount) external onlyMatch {
        require(lockedOf[player1] >= amount, "Vault: p1 locked insufficient");
        require(lockedOf[player2] >= amount, "Vault: p2 locked insufficient");
        lockedOf[player1] -= amount;
        lockedOf[player2] -= amount;
        balanceOf[player1] += amount;
        balanceOf[player2] += amount;
        emit Unlocked(player1, amount);
        emit Unlocked(player2, amount);
    }

    // ---------- 管理员 ----------

    function setFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 10000, "Vault: bps > 100%");
        feeBps = bps;
    }

    function setMinFee(uint256 amount) external onlyOwner {
        minFee = amount;
    }

    function setMatchContract(address m) external onlyOwner {
        require(m != address(0), "Vault: zero address");
        matchContract = m;
    }

    function withdrawFee(uint256 amount) external onlyOwner {
        require(feePool >= amount, "Vault: insufficient fee");
        feePool -= amount;
        require(token.transfer(owner(), amount), "Vault: transfer failed");
        emit FeeWithdrawn(owner(), amount);
    }
}
