// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIndexioFactory} from "./interfaces/IIndexioFactory.sol";
import {IIndexioSwapAdapter} from "./interfaces/IIndexioSwapAdapter.sol";

interface IIndexioReinvestmentVault {
    function settlementToken() external view returns (address);
    function assets() external view returns (address[] memory);
    function targetWeightsBps() external view returns (uint16[] memory);
    function seeded() external view returns (bool);
    function closed() external view returns (bool);
    function rebalancePaused() external view returns (bool);
    function processIncome(uint256 amount) external returns (uint256 distributed, uint256 compounded);
    function rebalanceTransferOut(address token, address to, uint256 amount) external;
}

/// @notice Processes recognized settlement-token income and immediately reinvests
///         only the retained/compound portion across the vault's non-settlement constituents.
/// @dev This router is deliberately narrow:
///      - it never changes a vault's constituent list or target weights;
///      - it can only spend settlement tokens returned as `compounded` by processIncome in this call;
///      - every swap output is delivered directly back to the vault;
///      - caller cannot choose arbitrary allocation percentages;
///      - execution uses delayed/approved adapters plus caller-supplied min-outs.
///
///      For Compound/Hybrid indexes the router must be approved by the Factory as BOTH:
///      (1) an income source for the specific vault, and
///      (2) a rebalance router globally.
contract IndexioReinvestmentRouter is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant ADAPTER_DELAY = 1 days;
    uint256 private constant BPS = 10_000;

    struct ReinvestLeg {
        address adapter;
        uint256 minAmountOut;
        bytes routeData;
    }

    IIndexioFactory public immutable factory;
    address public immutable settlementToken;

    mapping(address => bool) public operator;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public adapterValidAt;

    error InvalidAddress();
    error InvalidVault();
    error InvalidAmount();
    error InvalidLegs();
    error InvalidAdapter();
    error UnauthorizedOperator();
    error TooEarly();
    error Expired();
    error Slippage();
    error UnsupportedTokenBehavior();

    event OperatorSet(address indexed account, bool approved);
    event AdapterProposed(address indexed adapter, uint256 validAt);
    event AdapterApproval(address indexed adapter, bool approved);
    event IncomeReinvestmentStarted(
        address indexed vault,
        address indexed operator,
        uint256 grossIncome,
        uint256 distributed,
        uint256 compounded
    );
    event ReinvestmentLegExecuted(
        address indexed vault,
        address indexed asset,
        uint256 settlementIn,
        uint256 assetOut
    );
    event IncomeReinvested(
        address indexed vault,
        address indexed operator,
        uint256 grossIncome,
        uint256 distributed,
        uint256 compounded
    );

    constructor(address owner_, address factory_, address settlementToken_) Ownable(owner_) {
        if (owner_ == address(0) || factory_ == address(0) || settlementToken_ == address(0)) {
            revert InvalidAddress();
        }
        factory = IIndexioFactory(factory_);
        settlementToken = settlementToken_;
        operator[owner_] = true;
        emit OperatorSet(owner_, true);
    }

    modifier onlyOperator() {
        if (!operator[msg.sender]) revert UnauthorizedOperator();
        _;
    }

    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    function setOperator(address account, bool approved) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        operator[account] = approved;
        emit OperatorSet(account, approved);
    }

    function proposeAdapter(address adapter) external onlyOwner {
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidAdapter();
        adapterValidAt[adapter] = block.timestamp + ADAPTER_DELAY;
        emit AdapterProposed(adapter, adapterValidAt[adapter]);
    }

    function activateAdapter(address adapter) external onlyOwner {
        uint256 validAt = adapterValidAt[adapter];
        if (validAt == 0 || block.timestamp < validAt) revert TooEarly();
        approvedAdapter[adapter] = true;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter, true);
    }

    function disableAdapter(address adapter) external onlyOwner {
        approvedAdapter[adapter] = false;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter, false);
    }

    /// @notice Process new recognized income and reinvest only the exact retained portion.
    /// @dev The operator supplies the gross USDC income and current protected swap routes.
    ///      The router first sends the gross income through the vault's existing processIncome().
    ///      It then withdraws exactly the returned `compounded` amount and allocates that amount
    ///      across every NON-settlement constituent in proportion to their declared target weights.
    ///
    ///      A 100% Income index returns compounded == 0 and therefore requires zero legs.
    function processAndReinvest(
        address vault,
        uint256 grossIncome,
        ReinvestLeg[] calldata legs,
        uint256 deadline
    )
        external
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 distributed, uint256 compounded)
    {
        if (block.timestamp > deadline) revert Expired();
        if (grossIncome == 0) revert InvalidAmount();
        if (!factory.isIndexVault(vault)) revert InvalidVault();

        IIndexioReinvestmentVault v = IIndexioReinvestmentVault(vault);
        if (
            v.settlementToken() != settlementToken ||
            !v.seeded() ||
            v.closed()
        ) revert InvalidVault();

        // This contract must be the approved source that calls processIncome,
        // and must also be approved as a rebalance router before it can release retained USDC.
        if (!factory.isIncomeSource(vault, address(this))) revert InvalidVault();

        address[] memory assets = v.assets();
        uint16[] memory weights = v.targetWeightsBps();
        if (assets.length == 0 || assets.length != weights.length) revert InvalidVault();

        (uint256 nonSettlementCount, uint256 nonSettlementWeight, bool hasSettlement) =
            _composition(assets, weights);

        if (!hasSettlement) revert InvalidVault();

        // Pull exact gross income from the authorized operator.
        uint256 beforeRouterSettlement = IERC20(settlementToken).balanceOf(address(this));
        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), grossIncome);
        if (
            IERC20(settlementToken).balanceOf(address(this)) - beforeRouterSettlement
                != grossIncome
        ) revert UnsupportedTokenBehavior();

        // Feed income through the existing vault accounting. The vault sends the
        // distributed portion to the Income Distributor and leaves the retained
        // portion in the vault.
        IERC20(settlementToken).forceApprove(vault, grossIncome);
        (distributed, compounded) = v.processIncome(grossIncome);
        IERC20(settlementToken).forceApprove(vault, 0);

        if (distributed + compounded != grossIncome) revert InvalidAmount();

        emit IncomeReinvestmentStarted(
            vault,
            msg.sender,
            grossIncome,
            distributed,
            compounded
        );

        // 100% Income: nothing is retained, so there is nothing to reinvest.
        if (compounded == 0) {
            if (legs.length != 0) revert InvalidLegs();
            emit IncomeReinvested(vault, msg.sender, grossIncome, distributed, 0);
            return (distributed, 0);
        }

        if (!factory.isRebalanceRouter(address(this))) revert InvalidVault();
        if (v.rebalancePaused()) revert InvalidVault();
        if (nonSettlementCount == 0 || nonSettlementWeight == 0) revert InvalidVault();
        if (legs.length != nonSettlementCount) revert InvalidLegs();

        // Pull exactly the newly-retained amount. This avoids spending any
        // pre-existing strategic USDC balance already held by the vault.
        uint256 beforePull = IERC20(settlementToken).balanceOf(address(this));
        v.rebalanceTransferOut(settlementToken, address(this), compounded);
        if (
            IERC20(settlementToken).balanceOf(address(this)) - beforePull
                != compounded
        ) revert UnsupportedTokenBehavior();

        uint256 allocated;
        uint256 legIndex;
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == settlementToken) continue;

            uint256 amountIn = legIndex + 1 == nonSettlementCount
                ? compounded - allocated
                : Math.mulDiv(compounded, weights[i], nonSettlementWeight);

            ReinvestLeg calldata leg = legs[legIndex];
            ++legIndex;

            // Tiny retained amounts can round an early leg to zero. Require an empty leg
            // rather than executing a meaningless external call.
            if (amountIn == 0) {
                if (
                    leg.adapter != address(0) ||
                    leg.minAmountOut != 0 ||
                    leg.routeData.length != 0
                ) revert InvalidLegs();
                continue;
            }

            allocated += amountIn;

            if (!approvedAdapter[leg.adapter] || leg.minAmountOut == 0) {
                revert InvalidAdapter();
            }

            uint256 beforeOut = IERC20(asset).balanceOf(vault);

            IERC20(settlementToken).safeTransfer(leg.adapter, amountIn);
            uint256 amountOut = IIndexioSwapAdapter(leg.adapter).swapExactInput(
                settlementToken,
                asset,
                amountIn,
                leg.minAmountOut,
                vault,
                leg.routeData
            );

            uint256 got = IERC20(asset).balanceOf(vault) - beforeOut;
            if (got != amountOut || got < leg.minAmountOut) revert Slippage();

            emit ReinvestmentLegExecuted(vault, asset, amountIn, amountOut);
        }

        if (allocated != compounded) revert InvalidAmount();

        // The router should not retain income settlement tokens after a successful run.
        if (IERC20(settlementToken).balanceOf(address(this)) != beforeRouterSettlement) {
            revert UnsupportedTokenBehavior();
        }

        emit IncomeReinvested(
            vault,
            msg.sender,
            grossIncome,
            distributed,
            compounded
        );
    }

    function previewReinvestment(address vault, uint256 compounded)
        external
        view
        returns (address[] memory assetsOut, uint256[] memory settlementAmounts)
    {
        if (!factory.isIndexVault(vault)) revert InvalidVault();

        IIndexioReinvestmentVault v = IIndexioReinvestmentVault(vault);
        if (v.settlementToken() != settlementToken) revert InvalidVault();

        address[] memory assets = v.assets();
        uint16[] memory weights = v.targetWeightsBps();
        (uint256 count, uint256 totalWeight, bool hasSettlement) =
            _composition(assets, weights);

        if (!hasSettlement || count == 0 || totalWeight == 0) revert InvalidVault();

        assetsOut = new address[](count);
        settlementAmounts = new uint256[](count);

        uint256 allocated;
        uint256 j;
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] == settlementToken) continue;

            uint256 amountIn = j + 1 == count
                ? compounded - allocated
                : Math.mulDiv(compounded, weights[i], totalWeight);

            assetsOut[j] = assets[i];
            settlementAmounts[j] = amountIn;
            allocated += amountIn;
            ++j;
        }
    }

    function _composition(address[] memory assets, uint16[] memory weights)
        internal
        view
        returns (
            uint256 nonSettlementCount,
            uint256 nonSettlementWeight,
            bool hasSettlement
        )
    {
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] == settlementToken) {
                hasSettlement = true;
            } else {
                ++nonSettlementCount;
                nonSettlementWeight += weights[i];
            }
        }
    }
}
