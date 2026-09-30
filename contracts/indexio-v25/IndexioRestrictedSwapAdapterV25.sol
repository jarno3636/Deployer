// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
contract IndexioRestrictedSwapAdapterV25 is Ownable2Step,ReentrancyGuard {
    using SafeERC20 for IERC20; uint256 public constant MAX_ROUTE_DATA_BYTES=16_384; uint256 public constant ALLOWLIST_DELAY=6 hours; address public immutable callerRouter; bool public bootstrapFinalized;
    mapping(address=>bool) public allowedTarget; mapping(address=>bool) public allowedSpender; mapping(address=>uint256) public pendingTargetValidAt; mapping(address=>uint256) public pendingSpenderValidAt;
    error OnlyCallerRouter(); error BootstrapClosed(); error BootstrapAlreadyFinalized(); error TooEarly(); error NothingPending(); error InvalidAddress(); error InvalidRoute(); error InvalidAmount(); error TargetNotAllowed(); error SpenderNotAllowed(); error SwapFailed(bytes reason); error InputNotConsumed(); error Slippage();
    event TargetSet(address indexed target,bool allowed);event SpenderSet(address indexed spender,bool allowed);event TargetProposed(address indexed target,uint256 validAt);event SpenderProposed(address indexed spender,uint256 validAt);event BootstrapFinalized(address indexed owner);event SwapExecuted(address indexed tokenIn,address indexed tokenOut,address indexed recipient,uint256 amountIn,uint256 amountOut,address target,address spender);
    constructor(address owner_,address callerRouter_) Ownable(owner_){if(owner_==address(0)||callerRouter_==address(0)||callerRouter_.code.length==0)revert InvalidAddress();callerRouter=callerRouter_;}
    modifier onlyCaller(){if(msg.sender!=callerRouter)revert OnlyCallerRouter();_;}
    function setTarget(address target,bool allowed) external onlyOwner {if(bootstrapFinalized&&allowed)revert BootstrapClosed();_setTarget(target,allowed);}
    function setSpender(address spender,bool allowed) external onlyOwner {if(bootstrapFinalized&&allowed)revert BootstrapClosed();_setSpender(spender,allowed);}
    function proposeTarget(address target) external onlyOwner {if(!bootstrapFinalized)revert BootstrapClosed();if(target==address(0)||target.code.length==0)revert InvalidAddress();uint256 t=block.timestamp+ALLOWLIST_DELAY;pendingTargetValidAt[target]=t;emit TargetProposed(target,t);}
    function activateTarget(address target) external onlyOwner {uint256 t=pendingTargetValidAt[target];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();delete pendingTargetValidAt[target];_setTarget(target,true);}
    function proposeSpender(address spender) external onlyOwner {if(!bootstrapFinalized)revert BootstrapClosed();if(spender==address(0)||spender.code.length==0)revert InvalidAddress();uint256 t=block.timestamp+ALLOWLIST_DELAY;pendingSpenderValidAt[spender]=t;emit SpenderProposed(spender,t);}
    function activateSpender(address spender) external onlyOwner {uint256 t=pendingSpenderValidAt[spender];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();delete pendingSpenderValidAt[spender];_setSpender(spender,true);}
    function finalizeBootstrap() external onlyOwner {if(bootstrapFinalized)revert BootstrapAlreadyFinalized();bootstrapFinalized=true;emit BootstrapFinalized(msg.sender);}
    function _setTarget(address target,bool allowed) internal {if(target==address(0)||(allowed&&target.code.length==0))revert InvalidAddress();allowedTarget[target]=allowed;if(!allowed)delete pendingTargetValidAt[target];emit TargetSet(target,allowed);}
    function _setSpender(address spender,bool allowed) internal {if(spender==address(0)||(allowed&&spender.code.length==0))revert InvalidAddress();allowedSpender[spender]=allowed;if(!allowed)delete pendingSpenderValidAt[spender];emit SpenderSet(spender,allowed);}
    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,address recipient,bytes calldata routeData) external onlyCaller nonReentrant returns(uint256 amountOut){
        if(tokenIn==address(0)||tokenOut==address(0)||recipient==address(0)||tokenIn==tokenOut||amountIn==0||minOut==0)revert InvalidAmount(); if(routeData.length==0||routeData.length>MAX_ROUTE_DATA_BYTES)revert InvalidRoute();
        (address target,address spender,bytes memory callData)=abi.decode(routeData,(address,address,bytes));if(!allowedTarget[target])revert TargetNotAllowed();if(!allowedSpender[spender])revert SpenderNotAllowed();if(target.code.length==0||spender.code.length==0||callData.length<4)revert InvalidRoute();
        uint256 inBefore=IERC20(tokenIn).balanceOf(address(this));if(inBefore<amountIn)revert InvalidAmount();uint256 outBefore=IERC20(tokenOut).balanceOf(recipient);IERC20(tokenIn).forceApprove(spender,amountIn);(bool ok,bytes memory reason)=target.call(callData);IERC20(tokenIn).forceApprove(spender,0);if(!ok)revert SwapFailed(reason);uint256 inAfter=IERC20(tokenIn).balanceOf(address(this));if(inAfter+amountIn!=inBefore)revert InputNotConsumed();amountOut=IERC20(tokenOut).balanceOf(recipient)-outBefore;if(amountOut<minOut)revert Slippage();emit SwapExecuted(tokenIn,tokenOut,recipient,amountIn,amountOut,target,spender);
    }
}
