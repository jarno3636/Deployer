// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice V3.2 LI.FI adapter with deterministic infrastructure trust.
/// @dev The LI.FI Diamond is immutable. Arbitrary targets/spenders are impossible; the router still
///      enforces Indexio slippage and this adapter enforces exact input consumption + recipient output.
contract IndexioLifiSwapAdapterV3 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_ROUTE_DATA_BYTES = 16_384;
    address public immutable callerRouter;
    address public immutable lifiDiamond;

    error OnlyCallerRouter(); error InvalidAddress(); error InvalidRoute(); error InvalidAmount();
    error UntrustedLifiInfrastructure(); error SwapFailed(bytes reason); error InputNotConsumed(); error Slippage();

    event SwapExecuted(address indexed tokenIn,address indexed tokenOut,address indexed recipient,uint256 amountIn,uint256 amountOut,bytes4 selector);
    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);

    constructor(address owner_, address callerRouter_, address lifiDiamond_) Ownable(owner_) {
        if(owner_==address(0)||callerRouter_==address(0)||lifiDiamond_==address(0)||callerRouter_.code.length==0||lifiDiamond_.code.length==0) revert InvalidAddress();
        callerRouter=callerRouter_;
        lifiDiamond=lifiDiamond_;
    }
    modifier onlyCaller(){if(msg.sender!=callerRouter)revert OnlyCallerRouter();_;}

    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,address recipient,bytes calldata routeData) external onlyCaller nonReentrant returns(uint256 amountOut){
        if(tokenIn==address(0)||tokenOut==address(0)||recipient==address(0)||tokenIn==tokenOut||amountIn==0||minOut==0)revert InvalidAmount();
        if(routeData.length==0||routeData.length>MAX_ROUTE_DATA_BYTES)revert InvalidRoute();
        (address target,address spender,bytes memory callData)=abi.decode(routeData,(address,address,bytes));
        if(callData.length<4)revert InvalidRoute();
        if(target!=lifiDiamond||spender!=lifiDiamond)revert UntrustedLifiInfrastructure();
        bytes4 selector; assembly { selector := mload(add(callData,32)) }
        if(selector==bytes4(0))revert InvalidRoute();

        uint256 inBefore=IERC20(tokenIn).balanceOf(address(this));
        if(inBefore<amountIn)revert InvalidAmount();
        uint256 outBefore=IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).forceApprove(lifiDiamond,amountIn);
        (bool ok,bytes memory reason)=lifiDiamond.call(callData);
        IERC20(tokenIn).forceApprove(lifiDiamond,0);
        if(!ok)revert SwapFailed(reason);
        uint256 inAfter=IERC20(tokenIn).balanceOf(address(this));
        if(inAfter+amountIn!=inBefore)revert InputNotConsumed();
        amountOut=IERC20(tokenOut).balanceOf(recipient)-outBefore;
        if(amountOut<minOut)revert Slippage();
        emit SwapExecuted(tokenIn,tokenOut,recipient,amountIn,amountOut,selector);
    }

    function recoverAccidentalToken(address token,uint256 amount) external onlyOwner nonReentrant {
        if(token==address(0)||amount==0)revert InvalidAmount();
        address recipient=owner();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }
}
