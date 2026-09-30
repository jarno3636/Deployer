// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IIndexioSwapAdapterV25 {
    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,bytes calldata routeData) external returns(uint256 amountOut);
}
