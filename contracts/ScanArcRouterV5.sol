// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ScanArcV5 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IArcfunCurveV5 {
    function buy(uint256 usdcIn, uint256 minTokensOut) external returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut);
}

/// @title ScanArcRouterV5
/// @notice Lifecycle router for Arcfun tokens on Arc mainnet.
/// @dev Pair provenance is proven off-chain from canonical Arcfun launch data, then authorized with
///      short-lived EIP-712 signatures from the ScanArc pair attester. Signatures are bound to this
///      router and Arc's chain id, so they cannot be replayed on another router or chain.
contract ScanArcRouterV5 {
    uint256 public constant FEE_BPS = 25; // 0.25%
    uint256 public constant BPS = 10_000;

    bytes32 public constant PAIR_AUTH_TYPEHASH =
        keccak256("PairAuthorization(address token,address curve,uint256 validUntil)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ScanArcRouter");
    bytes32 private constant VERSION_HASH = keccak256("5");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable usdc;
    address public immutable arcfunFactory;
    address public immutable arcfunV4Router;
    address public immutable feeRecipient;

    address public owner;
    address public pendingOwner;
    address public pairAttester;
    uint256 private unlocked = 1;

    mapping(address token => mapping(address curve => bool blocked)) public blockedPair;

    event PairBlockStatusChanged(address indexed token, address indexed curve, bool blocked);
    event PairAttesterChanged(address indexed previousAttester, address indexed newAttester);
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
    error InvalidPairAuthorization();
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
        address pairAttester_
    ) {
        if (
            usdc_ == address(0) || arcfunFactory_ == address(0) || arcfunV4Router_ == address(0)
                || feeRecipient_ == address(0) || owner_ == address(0) || pairAttester_ == address(0)
        ) revert InvalidAddress();
        if (usdc_.code.length == 0 || arcfunFactory_.code.length == 0 || arcfunV4Router_.code.length == 0) {
            revert InvalidAddress();
        }
        usdc = usdc_;
        arcfunFactory = arcfunFactory_;
        arcfunV4Router = arcfunV4Router_;
        feeRecipient = feeRecipient_;
        owner = owner_;
        pairAttester = pairAttester_;
        emit OwnershipTransferred(address(0), owner_);
        emit PairAttesterChanged(address(0), pairAttester_);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function pairAuthorizationDigest(address token, address curve, uint256 validUntil) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(PAIR_AUTH_TYPEHASH, token, curve, validUntil));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function isAuthorizedPair(
        address token,
        address curve,
        uint256 validUntil,
        bytes calldata signature
    ) public view returns (bool) {
        if (
            token == address(0) || curve == address(0) || token.code.length == 0 || curve.code.length == 0
                || block.timestamp > validUntil || blockedPair[token][curve]
        ) return false;
        return _recover(pairAuthorizationDigest(token, curve, validUntil), signature) == pairAttester;
    }

    function routeAvailable(
        address token,
        address curve,
        uint256 validUntil,
        bytes calldata signature
    ) external view returns (bool) {
        return isAuthorizedPair(token, curve, validUntil, signature);
    }

    function setPairBlocked(address token, address curve, bool blocked) external onlyOwner {
        if (token == address(0) || curve == address(0)) revert InvalidAddress();
        blockedPair[token][curve] = blocked;
        emit PairBlockStatusChanged(token, curve, blocked);
    }

    /// @notice Rotate only the narrow pair-attestation signer. Never use the owner/deployer private key here.
    function setPairAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert InvalidAddress();
        address previous = pairAttester;
        pairAttester = newAttester;
        emit PairAttesterChanged(previous, newAttester);
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

    function buyCurve(
        address token,
        address curve,
        uint256 grossUsdc,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        uint256 authValidUntil,
        bytes calldata authSignature
    ) external nonReentrant returns (uint256 tokensOut) {
        _validateTrade(token, curve, grossUsdc, recipient, deadline, authValidUntil, authSignature);

        uint256 fee = (grossUsdc * FEE_BPS) / BPS;
        uint256 routedUsdc = grossUsdc - fee;
        _safeTransferFrom(usdc, msg.sender, address(this), grossUsdc);
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _forceApprove(usdc, curve, routedUsdc);

        uint256 beforeToken = IERC20ScanArcV5(token).balanceOf(address(this));
        IArcfunCurveV5(curve).buy(routedUsdc, minTokensOut);
        _forceApprove(usdc, curve, 0);
        tokensOut = IERC20ScanArcV5(token).balanceOf(address(this)) - beforeToken;
        if (tokensOut < minTokensOut) revert SlippageExceeded();
        _safeTransfer(token, recipient, tokensOut);

        emit RoutedCurveBuy(msg.sender, token, curve, grossUsdc, fee, tokensOut);
    }

    function sellCurve(
        address token,
        address curve,
        uint256 tokensIn,
        uint256 minNetUsdcOut,
        address recipient,
        uint256 deadline,
        uint256 authValidUntil,
        bytes calldata authSignature
    ) external nonReentrant returns (uint256 netUsdcOut) {
        _validateTrade(token, curve, tokensIn, recipient, deadline, authValidUntil, authSignature);

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        _forceApprove(token, curve, tokensIn);
        uint256 grossMinimum = _grossForNetMinimum(minNetUsdcOut);
        uint256 beforeUsdc = IERC20ScanArcV5(usdc).balanceOf(address(this));
        IArcfunCurveV5(curve).sell(tokensIn, grossMinimum);
        _forceApprove(token, curve, 0);

        uint256 grossUsdcOut = IERC20ScanArcV5(usdc).balanceOf(address(this)) - beforeUsdc;
        uint256 fee = (grossUsdcOut * FEE_BPS) / BPS;
        netUsdcOut = grossUsdcOut - fee;
        if (netUsdcOut < minNetUsdcOut) revert SlippageExceeded();
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _safeTransfer(usdc, recipient, netUsdcOut);

        emit RoutedCurveSell(msg.sender, token, curve, tokensIn, fee, netUsdcOut);
    }

    function buyGraduated(
        address token,
        address curve,
        uint256 grossUsdc,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        uint256 authValidUntil,
        bytes calldata authSignature,
        bytes calldata routerCallData
    ) external nonReentrant returns (uint256 tokensOut, uint256 usdcRefunded) {
        _validateTrade(token, curve, grossUsdc, recipient, deadline, authValidUntil, authSignature);
        if (routerCallData.length < 4) revert InvalidCalldata();

        uint256 fee = (grossUsdc * FEE_BPS) / BPS;
        uint256 routedUsdc = grossUsdc - fee;
        uint256 initialUsdc = IERC20ScanArcV5(usdc).balanceOf(address(this));
        uint256 initialToken = IERC20ScanArcV5(token).balanceOf(address(this));

        _safeTransferFrom(usdc, msg.sender, address(this), grossUsdc);
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _forceApprove(usdc, arcfunV4Router, routedUsdc);

        (bool ok,) = arcfunV4Router.call(routerCallData);
        _forceApprove(usdc, arcfunV4Router, 0);
        if (!ok) revert ExternalRouteFailed();

        uint256 finalToken = IERC20ScanArcV5(token).balanceOf(address(this));
        if (finalToken < initialToken) revert ExternalRouteFailed();
        tokensOut = finalToken - initialToken;
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        uint256 finalUsdc = IERC20ScanArcV5(usdc).balanceOf(address(this));
        if (finalUsdc > initialUsdc) {
            usdcRefunded = finalUsdc - initialUsdc;
            _safeTransfer(usdc, msg.sender, usdcRefunded);
        }
        _safeTransfer(token, recipient, tokensOut);

        emit RoutedV4Buy(msg.sender, token, grossUsdc, fee, tokensOut, usdcRefunded);
    }

    function sellGraduated(
        address token,
        address curve,
        uint256 tokensIn,
        uint256 minNetUsdcOut,
        address recipient,
        uint256 deadline,
        uint256 authValidUntil,
        bytes calldata authSignature,
        bytes calldata routerCallData
    ) external nonReentrant returns (uint256 netUsdcOut, uint256 tokensRefunded) {
        _validateTrade(token, curve, tokensIn, recipient, deadline, authValidUntil, authSignature);
        if (routerCallData.length < 4) revert InvalidCalldata();

        uint256 initialToken = IERC20ScanArcV5(token).balanceOf(address(this));
        uint256 initialUsdc = IERC20ScanArcV5(usdc).balanceOf(address(this));

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        _forceApprove(token, arcfunV4Router, tokensIn);

        (bool ok,) = arcfunV4Router.call(routerCallData);
        _forceApprove(token, arcfunV4Router, 0);
        if (!ok) revert ExternalRouteFailed();

        uint256 finalUsdc = IERC20ScanArcV5(usdc).balanceOf(address(this));
        if (finalUsdc < initialUsdc) revert ExternalRouteFailed();
        uint256 grossUsdcOut = finalUsdc - initialUsdc;
        uint256 fee = (grossUsdcOut * FEE_BPS) / BPS;
        netUsdcOut = grossUsdcOut - fee;
        if (netUsdcOut < minNetUsdcOut) revert SlippageExceeded();

        uint256 finalToken = IERC20ScanArcV5(token).balanceOf(address(this));
        if (finalToken > initialToken) {
            tokensRefunded = finalToken - initialToken;
            _safeTransfer(token, msg.sender, tokensRefunded);
        }
        if (fee != 0) _safeTransfer(usdc, feeRecipient, fee);
        _safeTransfer(usdc, recipient, netUsdcOut);

        emit RoutedV4Sell(msg.sender, token, tokensIn, fee, netUsdcOut, tokensRefunded);
    }

    function rescue(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
    }

    function _validateTrade(
        address token,
        address curve,
        uint256 amount,
        address recipient,
        uint256 deadline,
        uint256 authValidUntil,
        bytes calldata authSignature
    ) private view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidAddress();
        if (blockedPair[token][curve]) revert PairBlocked();
        if (!isAuthorizedPair(token, curve, authValidUntil, authSignature)) revert InvalidPairAuthorization();
    }

    function _grossForNetMinimum(uint256 minNet) private pure returns (uint256) {
        return (minNet * BPS + (BPS - FEE_BPS - 1)) / (BPS - FEE_BPS);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF) return address(0);
        if (v != 27 && v != 28) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV5.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV5.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(abi.encodeCall(IERC20ScanArcV5.approve, (spender, 0)));
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV5.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
