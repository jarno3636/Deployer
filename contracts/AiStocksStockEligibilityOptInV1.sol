// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Optional onchain opt-in provider for AiStocksPolicyManagerV1.
/// @dev The Policy Manager calls isEligible(wallet). This contract does not
///      replace any issuer-level restrictions that may exist on B20 assets.
contract AiStocksStockEligibilityOptInV1 {
    mapping(address => bool) public enabled;

    event StockIndexAccessChanged(address indexed wallet, bool enabled);

    function enable() external {
        enabled[msg.sender] = true;
        emit StockIndexAccessChanged(msg.sender, true);
    }

    function disable() external {
        enabled[msg.sender] = false;
        emit StockIndexAccessChanged(msg.sender, false);
    }

    function isEligible(address wallet) external view returns (bool) {
        return enabled[wallet];
    }
}
