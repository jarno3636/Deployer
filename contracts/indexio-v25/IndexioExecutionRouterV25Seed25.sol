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
import {IIndexioFactoryV25} from "./interfaces/IIndexioFactoryV25.sol";
import {IIndexioVaultV25} from "./interfaces/IIndexioVaultV25.sol";
import {IIndexioSwapAdapterV25} from "./interfaces/IIndexioSwapAdapterV25.sol";

/// @notice V2.5 execution-router replacement with a $25 minimum initial seed. Vault ownership math remains oracleless.
contract IndexioExecutionRouterV25Seed25 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant FEE_BPS = 100;
    uint256 public constant MIN_GROSS_SEED_USD18 = 25e18;
    uint256 public constant MAX_SLIPPAGE_BPS = 500; // minOut must stay within 5% of the submitted quote
    
    struct BuyLeg {
        address adapter;
        uint256 amountIn;     // settlement units allocated to this asset
        uint256 quotedAmountOut;
        uint256 minAmountOut; // constituent units
        bytes routeData;
    }
    struct SellLeg {
        address adapter;
        uint256 quotedAmountOut;
        uint256 minAmountOut;
        bytes routeData;
    }

    IIndexioFactoryV25 public immutable factory;
    address public immutable settlementToken;
    mapping(address => bool) public approvedAdapter;
    uint256 public constant ADAPTER_DELAY = 6 hours;
    bool public bootstrapFinalized;
    mapping(address => uint256) public pendingAdapterValidAt;
    
    error InvalidAddress();error BootstrapClosed();error BootstrapAlreadyFinalized();error TooEarly();error NothingPending();
    error InvalidVault();
    error InvalidLegs();
    error InvalidAdapter();
    error InvalidAmount();
    error DeadlineExpired();
    error Slippage();
    error UnsupportedTokenBehavior();

        event AdapterApproval(address indexed adapter,bool approved);event AdapterProposed(address indexed adapter,uint256 validAt);event BootstrapFinalized(address indexed owner);
    event IndexSeeded(address indexed creator,address indexed vault,uint256 settlementIn,uint256 sharesOut);
    event IndexBought(address indexed buyer,address indexed vault,address indexed receiver,uint256 settlementIn,uint256 sharesOut);
    event IndexSold(address indexed seller,address indexed vault,address indexed receiver,uint256 sharesIn,uint256 settlementOut);
    event ExcessRefunded(address indexed buyer,address indexed token,uint256 amount);

    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);
    constructor(address owner_,address factory_,address settlementToken_) Ownable(owner_) {
        if (owner_ == address(0) || factory_ == address(0) || settlementToken_ == address(0)) revert InvalidAddress();
        factory = IIndexioFactoryV25(factory_);
        settlementToken = settlementToken_;
    }

    function setAdapter(address adapter,bool approved) external onlyOwner {
        if(bootstrapFinalized&&approved)revert BootstrapClosed();
        _setAdapter(adapter,approved);
    }
    function proposeAdapter(address adapter) external onlyOwner {
        if(!bootstrapFinalized)revert BootstrapClosed();
        if(adapter==address(0)||adapter.code.length==0)revert InvalidAddress();
        uint256 t=block.timestamp+ADAPTER_DELAY;pendingAdapterValidAt[adapter]=t;emit AdapterProposed(adapter,t);
    }
    function activateAdapter(address adapter) external onlyOwner {
        uint256 t=pendingAdapterValidAt[adapter];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();
        delete pendingAdapterValidAt[adapter];_setAdapter(adapter,true);
    }
    function finalizeBootstrap() external onlyOwner {if(bootstrapFinalized)revert BootstrapAlreadyFinalized();bootstrapFinalized=true;emit BootstrapFinalized(msg.sender);}
    function _setAdapter(address adapter,bool approved) internal {
        if(adapter==address(0)||(approved&&adapter.code.length==0))revert InvalidAddress();
        approvedAdapter[adapter]=approved;if(!approved)delete pendingAdapterValidAt[adapter];emit AdapterApproval(adapter,approved);
    }
    function setPaused(bool p) external onlyOwner { if (p) _pause(); else _unpause(); }

    /// @notice Creator-only initial seed. Settlement allocation MUST match declared target weights.
    function seedIndex(
        address vault,uint256 settlementAmountIn,BuyLeg[] calldata legs,address receiver,uint256 deadline
    ) external nonReentrant whenNotPaused returns(uint256 sharesOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        IIndexioVaultV25 v = IIndexioVaultV25(vault);
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
        IIndexioVaultV25 v = IIndexioVaultV25(vault);
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
        address vault,uint256 sharesIn,SellLeg[] calldata legs,uint256 quotedSettlementOut,uint256 minSettlementOut,address receiver,uint256 deadline
    ) external nonReentrant whenNotPaused returns(uint256 settlementOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        if (receiver == address(0) || sharesIn == 0) revert InvalidAmount();
        _validateSlippage(quotedSettlementOut,minSettlementOut);
        IIndexioVaultV25 v = IIndexioVaultV25(vault);
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
                if (leg.adapter != address(0) || leg.routeData.length != 0 || leg.quotedAmountOut != amount || leg.minAmountOut > amount) revert InvalidLegs();
                settlementOut += amount;
            } else {
                if (!approvedAdapter[leg.adapter]) revert InvalidAdapter();
                _validateSlippage(leg.quotedAmountOut,leg.minAmountOut);
                uint256 beforeOut = IERC20(settlementToken).balanceOf(address(this));
                IERC20(assets[i]).safeTransfer(leg.adapter,amount);
                uint256 out = IIndexioSwapAdapterV25(leg.adapter).swapExactInput(
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

    function _validateSlippage(uint256 quotedAmountOut,uint256 minAmountOut) internal pure {
        if(quotedAmountOut==0||minAmountOut==0) revert Slippage();
        uint256 floor=Math.mulDiv(quotedAmountOut,BPS-MAX_SLIPPAGE_BPS,BPS);
        if(minAmountOut<floor||minAmountOut>quotedAmountOut) revert Slippage();
    }

    function _executeBuyLeg(address asset,BuyLeg calldata leg) internal returns(uint256 grossOut) {
        if (asset == settlementToken) {
            if (leg.adapter != address(0) || leg.routeData.length != 0 || leg.quotedAmountOut != leg.amountIn || leg.minAmountOut > leg.amountIn) revert InvalidLegs();
            return leg.amountIn;
        }
        if (!approvedAdapter[leg.adapter]) revert InvalidAdapter();
        _validateSlippage(leg.quotedAmountOut,leg.minAmountOut);
        uint256 beforeOut = IERC20(asset).balanceOf(address(this));
        IERC20(settlementToken).safeTransfer(leg.adapter,leg.amountIn);
        uint256 out = IIndexioSwapAdapterV25(leg.adapter).swapExactInput(
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

    /// @notice Recover an ERC-20 accidentally sent outside an active atomic operation. Recipient is fixed to owner/Safe.
    function recoverAccidentalToken(address token,uint256 amount) external onlyOwner nonReentrant {
        if(token==address(0)||amount==0)revert InvalidAmount();if(token==settlementToken)revert InvalidAmount();
        address recipient=owner();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }
}
