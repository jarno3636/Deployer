// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Router-bound adapter. Trust is granted to an exact target/spender/function-selector tuple,
/// not to arbitrary calldata on independently approved contracts.
contract IndexioRestrictedSwapAdapterV25 is Ownable2Step,ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_ROUTE_DATA_BYTES=16_384;
    uint256 public constant ALLOWLIST_DELAY=6 hours;
    address public immutable callerRouter;
    bool public bootstrapFinalized;

    mapping(bytes32=>bool) public allowedRoute;
    mapping(bytes32=>uint256) public pendingRouteValidAt;

    error OnlyCallerRouter(); error BootstrapClosed(); error BootstrapAlreadyFinalized(); error TooEarly(); error NothingPending();
    error InvalidAddress(); error InvalidRoute(); error InvalidAmount(); error RouteNotAllowed(); error SwapFailed(bytes reason);
    error InputNotConsumed(); error Slippage();

    event RouteSet(address indexed target,address indexed spender,bytes4 indexed selector,bool allowed);
    event RouteProposed(address indexed target,address indexed spender,bytes4 indexed selector,uint256 validAt);
    event BootstrapFinalized(address indexed owner);
    event SwapExecuted(address indexed tokenIn,address indexed tokenOut,address indexed recipient,uint256 amountIn,uint256 amountOut,address target,address spender,bytes4 selector);

    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);
    constructor(address owner_,address callerRouter_) Ownable(owner_){
        if(owner_==address(0)||callerRouter_==address(0)||callerRouter_.code.length==0)revert InvalidAddress();
        callerRouter=callerRouter_;
    }
    modifier onlyCaller(){if(msg.sender!=callerRouter)revert OnlyCallerRouter();_;}

    function routeKey(address target,address spender,bytes4 selector) public pure returns(bytes32){return keccak256(abi.encode(target,spender,selector));}

    function setRoute(address target,address spender,bytes4 selector,bool allowed) external onlyOwner {
        if(bootstrapFinalized&&allowed)revert BootstrapClosed();
        _setRoute(target,spender,selector,allowed);
    }
    function proposeRoute(address target,address spender,bytes4 selector) external onlyOwner {
        if(!bootstrapFinalized)revert BootstrapClosed();
        _validateRouteIdentity(target,spender,selector);
        bytes32 key=routeKey(target,spender,selector);
        uint256 t=block.timestamp+ALLOWLIST_DELAY;pendingRouteValidAt[key]=t;
        emit RouteProposed(target,spender,selector,t);
    }
    function activateRoute(address target,address spender,bytes4 selector) external onlyOwner {
        bytes32 key=routeKey(target,spender,selector);uint256 t=pendingRouteValidAt[key];
        if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();
        delete pendingRouteValidAt[key];_setRoute(target,spender,selector,true);
    }
    function finalizeBootstrap() external onlyOwner {if(bootstrapFinalized)revert BootstrapAlreadyFinalized();bootstrapFinalized=true;emit BootstrapFinalized(msg.sender);}

    function _validateRouteIdentity(address target,address spender,bytes4 selector) internal view {
        if(target==address(0)||spender==address(0)||target.code.length==0||spender.code.length==0||selector==bytes4(0))revert InvalidAddress();
    }
    function _setRoute(address target,address spender,bytes4 selector,bool allowed) internal {
        if(allowed)_validateRouteIdentity(target,spender,selector);
        else if(target==address(0)||spender==address(0)||selector==bytes4(0))revert InvalidAddress();
        bytes32 key=routeKey(target,spender,selector);allowedRoute[key]=allowed;if(!allowed)delete pendingRouteValidAt[key];
        emit RouteSet(target,spender,selector,allowed);
    }

    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,address recipient,bytes calldata routeData) external onlyCaller nonReentrant returns(uint256 amountOut){
        if(tokenIn==address(0)||tokenOut==address(0)||recipient==address(0)||tokenIn==tokenOut||amountIn==0||minOut==0)revert InvalidAmount();
        if(routeData.length==0||routeData.length>MAX_ROUTE_DATA_BYTES)revert InvalidRoute();
        (address target,address spender,bytes memory callData)=abi.decode(routeData,(address,address,bytes));
        if(callData.length<4||target.code.length==0||spender.code.length==0)revert InvalidRoute();
        bytes4 selector;assembly { selector := mload(add(callData,32)) }
        if(!allowedRoute[routeKey(target,spender,selector)])revert RouteNotAllowed();

        uint256 inBefore=IERC20(tokenIn).balanceOf(address(this));if(inBefore<amountIn)revert InvalidAmount();
        uint256 outBefore=IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).forceApprove(spender,amountIn);
        (bool ok,bytes memory reason)=target.call(callData);
        IERC20(tokenIn).forceApprove(spender,0);
        if(!ok)revert SwapFailed(reason);
        uint256 inAfter=IERC20(tokenIn).balanceOf(address(this));if(inAfter+amountIn!=inBefore)revert InputNotConsumed();
        amountOut=IERC20(tokenOut).balanceOf(recipient)-outBefore;if(amountOut<minOut)revert Slippage();
        emit SwapExecuted(tokenIn,tokenOut,recipient,amountIn,amountOut,target,spender,selector);
    }

    /// @notice Recover an ERC-20 accidentally sent outside an active atomic operation. Recipient is fixed to owner/Safe.
    function recoverAccidentalToken(address token,uint256 amount) external onlyOwner nonReentrant {
        if(token==address(0)||amount==0)revert InvalidAmount();
        address recipient=owner();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }
}
