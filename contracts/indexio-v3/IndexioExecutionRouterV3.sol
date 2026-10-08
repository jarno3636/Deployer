// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IFactoryExecV3 {
    function isVault(address) external view returns(bool);
    function creatorOf(address) external view returns(address);
    function settlementToken() external view returns(address);
    function safetyController() external view returns(address);
    function executionRouterLocked() external view returns(bool);
    function transferPolicy() external view returns(address);
}
interface ITransferPolicyExecV3 { function expectedReceiveBps(address) external view returns(uint16); }
interface IVaultExecV3 {
    function assets() external view returns(address[] memory);
    function weights() external view returns(uint16[] memory);
    function seeded() external view returns(bool);
    function initialSharePriceUsd18() external view returns(uint256);
    function creatorFeeBps() external view returns(uint16);
    function expectedReceiveBps(address) external view returns(uint16);
    function seed(address,uint256[] calldata,uint256) external returns(uint256);
    function deposit(uint256[] calldata,address,uint256,uint256) external returns(uint256);
    function redeemFromRouter(address,uint256,address,uint256[] calldata,uint256) external returns(uint256[] memory);
    function closed() external view returns(bool);
    function governor() external view returns(address);
    function transferForRebalance(address,address,uint256) external returns(uint256);
}
interface ISafetyExecV3 {function depositsPaused(address) external view returns(bool);function tradingPaused(address) external view returns(bool);}
interface IGovernorExecV3 {function executable(uint256,bytes32) external view returns(bool);function execute(uint256,address[] calldata,uint16[] calldata,bytes32) external;}
interface ISwapAdapterV3 {function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,bytes calldata routeData) external returns(uint256 amountOut);}

/// @notice Canonical V3 entry router with balance-delta support for transfer-tax tokens.
/// @dev Settlement token pulls remain exact. Non-settlement asset transfers are measured at every hop.
contract IndexioExecutionRouterV3 is Ownable2Step,ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 constant BPS=10_000;
    uint256 constant INDEXIO_FEE_BPS=100;
    uint256 public constant MIN_GROSS_SEED_USD18=25e18;
    uint256 public constant MAX_SLIPPAGE_BPS=500;
    uint256 public constant MAX_BUY_REFUND_BPS=25;
    bytes32 public constant RELEASE_ID=keccak256("INDEXIO_V3_3_4_AUDIT_RC");
    address public immutable factory;
    address public immutable settlementToken;
    mapping(address=>bool) public approvedAdapter;
    mapping(address=>uint256) public pendingAdapterValidAt;
    uint256 public constant ADAPTER_ADD_DELAY=6 hours;

    struct BuyLeg {address adapter;uint256 amountIn;uint256 quotedAmountOut;uint256 minAmountOut;bytes routeData;}
    struct RebalanceLeg {address tokenIn;address tokenOut;address adapter;uint256 amountIn;uint256 quotedAmountOut;uint256 minAmountOut;bytes routeData;}

    event AdapterSet(address indexed adapter,bool approved);
    event AdapterProposed(address indexed adapter,uint256 validAt);
    event IndexSeeded(address indexed creator,address indexed vault,uint256 settlementIn,uint256 sharesOut,uint256 initialSharePriceUsd18);
    event IndexBought(address indexed buyer,address indexed vault,uint256 settlementIn,uint256 sharesOut);
    event IndexSold(address indexed seller,address indexed vault,uint256 sharesIn,uint256 settlementOut);
    event RebalanceExecuted(address indexed vault,uint256 indexed proposalId,bytes32 executionHash);
    event TransferAdjusted(address indexed token,address indexed recipient,uint256 requested,uint256 received);

    constructor(address guardian,address factory_) Ownable(guardian){
        require(guardian!=address(0)&&factory_.code.length>0,"config");
        factory=factory_;
        settlementToken=IFactoryExecV3(factory_).settlementToken();
    }

    function expectedAfterTransfer(address token,uint256 amount) external view returns(uint256){
        return Math.mulDiv(amount,ITransferPolicyExecV3(IFactoryExecV3(factory).transferPolicy()).expectedReceiveBps(token),BPS);
    }
    function expectedAfterVaultTransfer(address vault,address token,uint256 amount) external view returns(uint256){
        require(IFactoryExecV3(factory).isVault(vault),"vault");
        return Math.mulDiv(amount,IVaultExecV3(vault).expectedReceiveBps(token),BPS);
    }

    function setAdapter(address adapter,bool approved) external onlyOwner {
        require(adapter!=address(0)&&(!approved||adapter.code.length>0),"adapter");
        if(approved){require(!IFactoryExecV3(factory).executionRouterLocked(),"use proposal");approvedAdapter[adapter]=true;}
        else{approvedAdapter[adapter]=false;delete pendingAdapterValidAt[adapter];}
        emit AdapterSet(adapter,approved);
    }
    function proposeAdapter(address adapter) external onlyOwner {require(adapter!=address(0)&&adapter.code.length>0&&!approvedAdapter[adapter],"adapter");require(IFactoryExecV3(factory).executionRouterLocked(),"bootstrap open");uint256 t=block.timestamp+ADAPTER_ADD_DELAY;pendingAdapterValidAt[adapter]=t;emit AdapterProposed(adapter,t);}
    function activateAdapter(address adapter) external onlyOwner {uint256 t=pendingAdapterValidAt[adapter];require(t!=0&&block.timestamp>=t,"not ready");require(adapter.code.length>0,"adapter");delete pendingAdapterValidAt[adapter];approvedAdapter[adapter]=true;emit AdapterSet(adapter,true);}

    function seedIndex(address vault,uint256 settlementAmountIn,BuyLeg[] calldata legs,address receiver,uint256 deadline) external nonReentrant returns(uint256 sharesOut){
        require(block.timestamp<=deadline,"deadline");
        require(IFactoryExecV3(factory).isVault(vault)&&!IVaultExecV3(vault).seeded(),"vault");
        address safety=IFactoryExecV3(factory).safetyController();
        require(!ISafetyExecV3(safety).depositsPaused(vault)&&!ISafetyExecV3(safety).tradingPaused(vault),"paused");
        address creator=IFactoryExecV3(factory).creatorOf(vault);
        require(msg.sender==creator&&receiver==creator&&settlementAmountIn>0,"creator");
        uint8 sd=IERC20Metadata(settlementToken).decimals();
        require(sd<=18,"decimals");
        uint256 grossUsd18=settlementAmountIn*(10**(18-sd));
        require(grossUsd18>=MIN_GROSS_SEED_USD18,"min seed");
        address[] memory assets=IVaultExecV3(vault).assets();
        uint16[] memory weights=IVaultExecV3(vault).weights();
        require(legs.length==assets.length&&weights.length==assets.length,"legs");
        // Preserve funds already in the shared router; a seed must not use or strand them.
        uint256 settlementBaseline=IERC20(settlementToken).balanceOf(address(this));
        _pullExactSettlement(msg.sender,settlementAmountIn);
        uint256[] memory gross=new uint256[](assets.length);
        uint256 allocated;
        for(uint256 i;i<assets.length;i++){
            uint256 expected=i+1==assets.length?settlementAmountIn-allocated:Math.mulDiv(settlementAmountIn,weights[i],BPS);
            require(legs[i].amountIn==expected&&expected>0,"weight");
            allocated+=expected;
            gross[i]=_buy(assets[i],legs[i]);
        }
        require(allocated==settlementAmountIn,"allocation");
        uint256 totalFeeBps=INDEXIO_FEE_BPS+IVaultExecV3(vault).creatorFeeBps();
        require(totalFeeBps<BPS,"fee");
        uint256 netUsd18=Math.mulDiv(grossUsd18,BPS-totalFeeBps,BPS);
        uint256 price=IVaultExecV3(vault).initialSharePriceUsd18();
        sharesOut=Math.mulDiv(netUsd18,1e18,price);
        require(sharesOut>0&&sharesOut<=type(uint208).max,"price/seed");
        for(uint256 i;i<assets.length;i++)IERC20(assets[i]).forceApprove(vault,gross[i]);
        sharesOut=IVaultExecV3(vault).seed(receiver,gross,sharesOut);
        for(uint256 i;i<assets.length;i++)IERC20(assets[i]).forceApprove(vault,0);
        // A seed must consume the entire settlement contribution, including any
        // direct-USDC constituent. Do not silently retain a buyer's settlement.
        require(IERC20(settlementToken).balanceOf(address(this))==settlementBaseline,"seed settlement residue");
        emit IndexSeeded(creator,vault,settlementAmountIn,sharesOut,price);
    }

    function buyIndex(address vault,uint256 settlementAmountIn,BuyLeg[] calldata legs,uint256 minSharesOut,address receiver,uint256 deadline) external nonReentrant returns(uint256 sharesOut){
        require(block.timestamp<=deadline&&receiver!=address(0)&&settlementAmountIn>0,"input/deadline");
        require(IFactoryExecV3(factory).isVault(vault)&&IVaultExecV3(vault).seeded()&&!IVaultExecV3(vault).closed(),"vault");
        address safety=IFactoryExecV3(factory).safetyController();
        require(!ISafetyExecV3(safety).depositsPaused(vault)&&!ISafetyExecV3(safety).tradingPaused(vault),"paused");
        address[] memory assets=IVaultExecV3(vault).assets();
        uint16[] memory weights=IVaultExecV3(vault).weights();
        require(legs.length==assets.length&&weights.length==assets.length,"legs");
        // Snapshot before collecting the buyer's USDC. Otherwise an index
        // containing USDC can strand the unaccepted part of that USDC leg.
        uint256 settlementBaseline=IERC20(settlementToken).balanceOf(address(this));
        _pullExactSettlement(msg.sender,settlementAmountIn);
        uint256[] memory gross=new uint256[](assets.length);
        uint256[] memory beforeAsset=new uint256[](assets.length);
        uint256 allocated;
        uint256 maxTransferLossBps;
        for(uint256 i;i<assets.length;i++){
            beforeAsset[i]=IERC20(assets[i]).balanceOf(address(this));
            uint256 expected=i+1==assets.length?settlementAmountIn-allocated:Math.mulDiv(settlementAmountIn,weights[i],BPS);
            require(legs[i].amountIn==expected&&expected>0,"weight");
            allocated+=expected;
            gross[i]=_buy(assets[i],legs[i]);
            uint256 rbps=IVaultExecV3(vault).expectedReceiveBps(assets[i]);
            if(rbps<BPS)maxTransferLossBps=Math.max(maxTransferLossBps,BPS-rbps);
            IERC20(assets[i]).forceApprove(vault,gross[i]);
        }
        sharesOut=IVaultExecV3(vault).deposit(gross,receiver,minSharesOut,deadline);
        uint256 allowedRefundBps=Math.min(uint256(2_500),MAX_BUY_REFUND_BPS+maxTransferLossBps+10);
        for(uint256 i;i<assets.length;i++){
            IERC20(assets[i]).forceApprove(vault,0);
            uint256 bal=IERC20(assets[i]).balanceOf(address(this));
            // Settlement refunds are handled against the pre-pull baseline.
            uint256 refund=assets[i]==settlementToken?0:bal>beforeAsset[i]?bal-beforeAsset[i]:0;
            require(refund<=Math.mulDiv(gross[i],allowedRefundBps,BPS,Math.Rounding.Ceil),"imbalanced buy");
            if(refund>0)_pushMeasured(assets[i],msg.sender,refund);
        }
        uint256 settlementBalance=IERC20(settlementToken).balanceOf(address(this));
        require(settlementBalance>=settlementBaseline,"settlement deficit");
        uint256 settlementRefund=settlementBalance-settlementBaseline;
        require(settlementRefund<=Math.mulDiv(settlementAmountIn,allowedRefundBps,BPS,Math.Rounding.Ceil),"imbalanced settlement");
        if(settlementRefund>0){
            IERC20(settlementToken).safeTransfer(msg.sender,settlementRefund);
            require(IERC20(settlementToken).balanceOf(address(this))==settlementBaseline,"settlement refund");
        }
        emit IndexBought(msg.sender,vault,settlementAmountIn,sharesOut);
    }

    function sellIndex(address vault,uint256 sharesIn,BuyLeg[] calldata sellLegs,uint256 minSettlementOut,address receiver,uint256 deadline) external nonReentrant returns(uint256 settlementOut){
        require(block.timestamp<=deadline&&receiver!=address(0)&&sharesIn>0&&minSettlementOut>0,"input/deadline");
        require(IFactoryExecV3(factory).isVault(vault)&&IVaultExecV3(vault).seeded(),"vault");
        address safety=IFactoryExecV3(factory).safetyController();
        require(!ISafetyExecV3(safety).tradingPaused(vault),"trading paused");
        address[] memory assets=IVaultExecV3(vault).assets();
        require(sellLegs.length==assets.length,"legs");
        uint256 settlementBaseline=IERC20(settlementToken).balanceOf(address(this));
        uint256[] memory mins=new uint256[](assets.length);
        uint256[] memory amounts=IVaultExecV3(vault).redeemFromRouter(msg.sender,sharesIn,address(this),mins,deadline);
        for(uint256 i;i<assets.length;i++){
            uint256 routerAmount=amounts[i];
            // A very small redemption may contain zero units of some assets.
            // Never attempt to trade such a leg, but demand an empty route.
            if(routerAmount==0){
                require(sellLegs[i].amountIn==0&&sellLegs[i].adapter==address(0)&&sellLegs[i].minAmountOut==0&&sellLegs[i].quotedAmountOut==0&&sellLegs[i].routeData.length==0,"empty leg");
                continue;
            }
            require(sellLegs[i].amountIn==0||sellLegs[i].amountIn==routerAmount,"amount"); // zero means use measured receipt
            if(assets[i]==settlementToken){
                require(sellLegs[i].adapter==address(0)&&sellLegs[i].routeData.length==0&&sellLegs[i].quotedAmountOut==routerAmount&&sellLegs[i].minAmountOut<=routerAmount,"direct");
                continue;
            }
            require(approvedAdapter[sellLegs[i].adapter],"adapter");
            _validateSlippage(sellLegs[i].quotedAmountOut,sellLegs[i].minAmountOut);
            uint256 adapterAmount=_pushMeasured(assets[i],sellLegs[i].adapter,routerAmount);
            uint256 outBefore=IERC20(settlementToken).balanceOf(address(this));
            uint256 reported=ISwapAdapterV3(sellLegs[i].adapter).swapExactInput(assets[i],settlementToken,adapterAmount,sellLegs[i].minAmountOut,address(this),sellLegs[i].routeData);
            uint256 actual=IERC20(settlementToken).balanceOf(address(this))-outBefore;
            require(actual==reported&&actual>=sellLegs[i].minAmountOut,"swap");
        }
        settlementOut=IERC20(settlementToken).balanceOf(address(this))-settlementBaseline;
        require(settlementOut>=minSettlementOut,"min settlement");
        IERC20(settlementToken).safeTransfer(receiver,settlementOut);
        require(IERC20(settlementToken).balanceOf(address(this))==settlementBaseline,"settlement residue");
        emit IndexSold(msg.sender,vault,sharesIn,settlementOut);
    }

    function executeRebalance(address vault,uint256 proposalId,address[] calldata targetAssets,uint16[] calldata targetWeights,RebalanceLeg[] calldata trades,uint256 deadline) external nonReentrant {
        require(block.timestamp<=deadline&&IFactoryExecV3(factory).isVault(vault),"deadline/vault");
        address safety=IFactoryExecV3(factory).safetyController();
        require(!ISafetyExecV3(safety).tradingPaused(vault),"trading paused");
        bytes32 executionHash=keccak256(abi.encode(trades));
        address gov=IVaultExecV3(vault).governor();
        require(IGovernorExecV3(gov).executable(proposalId,executionHash),"proposal/plan");
        for(uint256 i;i<trades.length;i++){
            RebalanceLeg calldata t=trades[i];
            bool targetOk;
            for(uint256 j;j<targetAssets.length;j++)if(t.tokenOut==targetAssets[j]){targetOk=true;break;}
            require(targetOk&&t.tokenIn!=t.tokenOut&&t.amountIn>0&&approvedAdapter[t.adapter],"trade");
            _validateSlippage(t.quotedAmountOut,t.minAmountOut);
            uint256 adapterAmount=IVaultExecV3(vault).transferForRebalance(t.tokenIn,t.adapter,t.amountIn);
            uint256 beforeOut=IERC20(t.tokenOut).balanceOf(vault);
            uint256 reported=ISwapAdapterV3(t.adapter).swapExactInput(t.tokenIn,t.tokenOut,adapterAmount,t.minAmountOut,vault,t.routeData);
            uint256 actual=IERC20(t.tokenOut).balanceOf(vault)-beforeOut;
            require(actual==reported&&actual>=t.minAmountOut,"swap");
        }
        IGovernorExecV3(gov).execute(proposalId,targetAssets,targetWeights,executionHash);
        emit RebalanceExecuted(vault,proposalId,executionHash);
    }

    function _buy(address asset,BuyLeg calldata leg) internal returns(uint256 out){
        if(asset==settlementToken){require(leg.adapter==address(0)&&leg.routeData.length==0&&leg.quotedAmountOut==leg.amountIn&&leg.minAmountOut<=leg.amountIn,"direct");return leg.amountIn;}
        require(approvedAdapter[leg.adapter],"adapter");
        _validateSlippage(leg.quotedAmountOut,leg.minAmountOut);
        uint256 beforeBal=IERC20(asset).balanceOf(address(this));
        uint256 adapterAmount=_pushMeasured(settlementToken,leg.adapter,leg.amountIn);
        require(adapterAmount==leg.amountIn,"settlement transfer");
        uint256 reported=ISwapAdapterV3(leg.adapter).swapExactInput(settlementToken,asset,adapterAmount,leg.minAmountOut,address(this),leg.routeData);
        out=IERC20(asset).balanceOf(address(this))-beforeBal;
        require(out==reported&&out>=leg.minAmountOut,"swap");
    }

    function _validateSlippage(uint256 quote,uint256 minOut) internal pure {
        require(quote>0&&minOut>0&&minOut<=quote,"slippage");
        require(minOut>=Math.mulDiv(quote,BPS-MAX_SLIPPAGE_BPS,BPS),"slippage");
    }

    function _pullExactSettlement(address from,uint256 amount) internal {
        uint256 b=IERC20(settlementToken).balanceOf(address(this));
        IERC20(settlementToken).safeTransferFrom(from,address(this),amount);
        require(IERC20(settlementToken).balanceOf(address(this))-b==amount,"settlement nonstandard");
    }

    function _pushMeasured(address token,address to,uint256 amount) internal returns(uint256 received){
        uint256 senderBefore=IERC20(token).balanceOf(address(this));
        uint256 b=IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to,amount);
        uint256 senderAfter=IERC20(token).balanceOf(address(this));
        require(senderBefore>=senderAfter&&senderBefore-senderAfter==amount,"sender debit");
        received=IERC20(token).balanceOf(to)-b;
        require(received>0&&received<=amount,"received");
        uint256 bps=ITransferPolicyExecV3(IFactoryExecV3(factory).transferPolicy()).expectedReceiveBps(token);
        uint256 floorAmount=Math.mulDiv(amount,bps,BPS);
        if(floorAmount>0)floorAmount-=1;
        require(received>=floorAmount,"transfer exceeds policy");
        if(received!=amount)emit TransferAdjusted(token,to,amount,received);
    }
}
