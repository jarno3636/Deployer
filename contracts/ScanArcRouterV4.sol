// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ScanArcV4 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IArcfunCurveV4 {
    function buy(uint256 usdcIn, uint256 minTokensOut) external returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut);
}

/// @title ScanArcRouterV4
/// @notice Lifecycle router for canonical Arcfun tokens on Arc mainnet.
/// @dev Pre-graduation trades use the token's bonding curve. Graduated trades are forwarded only
///      to the immutable canonical Arcfun V4 router. User supplied V4 calldata cannot change the
///      external target, approvals are exact and temporary, and output balance deltas are enforced.
contract ScanArcRouterV4 {
    uint256 public constant FEE_BPS = 25; // 0.25% ScanArc routing fee
    uint256 public constant BPS = 10_000;

    address public immutable usdc;
    address public immutable arcfunFactory;
    address public immutable arcfunV4Router;
    address public immutable feeRecipient;

    address public owner;
    address public pendingOwner;
    uint256 private unlocked = 1;

    // Emergency deny-list only. Official pairs are otherwise automatic.
    mapping(address token => mapping(address curve => bool blocked)) public blockedPair;

    event PairBlockStatusChanged(address indexed token, address indexed curve, bool blocked);
    event RoutedCurveBuy(address indexed trader, address indexed token, address indexed curve, uint256 grossUsdc, uint256 scanArcFeeUsdc, uint256 tokensOut);
    event RoutedCurveSell(address indexed trader, address indexed token, address indexed curve, uint256 tokensIn, uint256 scanArcFeeUsdc, uint256 netUsdcOut);
    event RoutedV4Buy(address indexed trader, address indexed token, uint256 grossUsdc, uint256 scanArcFeeUsdc, uint256 tokensOut, uint256 usdcRefunded);
    event RoutedV4Sell(address indexed trader, address indexed token, uint256 tokensIn, uint256 scanArcFeeUsdc, uint256 netUsdcOut, uint256 tokensRefunded);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ReentrantCall();
    error InvalidAddress();
    error InvalidCalldata();
    error PairNotFactoryVerified();
    error PairBlocked();
    error ZeroAmount();
    error TransferFailed();
    error ExternalRouteFailed();
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
        address arcfunFactory_,
        address arcfunV4Router_,
        address feeRecipient_,
        address owner_,
        uint8 pairAuthMode_,
        bytes4 factoryPairSelector_,
        bytes4 curveTokenSelector_
    ) {
        if (
            usdc_ == address(0) || arcfunFactory_ == address(0) || arcfunV4Router_ == address(0)
                || feeRecipient_ == address(0) || owner_ == address(0)
                || pairAuthMode_ < 1 || pairAuthMode_ > 3 || factoryPairSelector_ == bytes4(0)
                || (pairAuthMode_ == 3 && curveTokenSelector_ == bytes4(0))
        ) revert InvalidAddress();
        if (usdc_.code.length == 0 || arcfunFactory_.code.length == 0 || arcfunV4Router_.code.length == 0) {
            revert InvalidAddress();
        }
        usdc = usdc_;
        arcfunFactory = arcfunFactory_;
        arcfunV4Router = arcfunV4Router_;
        feeRecipient = feeRecipient_;
        pairAuthMode = pairAuthMode_;
        factoryPairSelector = factoryPairSelector_;
        curveTokenSelector = curveTokenSelector_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Factory-authentication mode selected only after probing the live verified factory ABI.
    /// 1 = factory(token) -> curve, 2 = factory(curve) -> token, 3 = factory(curve) -> bool + curve() -> token.
    uint8 public immutable pairAuthMode;
    bytes4 public immutable factoryPairSelector;
    bytes4 public immutable curveTokenSelector;

    /// @notice Returns true only when the canonical factory proves this exact token/curve relationship.
    /// @dev V4 does not guess getter names. The deployer discovers and tests the selectors against a known
    ///      official pair using Blockscout's verified ABI before this contract can be deployed.
    function isOfficialPair(address token, address curve) public view returns (bool) {
        if (token == address(0) || curve == address(0) || token.code.length == 0 || curve.code.length == 0) return false;

        if (pairAuthMode == 1) {
            return _returnsAddress(arcfunFactory, factoryPairSelector, token, curve);
        }
        if (pairAuthMode == 2) {
            return _returnsAddress(arcfunFactory, factoryPairSelector, curve, token);
        }
        if (pairAuthMode == 3) {
            (bool ok, bytes memory data) = arcfunFactory.staticcall(abi.encodeWithSelector(factoryPairSelector, curve));
            if (!ok || data.length < 32 || abi.decode(data, (bool)) != true) return false;
            return _returnsAddressNoInput(curve, curveTokenSelector, token);
        }
        return false;
    }

    function routeAvailable(address token, address curve) external view returns (bool) {
        return !blockedPair[token][curve] && isOfficialPair(token, curve);
    }

    /// @notice Emergency/admin deny-list. No per-token enable transaction is required.
    function setPairBlocked(address token, address curve, bool blocked) external onlyOwner {
        if (token == address(0) || curve == address(0)) revert InvalidAddress();
        blockedPair[token][curve] = blocked;
        emit PairBlockStatusChanged(token, curve, blocked);
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

    /// @notice Buy an official Arcfun token while its bonding curve is active.
    function buyCurve(
        address token,
        address curve,
        uint256 grossUsdc,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        _validateTrade(token, curve, grossUsdc, recipient, deadline);

        uint256 fee = (grossUsdc * FEE_BPS) / BPS;
        uint256 routedUsdc = grossUsdc - fee;
        _safeTransferFrom(usdc, msg.sender, address(this), grossUsdc);
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _forceApprove(usdc, curve, routedUsdc);

        uint256 beforeToken = IERC20ScanArcV4(token).balanceOf(address(this));
        IArcfunCurveV4(curve).buy(routedUsdc, minTokensOut);
        _forceApprove(usdc, curve, 0);
        tokensOut = IERC20ScanArcV4(token).balanceOf(address(this)) - beforeToken;
        if (tokensOut < minTokensOut) revert SlippageExceeded();
        _safeTransfer(token, recipient, tokensOut);

        emit RoutedCurveBuy(msg.sender, token, curve, grossUsdc, fee, tokensOut);
    }

    /// @notice Sell an official Arcfun token while its bonding curve is active.
    function sellCurve(
        address token,
        address curve,
        uint256 tokensIn,
        uint256 minNetUsdcOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 netUsdcOut) {
        _validateTrade(token, curve, tokensIn, recipient, deadline);

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        _forceApprove(token, curve, tokensIn);
        uint256 grossMinimum = _grossForNetMinimum(minNetUsdcOut);
        uint256 beforeUsdc = IERC20ScanArcV4(usdc).balanceOf(address(this));
        IArcfunCurveV4(curve).sell(tokensIn, grossMinimum);
        _forceApprove(token, curve, 0);

        uint256 grossUsdcOut = IERC20ScanArcV4(usdc).balanceOf(address(this)) - beforeUsdc;
        uint256 fee = (grossUsdcOut * FEE_BPS) / BPS;
        netUsdcOut = grossUsdcOut - fee;
        if (netUsdcOut < minNetUsdcOut) revert SlippageExceeded();
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _safeTransfer(usdc, recipient, netUsdcOut);

        emit RoutedCurveSell(msg.sender, token, curve, tokensIn, fee, netUsdcOut);
    }

    /// @notice Buy an official graduated Arcfun token through the immutable canonical Arcfun V4 router.
    /// @param routerCallData Exact calldata produced for the canonical Arcfun V4 router.
    /// @dev The V4 call MUST deliver the requested token to this router; otherwise the transaction reverts.
    function buyGraduated(
        address token,
        address curve,
        uint256 grossUsdc,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        bytes calldata routerCallData
    ) external nonReentrant returns (uint256 tokensOut, uint256 usdcRefunded) {
        _validateTrade(token, curve, grossUsdc, recipient, deadline);
        if (routerCallData.length < 4) revert InvalidCalldata();

        uint256 fee = (grossUsdc * FEE_BPS) / BPS;
        uint256 routedUsdc = grossUsdc - fee;
        uint256 initialUsdc = IERC20ScanArcV4(usdc).balanceOf(address(this));
        uint256 initialToken = IERC20ScanArcV4(token).balanceOf(address(this));

        _safeTransferFrom(usdc, msg.sender, address(this), grossUsdc);
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _forceApprove(usdc, arcfunV4Router, routedUsdc);

        (bool ok,) = arcfunV4Router.call(routerCallData);
        _forceApprove(usdc, arcfunV4Router, 0);
        if (!ok) revert ExternalRouteFailed();

        uint256 finalToken = IERC20ScanArcV4(token).balanceOf(address(this));
        if (finalToken < initialToken) revert ExternalRouteFailed();
        tokensOut = finalToken - initialToken;
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        uint256 finalUsdc = IERC20ScanArcV4(usdc).balanceOf(address(this));
        if (finalUsdc > initialUsdc) {
            usdcRefunded = finalUsdc - initialUsdc;
            _safeTransfer(usdc, msg.sender, usdcRefunded);
        }
        _safeTransfer(token, recipient, tokensOut);

        emit RoutedV4Buy(msg.sender, token, grossUsdc, fee, tokensOut, usdcRefunded);
    }

    /// @notice Sell an official graduated Arcfun token through the immutable canonical Arcfun V4 router.
    /// @param routerCallData Exact calldata produced for the canonical Arcfun V4 router.
    /// @dev The V4 call MUST deliver USDC to this router; otherwise the transaction reverts.
    function sellGraduated(
        address token,
        address curve,
        uint256 tokensIn,
        uint256 minNetUsdcOut,
        address recipient,
        uint256 deadline,
        bytes calldata routerCallData
    ) external nonReentrant returns (uint256 netUsdcOut, uint256 tokensRefunded) {
        _validateTrade(token, curve, tokensIn, recipient, deadline);
        if (routerCallData.length < 4) revert InvalidCalldata();

        uint256 initialToken = IERC20ScanArcV4(token).balanceOf(address(this));
        uint256 initialUsdc = IERC20ScanArcV4(usdc).balanceOf(address(this));

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        _forceApprove(token, arcfunV4Router, tokensIn);

        (bool ok,) = arcfunV4Router.call(routerCallData);
        _forceApprove(token, arcfunV4Router, 0);
        if (!ok) revert ExternalRouteFailed();

        uint256 finalUsdc = IERC20ScanArcV4(usdc).balanceOf(address(this));
        if (finalUsdc < initialUsdc) revert ExternalRouteFailed();
        uint256 grossUsdcOut = finalUsdc - initialUsdc;
        uint256 fee = (grossUsdcOut * FEE_BPS) / BPS;
        netUsdcOut = grossUsdcOut - fee;
        if (netUsdcOut < minNetUsdcOut) revert SlippageExceeded();

        uint256 finalToken = IERC20ScanArcV4(token).balanceOf(address(this));
        if (finalToken > initialToken) {
            tokensRefunded = finalToken - initialToken;
            _safeTransfer(token, msg.sender, tokensRefunded);
        }
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _safeTransfer(usdc, recipient, netUsdcOut);

        emit RoutedV4Sell(msg.sender, token, tokensIn, fee, netUsdcOut, tokensRefunded);
    }

    /// @notice Recover tokens accidentally sent to this adapter. Owner cannot spend user wallet funds.
    function rescue(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
    }

    function _validateTrade(address token, address curve, uint256 amount, address recipient, uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidAddress();
        if (blockedPair[token][curve]) revert PairBlocked();
        if (!isOfficialPair(token, curve)) revert PairNotFactoryVerified();
    }

    function _grossForNetMinimum(uint256 minNet) private pure returns (uint256) {
        return (minNet * BPS + (BPS - FEE_BPS - 1)) / (BPS - FEE_BPS);
    }

    function _returnsAddress(address target, bytes4 selector, address input, address expected) private view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector, input));
        if (!ok || data.length < 32) return false;
        address resolved = abi.decode(data, (address));
        return resolved == expected;
    }

    function _returnsAddressNoInput(address target, bytes4 selector, address expected) private view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return false;
        address resolved = abi.decode(data, (address));
        return resolved == expected;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV4.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV4.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(abi.encodeCall(IERC20ScanArcV4.approve, (spender, 0)));
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV4.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
