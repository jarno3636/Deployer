// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Permissionless route selection over ONE immutable, reviewed Uniswap-V2-compatible router.
/// @dev Route data is abi.encode(address[] path, uint256 deadline). Never executes arbitrary quote calldata.
///      The router must implement swapExactTokensForTokensSupportingFeeOnTransferTokens.
///      CallerRouter must independently enforce vault eligibility, tax limits, and minimum net output.
contract IndexioFixedV2SwapAdapterV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable callerRouter;
    address public immutable dexRouter;
    uint256 public constant MAX_HOPS = 4;
    uint256 public constant MAX_ROUTE_DATA_BYTES = 320;
    error Unauthorized(); error InvalidRoute(); error InvalidAmount(); error Slippage(); error InputNotConsumed();
    event SwapExecuted(address indexed tokenIn,address indexed tokenOut,address indexed recipient,uint256 amountIn,uint256 amountOut);
    constructor(address callerRouter_,address dexRouter_) {
        require(block.chainid == 8453,"Base only");
        require(callerRouter_.code.length != 0 && dexRouter_.code.length != 0,"missing code");
        callerRouter=callerRouter_;dexRouter=dexRouter_;
    }
    function inspectPath(address tokenIn,address tokenOut,address[] calldata path,uint256 deadline) external view returns(bool) {
        return _valid(tokenIn,tokenOut,path,deadline);
    }
    function _valid(address tokenIn,address tokenOut,address[] memory path,uint256 deadline) internal view returns(bool){
        if(deadline<block.timestamp||deadline>block.timestamp+30 minutes||path.length<2||path.length>MAX_HOPS||tokenIn==tokenOut||tokenIn==address(0)||tokenOut==address(0))return false;
        if(path[0]!=tokenIn||path[path.length-1]!=tokenOut)return false;
        for(uint256 i=0;i<path.length;i++){
            if(path[i]==address(0)||path[i].code.length==0)return false;
            for(uint256 j=0;j<i;j++)if(path[j]==path[i])return false;
        }
        return true;
    }
    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,address recipient,bytes calldata routeData) external nonReentrant returns(uint256 amountOut){
        if(msg.sender!=callerRouter)revert Unauthorized();
        if(amountIn==0||minOut==0||recipient==address(0)||recipient==address(this)||recipient==tokenIn||recipient==tokenOut||recipient==dexRouter)revert InvalidAmount();
        if(routeData.length==0||routeData.length>MAX_ROUTE_DATA_BYTES)revert InvalidRoute();
        (address[] memory path,uint256 deadline)=abi.decode(routeData,(address[],uint256));
        if(!_valid(tokenIn,tokenOut,path,deadline))revert InvalidRoute();
        uint256 inBefore=IERC20(tokenIn).balanceOf(address(this));
        if(inBefore<amountIn)revert InvalidAmount();
        uint256 outBefore=IERC20(tokenOut).balanceOf(recipient);
        uint256 adapterOutBefore=IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(dexRouter,amountIn);
        IV2SupportingFeeRouter(dexRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn,minOut,path,recipient,deadline);
        IERC20(tokenIn).forceApprove(dexRouter,0);
        uint256 inAfter=IERC20(tokenIn).balanceOf(address(this));
        if(inAfter>inBefore||inBefore-inAfter!=amountIn)revert InputNotConsumed();
        if(IERC20(tokenOut).balanceOf(address(this))!=adapterOutBefore)revert InvalidRoute();
        uint256 outAfter=IERC20(tokenOut).balanceOf(recipient);
        if(outAfter<outBefore)revert Slippage();
        amountOut=outAfter-outBefore;
        if(amountOut<minOut)revert Slippage();
        emit SwapExecuted(tokenIn,tokenOut,recipient,amountIn,amountOut);
    }
}
interface IV2SupportingFeeRouter {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external;
}
