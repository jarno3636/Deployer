// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
/// @notice Immutable safety bounds shared by Indexio V3 vaults. Deployment itself has no time gate.
contract IndexioGovernanceConfigV3 {
    uint16 public constant BPS = 10_000;
    uint16 public constant INDEXIO_FEE_BPS = 100;
    uint16 public constant MAX_CREATOR_FEE_BPS = 100;
    uint16 public constant MAX_CREATOR_INCOME_REWARD_BPS = 2_000;
    uint16 public constant DEFAULT_QUORUM_BPS = 2_000;
    uint32 public constant VOTING_PERIOD = 3 days;
    uint32 public constant REBALANCE_EXIT_WINDOW = 24 hours;
    uint32 public constant COMPOSITION_EXIT_WINDOW = 72 hours;
    uint32 public constant CREATOR_FEE_EXIT_WINDOW = 7 days;
    bytes32 public constant CONFIG_ID = keccak256("INDEXIO_GOVERNANCE_CONFIG_V3");
}
