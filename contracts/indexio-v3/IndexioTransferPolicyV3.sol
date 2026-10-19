// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Optional transfer-behavior hints for fee-on-transfer / taxed ERC-20s.
/// @dev Accounting NEVER trusts this registry for balances; Vault/Router always measure real balance deltas.
///      This policy exists so the app/router can quote the next transfer correctly before execution.
///      Unconfigured tokens default to 10_000 bps for QUOTING, but have an independently enforced 5% safety allowance.
contract IndexioTransferPolicyV3 is Ownable2Step {
    uint16 public constant BPS = 10_000;
    // A transfer-tax allowance is a worst-case safety bound, NOT an estimate.
    // Unconfigured assets may transfer with up to 5% loss without an owner per-token approval.
    // Owner may tighten the universal limit but cannot loosen it beyond 5%.
    uint16 public constant MAX_AUTO_TAX_BPS = 500;
    uint16 public maxTransferTaxBps = MAX_AUTO_TAX_BPS;
    uint16 public constant MIN_RECEIVE_BPS = 9_500;

    struct Policy {
        uint16 receiveBps;
        bool configured;
    }

    mapping(address => Policy) public policy;

    event TransferPolicySet(address indexed token, uint16 receiveBps);
    event TransferPolicyCleared(address indexed token);
    event MaxTransferTaxUpdated(uint16 oldBps, uint16 newBps);

    constructor(address owner_) Ownable(owner_) {
        require(owner_ != address(0), "owner");
    }

    /// @notice Configure the expected amount received after one token transfer.
    /// @param receiveBps 9_900 means the recipient is expected to receive 99% of the sent amount.
    function setPolicy(address token, uint16 receiveBps) external onlyOwner {
        require(token.code.length > 0, "token");
        require(receiveBps >= BPS - maxTransferTaxBps && receiveBps <= BPS, "bps");
        policy[token] = Policy(receiveBps, true);
        emit TransferPolicySet(token, receiveBps);
    }

    /// @notice Return a token to standard-transfer assumptions. Actual balance deltas are still measured.
    function clearPolicy(address token) external onlyOwner {
        delete policy[token];
        emit TransferPolicyCleared(token);
    }

    /// @notice Optional governance-controlled tightening of the global tax ceiling.
    function setMaxTransferTaxBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_AUTO_TAX_BPS, "tax ceiling");
        uint16 old = maxTransferTaxBps;
        maxTransferTaxBps = bps;
        emit MaxTransferTaxUpdated(old, bps);
    }

    /// @notice Transaction enforcement floor, separate from the expected quote amount.
    ///         Per-token configured bounds may be stricter, never weaker.
    function minimumReceiveBps(address token) external view returns (uint16) {
        uint16 globalFloor = BPS - maxTransferTaxBps;
        Policy memory p = policy[token];
        return p.configured && p.receiveBps > globalFloor ? p.receiveBps : globalFloor;
    }

    function expectedReceiveBps(address token) external view returns (uint16) {
        Policy memory p = policy[token];
        return p.configured ? p.receiveBps : BPS;
    }
}
