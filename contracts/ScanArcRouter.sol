// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ScanArc {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IArcfunCurve {
    function buy(uint256 usdcIn, uint256 minTokensOut) external returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut);
}

/// @notice Fee-aware adapter for registered Arcfun bonding curves on Arc.
/// @dev Deployment and pair registration must wait for an independent security review.
contract ScanArcRouter {
    uint256 public constant FEE_BPS = 25;
    uint256 public constant BPS = 10_000;

    address public immutable usdc;
    address public immutable feeRecipient;
    address public owner;
    address public pendingOwner;
    uint256 private unlocked = 1;

    mapping(address token => mapping(address curve => bool allowed)) public allowedPair;

    event PairStatusChanged(address indexed token, address indexed curve, bool allowed);
    event RoutedBuy(address indexed trader, address indexed token, address indexed curve, uint256 grossUsdc, uint256 feeUsdc, uint256 tokensOut);
    event RoutedSell(address indexed trader, address indexed token, address indexed curve, uint256 tokensIn, uint256 feeUsdc, uint256 netUsdcOut);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    error Unauthorized();
    error ReentrantCall();
    error InvalidAddress();
    error PairNotAllowed();
    error ZeroAmount();
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

    constructor(address usdc_, address feeRecipient_, address owner_) {
        if (usdc_ == address(0) || feeRecipient_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        if (usdc_.code.length == 0) revert InvalidAddress();
        usdc = usdc_;
        feeRecipient = feeRecipient_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPair(address token, address curve, bool allowed) external onlyOwner {
        if (token.code.length == 0 || curve.code.length == 0) revert InvalidAddress();
        allowedPair[token][curve] = allowed;
        emit PairStatusChanged(token, curve, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function buy(
        address token,
        address curve,
        uint256 grossUsdc,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!allowedPair[token][curve]) revert PairNotAllowed();
        if (grossUsdc == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidAddress();

        uint256 fee = (grossUsdc * FEE_BPS) / BPS;
        uint256 routedUsdc = grossUsdc - fee;
        _safeTransferFrom(usdc, msg.sender, address(this), grossUsdc);
        _safeTransfer(usdc, feeRecipient, fee);
        _forceApprove(usdc, curve, routedUsdc);

        uint256 beforeBalance = IERC20ScanArc(token).balanceOf(address(this));
        IArcfunCurve(curve).buy(routedUsdc, minTokensOut);
        _forceApprove(usdc, curve, 0);
        tokensOut = IERC20ScanArc(token).balanceOf(address(this)) - beforeBalance;
        if (tokensOut < minTokensOut) revert SlippageExceeded();
        _safeTransfer(token, recipient, tokensOut);
        emit RoutedBuy(msg.sender, token, curve, grossUsdc, fee, tokensOut);
    }

    function sell(
        address token,
        address curve,
        uint256 tokensIn,
        uint256 minNetUsdcOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 netUsdcOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!allowedPair[token][curve]) revert PairNotAllowed();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidAddress();

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        _forceApprove(token, curve, tokensIn);
        uint256 grossMinimum = (minNetUsdcOut * BPS + (BPS - FEE_BPS - 1)) / (BPS - FEE_BPS);
        uint256 beforeBalance = IERC20ScanArc(usdc).balanceOf(address(this));
        IArcfunCurve(curve).sell(tokensIn, grossMinimum);
        _forceApprove(token, curve, 0);
        uint256 grossUsdcOut = IERC20ScanArc(usdc).balanceOf(address(this)) - beforeBalance;
        uint256 fee = (grossUsdcOut * FEE_BPS) / BPS;
        netUsdcOut = grossUsdcOut - fee;
        if (netUsdcOut < minNetUsdcOut) revert SlippageExceeded();
        _safeTransfer(usdc, feeRecipient, fee);
        _safeTransfer(usdc, recipient, netUsdcOut);
        emit RoutedSell(msg.sender, token, curve, tokensIn, fee, netUsdcOut);
    }

    function rescue(address token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(abi.encodeCall(IERC20ScanArc.approve, (spender, 0)));
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
