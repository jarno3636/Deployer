// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
/// @notice Narrow emergency guardian. It can pause risk-increasing actions, but cannot seize vault assets.
contract IndexioSafetyControllerV3 is Ownable2Step {
    mapping(address=>bool) public depositsPaused;
    mapping(address=>bool) public tradingPaused;
    event VaultSafetyUpdated(address indexed vault,bool depositsPaused,bool tradingPaused);
    constructor(address guardian) Ownable(guardian) { require(guardian!=address(0),"guardian"); }
    function setVaultSafety(address vault,bool pauseDeposits,bool pauseTrading) external onlyOwner {
        require(vault!=address(0),"vault"); depositsPaused[vault]=pauseDeposits; tradingPaused[vault]=pauseTrading;
        emit VaultSafetyUpdated(vault,pauseDeposits,pauseTrading);
    }
}
