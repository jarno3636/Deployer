// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice V3 swap adapter dedicated to the 0x Swap API v2 AllowanceHolder flow on Base.
/// @dev For ERC20 swaps, 0x documents AllowanceHolder as both allowance target and transaction entry point.
///      The offchain quote MUST be requested with taker=this adapter and recipient=the recipient supplied by Indexio.
///      Indexio still enforces token pair, exact amountIn, minOut, quote/slippage bounds and transaction deadline.
contract IndexioRestrictedSwapAdapterV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ROUTE_DATA_BYTES = 16_384;
    address public constant ZERO_X_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;
    address public immutable callerRouter;

    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address router) {
        require(block.chainid == 8453, "Base only");
        require(router.code.length > 0, "router");
        require(ZERO_X_ALLOWANCE_HOLDER.code.length > 0, "0x unavailable");
        callerRouter = router;
    }

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata routeData
    ) external nonReentrant returns (uint256 amountOut) {
        require(msg.sender == callerRouter, "router");
        require(
            tokenIn != address(0) && tokenOut != address(0) && recipient != address(0) &&
            tokenIn != tokenOut && amountIn > 0 && minOut > 0,
            "input"
        );
        require(routeData.length >= 4 && routeData.length <= MAX_ROUTE_DATA_BYTES, "0x data");

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        require(inBefore == amountIn, "unexpected input balance");
        uint256 adapterOutBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);

        // Never grant a passive/unlimited approval. 0x receives only this swap's exact input amount.
        IERC20(tokenIn).forceApprove(ZERO_X_ALLOWANCE_HOLDER, amountIn);
        (bool ok, bytes memory ret) = ZERO_X_ALLOWANCE_HOLDER.call(routeData);
        IERC20(tokenIn).forceApprove(ZERO_X_ALLOWANCE_HOLDER, 0);
        if (!ok) {
            if (ret.length > 0) assembly { revert(add(ret, 32), mload(ret)) }
            revert("0x swap failed");
        }

        require(IERC20(tokenIn).balanceOf(address(this)) == 0, "input not consumed");
        require(IERC20(tokenOut).balanceOf(address(this)) == adapterOutBefore, "adapter output residue");
        amountOut = IERC20(tokenOut).balanceOf(recipient) - outBefore;
        require(amountOut >= minOut, "slippage");

        emit SwapExecuted(tokenIn, tokenOut, recipient, amountIn, amountOut);
    }
}
