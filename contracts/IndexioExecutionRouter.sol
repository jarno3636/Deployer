// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIndexioFactory} from "./interfaces/IIndexioFactory.sol";
import {IIndexioVault} from "./interfaces/IIndexioVault.sol";
import {IIndexioSwapAdapter} from "./interfaces/IIndexioSwapAdapter.sol";

/// @notice Settlement-token execution helper. Vault ownership math remains oracleless.
contract IndexioExecutionRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant FEE_BPS = 100;
    uint256 public constant MIN_GROSS_SEED_USD18 = 100e18;
    uint256 public constant ADAPTER_DELAY = 1 days;

    struct BuyLeg {
        address adapter;
        uint256 amountIn;     // settlement units allocated to this asset
        uint256 minAmountOut; // constituent units
        bytes routeData;
    }
    struct SellLeg {
        address adapter;
        uint256 minAmountOut;
        bytes routeData;
    }

    IIndexioFactory public immutable factory;
    address public immutable settlementToken;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public adapterValidAt;

    error InvalidAddress();
    error InvalidVault();
    error InvalidLegs();
    error InvalidAdapter();
    error InvalidAmount();
    error DeadlineExpired();
    error Slippage();
    error UnsupportedTokenBehavior();

    event AdapterProposed(address indexed adapter,uint256 validAt);
    event AdapterApproval(address indexed adapter,bool approved);
    event IndexSeeded(address indexed creator,address indexed vault,uint256 settlementIn,uint256 sharesOut);
    event IndexBought(address indexed buyer,address indexed vault,address indexed receiver,uint256 settlementIn,uint256 sharesOut);
    event IndexSold(address indexed seller,address indexed vault,address indexed receiver,uint256 sharesIn,uint256 settlementOut);
    event ExcessRefunded(address indexed buyer,address indexed token,uint256 amount);

    constructor(address owner_,address factory_,address settlementToken_) Ownable(owner_) {
        if (owner_ == address(0) || factory_ == address(0) || settlementToken_ == address(0)) revert InvalidAddress();
        factory = IIndexioFactory(factory_);
        settlementToken = settlementToken_;
    }

    function proposeAdapter(address adapter) external onlyOwner {
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidAddress();
        adapterValidAt[adapter] = block.timestamp + ADAPTER_DELAY;
        emit AdapterProposed(adapter,adapterValidAt[adapter]);
    }
    function activateAdapter(address adapter) external onlyOwner {
        uint256 t = adapterValidAt[adapter];
        if (t == 0 || block.timestamp < t) revert InvalidAdapter();
        approvedAdapter[adapter] = true;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter,true);
    }
    function disableAdapter(address adapter) external onlyOwner {
        approvedAdapter[adapter] = false;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter,false);
    }
    function setPaused(bool p) external onlyOwner { if (p) _pause(); else _unpause(); }

    /// @notice Creator-only initial seed. Settlement allocation MUST match declared target weights.
    function seedIndex(
        address vault,uint256 settlementAmountIn,BuyLeg[] calldata legs,address receiver,uint256 deadline
    ) external nonReentrant whenNotPaused returns(uint256 sharesOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        IIndexioVault v = IIndexioVault(vault);
        if (v.settlementToken() != settlementToken || v.seeded()) revert InvalidVault();
        if (msg.sender != v.creator() || receiver != msg.sender || settlementAmountIn == 0) revert InvalidAmount();

        address[] memory assets = v.assets();
        uint16[] memory weights = v.targetWeightsBps();
        if (legs.length != assets.length || weights.length != assets.length) revert InvalidLegs();

        uint8 sd = IERC20Metadata(settlementToken).decimals();
        if (sd > 18) revert InvalidAmount();
        uint256 grossUsd18 = settlementAmountIn * (10 ** (18 - sd));
        if (grossUsd18 < MIN_GROSS_SEED_USD18) revert InvalidAmount();

        _pullSettlement(msg.sender,settlementAmountIn);
        uint256[] memory grossAmounts = new uint256[](assets.length);
        uint256 allocated;
        for (uint256 i; i < assets.length; ++i) {
            // Last leg receives integer remainder so allocations always sum exactly to the seed amount.
            uint256 expected = i + 1 == assets.length
                ? settlementAmountIn - allocated
                : Math.mulDiv(settlementAmountIn,weights[i],BPS);
            BuyLeg calldata leg = legs[i];
            if (leg.amountIn != expected || expected == 0) revert InvalidLegs();
            allocated += expected;
            grossAmounts[i] = _executeBuyLeg(assets[i],leg);
        }
        if (allocated != settlementAmountIn) revert InvalidAmount();

        uint256 fee = Math.mulDiv(settlementAmountIn,FEE_BPS,BPS,Math.Rounding.Ceil);
        if (fee >= settlementAmountIn) revert InvalidAmount();
        uint256 netPrincipalUsd18 = (settlementAmountIn - fee) * (10 ** (18 - sd));
        uint256 shares = Math.mulDiv(netPrincipalUsd18,1e18,v.initialSharePriceUsd18());
        if (shares == 0) revert InvalidAmount();

        _approveBasket(assets,vault,grossAmounts);
        sharesOut = v.seed(receiver,grossAmounts,shares);
        _clearBasketApprovals(assets,vault);
        emit IndexSeeded(msg.sender,vault,settlementAmountIn,sharesOut);
    }

    function buyIndex(
        address vault,uint256 settlementAmountIn,BuyLeg[] calldata legs,uint256 minSharesOut,address receiver,uint256 deadline
    ) external nonReentrant whenNotPaused returns(uint256 sharesOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        if (receiver == address(0) || settlementAmountIn == 0) revert InvalidAmount();
        IIndexioVault v = IIndexioVault(vault);
        if (v.settlementToken() != settlementToken || !v.seeded() || v.closed()) revert InvalidVault();
        address[] memory assets = v.assets();
        if (legs.length != assets.length) revert InvalidLegs();

        _pullSettlement(msg.sender,settlementAmountIn);
        uint256 allocated;
        uint256[] memory grossAmounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            BuyLeg calldata leg = legs[i];
            if (leg.amountIn == 0) revert InvalidAmount();
            allocated += leg.amountIn;
            grossAmounts[i] = _executeBuyLeg(assets[i],leg);
        }
        if (allocated != settlementAmountIn) revert InvalidAmount();

        _approveBasket(assets,vault,grossAmounts);
        uint256[] memory acceptedGross;
        (sharesOut,acceptedGross) = v.deposit(receiver,grossAmounts,minSharesOut,deadline);
        _clearBasketApprovals(assets,vault);

        // Any execution imbalance is returned as the actual constituent rather than donated to existing holders.
        for (uint256 i; i < assets.length; ++i) {
            uint256 refund = grossAmounts[i] - acceptedGross[i];
            if (refund > 0) {
                IERC20(assets[i]).safeTransfer(msg.sender,refund);
                emit ExcessRefunded(msg.sender,assets[i],refund);
            }
        }
        emit IndexBought(msg.sender,vault,receiver,settlementAmountIn,sharesOut);
    }

    function sellIndex(
        address vault,uint256 sharesIn,SellLeg[] calldata legs,uint256 minSettlementOut,address receiver,uint256 deadline
    ) external nonReentrant whenNotPaused returns(uint256 settlementOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        if (receiver == address(0) || sharesIn == 0) revert InvalidAmount();
        IIndexioVault v = IIndexioVault(vault);
        if (v.settlementToken() != settlementToken) revert InvalidVault();
        address[] memory assets = v.assets();
        if (legs.length != assets.length) revert InvalidLegs();

        address share = v.shareToken();
        uint256 beforeShare = IERC20(share).balanceOf(address(this));
        IERC20(share).safeTransferFrom(msg.sender,address(this),sharesIn);
        if (IERC20(share).balanceOf(address(this)) - beforeShare != sharesIn) revert UnsupportedTokenBehavior();

        uint256[] memory mins = new uint256[](assets.length);
        uint256[] memory amounts = v.redeem(sharesIn,address(this),mins,deadline);
        for (uint256 i; i < assets.length; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            SellLeg calldata leg = legs[i];
            if (assets[i] == settlementToken) {
                if (leg.adapter != address(0) || leg.routeData.length != 0 || leg.minAmountOut > amount) revert InvalidLegs();
                settlementOut += amount;
            } else {
                if (!approvedAdapter[leg.adapter]) revert InvalidAdapter();
                uint256 beforeOut = IERC20(settlementToken).balanceOf(address(this));
                IERC20(assets[i]).safeTransfer(leg.adapter,amount);
                uint256 out = IIndexioSwapAdapter(leg.adapter).swapExactInput(
                    assets[i],settlementToken,amount,leg.minAmountOut,address(this),leg.routeData
                );
                uint256 got = IERC20(settlementToken).balanceOf(address(this)) - beforeOut;
                if (got != out || got < leg.minAmountOut) revert Slippage();
                settlementOut += got;
            }
        }
        if (settlementOut < minSettlementOut) revert Slippage();
        IERC20(settlementToken).safeTransfer(receiver,settlementOut);
        emit IndexSold(msg.sender,vault,receiver,sharesIn,settlementOut);
    }

    function _pullSettlement(address from,uint256 amount) internal {
        uint256 beforeBal = IERC20(settlementToken).balanceOf(address(this));
        IERC20(settlementToken).safeTransferFrom(from,address(this),amount);
        if (IERC20(settlementToken).balanceOf(address(this)) - beforeBal != amount) revert UnsupportedTokenBehavior();
    }

    function _executeBuyLeg(address asset,BuyLeg calldata leg) internal returns(uint256 grossOut) {
        if (asset == settlementToken) {
            if (leg.adapter != address(0) || leg.routeData.length != 0 || leg.minAmountOut > leg.amountIn) revert InvalidLegs();
            return leg.amountIn;
        }
        if (!approvedAdapter[leg.adapter] || leg.minAmountOut == 0) revert InvalidAdapter();
        uint256 beforeOut = IERC20(asset).balanceOf(address(this));
        IERC20(settlementToken).safeTransfer(leg.adapter,leg.amountIn);
        uint256 out = IIndexioSwapAdapter(leg.adapter).swapExactInput(
            settlementToken,asset,leg.amountIn,leg.minAmountOut,address(this),leg.routeData
        );
        uint256 got = IERC20(asset).balanceOf(address(this)) - beforeOut;
        if (got != out || got < leg.minAmountOut) revert Slippage();
        return got;
    }

    function _approveBasket(address[] memory assets,address vault,uint256[] memory amounts) internal {
        for (uint256 i; i < assets.length; ++i) IERC20(assets[i]).forceApprove(vault,amounts[i]);
    }
    function _clearBasketApprovals(address[] memory assets,address vault) internal {
        for (uint256 i; i < assets.length; ++i) IERC20(assets[i]).forceApprove(vault,0);
    }
}
