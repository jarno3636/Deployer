// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20ScanArcV2 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ITokenMessengerV2ScanArcForwarding {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @title ScanArcCCTPBridgeV2
/// @notice Arc-source USDC adapter that enforces ScanArc's fixed 0.25% fee and
///         opts into Circle CCTP Forwarding Service for automatic destination minting.
/// @dev This contract is intended for Arc mainnet (CCTP domain 26). It leaves
///      existing ScanArc routers and CCTP Bridge V1 untouched.
contract ScanArcCCTPBridgeV2 {
    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error UnsupportedDestination(uint32 domain);
    error Paused();
    error Reentrancy();
    error TokenCallFailed();
    error ResidualUSDC();

    uint256 public constant VERSION = 2;
    uint256 public constant FEE_BPS = 25; // 0.25%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Circle Forwarding Service v0 hook:
    // bytes24("cctp-forward") || uint32(0) || uint32(0)
    bytes32 public constant FORWARDING_HOOK_DATA =
        0x636374702d666f72776172640000000000000000000000000000000000000000;

    // Circle currently marks Fast Transfer as N/A for Arc source transfers.
    // Arc standard CCTP attestation is already fast, and forwarding removes the
    // destination-wallet transaction.
    uint32 public constant MIN_FINALITY_THRESHOLD = 2000;

    address public immutable USDC;
    address public immutable TOKEN_MESSENGER_V2;
    uint32 public immutable LOCAL_DOMAIN;

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    bool public paused;

    mapping(uint32 => bool) public destinationEnabled;
    uint256 private _locked = 1;

    event BridgeInitiated(
        address indexed sender,
        uint32 indexed destinationDomain,
        bytes32 indexed mintRecipient,
        uint256 grossAmount,
        uint256 scanArcFee,
        uint256 burnAmount,
        uint256 maxCircleFee,
        uint32 minFinalityThreshold,
        bytes32 forwardingHookData
    );
    event DestinationEnabled(uint32 indexed domain, bool enabled);
    event FeeRecipientChanged(address indexed previousRecipient, address indexed newRecipient);
    event PauseChanged(bool paused);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address owner_,
        address feeRecipient_,
        address usdc_,
        address tokenMessengerV2_,
        uint32 localDomain_,
        uint32[] memory initialDestinationDomains
    ) {
        if (
            owner_ == address(0) ||
            feeRecipient_ == address(0) ||
            usdc_ == address(0) ||
            tokenMessengerV2_ == address(0)
        ) revert InvalidAddress();

        owner = owner_;
        feeRecipient = feeRecipient_;
        USDC = usdc_;
        TOKEN_MESSENGER_V2 = tokenMessengerV2_;
        LOCAL_DOMAIN = localDomain_;

        emit OwnershipTransferred(address(0), owner_);
        emit FeeRecipientChanged(address(0), feeRecipient_);

        for (uint256 i; i < initialDestinationDomains.length; ++i) {
            uint32 domain = initialDestinationDomains[i];
            if (domain != localDomain_) {
                destinationEnabled[domain] = true;
                emit DestinationEnabled(domain, true);
            }
        }
    }

    /// @notice Bridge Arc native USDC with Circle Forwarding Service enabled.
    /// @param grossAmount Total USDC pulled from the sender, including ScanArc fee.
    /// @param destinationDomain Circle CCTP destination domain.
    /// @param mintRecipient Destination recipient encoded as bytes32.
    /// @param maxCircleFee Maximum CCTP + Forwarding Service fee Circle may deduct.
    function bridgeUSDC(
        uint256 grossAmount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxCircleFee
    ) external nonReentrant {
        if (paused) revert Paused();
        if (!destinationEnabled[destinationDomain] || destinationDomain == LOCAL_DOMAIN) {
            revert UnsupportedDestination(destinationDomain);
        }
        if (grossAmount == 0 || mintRecipient == bytes32(0)) revert InvalidAmount();

        uint256 scanArcFee = (grossAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 burnAmount = grossAmount - scanArcFee;
        if (burnAmount == 0 || maxCircleFee >= burnAmount) revert InvalidAmount();

        // Preserve any pre-existing dust rather than allowing a third party to brick
        // the adapter by sending USDC directly to it. This transaction itself must
        // still finish with exactly the same adapter balance it started with.
        uint256 balanceBefore = IERC20ScanArcV2(USDC).balanceOf(address(this));

        _safeTransferFrom(USDC, msg.sender, address(this), grossAmount);
        if (scanArcFee != 0) _safeTransfer(USDC, feeRecipient, scanArcFee);

        _forceApprove(USDC, TOKEN_MESSENGER_V2, burnAmount);
        ITokenMessengerV2ScanArcForwarding(TOKEN_MESSENGER_V2).depositForBurnWithHook(
            burnAmount,
            destinationDomain,
            mintRecipient,
            USDC,
            bytes32(0),
            maxCircleFee,
            MIN_FINALITY_THRESHOLD,
            abi.encodePacked(FORWARDING_HOOK_DATA)
        );
        _forceApprove(USDC, TOKEN_MESSENGER_V2, 0);

        if (IERC20ScanArcV2(USDC).balanceOf(address(this)) != balanceBefore) {
            revert ResidualUSDC();
        }

        emit BridgeInitiated(
            msg.sender,
            destinationDomain,
            mintRecipient,
            grossAmount,
            scanArcFee,
            burnAmount,
            maxCircleFee,
            MIN_FINALITY_THRESHOLD,
            FORWARDING_HOOK_DATA
        );
    }

    function quote(uint256 grossAmount) external pure returns (uint256 scanArcFee, uint256 burnAmount) {
        scanArcFee = (grossAmount * FEE_BPS) / BPS_DENOMINATOR;
        burnAmount = grossAmount - scanArcFee;
    }

    function setDestinationEnabled(uint32 domain, bool enabled) external onlyOwner {
        if (domain == LOCAL_DOMAIN) enabled = false;
        destinationEnabled[domain] = enabled;
        emit DestinationEnabled(domain, enabled);
    }

    function setFeeRecipient(address next) external onlyOwner {
        if (next == address(0)) revert InvalidAddress();
        address previous = feeRecipient;
        feeRecipient = next;
        emit FeeRecipientChanged(previous, next);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert InvalidAddress();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    /// @notice Recover non-USDC tokens accidentally sent here.
    function rescueForeignToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == USDC || token == address(0) || to == address(0)) revert InvalidAddress();
        _safeTransfer(token, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV2.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV2.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArcV2.approve, (spender, amount)));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;

        (ok, data) = token.call(abi.encodeCall(IERC20ScanArcV2.approve, (spender, 0)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();

        (ok, data) = token.call(abi.encodeCall(IERC20ScanArcV2.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }
}
