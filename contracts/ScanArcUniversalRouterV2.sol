// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ScanArcUniversal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IPermit2ScanArc {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouterScanArc {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title ScanArcUniversalRouterV2
/// @notice Arc-wide Uniswap v4 execution adapter for ERC-20 <-> Arc USDC swaps.
/// @dev This contract never accepts an arbitrary target. It can only execute the fixed V4_SWAP command
///      against the owner-configured official Uniswap Universal Router. ScanArc's Arcfun Router V5 remains the
///      preferred path for Arcfun bonding-curve lifecycle trades; this adapter expands coverage to other
///      Arc tokens with Uniswap v4 liquidity.
contract ScanArcUniversalRouterV2 {
    uint256 public constant FEE_BPS = 25; // 0.25%
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_HOPS = 4;

    // Uniswap Universal Router / V4 action bytes.
    bytes1 private constant CMD_V4_SWAP = 0x10;
    bytes1 private constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    bytes1 private constant ACTION_SWAP_EXACT_IN = 0x07;
    bytes1 private constant ACTION_SETTLE_ALL = 0x0c;
    bytes1 private constant ACTION_TAKE_ALL = 0x0f;

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    address public immutable usdc;
    address public universalRouter;
    address public immutable permit2;
    address public immutable feeRecipient;

    address public owner;
    address public pendingOwner;
    uint256 private unlocked = 1;

    mapping(address token => bool blocked) public blockedToken;

    event UniversalSwap(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 scanArcFeeUsdc,
        uint256 amountOut,
        uint256 inputRefunded,
        uint8 hops
    );
    event TokenBlockStatusChanged(address indexed token, bool blocked);
    event UniversalRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ReentrantCall();
    error InvalidAddress();
    error InvalidRoute();
    error UnsupportedPair();
    error TokenBlocked();
    error ZeroAmount();
    error AmountTooLarge();
    error TransferFailed();
    error SlippageExceeded();
    error DeadlineExpired();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert ReentrantCall();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(
        address usdc_,
        address universalRouter_,
        address permit2_,
        address feeRecipient_,
        address owner_
    ) {
        if (
            usdc_ == address(0) || universalRouter_ == address(0) || permit2_ == address(0)
                || feeRecipient_ == address(0) || owner_ == address(0)
        ) revert InvalidAddress();
        if (usdc_.code.length == 0 || universalRouter_.code.length == 0 || permit2_.code.length == 0) {
            revert InvalidAddress();
        }
        usdc = usdc_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        feeRecipient = feeRecipient_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Update the approved Uniswap Universal Router without redeploying ScanArc.
    /// @dev Existing per-swap Permit2 allowances are cleared at the end of every successful swap.
    function setUniversalRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0) || newRouter.code.length == 0) revert InvalidAddress();
        address previousRouter = universalRouter;
        universalRouter = newRouter;
        emit UniversalRouterUpdated(previousRouter, newRouter);
    }

    /// @notice Execute one exact-input Uniswap v4 pool swap. One side must be Arc USDC.
    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline,
        PoolKey calldata poolKey,
        bytes calldata hookData
    ) external nonReentrant returns (uint256 amountOut, uint256 inputRefunded) {
        _validateBase(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline);
        if (!_poolMatches(poolKey, tokenIn, tokenOut)) revert InvalidRoute();

        bool zeroForOne = tokenIn == poolKey.currency0;
        (uint256 routedIn, uint256 upfrontFee) = _collectAndPrepareInput(tokenIn, amountIn);
        uint256 routerMinimum = tokenOut == usdc ? _grossForNetMinimum(minAmountOut) : minAmountOut;
        if (routedIn > type(uint128).max || routerMinimum > type(uint128).max) revert AmountTooLarge();

        uint256 beforeIn = IERC20ScanArcUniversal(tokenIn).balanceOf(address(this)) - routedIn;
        uint256 beforeOut = IERC20ScanArcUniversal(tokenOut).balanceOf(address(this));

        _approveUniversal(tokenIn, routedIn, deadline);

        bytes memory actions = abi.encodePacked(
            ACTION_SWAP_EXACT_IN_SINGLE,
            ACTION_SETTLE_ALL,
            ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: poolKey,
                zeroForOne: zeroForOne,
                amountIn: uint128(routedIn),
                amountOutMinimum: uint128(routerMinimum),
                minHopPriceX36: 0,
                hookData: hookData
            })
        );
        params[1] = abi.encode(tokenIn, routedIn);
        params[2] = abi.encode(tokenOut, routerMinimum);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouterScanArc(universalRouter).execute(abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
        _clearUniversalApproval(tokenIn);

        (amountOut, inputRefunded) = _settleResult(
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOut,
            recipient,
            beforeIn,
            beforeOut,
            upfrontFee,
            1
        );
    }

    /// @notice Execute a multi-hop exact-input Uniswap v4 route. One side must be Arc USDC.
    /// @dev path[i].intermediateCurrency is the output currency of hop i. The last item must equal tokenOut.
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline,
        PathKey[] calldata path
    ) external nonReentrant returns (uint256 amountOut, uint256 inputRefunded) {
        _validateBase(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline);
        uint256 hops = path.length;
        if (hops == 0 || hops > MAX_HOPS || path[hops - 1].intermediateCurrency != tokenOut) revert InvalidRoute();

        address currency = tokenIn;
        for (uint256 i; i < hops; ++i) {
            address next = path[i].intermediateCurrency;
            if (next == address(0) || next == currency || blockedToken[next]) revert InvalidRoute();
            currency = next;
        }

        (uint256 routedIn, uint256 upfrontFee) = _collectAndPrepareInput(tokenIn, amountIn);
        uint256 routerMinimum = tokenOut == usdc ? _grossForNetMinimum(minAmountOut) : minAmountOut;
        if (routedIn > type(uint128).max || routerMinimum > type(uint128).max) revert AmountTooLarge();

        uint256 beforeIn = IERC20ScanArcUniversal(tokenIn).balanceOf(address(this)) - routedIn;
        uint256 beforeOut = IERC20ScanArcUniversal(tokenOut).balanceOf(address(this));

        _approveUniversal(tokenIn, routedIn, deadline);

        PathKey[] memory route = new PathKey[](hops);
        for (uint256 i; i < hops; ++i) route[i] = path[i];
        uint256[] memory minHopPriceX36 = new uint256[](0);
        ExactInputParams memory swapParams = ExactInputParams({
            currencyIn: tokenIn,
            path: route,
            minHopPriceX36: minHopPriceX36,
            amountIn: uint128(routedIn),
            amountOutMinimum: uint128(routerMinimum)
        });

        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(swapParams);
        params[1] = abi.encode(tokenIn, routedIn);
        params[2] = abi.encode(tokenOut, routerMinimum);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouterScanArc(universalRouter).execute(abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
        _clearUniversalApproval(tokenIn);

        (amountOut, inputRefunded) = _settleResult(
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOut,
            recipient,
            beforeIn,
            beforeOut,
            upfrontFee,
            uint8(hops)
        );
    }

    function setTokenBlocked(address token, bool blocked) external onlyOwner {
        if (token == address(0) || token == usdc) revert InvalidAddress();
        blockedToken[token] = blocked;
        emit TokenBlockStatusChanged(token, blocked);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function rescue(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
    }

    function _validateBase(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) private view {
        if (block.timestamp > deadline || deadline > type(uint48).max) revert DeadlineExpired();
        if (tokenIn == address(0) || tokenOut == address(0) || recipient == address(0) || tokenIn == tokenOut) revert InvalidAddress();
        if (amountIn == 0 || minAmountOut == 0) revert ZeroAmount();
        if (tokenIn != usdc && tokenOut != usdc) revert UnsupportedPair();
        if (blockedToken[tokenIn] || blockedToken[tokenOut]) revert TokenBlocked();
        if (tokenIn.code.length == 0 || tokenOut.code.length == 0) revert InvalidAddress();
    }

    function _poolMatches(PoolKey calldata key, address tokenIn, address tokenOut) private pure returns (bool) {
        if (key.currency0 == address(0) || key.currency1 == address(0) || key.currency0 >= key.currency1) return false;
        return (tokenIn == key.currency0 && tokenOut == key.currency1)
            || (tokenIn == key.currency1 && tokenOut == key.currency0);
    }

    function _collectAndPrepareInput(address tokenIn, uint256 amountIn) private returns (uint256 routedIn, uint256 upfrontFee) {
        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        if (tokenIn == usdc) {
            upfrontFee = (amountIn * FEE_BPS) / BPS;
            routedIn = amountIn - upfrontFee;
            if (upfrontFee != 0) _safeTransfer(usdc, feeRecipient, upfrontFee);
        } else {
            routedIn = amountIn;
        }
    }

    function _settleResult(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 beforeIn,
        uint256 beforeOut,
        uint256 upfrontFee,
        uint8 hops
    ) private returns (uint256 netOut, uint256 inputRefunded) {
        uint256 finalOut = IERC20ScanArcUniversal(tokenOut).balanceOf(address(this));
        if (finalOut < beforeOut) revert SlippageExceeded();
        uint256 grossOut = finalOut - beforeOut;

        uint256 fee = upfrontFee;
        if (tokenOut == usdc) {
            fee = (grossOut * FEE_BPS) / BPS;
            netOut = grossOut - fee;
            if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        } else {
            netOut = grossOut;
        }
        if (netOut < minAmountOut) revert SlippageExceeded();
        _safeTransfer(tokenOut, recipient, netOut);

        uint256 finalIn = IERC20ScanArcUniversal(tokenIn).balanceOf(address(this));
        if (finalIn > beforeIn) {
            inputRefunded = finalIn - beforeIn;
            _safeTransfer(tokenIn, msg.sender, inputRefunded);
        }

        emit UniversalSwap(msg.sender, tokenIn, tokenOut, amountIn, fee, netOut, inputRefunded, hops);
    }

    function _approveUniversal(address token, uint256 amount, uint256 deadline) private {
        if (amount > type(uint160).max) revert AmountTooLarge();
        _forceApprove(token, permit2, amount);
        IPermit2ScanArc(permit2).approve(token, universalRouter, uint160(amount), uint48(deadline));
    }

    function _clearUniversalApproval(address token) private {
        IPermit2ScanArc(permit2).approve(token, universalRouter, 0, 0);
        _forceApprove(token, permit2, 0);
    }

    function _grossForNetMinimum(uint256 minNet) private pure returns (uint256) {
        return (minNet * BPS + (BPS - FEE_BPS - 1)) / (BPS - FEE_BPS);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcUniversal.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcUniversal.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(abi.encodeCall(IERC20ScanArcUniversal.approve, (spender, 0)));
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) revert TransferFailed();
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcUniversal.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
