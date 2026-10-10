// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IIndexioFactoryBuyV338 {
    function isVault(address vault) external view returns (bool);
    function settlementToken() external view returns (address);
    function registry() external view returns (address);
    function feeTreasury() external view returns (address);
    function vaultDeployer() external view returns (address);
    function executionRouter() external view returns (address);
    function executionRouterLocked() external view returns (bool);
    function safetyController() external view returns (address);
    function transferPolicy() external view returns (address);
}

interface IIndexioVaultBuyV338 {
    function factory() external view returns (address);
    function assets() external view returns (address[] memory);
    function MAX_DEPOSIT_IMBALANCE_BPS() external view returns (uint16);
    function seeded() external view returns (bool);
    function closed() external view returns (bool);
    function creatorFeeBps() external view returns (uint16);
    function shareToken() external view returns (address);
    function expectedReceiveBps(address token) external view returns (uint16);
    function deposit(uint256[] calldata gross, address receiver, uint256 minSharesOut, uint256 deadline) external returns (uint256);
}

interface IIndexioSafetyBuyV338 {
    function depositsPaused(address vault) external view returns (bool);
    function tradingPaused(address vault) external view returns (bool);
}

interface IIndexioSwapAdapterBuyV338 {
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata routeData
    ) external returns (uint256 amountOut);
}

interface IIndexioShareSupplyBuyV338 {
    function totalSupply() external view returns (uint256);
    function vault() external view returns (address);
}

interface IIndexioBindingBuyV338 {
    function factory() external view returns (address);
    function factoryLocked() external view returns (bool);
}

interface IIndexioVaultDeployerBindingBuyV338 {
    function canonicalFactory() external view returns (address);
    function factoryLocked() external view returns (bool);
}

interface IIndexioRouterBoundAdapterV338 {
    function callerRouter() external view returns (address);
    function RELEASE_ID() external view returns (bytes32);
}

/// @title Indexio V3.3.8 Adaptive Proportional Buy Router — candidate
/// @notice New purchases into already-seeded V3.3.8 vaults without the legacy
///         router's fixed USDC-per-weight allocation. NOT a replacement for seed or sell.
/// @dev This contract CANNOT relax the immutable vault's 1% proportional-deposit rule.
///      It must be paired with newly deployed restricted adapters whose `callerRouter`
///      equals this router. Existing adapters are immutable-bound to the old router.
///      NOT AUDITED; DO NOT DEPLOY WITH USER FUNDS UNTIL FORK TESTING AND REVIEW.
contract IndexioProportionalBuyRouterV338 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // This add-on is dedicated to the deployed V3.3.8 protocol. An accidentally
    // supplied older Factory must fail IN THE CONSTRUCTOR, before any user funds
    // could be approved or routed to the wrong contract.
    address public constant CANONICAL_FACTORY = 0x0db41d4b3221bd4244a83da39e0ef91a706a0e62;
    address public constant CANONICAL_OWNER = 0x3118fe32b27651734fe4d966d1bc240be6e3139d;
    address public constant CANONICAL_REGISTRY = 0x5c4791e3b752d9b084e8fd76932e82c2031f15c1;
    address public constant CANONICAL_USDC = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913;
    address public constant CANONICAL_TREASURY = 0x3118fe32b27651734fe4d966d1bc240be6e3139d;
    address public constant CANONICAL_SAFETY = 0xaa3d6f215deaf871759936d19f157104ffe9644d;
    address public constant CANONICAL_TRANSFER_POLICY = 0x311e4894b50484d10641133609d44668e627585c;
    address public constant CANONICAL_VAULT_DEPLOYER = 0x372a68bf3dc1b5b416f3849a7df502b706805a8a;
    address public constant ORIGINAL_EXECUTION_ROUTER = 0x38476748a9197f0ef02a812948f123e892ac8aca;

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 1_000; // <=10%; minSharesOut remains mandatory
    uint256 public constant MAX_REFUND_BPS = 3_000; // <=30% maximum; frontend defaults far lower
    uint256 public constant ADAPTER_ADD_DELAY = 6 hours;
    uint256 public constant MAX_ASSETS = 20;
    bytes32 public constant ADAPTER_RELEASE_ID = keccak256("INDEXIO_V3_3_6_HARDENED_RC");

    address public immutable factory;
    address public immutable settlementToken;
    bool public buysPaused;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public pendingAdapterValidAt;

    struct BuyLeg {
        address adapter;
        uint256 amountIn;        // independent USDC budget for this asset, NOT fixed by target weight
        uint256 quotedAmountOut; // expected FINAL output at this router (after any swap/output tax)
        uint256 minAmountOut;    // user minimum after any output tax; max permitted variance 10%
        bytes routeData;
    }

    event AdapterProposed(address indexed adapter, uint256 executableAt);
    event AdapterSet(address indexed adapter, bool approved);
    event BuysPausedSet(bool paused);
    event ProportionalBuy(
        address indexed buyer,
        address indexed vault,
        address indexed receiver,
        uint256 settlementIn,
        uint256 sharesOut,
        uint256 settlementRefund
    );
    event RefundedAsset(address indexed buyer, address indexed asset, uint256 amount);

    constructor(address owner_, address factory_) Ownable(owner_) {
        require(block.chainid == 8453, "Base only");
        require(owner_ == CANONICAL_OWNER && factory_ == CANONICAL_FACTORY && factory_.code.length > 0, "wrong V3.3.8 deployment");
        IIndexioFactoryBuyV338 f = IIndexioFactoryBuyV338(factory_);
        address usdc = f.settlementToken();
        require(usdc == CANONICAL_USDC && usdc.code.length > 0, "wrong USDC");
        require(f.registry() == CANONICAL_REGISTRY && f.feeTreasury() == CANONICAL_TREASURY &&
                f.safetyController() == CANONICAL_SAFETY && f.transferPolicy() == CANONICAL_TRANSFER_POLICY &&
                f.vaultDeployer() == CANONICAL_VAULT_DEPLOYER &&
                f.executionRouter() == ORIGINAL_EXECUTION_ROUTER && f.executionRouterLocked(), "wrong Factory wiring");
        require(IIndexioBindingBuyV338(CANONICAL_SAFETY).factory() == factory_ &&
                IIndexioBindingBuyV338(CANONICAL_SAFETY).factoryLocked(), "safety not bound");
        require(IIndexioVaultDeployerBindingBuyV338(CANONICAL_VAULT_DEPLOYER).canonicalFactory() == factory_ &&
                IIndexioVaultDeployerBindingBuyV338(CANONICAL_VAULT_DEPLOYER).factoryLocked(), "deployer not bound");
        factory = factory_;
        settlementToken = usdc;
    }

    /// @notice Emergency shutoff does not affect the original seed/buy/sell router.
    function setBuysPaused(bool paused) external onlyOwner {
        buysPaused = paused;
        emit BuysPausedSet(paused);
    }

    /// @notice Delayed additions; disabling a compromised adapter is immediate.
    function proposeAdapter(address adapter) external onlyOwner {
        require(adapter.code.length > 0 && !approvedAdapter[adapter] &&
                IIndexioRouterBoundAdapterV338(adapter).callerRouter() == address(this) &&
                IIndexioRouterBoundAdapterV338(adapter).RELEASE_ID() == ADAPTER_RELEASE_ID, "adapter");
        uint256 at = block.timestamp + ADAPTER_ADD_DELAY;
        pendingAdapterValidAt[adapter] = at;
        emit AdapterProposed(adapter, at);
    }

    function activateAdapter(address adapter) external onlyOwner {
        uint256 at = pendingAdapterValidAt[adapter];
        require(at != 0 && block.timestamp >= at && adapter.code.length > 0 &&
                IIndexioRouterBoundAdapterV338(adapter).callerRouter() == address(this) &&
                IIndexioRouterBoundAdapterV338(adapter).RELEASE_ID() == ADAPTER_RELEASE_ID, "not ready");
        delete pendingAdapterValidAt[adapter];
        approvedAdapter[adapter] = true;
        emit AdapterSet(adapter, true);
    }

    function disableAdapter(address adapter) external onlyOwner {
        approvedAdapter[adapter] = false;
        delete pendingAdapterValidAt[adapter];
        emit AdapterSet(adapter, false);
    }

    /// @notice Helps the frontend quote gross token quantities for a desired share amount.
    /// @dev Read-only estimate. Quote paths still MUST be simulated against live state.
    ///      The vault's actual fee-rounding and transfer losses may differ by a few units.
    function previewTargetGross(address vault, uint256 desiredShares)
        external view returns (address[] memory assets, uint256[] memory grossTargets)
    {
        require(IIndexioFactoryBuyV338(factory).isVault(vault) && desiredShares > 0, "vault/shares");
        IIndexioVaultBuyV338 v = IIndexioVaultBuyV338(vault);
        require(v.seeded() && !v.closed() && v.factory() == factory &&
                v.MAX_DEPOSIT_IMBALANCE_BPS() == 100, "incompatible V3.3.8 vault");
        assets = v.assets();
        require(IIndexioShareSupplyBuyV338(v.shareToken()).vault() == vault, "wrong share token");
        uint256 supply = IIndexioShareSupplyBuyV338(v.shareToken()).totalSupply();
        require(supply > 0 && assets.length > 0 && assets.length <= MAX_ASSETS, "supply/assets");
        uint256 feeBps = 100 + uint256(v.creatorFeeBps());
        require(feeBps < BPS, "fee");
        grossTargets = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            uint256 vaultBalance = IERC20(assets[i]).balanceOf(vault);
            uint256 receiveBps = v.expectedReceiveBps(assets[i]);
            require(vaultBalance > 0 && receiveBps > 0 && receiveBps <= BPS, "asset/policy");
            uint256 requiredActual = Math.mulDiv(vaultBalance, desiredShares, supply, Math.Rounding.Ceil);
            uint256 requiredNominal = Math.mulDiv(requiredActual, BPS, receiveBps, Math.Rounding.Ceil);
            grossTargets[i] = Math.mulDiv(requiredNominal, BPS, BPS - feeBps, Math.Rounding.Ceil) + 3;
        }
    }

    /// @notice Flexible USDC-allocation buy; excess output is refunded rather than
    ///         enforcing the old router's default 0.35% upper limit.
    /// @param maxRefundBps Max residual of *each leg* and of total settlement,
    ///        as selected by the investor (at most 30%). This is NOT slippage.
    /// @param minSharesOut Investor's ultimate economic protection: transaction
    ///        reverts if the vault cannot mint the agreed minimum share amount.
    function buyExistingIndex(
        address vault,
        uint256 settlementAmountIn,
        BuyLeg[] calldata legs,
        uint256 minSharesOut,
        uint16 maxRefundBps,
        address receiver,
        uint256 deadline
    ) external nonReentrant returns (uint256 sharesOut) {
        require(!buysPaused && block.timestamp <= deadline, "paused/deadline");
        require(receiver != address(0) && settlementAmountIn > 0 && minSharesOut > 0, "input");
        require(maxRefundBps <= MAX_REFUND_BPS, "refund limit");
        IIndexioFactoryBuyV338 f = IIndexioFactoryBuyV338(factory);
        require(f.isVault(vault), "not Indexio vault");
        IIndexioVaultBuyV338 v = IIndexioVaultBuyV338(vault);
        require(v.seeded() && !v.closed() && v.factory() == factory &&
                v.MAX_DEPOSIT_IMBALANCE_BPS() == 100 &&
                IIndexioShareSupplyBuyV338(v.shareToken()).vault() == vault, "incompatible V3.3.8 vault");
        address safety = f.safetyController();
        require(!IIndexioSafetyBuyV338(safety).depositsPaused(vault) &&
                !IIndexioSafetyBuyV338(safety).tradingPaused(vault), "vault paused");

        address[] memory assets = v.assets();
        require(assets.length > 0 && assets.length <= MAX_ASSETS && legs.length == assets.length, "legs");

        // Snapshot prior balances so donated tokens can never be spent or swept.
        uint256 baseUsdc = IERC20(settlementToken).balanceOf(address(this));
        uint256[] memory original = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            require(assets[i] != address(0), "asset");
            original[i] = IERC20(assets[i]).balanceOf(address(this));
        }
        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), settlementAmountIn);
        require(IERC20(settlementToken).balanceOf(address(this)) == baseUsdc + settlementAmountIn, "nonstandard USDC");

        uint256[] memory gross = new uint256[](assets.length);
        uint256 spent;
        for (uint256 i; i < assets.length; ++i) {
            BuyLeg calldata leg = legs[i];
            require(leg.amountIn > 0 && spent + leg.amountIn <= settlementAmountIn, "budget");
            spent += leg.amountIn;
            if (assets[i] == settlementToken) {
                require(leg.adapter == address(0) && leg.routeData.length == 0 &&
                        leg.quotedAmountOut == leg.amountIn && leg.minAmountOut <= leg.amountIn, "direct USDC");
                gross[i] = leg.amountIn;
            } else {
                require(approvedAdapter[leg.adapter] && leg.adapter.code.length > 0 &&
                        IIndexioRouterBoundAdapterV338(leg.adapter).callerRouter() == address(this) &&
                        IIndexioRouterBoundAdapterV338(leg.adapter).RELEASE_ID() == ADAPTER_RELEASE_ID, "adapter");
                require(leg.quotedAmountOut > 0 && leg.minAmountOut > 0 &&
                        leg.minAmountOut <= leg.quotedAmountOut &&
                        leg.minAmountOut >= Math.mulDiv(leg.quotedAmountOut, BPS - MAX_SWAP_SLIPPAGE_BPS, BPS),
                        "swap slippage");
                uint256 beforeOut = IERC20(assets[i]).balanceOf(address(this));
                // USDC must arrive exactly: taxed settlement input is not supported.
                uint256 beforeAdapter = IERC20(settlementToken).balanceOf(leg.adapter);
                IERC20(settlementToken).safeTransfer(leg.adapter, leg.amountIn);
                require(IERC20(settlementToken).balanceOf(leg.adapter) - beforeAdapter == leg.amountIn, "USDC transfer");
                uint256 reported = IIndexioSwapAdapterBuyV338(leg.adapter).swapExactInput(
                    settlementToken, assets[i], leg.amountIn, leg.minAmountOut, address(this), leg.routeData
                );
                gross[i] = IERC20(assets[i]).balanceOf(address(this)) - beforeOut;
                require(reported == gross[i] && gross[i] >= leg.minAmountOut, "swap output");
            }
            IERC20(assets[i]).forceApprove(vault, gross[i]);
        }

        // The existing vault enforces its own hard 1% deposit-capacity tolerance,
        // measured token-transfer behavior, fixed fees, and minSharesOut.
        sharesOut = v.deposit(gross, receiver, minSharesOut, deadline);

        for (uint256 i; i < assets.length; ++i) {
            IERC20(assets[i]).forceApprove(vault, 0);
            if (assets[i] == settlementToken) continue;
            uint256 balance = IERC20(assets[i]).balanceOf(address(this));
            require(balance >= original[i], "token deficit");
            uint256 refund = balance - original[i];
            require(refund <= Math.mulDiv(gross[i], maxRefundBps, BPS, Math.Rounding.Ceil), "excess token refund");
            if (refund > 0) {
                IERC20(assets[i]).safeTransfer(msg.sender, refund);
                require(IERC20(assets[i]).balanceOf(address(this)) == original[i], "token residue");
                emit RefundedAsset(msg.sender, assets[i], refund);
            }
        }

        uint256 afterUsdc = IERC20(settlementToken).balanceOf(address(this));
        require(afterUsdc >= baseUsdc, "USDC deficit");
        uint256 refundUsdc = afterUsdc - baseUsdc;
        require(refundUsdc <= Math.mulDiv(settlementAmountIn, maxRefundBps, BPS, Math.Rounding.Ceil),
                "excess USDC refund");
        if (refundUsdc > 0) IERC20(settlementToken).safeTransfer(msg.sender, refundUsdc);
        require(IERC20(settlementToken).balanceOf(address(this)) == baseUsdc, "USDC residue");
        emit ProportionalBuy(msg.sender, vault, receiver, settlementAmountIn, sharesOut, refundUsdc);
    }
}
