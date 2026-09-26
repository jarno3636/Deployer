// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IndexioShareToken} from "./IndexioShareToken.sol";
import {IndexioIncomeDistributor} from "./IndexioIncomeDistributor.sol";

interface IIndexioFactoryV24 {
    function feeTreasury() external view returns(address);
    function registry() external view returns(address);
    function isIncomeSource(address vault,address source) external view returns(bool);
    function isExecutionRouter(address router) external view returns(bool);
    function isRebalanceRouter(address router) external view returns(bool);
}
interface IRegistryV24 { function requireAsset(address,uint16) external view returns(uint8); }

/// @notice Oracleless proportional basket vault. Dollar market data is never used for ownership accounting.
contract IndexioVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 public constant INDEXIO_TRANSACTION_FEE_BPS = 100; // fixed 1%

    address public immutable factory;
    address public immutable creator;
    address public immutable settlementToken;
    IndexioShareToken public immutable shareToken;
    IndexioIncomeDistributor public immutable incomeDistributor;
    uint256 public immutable initialSharePriceUsd18;
    uint16 public immutable distributionBps;

    address[] private _assets;
    uint16[] private _weights;

    bool public seeded;
    bool public depositsPaused;
    bool public incomePaused;
    bool public rebalancePaused;
    bool public closed;

    error OnlyFactory();
    error OnlyCreator();
    error OnlyExecutionRouter();
    error OnlyRebalanceRouter();
    error InvalidAmount();
    error InvalidReceiver();
    error NotSeeded();
    error AlreadySeeded();
    error Slippage();
    error UnsupportedToken();
    error InvalidTreasury();
    error DepositsPaused();
    error IncomePaused();
    error RebalancePaused();
    error VaultClosed();
    error UnapprovedIncomeSource();
    error AssetDisabled();

    event Seeded(address indexed creator,uint256 shares,uint256[] fees);
    event Deposited(address indexed caller,address indexed receiver,uint256 shares,uint256[] acceptedGross,uint256[] refunds,uint256[] fees);
    event Redeemed(address indexed owner,address indexed receiver,uint256 shares,uint256[] netAmounts,uint256[] fees);
    event IncomeProcessed(address indexed source,uint256 gross,uint256 distributed,uint256 compounded);
    event PauseState(bool depositsPaused,bool incomePaused,bool rebalancePaused);
    event VaultClosedPermanently();
    event RebalanceAssetReleased(address indexed router,address indexed token,uint256 amount);

    constructor(
        address factory_,
        address creator_,
        address settlement_,
        string memory name_,
        string memory symbol_,
        address[] memory assets_,
        uint16[] memory weights_,
        uint256 initialSharePriceUsd18_,
        uint16 distributionBps_
    ) {
        factory = factory_;
        creator = creator_;
        settlementToken = settlement_;
        _assets = assets_;
        _weights = weights_;
        initialSharePriceUsd18 = initialSharePriceUsd18_;
        distributionBps = distributionBps_;
        shareToken = new IndexioShareToken(name_, symbol_, address(this));
        incomeDistributor = new IndexioIncomeDistributor(settlement_, address(shareToken), address(this));
        shareToken.setIncomeHook(address(incomeDistributor));
    }

    modifier onlyFactory() { if (msg.sender != factory) revert OnlyFactory(); _; }

    function assets() external view returns(address[] memory) { return _assets; }
    function targetWeightsBps() external view returns(uint16[] memory) { return _weights; }
    function assetCount() external view returns(uint256) { return _assets.length; }
    function feeTreasury() public view returns(address) { return IIndexioFactoryV24(factory).feeTreasury(); }

    /// @dev Fee rounds UP so splitting a transaction cannot reduce the effective protocol fee.
    function previewNetAmount(uint256 gross) public pure returns(uint256 net,uint256 fee) {
        if (gross == 0) return (0,0);
        fee = Math.mulDiv(gross, INDEXIO_TRANSACTION_FEE_BPS, BPS, Math.Rounding.Ceil);
        if (fee >= gross) return (0,fee);
        net = gross - fee;
    }

    /// @notice Preview the maximum proportional deposit accepted from supplied gross token amounts.
    /// @dev Excess stays with the caller; a router can refund it to the buyer.
    function previewDeposit(uint256[] calldata grossAmounts)
        external view returns(uint256 shares,uint256[] memory acceptedGross,uint256[] memory refunds)
    {
        return _previewDeposit(grossAmounts);
    }

    function seed(address receiver,uint256[] calldata grossAmounts,uint256 initialShares)
        external nonReentrant returns(uint256 shares)
    {
        if (closed) revert VaultClosed();
        if (depositsPaused) revert DepositsPaused();
        if (seeded) revert AlreadySeeded();
        if (!IIndexioFactoryV24(factory).isExecutionRouter(msg.sender)) revert OnlyExecutionRouter();
        // Initial seed ownership must belong to the index creator.
        if (receiver != creator || initialShares == 0) revert InvalidReceiver();

        uint256[] memory fees = _pullSeed(msg.sender, grossAmounts);
        seeded = true;
        shares = initialShares;
        shareToken.mint(receiver, shares);
        emit Seeded(receiver, shares, fees);
    }

    function deposit(address receiver,uint256[] calldata grossAmounts,uint256 minShares,uint256 deadline)
        external nonReentrant returns(uint256 shares,uint256[] memory acceptedGross)
    {
        if (block.timestamp > deadline) revert Slippage();
        if (closed) revert VaultClosed();
        if (depositsPaused) revert DepositsPaused();
        if (!seeded) revert NotSeeded();
        if (receiver == address(0)) revert InvalidReceiver();

        uint256[] memory refunds;
        (shares, acceptedGross, refunds) = _previewDeposit(grossAmounts);
        if (shares == 0 || shares < minShares) revert Slippage();

        address treasury = feeTreasury();
        if (treasury == address(0) || treasury == address(this)) revert InvalidTreasury();
        uint256[] memory fees = new uint256[](_assets.length);

        for (uint256 i; i < _assets.length; ++i) {
            (uint256 net,uint256 fee) = previewNetAmount(acceptedGross[i]);
            if (net == 0) revert InvalidAmount();
            _pullExact(_assets[i], msg.sender, address(this), net);
            if (fee > 0) _pullExact(_assets[i], msg.sender, treasury, fee);
            fees[i] = fee;
        }

        shareToken.mint(receiver, shares);
        emit Deposited(msg.sender, receiver, shares, acceptedGross, refunds, fees);
    }

    function redeem(uint256 shares,address receiver,uint256[] calldata minNetAmounts,uint256 deadline)
        external nonReentrant returns(uint256[] memory netAmounts)
    {
        if (block.timestamp > deadline) revert Slippage();
        if (receiver == address(0) || shares == 0 || minNetAmounts.length != _assets.length) revert InvalidReceiver();
        uint256 supply = shareToken.totalSupply();
        if (shares > supply || shareToken.balanceOf(msg.sender) < shares) revert InvalidAmount();

        address treasury = feeTreasury();
        if (treasury == address(0) || treasury == address(this)) revert InvalidTreasury();

        netAmounts = new uint256[](_assets.length);
        uint256[] memory fees = new uint256[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            uint256 bal = IERC20(_assets[i]).balanceOf(address(this));
            uint256 gross = shares == supply ? bal : Math.mulDiv(bal, shares, supply);
            (uint256 net,uint256 fee) = previewNetAmount(gross);
            // Tiny native-unit dust may round entirely to the fee; never brick an in-kind exit.
            if (net < minNetAmounts[i]) revert Slippage();
            netAmounts[i] = net;
            fees[i] = fee;
        }

        shareToken.burn(msg.sender, shares);
        if (shares == supply) {
            closed = true;
            depositsPaused = true;
            rebalancePaused = true;
            emit VaultClosedPermanently();
        }

        for (uint256 i; i < _assets.length; ++i) {
            if (fees[i] > 0) IERC20(_assets[i]).safeTransfer(treasury, fees[i]);
            if (netAmounts[i] > 0) IERC20(_assets[i]).safeTransfer(receiver, netAmounts[i]);
        }
        emit Redeemed(msg.sender, receiver, shares, netAmounts, fees);
    }

    /// @notice Recognizes actual settlement-token income from a delayed/approved source.
    /// @dev No Indexio 1% transaction fee is charged on income or claims.
    function processIncome(uint256 amount) external nonReentrant returns(uint256 distributed,uint256 compounded) {
        if (incomePaused) revert IncomePaused();
        if (!seeded || amount == 0 || shareToken.totalSupply() == 0) revert InvalidAmount();
        if (!IIndexioFactoryV24(factory).isIncomeSource(address(this), msg.sender)) revert UnapprovedIncomeSource();

        uint256 beforeBal = IERC20(settlementToken).balanceOf(address(this));
        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(settlementToken).balanceOf(address(this)) - beforeBal;
        if (got != amount) revert UnsupportedToken();

        distributed = Math.mulDiv(got, distributionBps, BPS);
        compounded = got - distributed;
        if (compounded > 0 && !_isConstituent(settlementToken)) revert UnsupportedToken();

        if (distributed > 0) {
            IERC20(settlementToken).forceApprove(address(incomeDistributor), distributed);
            incomeDistributor.recordIncome(distributed);
            IERC20(settlementToken).forceApprove(address(incomeDistributor), 0);
        }
        emit IncomeProcessed(msg.sender, got, distributed, compounded);
    }

    /// @notice Allows only an approved rebalance router to atomically move a constituent for a restricted swap.
    function rebalanceTransferOut(address token,address to,uint256 amount) external nonReentrant {
        if (closed) revert VaultClosed();
        if (rebalancePaused) revert RebalancePaused();
        if (!IIndexioFactoryV24(factory).isRebalanceRouter(msg.sender)) revert OnlyRebalanceRouter();
        if (!_isConstituent(token) || to != msg.sender || amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(to, amount);
        emit RebalanceAssetReleased(msg.sender, token, amount);
    }

    function recoverUnrelatedToken(address token,address to,uint256 amount) external onlyFactory {
        if (to == address(0) || token == address(shareToken) || token == settlementToken || _isConstituent(token)) {
            revert UnsupportedToken();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    function setPauseState(bool deposits_,bool income_,bool rebalance_) external onlyFactory {
        depositsPaused = deposits_;
        incomePaused = income_;
        rebalancePaused = rebalance_;
        emit PauseState(deposits_, income_, rebalance_);
    }

    function close() external onlyFactory {
        if (!closed) {
            closed = true;
            depositsPaused = true;
            rebalancePaused = true;
            emit VaultClosedPermanently();
        }
    }

    function _previewDeposit(uint256[] calldata grossAmounts)
        internal view returns(uint256 shares,uint256[] memory acceptedGross,uint256[] memory refunds)
    {
        if (grossAmounts.length != _assets.length || !seeded || closed) revert InvalidAmount();
        uint256 supply = shareToken.totalSupply();
        if (supply == 0) revert InvalidAmount();

        uint256[] memory pre = new uint256[](_assets.length);
        uint256 minShares = type(uint256).max;
        for (uint256 i; i < _assets.length; ++i) {
            _requireEnabled(i);
            pre[i] = IERC20(_assets[i]).balanceOf(address(this));
            if (pre[i] == 0 || grossAmounts[i] == 0) revert InvalidAmount();
            (uint256 net,) = previewNetAmount(grossAmounts[i]);
            if (net == 0) revert InvalidAmount();
            uint256 candidateShares = Math.mulDiv(supply, net, pre[i]);
            if (candidateShares < minShares) minShares = candidateShares;
        }
        if (minShares == 0 || minShares == type(uint256).max) revert InvalidAmount();

        shares = minShares;
        acceptedGross = new uint256[](_assets.length);
        refunds = new uint256[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            uint256 requiredNet = Math.mulDiv(pre[i], shares, supply, Math.Rounding.Ceil);
            uint256 grossNeeded = _grossForNet(requiredNet);
            if (grossNeeded == 0 || grossNeeded > grossAmounts[i]) revert InvalidAmount();
            acceptedGross[i] = grossNeeded;
            refunds[i] = grossAmounts[i] - grossNeeded;
        }
    }

    function _pullSeed(address from,uint256[] calldata grossAmounts) internal returns(uint256[] memory fees) {
        if (grossAmounts.length != _assets.length) revert InvalidAmount();
        address treasury = feeTreasury();
        if (treasury == address(0) || treasury == address(this)) revert InvalidTreasury();
        fees = new uint256[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            _requireEnabled(i);
            uint256 gross = grossAmounts[i];
            (uint256 net,uint256 fee) = previewNetAmount(gross);
            if (net == 0) revert InvalidAmount();
            _pullExact(_assets[i], from, address(this), net);
            if (fee > 0) _pullExact(_assets[i], from, treasury, fee);
            fees[i] = fee;
        }
    }

    function _grossForNet(uint256 requiredNet) internal pure returns(uint256 gross) {
        if (requiredNet == 0) return 0;
        gross = Math.mulDiv(requiredNet, BPS, BPS - INDEXIO_TRANSACTION_FEE_BPS, Math.Rounding.Ceil);
        // Defensive correction for ceil-fee integer arithmetic.
        while (_netOfGross(gross) < requiredNet) ++gross;
        while (gross > 1 && _netOfGross(gross - 1) >= requiredNet) --gross;
    }

    function _netOfGross(uint256 gross) internal pure returns(uint256) {
        if (gross == 0) return 0;
        uint256 fee = Math.mulDiv(gross, INDEXIO_TRANSACTION_FEE_BPS, BPS, Math.Rounding.Ceil);
        return fee >= gross ? 0 : gross - fee;
    }

    function _pullExact(address token,address from,address to,uint256 amount) internal {
        uint256 beforeBal = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from, to, amount);
        if (IERC20(token).balanceOf(to) - beforeBal != amount) revert UnsupportedToken();
    }

    function _requireEnabled(uint256 i) internal view {
        try IRegistryV24(IIndexioFactoryV24(factory).registry()).requireAsset(_assets[i], _weights[i]) returns(uint8) {
        } catch {
            revert AssetDisabled();
        }
    }

    function _isConstituent(address token) internal view returns(bool) {
        for (uint256 i; i < _assets.length; ++i) if (_assets[i] == token) return true;
        return false;
    }
}
