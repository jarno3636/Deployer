// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Indexio Pay Router V1 — Base mainnet, native USDC only
/// @notice Non-upgradeable, non-custodial USDC payments with a 0.1% fee capped at 20 USDC.
/// @dev Deploy with a fixed, carefully verified treasury. No owner, fee setter, or sweep.
contract IndexioPayRouter {
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 public constant FEE_BPS = 10; // 0.1%, NOT 1%
    uint256 public constant MAX_FEE = 20_000_000; // 20 USDC, 6 decimals
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public immutable treasury;

    error InvalidRecipient();
    error InvalidAmount();
    error USDCTransferFailed();
    error WrongChain();

    /// @notice All amounts are raw USDC units. (tx hash, log index) identifies each receipt.
    /// @dev Gross amount is the total removed from the sender; net is what the recipient gets.
    event PaymentSent(
        address indexed payer,
        address indexed recipient,
        uint256 totalAmount,
        uint256 recipientAmount,
        uint256 feeAmount
    );

    constructor(address treasury_) {
        if (block.chainid != 8453) revert WrongChain();
        if (treasury_ == address(0) || treasury_ == USDC || treasury_ == address(this)) revert InvalidRecipient();
        treasury = treasury_;
    }

    function quote(uint256 totalAmount) public pure returns (uint256 recipientAmount, uint256 feeAmount) {
        if (totalAmount == 0) revert InvalidAmount();
        feeAmount = (totalAmount * FEE_BPS) / BPS_DENOMINATOR;
        if (feeAmount > MAX_FEE) feeAmount = MAX_FEE;
        recipientAmount = totalAmount - feeAmount;
    }

    /// @notice Send totalAmount USDC, with the fee DEDUCTED from the total.
    /// @dev Caller must approve exactly totalAmount USDC first; never grants unlimited spending.
    ///      Both transfers revert together if either one fails. The router never holds the USDC.
    function pay(address recipient, uint256 totalAmount) external {
        if (msg.sender == treasury || recipient == address(0) || recipient == msg.sender || recipient == address(this)
            || recipient == treasury || recipient == USDC) revert InvalidRecipient();
        (uint256 received, uint256 fee) = quote(totalAmount);
        _safeTransferFrom(msg.sender, recipient, received);
        if (fee != 0) _safeTransferFrom(msg.sender, treasury, fee);
        emit PaymentSent(msg.sender, recipient, totalAmount, received, fee);
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = USDC.call(
            abi.encodeWithSelector(bytes4(0x23b872dd), from, to, amount)
        );
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert USDCTransferFailed();
        }
    }
}
