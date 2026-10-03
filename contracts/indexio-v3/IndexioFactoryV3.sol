// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
interface IRegistryV3 { function requireAsset(address asset,uint16 weight) external view returns(uint8); }
contract IndexioFactoryV3 is Ownable2Step {
    uint16 public constant INDEXIO_FEE_BPS=100; uint16 public constant MAX_CREATOR_FEE_BPS=100; uint16 public constant MAX_CREATOR_INCOME_REWARD_BPS=2000;
    address public immutable registry; address public immutable settlementToken; address public immutable feeTreasury; address public immutable safetyController; address public immutable vaultDeployer;
    mapping(address=>bool) public isVault; mapping(address=>address) public creatorOf; address[] public allVaults;
    event VaultRegistered(address indexed vault,address indexed creator,uint16 creatorFeeBps,uint16 creatorIncomeRewardBps);
    constructor(address owner_,address registry_,address settlement_,address treasury_,address safety_,address deployer_) Ownable(owner_){require(owner_!=address(0)&&registry_.code.length>0&&settlement_.code.length>0&&treasury_!=address(0)&&safety_.code.length>0&&deployer_.code.length>0,"config");registry=registry_;settlementToken=settlement_;feeTreasury=treasury_;safetyController=safety_;vaultDeployer=deployer_;}
    function validateComposition(address[] calldata assets,uint16[] calldata weights) external view {require(assets.length>0&&assets.length==weights.length&&assets.length<=20,"composition");uint256 sum;for(uint256 i;i<assets.length;i++){IRegistryV3(registry).requireAsset(assets[i],weights[i]);sum+=weights[i];for(uint256 j;j<i;j++)require(assets[j]!=assets[i],"duplicate");}require(sum==10_000,"weights");}
    function registerVault(address vault,address creator,uint16 creatorFeeBps,uint16 rewardBps) external {require(msg.sender==vaultDeployer&&vault.code.length>0&&!isVault[vault]&&creator!=address(0),"vault");require(creatorFeeBps<=MAX_CREATOR_FEE_BPS&&rewardBps<=MAX_CREATOR_INCOME_REWARD_BPS,"fees");isVault[vault]=true;creatorOf[vault]=creator;allVaults.push(vault);emit VaultRegistered(vault,creator,creatorFeeBps,rewardBps);}
    function vaultCount() external view returns(uint256){return allVaults.length;}
}
