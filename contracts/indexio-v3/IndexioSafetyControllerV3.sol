// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
interface IFactorySafetyV3 { function isVault(address) external view returns(bool); }
/// @notice Narrow emergency guardian. It can pause risk-increasing actions, but cannot seize assets or change economics.
contract IndexioSafetyControllerV3 is Ownable2Step {
    address public factory; bool public factoryLocked;
    mapping(address=>bool) public depositsPaused; mapping(address=>bool) public tradingPaused;
    event FactoryLocked(address indexed factory); event VaultSafetyUpdated(address indexed vault,bool depositsPaused,bool tradingPaused);
    constructor(address guardian) Ownable(guardian){require(guardian!=address(0),"guardian");}
    function setFactoryOnce(address f) external onlyOwner {require(!factoryLocked&&f.code.length>0,"factory");factory=f;factoryLocked=true;emit FactoryLocked(f);}
    function setVaultSafety(address vault,bool pauseDeposits,bool pauseTrading) external onlyOwner {require(factoryLocked&&IFactorySafetyV3(factory).isVault(vault),"vault");depositsPaused[vault]=pauseDeposits;tradingPaused[vault]=pauseTrading;emit VaultSafetyUpdated(vault,pauseDeposits,pauseTrading);}
}
