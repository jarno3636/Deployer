// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20ScanArcBuy {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

/// @notice Adapter contract approved by ScanArc governance. The adapter receives exact input approval,
/// executes one venue/launcher-specific route, and MUST send outputToken to `recipient`.
interface IScanArcBuyAdapter {
    function executeBuy(
        address inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline,
        bytes calldata routeData
    ) external returns (uint256 amountOut);
}

/// @title ScanArcBuyRouterV1
/// @notice Small execution layer for ScanArc's "Find token -> Buy" UX.
/// @dev Route discovery stays off-chain. On-chain execution is restricted to owner-allowlisted adapters.
/// The router never accepts an arbitrary target address. V1 is synchronous; cross-chain CCTP/Gateway
/// adapters that require asynchronous destination settlement should use a later dedicated interface.
contract ScanArcBuyRouterV1 {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 50; // immutable 0.50% safety ceiling

    address public immutable usdc;
    address public feeRecipient;
    address public owner;
    address public pendingOwner;
    uint16 public feeBps = 25; // 0.25% default
    bool public paused;
    uint256 private unlocked = 1;

    mapping(address adapter => bool allowed) public allowedAdapter;
    mapping(address token => bool blocked) public blockedToken;

    event BuyExecuted(
        address indexed buyer,
        address indexed outputToken,
        address indexed adapter,
        address inputToken,
        uint256 grossInput,
        uint256 feePaid,
        uint256 routedInput,
        uint256 amountOut,
        address recipient
    );
    event AdapterStatusChanged(address indexed adapter, bool allowed);
    event TokenBlockStatusChanged(address indexed token, bool blocked);
    event FeeChanged(uint16 previousFeeBps, uint16 newFeeBps);
    event FeeRecipientChanged(address indexed previousRecipient, address indexed newRecipient);
    event PauseChanged(bool paused);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ReentrantCall();
    error Paused();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidFee();
    error AdapterNotAllowed();
    error TokenBlocked();
    error DeadlineExpired();
    error TransferFailed();
    error SlippageExceeded();

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

    constructor(address usdc_, address feeRecipient_, address owner_) {
        if (usdc_ == address(0) || feeRecipient_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        if (usdc_.code.length == 0) revert InvalidAddress();
        usdc = usdc_;
        feeRecipient = feeRecipient_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        emit FeeRecipientChanged(address(0), feeRecipient_);
    }

    /// @notice Universal ScanArc buy entrypoint. UI may label this simply "Buy".
    /// @param inputToken Asset the user pays with. V1 supports any ERC-20 an allowlisted adapter supports.
    /// @param outputToken Token the user wants.
    /// @param amountIn Gross amount pulled from the user before ScanArc fee.
    /// @param minAmountOut Minimum tokens that must reach recipient.
    /// @param recipient Final token recipient; normally the connected wallet.
    /// @param adapter ScanArc-approved venue/launcher adapter selected by the route engine.
    /// @param routeData Venue-specific route payload interpreted only by the allowlisted adapter.
    function buy(
        address inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline,
        address adapter,
        bytes calldata routeData
    ) external nonReentrant returns (uint256 amountOut) {
        if (paused) revert Paused();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (
            inputToken == address(0) || outputToken == address(0) || recipient == address(0) || adapter == address(0)
                || inputToken == outputToken
        ) revert InvalidAddress();
        if (amountIn == 0 || minAmountOut == 0) revert InvalidAmount();
        if (!allowedAdapter[adapter] || adapter.code.length == 0) revert AdapterNotAllowed();
        if (blockedToken[inputToken] || blockedToken[outputToken]) revert TokenBlocked();
        if (inputToken.code.length == 0 || outputToken.code.length == 0) revert InvalidAddress();

        _safeTransferFrom(inputToken, msg.sender, address(this), amountIn);

        uint256 fee = (amountIn * feeBps) / BPS;
        uint256 routedInput = amountIn - fee;
        if (fee != 0) _safeTransfer(inputToken, feeRecipient, fee);

        uint256 beforeOut = IERC20ScanArcBuy(outputToken).balanceOf(recipient);
        _forceApprove(inputToken, adapter, routedInput);
        uint256 reportedOut = IScanArcBuyAdapter(adapter).executeBuy(
            inputToken,
            outputToken,
            routedInput,
            minAmountOut,
            recipient,
            deadline,
            routeData
        );
        _forceApprove(inputToken, adapter, 0);

        uint256 afterOut = IERC20ScanArcBuy(outputToken).balanceOf(recipient);
        if (afterOut < beforeOut) revert SlippageExceeded();
        amountOut = afterOut - beforeOut;
        if (amountOut < minAmountOut || reportedOut < minAmountOut) revert SlippageExceeded();

        // Refund any unspent input returned by the adapter to the router.
        uint256 refund = IERC20ScanArcBuy(inputToken).balanceOf(address(this));
        if (refund != 0) _safeTransfer(inputToken, msg.sender, refund);

        emit BuyExecuted(
            msg.sender,
            outputToken,
            adapter,
            inputToken,
            amountIn,
            fee,
            routedInput,
            amountOut,
            recipient
        );
    }

    function setAdapterAllowed(address adapter, bool allowed) external onlyOwner {
        if (adapter == address(0) || (allowed && adapter.code.length == 0)) revert InvalidAddress();
        allowedAdapter[adapter] = allowed;
        emit AdapterStatusChanged(adapter, allowed);
    }

    function setTokenBlocked(address token, bool blocked) external onlyOwner {
        if (token == address(0) || token == usdc) revert InvalidAddress();
        blockedToken[token] = blocked;
        emit TokenBlockStatusChanged(token, blocked);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        uint16 previous = feeBps;
        feeBps = newFeeBps;
        emit FeeChanged(previous, newFeeBps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert InvalidAddress();
        address previous = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientChanged(previous, newRecipient);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
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

    /// @notice Recover tokens accidentally sent directly to this router. Not usable while a buy is executing.
    function rescue(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
    }

    function quoteFee(uint256 amountIn) external view returns (uint256 fee, uint256 routedInput) {
        fee = (amountIn * feeBps) / BPS;
        routedInput = amountIn - fee;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcBuy.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcBuy.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(abi.encodeCall(IERC20ScanArcBuy.approve, (spender, 0)));
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) revert TransferFailed();
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcBuy.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
