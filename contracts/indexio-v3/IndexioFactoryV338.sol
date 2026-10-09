// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
interface IExecutionRouterIdentityV338 {function factory() external view returns(address);function settlementToken() external view returns(address);}
interface IRegistryV338 { function requireAsset(address asset,uint16 weight) external view returns(uint8); }
interface ISafetyBindingV338 { function factory() external view returns(address); function factoryLocked() external view returns(bool); }
interface IVaultDeployerBindingV338 { function canonicalFactory() external view returns(address); function factoryLocked() external view returns(bool); }
contract IndexioFactoryV338 is Ownable2Step {
    uint16 public constant INDEXIO_FEE_BPS=100; uint16 public constant MAX_CREATOR_FEE_BPS=100; uint16 public constant MAX_CREATOR_INCOME_REWARD_BPS=2000;
    address public immutable registry; address public immutable settlementToken; address public immutable feeTreasury; address public immutable safetyController; address public immutable vaultDeployer; address public immutable transferPolicy;
    address public executionRouter; bool public executionRouterLocked;
    mapping(address=>bool) public isVault; mapping(address=>address) public creatorOf; address[] public allVaults;
    event VaultRegistered(address indexed vault,address indexed creator,uint16 creatorFeeBps,uint16 creatorIncomeRewardBps,uint16 distributionBps,uint256 initialSharePriceUsd18);
    event ExecutionRouterLocked(address indexed router);
    constructor(address owner_,address registry_,address settlement_,address treasury_,address safety_,address deployer_,address transferPolicy_) Ownable(owner_){require(owner_!=address(0)&&registry_.code.length>0&&settlement_.code.length>0&&treasury_!=address(0)&&safety_.code.length>0&&deployer_.code.length>0&&transferPolicy_.code.length>0,"config");registry=registry_;settlementToken=settlement_;feeTreasury=treasury_;safetyController=safety_;vaultDeployer=deployer_;transferPolicy=transferPolicy_;}
    function setExecutionRouterOnce(address router) external onlyOwner {require(!executionRouterLocked&&router.code.length>0,"router");require(ISafetyBindingV338(safetyController).factoryLocked()&&ISafetyBindingV338(safetyController).factory()==address(this),"safety binding");require(IVaultDeployerBindingV338(vaultDeployer).factoryLocked()&&IVaultDeployerBindingV338(vaultDeployer).canonicalFactory()==address(this),"deployer binding");require(IExecutionRouterIdentityV338(router).factory()==address(this)&&IExecutionRouterIdentityV338(router).settlementToken()==settlementToken,"router identity");executionRouter=router;executionRouterLocked=true;emit ExecutionRouterLocked(router);}
    function validateComposition(address[] calldata assets,uint16[] calldata weights) external view {require(assets.length>0&&assets.length==weights.length&&assets.length<=20,"composition");uint256 sum;for(uint256 i;i<assets.length;i++){IRegistryV338(registry).requireAsset(assets[i],weights[i]);sum+=weights[i];for(uint256 j;j<i;j++)require(assets[j]!=assets[i],"duplicate");}require(sum==10_000,"weights");}
    function registerVault(address vault,address creator,uint16 creatorFeeBps,uint16 rewardBps,uint16 distributionBps,uint256 initialSharePriceUsd18) external {require(msg.sender==vaultDeployer&&vault.code.length>0&&!isVault[vault]&&creator!=address(0),"vault");require(creatorFeeBps<=MAX_CREATOR_FEE_BPS&&rewardBps<=MAX_CREATOR_INCOME_REWARD_BPS&&distributionBps<=10_000&&initialSharePriceUsd18>0,"config");isVault[vault]=true;creatorOf[vault]=creator;allVaults.push(vault);emit VaultRegistered(vault,creator,creatorFeeBps,rewardBps,distributionBps,initialSharePriceUsd18);}
    function vaultCount() external view returns(uint256){return allVaults.length;}
}
