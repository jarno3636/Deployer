// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IndexioVaultV3} from "./IndexioVaultV3.sol";
interface IFactoryRegisterV3 { function registerVault(address vault,address creator,uint16 creatorFeeBps,uint16 rewardBps,uint256 initialSharePriceUsd18) external; }
contract IndexioVaultDeployerV3 {
    event VaultDeployed(address indexed factory,address indexed creator,address indexed vault,address shareToken,address incomeHub,address governor,uint256 initialSharePriceUsd18);
    function deploy(address factory,string calldata name,string calldata symbol,address[] calldata assets,uint16[] calldata weights,uint16 creatorFeeBps,uint16 creatorIncomeRewardBps,uint256 initialSharePriceUsd18) external returns(address vault){require(factory.code.length>0&&initialSharePriceUsd18>0,"config");IndexioVaultV3 v=new IndexioVaultV3(factory,msg.sender,name,symbol,assets,weights,creatorFeeBps,creatorIncomeRewardBps,initialSharePriceUsd18);vault=address(v);IFactoryRegisterV3(factory).registerVault(vault,msg.sender,creatorFeeBps,creatorIncomeRewardBps,initialSharePriceUsd18);emit VaultDeployed(factory,msg.sender,vault,address(v.shareToken()),address(v.incomeHub()),address(v.governor()),initialSharePriceUsd18);}
}
