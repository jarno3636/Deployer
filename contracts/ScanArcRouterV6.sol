// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ScanArcRouterV6
/// @notice Canonical Arcfun pair authorization gate for ScanArc's direct-curve execution path.
/// @dev Arcfun pre-graduation tokens enforce a launch guard that requires the bonding curve to be
///      a party to token transfers. A normal intermediary router therefore cannot safely custody
///      tokens or USDC and then call the curve without changing the execution semantics. V6 never
///      takes custody and never calls the curve. ScanArc proves the canonical token/curve pair,
///      obtains a short-lived EIP-712 authorization from the pair attester, validates it here, then
///      the connected wallet calls the canonical curve directly. Graduated tokens remain routed by
///      ScanArcUniversalRouterV1.
contract ScanArcRouterV6 {
    bytes32 public constant PAIR_AUTH_TYPEHASH =
        keccak256("PairAuthorization(address token,address curve,uint256 validUntil)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ScanArcRouter");
    bytes32 private constant VERSION_HASH = keccak256("6");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 public constant VERSION = 6;
    bool public constant DIRECT_CURVE_EXECUTION = true;

    address public immutable arcfunFactory;
    address public owner;
    address public pendingOwner;
    address public pairAttester;

    mapping(address token => mapping(address curve => bool blocked)) public blockedPair;

    event PairBlockStatusChanged(address indexed token, address indexed curve, bool blocked);
    event PairAttesterChanged(address indexed previousAttester, address indexed newAttester);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address arcfunFactory_, address owner_, address pairAttester_) {
        if (arcfunFactory_ == address(0) || owner_ == address(0) || pairAttester_ == address(0)) {
            revert InvalidAddress();
        }
        if (arcfunFactory_.code.length == 0) revert InvalidAddress();

        arcfunFactory = arcfunFactory_;
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

    function pairAuthorizationDigest(
        address token,
        address curve,
        uint256 validUntil
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(PAIR_AUTH_TYPEHASH, token, curve, validUntil));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Validates a short-lived ScanArc attestation for a canonical Arcfun pair.
    /// @dev This is deliberately view-only. The user's wallet must call the canonical curve directly.
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

    /// @notice Compatibility read for ScanArc clients selecting the direct-curve route.
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

    /// @notice Rotate only the narrow pair-attestation signer. Do not use the owner key as attester.
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
}
