// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IIndexioSwapAdapter {
    /// @notice Swaps an exact amount of tokenIn for tokenOut and sends tokenOut to recipient.
    /// @dev Caller must transfer tokenIn to the adapter before calling. Implementations must consume exactly amountIn.
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata routeData
    ) external returns (uint256 amountOut);
}
