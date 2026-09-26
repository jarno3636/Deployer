// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Restricted calldata adapter for Indexio V2.4.
/// @dev Deploy one instance per authorized caller router (Execution or Rebalance).
///      Targets/spenders can only be granted after a delay; revocation is immediate.
///      The adapter holds no custody between swaps and proves exact input consumption
///      plus minimum output delivery to the router-selected recipient.
contract IndexioRestrictedSwapAdapter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TRUST_DELAY = 1 days;
    uint256 public constant MAX_ROUTE_DATA_BYTES = 16_384;

    address public immutable callerRouter;

    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public allowedSpender;
    mapping(address => uint256) public pendingTargetValidAt;
    mapping(address => uint256) public pendingSpenderValidAt;

    error OnlyCallerRouter();
    error InvalidAddress();
    error InvalidRoute();
    error InvalidAmount();
    error TooEarly();
    error TargetNotAllowed();
    error SpenderNotAllowed();
    error SwapFailed(bytes reason);
    error InputNotConsumed();
    error Slippage();

    event TargetProposed(address indexed target, uint256 validAt);
    event TargetSet(address indexed target, bool allowed);
    event SpenderProposed(address indexed spender, uint256 validAt);
    event SpenderSet(address indexed spender, bool allowed);
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut,
        address target,
        address spender
    );

    constructor(address owner_, address callerRouter_) Ownable(owner_) {
        if (owner_ == address(0) || callerRouter_ == address(0) || callerRouter_.code.length == 0) {
            revert InvalidAddress();
        }
        callerRouter = callerRouter_;
    }

    modifier onlyCaller() {
        if (msg.sender != callerRouter) revert OnlyCallerRouter();
        _;
    }

    function proposeTarget(address target) external onlyOwner {
        if (target == address(0) || target.code.length == 0) revert InvalidAddress();
        uint256 validAt = block.timestamp + TRUST_DELAY;
        pendingTargetValidAt[target] = validAt;
        emit TargetProposed(target, validAt);
    }

    function activateTarget(address target) external onlyOwner {
        uint256 validAt = pendingTargetValidAt[target];
        if (validAt == 0 || block.timestamp < validAt) revert TooEarly();
        allowedTarget[target] = true;
        delete pendingTargetValidAt[target];
        emit TargetSet(target, true);
    }

    function disableTarget(address target) external onlyOwner {
        allowedTarget[target] = false;
        delete pendingTargetValidAt[target];
        emit TargetSet(target, false);
    }

    function proposeSpender(address spender) external onlyOwner {
        if (spender == address(0) || spender.code.length == 0) revert InvalidAddress();
        uint256 validAt = block.timestamp + TRUST_DELAY;
        pendingSpenderValidAt[spender] = validAt;
        emit SpenderProposed(spender, validAt);
    }

    function activateSpender(address spender) external onlyOwner {
        uint256 validAt = pendingSpenderValidAt[spender];
        if (validAt == 0 || block.timestamp < validAt) revert TooEarly();
        allowedSpender[spender] = true;
        delete pendingSpenderValidAt[spender];
        emit SpenderSet(spender, true);
    }

    function disableSpender(address spender) external onlyOwner {
        allowedSpender[spender] = false;
        delete pendingSpenderValidAt[spender];
        emit SpenderSet(spender, false);
    }

    /// @param routeData abi.encode(target, spender, callData)
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata routeData
    ) external onlyCaller nonReentrant returns (uint256 amountOut) {
        if (
            tokenIn == address(0) || tokenOut == address(0) || recipient == address(0) ||
            tokenIn == tokenOut || amountIn == 0 || minOut == 0
        ) revert InvalidAmount();
        if (routeData.length == 0 || routeData.length > MAX_ROUTE_DATA_BYTES) revert InvalidRoute();

        (address target, address spender, bytes memory callData) = abi.decode(routeData, (address, address, bytes));
        if (!allowedTarget[target]) revert TargetNotAllowed();
        if (!allowedSpender[spender]) revert SpenderNotAllowed();
        if (target.code.length == 0 || spender.code.length == 0 || callData.length < 4) revert InvalidRoute();

        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        if (inputBefore < amountIn) revert InvalidAmount();
        uint256 outputBefore = IERC20(tokenOut).balanceOf(recipient);

        IERC20(tokenIn).forceApprove(spender, amountIn);
        (bool ok, bytes memory reason) = target.call(callData);
        IERC20(tokenIn).forceApprove(spender, 0);
        if (!ok) revert SwapFailed(reason);

        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter + amountIn != inputBefore) revert InputNotConsumed();

        uint256 outputAfter = IERC20(tokenOut).balanceOf(recipient);
        amountOut = outputAfter - outputBefore;
        if (amountOut < minOut) revert Slippage();

        emit SwapExecuted(tokenIn, tokenOut, recipient, amountIn, amountOut, target, spender);
    }
}
