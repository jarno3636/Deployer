// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIndexioFactoryV25} from "./interfaces/IIndexioFactoryV25.sol";
import {IIndexioVaultV25} from "./interfaces/IIndexioVaultV25.sol";
import {IIndexioSwapAdapterV25} from "./interfaces/IIndexioSwapAdapterV25.sol";

/// @notice Atomic DRIP-style income reinvestment. No strategic USDC constituent is required in V2.5.
contract IndexioReinvestmentRouterV25 is Ownable2Step,ReentrancyGuard,Pausable {
    using SafeERC20 for IERC20;uint256 private constant BPS=10_000;uint256 public constant MAX_SLIPPAGE_BPS=500;
    struct ReinvestLeg{address adapter;uint256 quotedAmountOut;uint256 minAmountOut;bytes routeData;}
    IIndexioFactoryV25 public immutable factory;address public immutable settlementToken;mapping(address=>bool) public operator;mapping(address=>bool) public approvedAdapter; uint256 public constant ADAPTER_DELAY=6 hours; uint256 public constant OPERATOR_DELAY=6 hours; bool public bootstrapFinalized; mapping(address=>uint256) public pendingAdapterValidAt; mapping(address=>uint256) public pendingOperatorValidAt;
    error InvalidAddress();error BootstrapClosed();error BootstrapAlreadyFinalized();error TooEarly();error NothingPending();error InvalidVault();error InvalidAmount();error InvalidLegs();error InvalidAdapter();error UnauthorizedOperator();error Expired();error Slippage();error UnsupportedTokenBehavior();
    event OperatorSet(address indexed account,bool approved);event OperatorProposed(address indexed account,uint256 validAt);event AdapterApproval(address indexed adapter,bool approved);event AdapterProposed(address indexed adapter,uint256 validAt);event BootstrapFinalized(address indexed owner);event IncomeReinvested(address indexed vault,address indexed operator,uint256 grossIncome,uint256 distributed,uint256 reinvested);event ReinvestmentLegExecuted(address indexed vault,address indexed asset,uint256 settlementIn,uint256 assetOut);
    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);
    constructor(address owner_,address factory_,address settlement_) Ownable(owner_){if(owner_==address(0)||factory_==address(0)||settlement_==address(0)||factory_.code.length==0||settlement_.code.length==0)revert InvalidAddress();factory=IIndexioFactoryV25(factory_);settlementToken=settlement_;operator[owner_]=true;emit OperatorSet(owner_,true);}
    modifier onlyOperator(){if(!operator[msg.sender])revert UnauthorizedOperator();_;}
    function setPaused(bool p) external onlyOwner{if(p)_pause();else _unpause();}
    function setOperator(address account,bool approved) external onlyOwner{if(account==address(0))revert InvalidAddress();if(bootstrapFinalized&&approved)revert BootstrapClosed();operator[account]=approved;if(!approved)delete pendingOperatorValidAt[account];emit OperatorSet(account,approved);}
    function proposeOperator(address account) external onlyOwner{if(!bootstrapFinalized)revert BootstrapClosed();if(account==address(0))revert InvalidAddress();uint256 t=block.timestamp+OPERATOR_DELAY;pendingOperatorValidAt[account]=t;emit OperatorProposed(account,t);}
    function activateOperator(address account) external onlyOwner{uint256 t=pendingOperatorValidAt[account];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();delete pendingOperatorValidAt[account];operator[account]=true;emit OperatorSet(account,true);}
    function setAdapter(address adapter,bool approved) external onlyOwner {
        if(bootstrapFinalized&&approved)revert BootstrapClosed();
        _setAdapter(adapter,approved);
    }
    function proposeAdapter(address adapter) external onlyOwner {
        if(!bootstrapFinalized)revert BootstrapClosed();
        if(adapter==address(0)||adapter.code.length==0)revert InvalidAdapter();
        uint256 t=block.timestamp+ADAPTER_DELAY;pendingAdapterValidAt[adapter]=t;emit AdapterProposed(adapter,t);
    }
    function activateAdapter(address adapter) external onlyOwner {
        uint256 t=pendingAdapterValidAt[adapter];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();
        delete pendingAdapterValidAt[adapter];_setAdapter(adapter,true);
    }
    function finalizeBootstrap() external onlyOwner {if(bootstrapFinalized)revert BootstrapAlreadyFinalized();bootstrapFinalized=true;emit BootstrapFinalized(msg.sender);}
    function _setAdapter(address adapter,bool approved) internal {
        if(adapter==address(0)||(approved&&adapter.code.length==0))revert InvalidAdapter();
        approvedAdapter[adapter]=approved;if(!approved)delete pendingAdapterValidAt[adapter];emit AdapterApproval(adapter,approved);
    }
    function previewReinvestment(address vault,uint256 reinvestable) external view returns(address[] memory assetsOut,uint256[] memory settlementAmounts){if(!factory.isIndexVault(vault))revert InvalidVault();IIndexioVaultV25 v=IIndexioVaultV25(vault);address[] memory a=v.assets();uint16[] memory w=v.targetWeightsBps();if(a.length==0||a.length!=w.length)revert InvalidVault();assetsOut=a;settlementAmounts=new uint256[](a.length);uint256 allocated;for(uint256 i;i<a.length;++i){uint256 x=i+1==a.length?reinvestable-allocated:Math.mulDiv(reinvestable,w[i],BPS);settlementAmounts[i]=x;allocated+=x;}}
    function processAndReinvest(address vault,uint256 grossIncome,ReinvestLeg[] calldata legs,uint256 deadline) external onlyOperator nonReentrant whenNotPaused returns(uint256 distributed,uint256 reinvested){
        if(block.timestamp>deadline)revert Expired();if(grossIncome==0||!factory.isIndexVault(vault)||!factory.isReinvestmentRouter(address(this))||!factory.isIncomeSource(vault,address(this)))revert InvalidVault();IIndexioVaultV25 v=IIndexioVaultV25(vault);if(v.settlementToken()!=settlementToken||!v.seeded()||v.closed()||v.reinvestmentPaused())revert InvalidVault();address[] memory assets=v.assets();uint16[] memory weights=v.targetWeightsBps();if(assets.length==0||assets.length!=weights.length||legs.length!=assets.length)revert InvalidLegs();
        uint256 start=IERC20(settlementToken).balanceOf(address(this));IERC20(settlementToken).safeTransferFrom(msg.sender,address(this),grossIncome);if(IERC20(settlementToken).balanceOf(address(this))-start!=grossIncome)revert UnsupportedTokenBehavior();IERC20(settlementToken).forceApprove(vault,grossIncome);(distributed,reinvested)=v.processIncomeForReinvestment(grossIncome);IERC20(settlementToken).forceApprove(vault,0);if(distributed+reinvested!=grossIncome||reinvested==0)revert InvalidAmount();
        uint256 allocated;for(uint256 i;i<assets.length;++i){uint256 amountIn=i+1==assets.length?reinvested-allocated:Math.mulDiv(reinvested,weights[i],BPS);allocated+=amountIn;ReinvestLeg calldata leg=legs[i];if(amountIn==0)revert InvalidAmount();if(assets[i]==settlementToken){if(leg.adapter!=address(0)||leg.quotedAmountOut!=amountIn||leg.minAmountOut>amountIn||leg.routeData.length!=0)revert InvalidLegs();IERC20(settlementToken).safeTransfer(vault,amountIn);emit ReinvestmentLegExecuted(vault,assets[i],amountIn,amountIn);}else{if(!approvedAdapter[leg.adapter]||leg.quotedAmountOut==0||leg.minAmountOut==0)revert InvalidAdapter();if(leg.minAmountOut<(leg.quotedAmountOut*(BPS-MAX_SLIPPAGE_BPS))/BPS||leg.minAmountOut>leg.quotedAmountOut)revert Slippage();uint256 beforeOut=IERC20(assets[i]).balanceOf(vault);IERC20(settlementToken).safeTransfer(leg.adapter,amountIn);uint256 out=IIndexioSwapAdapterV25(leg.adapter).swapExactInput(settlementToken,assets[i],amountIn,leg.minAmountOut,vault,leg.routeData);uint256 got=IERC20(assets[i]).balanceOf(vault)-beforeOut;if(got!=out||got<leg.minAmountOut)revert Slippage();emit ReinvestmentLegExecuted(vault,assets[i],amountIn,out);}}
        if(allocated!=reinvested||IERC20(settlementToken).balanceOf(address(this))!=start)revert UnsupportedTokenBehavior();emit IncomeReinvested(vault,msg.sender,grossIncome,distributed,reinvested);
    }

    /// @notice Recover an ERC-20 accidentally sent outside an active atomic operation. Recipient is fixed to owner/Safe.
    function recoverAccidentalToken(address token,uint256 amount) external onlyOwner nonReentrant {
        if(token==address(0)||amount==0)revert InvalidAmount();if(token==settlementToken)revert InvalidAmount();
        address recipient=owner();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }
}
