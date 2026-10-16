// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Match
 * @notice 对局合约：代币直接锁定在 Match，开局双方各一笔转账锁仓，结束时赢家单笔提交双方签名结算。
 *
 * 资金流：
 *   - createMatchWithStake：玩家 1 转账 amount，创建 Pending
 *   - acceptMatchWithStake：玩家 2 转账 amount，进入 Active
 *   - settleWithSignatures：赢家提交 resultHash + winner + 双方 EIP-712 签名，单笔结算
 *   - claimTimeout：超时后按已提交/未提交情况退款或单方结算
 *
 * 费率 / 场次在开赛时快照，之后调整不影响已开赛对局。
 */
contract Match is Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    IERC20 public immutable token;

    // ---------- 场次档位（参数化，可增删改） ----------
    struct Tier {
        uint256 amount; // 每人质押（代币最小单位整数）
        bool enabled;
    }
    Tier[] public tiers;

    // ---------- 对局状态 ----------
    enum State {
        Pending,
        Active,
        Submitted,
        Settled,
        Cancelled
    }

    struct Game {
        address player1;
        address player2;
        uint256 amount;
        uint256 feeBps;
        uint256 minFee;
        State state;
        bytes32 resultHash1;
        address winner1;
        bool submitted1;
        bytes32 resultHash2;
        address winner2;
        bool submitted2;
        uint256 createdAt;
        uint256 activeAt;
    }

    mapping(uint256 => Game) public games;
    uint256 public nextMatchId = 1;

    // ---------- 链上对局历史（质押后登记，结算/退款时更新） ----------
    enum RecordStatus {
        Pending,   // 质押完成，等待对局结果
        Settled,   // 已有结算结果
        Refunded   // 双方未签名，已退款给各自玩家
    }

    struct MatchRecord {
        uint256 matchId;
        bool exists;        // 是否已完成质押登记
        address player1;
        address player2;
        address winner;
        address loser;
        uint256 score0;
        uint256 score1;
        uint256 duration;   // 秒
        uint256 timestamp;  // 质押登记/状态更新时间
        uint256 amount;     // 每人质押
        uint256 fee;        // 手续费，仅 Settled 有值
        uint256 claimable;  // 胜方可领取金额，仅 Settled 有值
        bool claimed;       // 胜方是否已领取
        bool refundClaimed1; // 玩家1 是否已领取退款
        bool refundClaimed2; // 玩家2 是否已领取退款
        bool noFeeRefund;   // 系统兜底未开局退款，不收取手续费
        RecordStatus status;
    }

    mapping(uint256 => MatchRecord) public records;
    mapping(address => uint256[]) public userMatchIds;

    /// 授权 gas 代付/登记钱包：只允许调用记录登记与领取，不能动用其他权限
    address public relayer;

    event MatchRecordCreated(uint256 indexed matchId, address indexed player1, address indexed player2);
    event MatchRecordUpdated(uint256 indexed matchId, address indexed winner, address indexed loser, uint256 score0, uint256 score1, uint256 duration);
    event RewardClaimed(uint256 indexed matchId, address indexed winner, uint256 amount);
    event RefundClaimed(uint256 indexed matchId, address indexed player, uint256 amount);
    event RelayerUpdated(address indexed relayer);
    event MatchRecordRefunded(uint256 indexed matchId);
    // 平台累计手续费（留在本合约，owner 可提取）
    uint256 public feePool;

    /// 收费场总开关：false 时禁止创建/接受新收费对局（后续升级/维护用）
    bool public paidEnabled = true;

    // 超时配置（秒）
    uint256 public pendingTimeout = 300;
    uint256 public resultTimeout = 300;

    /// 签名域
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant RESULT_TYPEHASH =
        keccak256("MatchResult(uint256 matchId,bytes32 resultHash,address winner)");
    bytes32 public constant RECORD_TYPEHASH =
        keccak256("MatchRecord(uint256 matchId,bytes32 resultHash,address winner,uint256 score0,uint256 score1,uint256 duration)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    string public constant NAME = "FingertipFootballMatch";
    string public constant VERSION = "1";

    event TierAdded(uint256 index, uint256 amount);
    event TierRemoved(uint256 index);
    event MatchCreated(uint256 indexed matchId, address indexed player1, uint256 amount);
    event MatchAccepted(uint256 indexed matchId, address indexed player2);
    event ResultSubmitted(uint256 indexed matchId, address indexed winner, bytes32 resultHash);
    event MatchSettled(uint256 indexed matchId, address indexed winner, address indexed loser, uint256 amount, uint256 fee);
    event MatchRefunded(uint256 indexed matchId);
    event MatchCancelled(uint256 indexed matchId);
    event FeeWithdrawn(address indexed owner, uint256 amount);
    event PaidEnabledUpdated(bool enabled);

    constructor(IERC20 _token) {
        token = _token;
        uint256 _chainId;
        assembly {
            _chainId := chainid()
        }
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), _chainId, address(this))
        );
    }

    // ---------- 场次管理（owner） ----------

    function addTier(uint256 amount) external onlyOwner {
        require(amount > 0, "Match: zero amount");
        tiers.push(Tier(amount, true));
        emit TierAdded(tiers.length - 1, amount);
    }

    function setTierEnabled(uint256 index, bool enabled) external onlyOwner {
        require(index < tiers.length, "Match: bad index");
        tiers[index].enabled = enabled;
    }

    function removeTier(uint256 index) external onlyOwner {
        require(index < tiers.length, "Match: bad index");
        tiers[index] = tiers[tiers.length - 1];
        tiers.pop();
        emit TierRemoved(index);
    }

    function tierCount() external view returns (uint256) {
        return tiers.length;
    }

    // ---------- 比赛流程 ----------

    /// @notice 发起者创建比赛并直接锁定自己的代币。
    function createMatchWithStake(uint256 tierIndex, address opponent) external {
        require(paidEnabled, "Match: paid disabled");
        require(tierIndex < tiers.length && tiers[tierIndex].enabled, "Match: tier disabled");
        require(opponent != msg.sender, "Match: self match");
        uint256 amount = tiers[tierIndex].amount;
        require(token.balanceOf(msg.sender) >= amount, "Match: insufficient token");

        // 快照费率（开赛时锁定）
        uint256 feeBps = 300;
        uint256 minFee = 0;

        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 id = nextMatchId++;
        Game storage g = games[id];
        g.player1 = msg.sender;
        g.player2 = opponent;
        g.amount = amount;
        g.feeBps = feeBps;
        g.minFee = minFee;
        g.state = State.Pending;
        g.createdAt = block.timestamp;

        emit MatchCreated(id, msg.sender, amount);
    }

    /// @notice 对手接受并直接锁定自己的代币，进入对局。
    function acceptMatchWithStake(uint256 matchId) external {
        require(paidEnabled, "Match: paid disabled");
        Game storage g = games[matchId];
        require(g.state == State.Pending, "Match: not pending");
        require(msg.sender == g.player2, "Match: not player2");
        require(token.balanceOf(msg.sender) >= g.amount, "Match: insufficient token");

        token.safeTransferFrom(msg.sender, address(this), g.amount);

        g.state = State.Active;
        g.activeAt = block.timestamp;
        emit MatchAccepted(matchId, msg.sender);
    }

    /// @notice Relayer 或玩家在质押完成后登记一条链上历史记录。
    /// 只登记对局参与者与质押金额，不裁决结果；已存在记录时不能重复登记。
    function registerMatchRecord(uint256 matchId) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(msg.sender == g.player1 || msg.sender == g.player2 || msg.sender == relayer, "Match: not allowed");
        MatchRecord storage r = records[matchId];
        require(!r.exists, "Match: record exists");
        r.exists = true;
        r.matchId = matchId;
        r.player1 = g.player1;
        r.player2 = g.player2;
        r.amount = g.amount;
        r.timestamp = block.timestamp;
        r.status = RecordStatus.Pending;
        _pushUserMatch(g.player1, matchId);
        _pushUserMatch(g.player2, matchId);
        emit MatchRecordCreated(matchId, g.player1, g.player2);
    }

    // 避免同一 matchId 重复加入 userMatchIds
    function _pushUserMatch(address user, uint256 matchId) internal {
        uint256[] storage ids = userMatchIds[user];
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == matchId) return;
        }
        ids.push(matchId);
    }

    /// @notice 双方均未提交结果时，各自从历史记录领取退回的质押。
    function claimRefund(uint256 matchId) external {
        MatchRecord storage r = records[matchId];
        require(r.status == RecordStatus.Refunded, "Match: not refunded");
        // 系统兜底未开局退款不扣手续费；平局/正常退款按总底池 3% 收手续费
        uint256 refundAmount = r.noFeeRefund ? r.amount : r.amount - (r.fee / 2);
        if (msg.sender == r.player1) {
            require(!r.refundClaimed1, "Match: already refunded");
            r.refundClaimed1 = true;
            token.safeTransfer(r.player1, refundAmount);
            emit RefundClaimed(matchId, r.player1, refundAmount);
            return;
        }
        if (msg.sender == r.player2) {
            require(!r.refundClaimed2, "Match: already refunded");
            r.refundClaimed2 = true;
            token.safeTransfer(r.player2, refundAmount);
            emit RefundClaimed(matchId, r.player2, refundAmount);
            return;
        }
        revert("Match: not player");
    }

    /// @notice 系统兜底：双方已质押但始终未进入对局/未提交结果，Relayer 调用后双方可全额领回本金。
    /// 此路径不计算手续费，也不进入 feePool。
    function refundNoGame(uint256 matchId) external {
        require(msg.sender == relayer, "Match: not relayer");
        Game storage g = games[matchId];
        require(g.state == State.Active, "Match: wrong state");
        require(!g.submitted1 && !g.submitted2, "Match: already submitted");

        MatchRecord storage r = records[matchId];
        if (!r.exists) {
            r.exists = true;
            r.matchId = matchId;
            r.player1 = g.player1;
            r.player2 = g.player2;
            r.amount = g.amount;
            _pushUserMatch(g.player1, matchId);
            _pushUserMatch(g.player2, matchId);
            emit MatchRecordCreated(matchId, g.player1, g.player2);
        }
        require(r.status == RecordStatus.Pending, "Match: record exists");
        r.status = RecordStatus.Refunded;
        r.amount = g.amount;
        r.fee = 0;
        r.noFeeRefund = true;
        r.timestamp = block.timestamp;
        g.state = State.Settled;
        emit MatchRecordRefunded(matchId);
        emit MatchRefunded(matchId);
    }

    /// @notice 内部将记录标记为已退款，不直接发钱，由玩家各自 claimRefund。
    function _markRecordRefunded(uint256 matchId, Game storage g) internal {
        MatchRecord storage r = records[matchId];
        uint256 fee = _calcFee(g);
        if (!r.exists) {
            r.exists = true;
            r.matchId = matchId;
            r.player1 = g.player1;
            r.player2 = g.player2;
            r.amount = g.amount;
            r.fee = fee;
            _pushUserMatch(g.player1, matchId);
            _pushUserMatch(g.player2, matchId);
        }
        if (r.status == RecordStatus.Pending) {
            r.status = RecordStatus.Refunded;
            r.amount = g.amount;
            r.fee = fee;
            feePool += fee;
            r.timestamp = block.timestamp;
            emit MatchRecordRefunded(matchId);
        }
    }

    /// @notice 取消 Pending：发起者可随时撤回；超时后任何人可取消。
    function cancelMatch(uint256 matchId) external {
        Game storage g = games[matchId];
        require(g.state == State.Pending, "Match: not pending");
        bool isPlayer1 = msg.sender == g.player1;
        bool timeout = block.timestamp >= g.createdAt + pendingTimeout;
        require(isPlayer1 || timeout, "Match: cannot cancel");
        token.safeTransfer(g.player1, g.amount);
        g.state = State.Cancelled;
        emit MatchCancelled(matchId);
    }

    /// @notice 任意一方把自己的结果签名单独上链。
    /// 支持超时后按单方签名结算，防止拒签逃单。
    function submitSignature(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        bytes calldata signature
    ) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(winner == g.player1 || winner == g.player2 || winner == address(0), "Match: bad winner");

        if (msg.sender == g.player1) {
            require(!g.submitted1, "Match: player1 already submitted");
            require(_verifySignature(matchId, resultHash, winner, g.player1, signature), "Match: bad sig1");
            g.resultHash1 = resultHash;
            g.winner1 = winner;
            g.submitted1 = true;
        } else if (msg.sender == g.player2) {
            require(!g.submitted2, "Match: player2 already submitted");
            require(_verifySignature(matchId, resultHash, winner, g.player2, signature), "Match: bad sig2");
            g.resultHash2 = resultHash;
            g.winner2 = winner;
            g.submitted2 = true;
        } else {
            revert("Match: not player");
        }
        g.state = State.Submitted;
        emit ResultSubmitted(matchId, winner, resultHash);
    }

    /// @notice 赢家提交双方签名 + 结果哈希，单笔结算。
    /// 双方签名内容为 (matchId, resultHash, winner)，EIP-712 签名。
    function settleWithSignatures(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        bytes calldata signature1,
        bytes calldata signature2
    ) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(!g.submitted1 && !g.submitted2, "Match: already both submitted");
        require(winner == g.player1 || winner == g.player2 || winner == address(0), "Match: bad winner");
        require(_verifySignature(matchId, resultHash, winner, g.player1, signature1), "Match: bad sig1");
        require(_verifySignature(matchId, resultHash, winner, g.player2, signature2), "Match: bad sig2");

        g.resultHash1 = resultHash;
        g.winner1 = winner;
        g.submitted1 = true;
        g.resultHash2 = resultHash;
        g.winner2 = winner;
        g.submitted2 = true;
        g.state = State.Submitted;

        emit ResultSubmitted(matchId, winner, resultHash);

        _settle(matchId, g, winner);
    }

    /// @notice 胜方凭败方签名单笔提取奖金。
    /// 签名内容为 (matchId, resultHash, winner)，签名人必须是败方；调用者必须是胜方。
    function settleByWinnerSignature(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        bytes calldata loserSignature
    ) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(!g.submitted1 && !g.submitted2, "Match: already both submitted");
        require(winner == msg.sender, "Match: only winner can claim");
        require(winner == g.player1 || winner == g.player2, "Match: bad winner");

        address loser = winner == g.player1 ? g.player2 : g.player1;
        require(_verifySignature(matchId, resultHash, winner, loser, loserSignature), "Match: bad loser sig");

        g.resultHash1 = resultHash;
        g.winner1 = winner;
        g.submitted1 = true;
        g.resultHash2 = resultHash;
        g.winner2 = winner;
        g.submitted2 = true;
        g.state = State.Submitted;

        emit ResultSubmitted(matchId, winner, resultHash);

        _settle(matchId, g, winner);
    }

    /// @notice 单方认输：调用者视为败方，资金直接结算给对手。
    /// 仅对局双方可调用，且对局还未结算/退款；链上直接转账，不进入 claimReward。
    function forfeit(uint256 matchId) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(msg.sender == g.player1 || msg.sender == g.player2, "Match: not player");
        address winner = msg.sender == g.player1 ? g.player2 : g.player1;
        _settle(matchId, g, winner);
        emit ResultSubmitted(matchId, winner, bytes32(0));
    }

    /// @notice 记录对局结果并结算奖金（可领取状态写入记录）。
    /// 败方签的是 RECORD_TYPEHASH，包含比分/时长，防止伪造历史。
    /// 调用方可以是胜方本人，或授权的 relayer（gas 代付）。
    function recordResult(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        uint256 score0,
        uint256 score1,
        uint256 duration,
        bytes calldata loserSignature
    ) external {
        Game storage g = games[matchId];
        require(g.state == State.Active || g.state == State.Submitted, "Match: wrong state");
        require(!g.submitted1 && !g.submitted2, "Match: already both submitted");
        bool isTie = winner == address(0);
        require(isTie || winner == g.player1 || winner == g.player2, "Match: bad winner");
        require(records[matchId].status != RecordStatus.Settled && records[matchId].status != RecordStatus.Refunded, "Match: record exists");

        // 平局：任一玩家都可提交，验对方签名；正常对局只允许胜方或 relayer
        if (isTie) {
            require(msg.sender == g.player1 || msg.sender == g.player2 || msg.sender == relayer, "Match: not allowed");
        } else {
            require(msg.sender == winner || msg.sender == relayer, "Match: not allowed");
        }

        address loser;
        if (isTie) {
            // 平局双方都认可，任意一方的签名都有效；这里用提交者之外的玩家作为“败方签名”
            loser = msg.sender == g.player1 ? g.player2 : g.player1;
        } else {
            loser = winner == g.player1 ? g.player2 : g.player1;
        }
        require(_verifyRecordSignature(matchId, resultHash, winner, score0, score1, duration, loser, loserSignature), "Match: bad loser sig");

        // 先把资金结算：平局进入退款状态，正常结算进入待领取
        uint256 fee = _calcFee(g);
        uint256 claimable = (g.amount * 2) - fee;
        feePool += fee;
        g.state = State.Settled;

        MatchRecord storage r = records[matchId];
        // 若质押登记尚未发生，则在结算时补登记，保证历史完整
        if (!r.exists) {
            r.exists = true;
            r.matchId = matchId;
            r.player1 = g.player1;
            r.player2 = g.player2;
            _pushUserMatch(g.player1, matchId);
            _pushUserMatch(g.player2, matchId);
            emit MatchRecordCreated(matchId, g.player1, g.player2);
        } else {
            require(r.status == RecordStatus.Pending, "Match: record exists");
        }
        r.winner = winner;
        r.loser = loser;
        r.score0 = score0;
        r.score1 = score1;
        r.duration = duration;
        r.timestamp = block.timestamp;
        r.amount = g.amount;
        r.fee = fee;
        r.claimable = claimable;
        r.claimed = false;
        r.status = isTie ? RecordStatus.Refunded : RecordStatus.Settled;
        emit MatchRecordUpdated(matchId, winner, loser, score0, score1, duration);
    }

    /// @notice 胜方领取奖励；奖励已锁在合约记录里，领取后标记 claimed。
    /// 调用方可以是胜方本人，或授权 relayer（gas 代付）。
    function claimReward(uint256 matchId) external {
        MatchRecord storage r = records[matchId];
        require(r.winner != address(0), "Match: no record");
        require(!r.claimed, "Match: already claimed");
        require(msg.sender == r.winner || msg.sender == relayer, "Match: not allowed");

        r.claimed = true;
        token.safeTransfer(r.winner, r.claimable);
        emit RewardClaimed(matchId, r.winner, r.claimable);
    }

    /// @notice 查询某用户参与的对局 ID 列表。
    function getUserMatchIds(address user) external view returns (uint256[] memory) {
        return userMatchIds[user];
    }

    /// @notice 查询某用户的完整历史记录。
    function getUserMatches(address user) external view returns (MatchRecord[] memory) {
        uint256[] memory ids = userMatchIds[user];
        MatchRecord[] memory out = new MatchRecord[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = records[ids[i]];
        }
        return out;
    }

    /// @notice 校验 RECORD_TYPEHASH 签名。
    function _verifyRecordSignature(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        uint256 score0,
        uint256 score1,
        uint256 duration,
        address signer,
        bytes calldata signature
    ) internal view returns (bool) {
        bytes32 structHash = keccak256(abi.encode(RECORD_TYPEHASH, matchId, resultHash, winner, score0, score1, duration));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        return ECDSA.recover(digest, signature) == signer;
    }

    /// @notice 超时结算规则：
    ///   只有一方签名 → 按该方签名的 winner 结算
    ///   双方都签名且一致 → 结算
    ///   双方都签名但不一致 → 进入挑战仲裁（owner 手动）
    ///   双方都没签名 → 退款
    function claimTimeout(uint256 matchId) external {
        Game storage g = games[matchId];
        require(block.timestamp >= g.activeAt + resultTimeout, "Match: not timeout");

        if (g.state == State.Active) {
            // 双方都没提交就超时 → 标记记录为 Refunded，由双方在历史里各自领取本金
            _markRecordRefunded(matchId, g);
            g.state = State.Settled;
            emit MatchRefunded(matchId);
            return;
        }

        require(g.state == State.Submitted, "Match: wrong state");

        // 双方都没签名（理论上不会到这，防御性处理）
        if (!g.submitted1 && !g.submitted2) {
            _markRecordRefunded(matchId, g);
            g.state = State.Settled;
            emit MatchRefunded(matchId);
            return;
        }

        // 只有一方签名：直接按该签名结算
        if (g.submitted1 && !g.submitted2) {
            _settle(matchId, g, g.winner1);
            return;
        }
        if (g.submitted2 && !g.submitted1) {
            _settle(matchId, g, g.winner2);
            return;
        }

        // 双方都签名：一致则结算，不一致进入仲裁
        if (g.winner1 == g.winner2 && g.resultHash1 == g.resultHash2) {
            _settle(matchId, g, g.winner1);
            return;
        }
        g.state = State.Settled;
        _markRecordRefunded(matchId, g);
        emit MatchRefunded(matchId);
    }

    // ---------- 内部 ----------

    function _settle(uint256 matchId, Game storage g, address winner) internal {
        if (winner == address(0)) {
            _markRecordRefunded(matchId, g);
            g.state = State.Settled;
            emit MatchRefunded(matchId);
            return;
        }
        _settleWithFee(matchId, g, winner, _calcFee(g));
    }

    function _updateRecordAfterSettle(uint256 matchId, address winner, address loser, uint256 amount, uint256 fee) internal {
        Game storage g = games[matchId];
        MatchRecord storage r = records[matchId];
        // 未提前登记时补登记，保证历史记录完整
        if (!r.exists) {
            r.exists = true;
            r.matchId = matchId;
            r.player1 = g.player1;
            r.player2 = g.player2;
            _pushUserMatch(g.player1, matchId);
            _pushUserMatch(g.player2, matchId);
        }
        require(r.matchId == matchId, "Match: no record");
        require(r.status == RecordStatus.Pending, "Match: record not pending");
        r.winner = winner;
        r.loser = loser;
        r.amount = amount;
        r.fee = fee;
        r.claimable = (amount * 2) - fee;
        r.claimed = false;
        r.status = RecordStatus.Settled;
        r.timestamp = block.timestamp;
        emit MatchRecordUpdated(matchId, winner, loser, 0, 0, 0);
    }

    function _settleWithFee(uint256 matchId, Game storage g, address winner, uint256 fee) internal {
        address loser = winner == g.player1 ? g.player2 : g.player1;
        token.safeTransfer(winner, (g.amount * 2) - fee);
        feePool += fee;
        g.state = State.Settled;
        _updateRecordAfterSettle(matchId, winner, loser, g.amount, fee);
        emit MatchSettled(matchId, winner, loser, g.amount, fee);
    }

    function _calcFee(Game storage g) internal view returns (uint256) {
        uint256 pot = g.amount * 2;
        uint256 fee = (pot * g.feeBps) / 10000;
        if (fee < g.minFee) fee = g.minFee;
        require(fee < pot, "Match: fee >= pot");
        return fee;
    }

    function _verifySignature(
        uint256 matchId,
        bytes32 resultHash,
        address winner,
        address signer,
        bytes calldata signature
    ) internal view returns (bool) {
        // 结构哈希必须包含 matchId，才能保证签名绑定到具体对局
        bytes32 structHash = keccak256(abi.encode(RESULT_TYPEHASH, matchId, resultHash, winner));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        return ECDSA.recover(digest, signature) == signer;
    }

    // ---------- 配置（owner） ----------

    /// @notice 收费场总开关：owner 可停用/恢复收费场，不影响已开始对局结算
    function setPaidEnabled(bool enabled) external onlyOwner {
        paidEnabled = enabled;
        emit PaidEnabledUpdated(enabled);
    }

    /// @notice 设置 gas 代付钱包（relayer），只允许它调用 recordResult/claimReward
    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "Match: zero address");
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    function setPendingTimeout(uint256 t) external onlyOwner {
        pendingTimeout = t;
    }

    function setResultTimeout(uint256 t) external onlyOwner {
        resultTimeout = t;
    }

    function withdrawFee(uint256 amount) external onlyOwner {
        require(feePool >= amount, "Match: insufficient fee");
        feePool -= amount;
        token.safeTransfer(msg.sender, amount);
        emit FeeWithdrawn(msg.sender, amount);
    }
}
