// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IndexioVault} from "./IndexioVault.sol";

/// @title IndexioVaultDeployer
/// @notice Small deployment helper that keeps IndexioVault creation bytecode out of IndexioFactory runtime.
/// @dev This helper is intentionally stateless. The caller becomes the factory recorded in the new vault.
///      Only vaults subsequently registered by the canonical IndexioFactory are official Indexio vaults.
contract IndexioVaultDeployer {
    bytes32 public constant DEPLOYER_ID = keccak256("INDEXIO_VAULT_DEPLOYER_V2_4");

    error InvalidCaller();

    event VaultDeployed(address indexed factory, address indexed creator, address indexed vault);

    function deployVault(
        address creator,
        address settlementToken,
        string calldata name,
        string calldata symbol,
        address[] calldata assets,
        uint16[] calldata weights,
        uint256 initialSharePriceUsd18,
        uint16 distributionBps
    ) external returns (address vault) {
        // An EOA cannot serve as an Indexio factory. This also prevents accidental direct wallet use.
        if (msg.sender.code.length == 0) revert InvalidCaller();

        IndexioVault v = new IndexioVault(
            msg.sender,
            creator,
            settlementToken,
            name,
            symbol,
            assets,
            weights,
            initialSharePriceUsd18,
            distributionBps
        );
        vault = address(v);
        emit VaultDeployed(msg.sender, creator, vault);
    }
}
