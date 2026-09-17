// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20ScanArc {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ITokenMessengerV2ScanArc {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @title ScanArcCCTPBridgeV1
/// @notice Fee-enforcing CCTP V2 source-chain adapter for native USDC.
/// @dev Pulls USDC only inside the bridge transaction, immediately pays the fixed
///      ScanArc fee, and approves/burns the remainder through Circle TokenMessengerV2.
///      No bridge balance is intentionally retained. Deploy one instance per source chain.
contract ScanArcCCTPBridgeV1 {
    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error UnsupportedDestination(uint32 domain);
    error Paused();
    error Reentrancy();
    error TokenCallFailed();
    error ResidualUSDC();

    uint256 public constant FEE_BPS = 25; // 0.25%
    uint256 public constant BPS_DENOMINATOR = 10_000;

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
        uint256 maxCctpFee,
        uint32 minFinalityThreshold
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
        if (owner_ == address(0) || feeRecipient_ == address(0) || usdc_ == address(0) || tokenMessengerV2_ == address(0)) {
            revert InvalidAddress();
        }
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

    /// @notice Bridge native USDC through Circle CCTP V2 while enforcing ScanArc's fixed 0.25% fee.
    /// @param grossAmount Total USDC pulled from the sender (6 decimals on supported EVM chains).
    /// @param destinationDomain Circle CCTP destination domain.
    /// @param mintRecipient Destination recipient encoded as bytes32.
    /// @param maxCctpFee Maximum Circle CCTP fee deducted from the burn amount.
    /// @param minFinalityThreshold 1000 for Fast Transfer or 2000 for Standard Transfer.
    function bridgeUSDC(
        uint256 grossAmount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxCctpFee,
        uint32 minFinalityThreshold
    ) external nonReentrant {
        if (paused) revert Paused();
        if (!destinationEnabled[destinationDomain] || destinationDomain == LOCAL_DOMAIN) {
            revert UnsupportedDestination(destinationDomain);
        }
        if (grossAmount == 0 || mintRecipient == bytes32(0)) revert InvalidAmount();

        uint256 fee = (grossAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 burnAmount = grossAmount - fee;
        if (burnAmount == 0 || maxCctpFee >= burnAmount) revert InvalidAmount();

        _safeTransferFrom(USDC, msg.sender, address(this), grossAmount);
        if (fee != 0) _safeTransfer(USDC, feeRecipient, fee);

        _forceApprove(USDC, TOKEN_MESSENGER_V2, burnAmount);
        ITokenMessengerV2ScanArc(TOKEN_MESSENGER_V2).depositForBurn(
            burnAmount,
            destinationDomain,
            mintRecipient,
            USDC,
            bytes32(0),
            maxCctpFee,
            minFinalityThreshold
        );
        _forceApprove(USDC, TOKEN_MESSENGER_V2, 0);

        // The adapter must never silently accumulate users' bridge USDC.
        if (IERC20ScanArc(USDC).balanceOf(address(this)) != 0) revert ResidualUSDC();

        emit BridgeInitiated(
            msg.sender,
            destinationDomain,
            mintRecipient,
            grossAmount,
            fee,
            burnAmount,
            maxCctpFee,
            minFinalityThreshold
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

    /// @notice Recover non-USDC tokens accidentally sent here. Native USDC is deliberately unrecoverable by owner.
    function rescueForeignToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == USDC || token == address(0) || to == address(0)) revert InvalidAddress();
        _safeTransfer(token, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20ScanArc.approve, (spender, amount)));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;
        (ok, data) = token.call(abi.encodeCall(IERC20ScanArc.approve, (spender, 0)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
        (ok, data) = token.call(abi.encodeCall(IERC20ScanArc.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }
}
