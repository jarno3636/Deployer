// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Optional transfer-behavior hints for fee-on-transfer / taxed ERC-20s.
/// @dev Accounting NEVER trusts this registry for balances; Vault/Router always measure real balance deltas.
///      This policy exists so the app/router can quote the next transfer correctly before execution.
///      Unconfigured tokens default to 10_000 bps (standard ERC-20 transfer behavior).
contract IndexioTransferPolicyV3 is Ownable2Step {
    uint16 public constant BPS = 10_000;
    uint16 public constant MIN_RECEIVE_BPS = 8_000; // reject extreme/hostile token behavior

    struct Policy {
        uint16 receiveBps;
        bool configured;
    }

    mapping(address => Policy) public policy;

    event TransferPolicySet(address indexed token, uint16 receiveBps);
    event TransferPolicyCleared(address indexed token);

    constructor(address owner_) Ownable(owner_) {
        require(owner_ != address(0), "owner");
    }

    /// @notice Configure the expected amount received after one token transfer.
    /// @param receiveBps 9_900 means the recipient is expected to receive 99% of the sent amount.
    function setPolicy(address token, uint16 receiveBps) external onlyOwner {
        require(token.code.length > 0, "token");
        require(receiveBps >= MIN_RECEIVE_BPS && receiveBps <= BPS, "bps");
        policy[token] = Policy(receiveBps, true);
        emit TransferPolicySet(token, receiveBps);
    }

    /// @notice Return a token to standard-transfer assumptions. Actual balance deltas are still measured.
    function clearPolicy(address token) external onlyOwner {
        delete policy[token];
        emit TransferPolicyCleared(token);
    }

    function expectedReceiveBps(address token) external view returns (uint16) {
        Policy memory p = policy[token];
        return p.configured ? p.receiveBps : BPS;
    }
}
