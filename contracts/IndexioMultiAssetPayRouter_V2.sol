// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Indexio Pay V2 - Base native ETH and compatible ERC-20 assets
/// @notice Fixed 10-bp payment fee in the asset sent. Existing USDC Pay V1 remains live.
/// @dev Non-upgradeable and permissionless. Some ERC-20s (rebasing, restrictive,
///      unusual transfer behavior) cannot be safely supported and will revert.
///      Does NOT provide a universal $20 USD fee cap: such a cap requires an oracle.
contract IndexioMultiAssetPayRouterV2 {
    uint256 public constant FEE_BPS = 10; // 0.10% of assets collected
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_USDC_FEE = 20_000_000; // 20 native Base USDC
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public immutable treasury;

    uint256 private entered = 1;

    error WrongChain();
    error BadRecipient();
    error BadAsset();
    error BadAmount();
    error LowReceipt(uint256 actual, uint256 minimum);
    error TokenCallFailed();
    error BalanceReadFailed();
    error UnexpectedTransfer();
    error NativePaymentFailed();
    error ReentrantCall();

    /// @dev asset == address(0) means ETH on Base; every other address is ERC-20.
    ///      Actual recipient and treasury amounts are measured with balance deltas.
    ///      Receipt identifies payment by (chain, router, txHash, logIndex).
    event AssetPaymentSent(
        address indexed payer,
        address indexed recipient,
        address indexed asset,
        uint256 requestedAmount,
        uint256 collectedAmount,
        uint256 recipientAmount,
        uint256 feeAmount
    );

    constructor(address treasury_) {
        if (block.chainid != 8453) revert WrongChain();
        if (treasury_ == address(0) || treasury_ == address(this) || treasury_ == USDC)
            revert BadRecipient();
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    function quote(address asset, uint256 gross) public pure returns (uint256 toRecipient, uint256 protocolFee) {
        if (gross == 0) revert BadAmount();
        protocolFee = gross * FEE_BPS / BPS_DENOMINATOR;
        if (asset == USDC && protocolFee > MAX_USDC_FEE) protocolFee = MAX_USDC_FEE;
        toRecipient = gross - protocolFee;
    }

    /// @notice One ETH payment, with the fixed fee deducted from msg.value.
    function payNative(address recipient, uint256 minimumReceived) external payable nonReentrant {
        _checkRecipient(recipient, address(0));
        (uint256 toRecipient, uint256 fee) = quote(address(0), msg.value);
        if (toRecipient < minimumReceived) revert LowReceipt(toRecipient, minimumReceived);
        _sendEth(recipient, toRecipient);
        if (fee != 0) _sendEth(treasury, fee);
        emit AssetPaymentSent(msg.sender, recipient, address(0), msg.value, msg.value, toRecipient, fee);
    }

    /// @notice One token payment after the sender approves the router for `amount`.
    /// @dev Pull first and calculate fees on the actual amount collected. Also measure
    ///      outbound transfer taxes; minimumReceived applies to REAL recipient gains.
    ///      This contract never requests allowances or grants unlimited approvals.
    function payToken(address asset, address recipient, uint256 amount, uint256 minimumReceived)
        external nonReentrant
    {
        _checkRecipient(recipient, asset);
        if (asset.code.length == 0 || asset == address(this)) revert BadAsset();
        if (amount == 0) revert BadAmount();

        uint256 beforeHere = _balance(asset, address(this));
        _tokenCall(asset, abi.encodeWithSelector(bytes4(0x23b872dd), msg.sender, address(this), amount));
        uint256 afterPull = _balance(asset, address(this));
        if (afterPull <= beforeHere || afterPull - beforeHere > amount) revert UnexpectedTransfer();
        uint256 collected = afterPull - beforeHere;
        (uint256 recipientNominal, uint256 feeNominal) = quote(asset, collected);

        uint256 beforeRecipient = _balance(asset, recipient);
        _tokenCall(asset, abi.encodeWithSelector(bytes4(0xa9059cbb), recipient, recipientNominal));
        uint256 afterRecipient = _balance(asset, recipient);
        if (afterRecipient < beforeRecipient) revert UnexpectedTransfer();
        uint256 received = afterRecipient - beforeRecipient;
        if (received < minimumReceived) revert LowReceipt(received, minimumReceived);

        uint256 feeReceived;
        if (feeNominal != 0) {
            uint256 beforeTreasury = _balance(asset, treasury);
            _tokenCall(asset, abi.encodeWithSelector(bytes4(0xa9059cbb), treasury, feeNominal));
            uint256 afterTreasury = _balance(asset, treasury);
            if (afterTreasury < beforeTreasury) revert UnexpectedTransfer();
            feeReceived = afterTreasury - beforeTreasury;
        }
        // Never spend balances left in the contract by unrelated senders.
        // Also rejects incompatible rebasing/reflection behavior.
        if (_balance(asset, address(this)) != beforeHere) revert UnexpectedTransfer();
        emit AssetPaymentSent(msg.sender, recipient, asset, amount, collected, received, feeReceived);
    }

    function _checkRecipient(address recipient, address asset) private view {
        if (msg.sender == treasury || recipient == address(0) || recipient == msg.sender || recipient == treasury ||
            recipient == address(this) || recipient == asset) revert BadRecipient();
    }

    function _balance(address asset, address owner) private view returns (uint256 value) {
        (bool ok, bytes memory data) = asset.staticcall(abi.encodeWithSelector(bytes4(0x70a08231), owner));
        if (!ok || data.length != 32) revert BalanceReadFailed();
        value = abi.decode(data, (uint256));
    }

    function _tokenCall(address asset, bytes memory callData) private {
        (bool ok, bytes memory data) = asset.call(callData);
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool)))))
            revert TokenCallFailed();
    }

    function _sendEth(address to, uint256 value) private {
        (bool ok, ) = payable(to).call{value:value}("");
        if (!ok) revert NativePaymentFailed();
    }

    // No payable receive/fallback. An accidental direct ETH payment reverts.
}
