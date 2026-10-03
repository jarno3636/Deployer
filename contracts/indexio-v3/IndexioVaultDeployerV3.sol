// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IndexioVaultV3} from "./IndexioVaultV3.sol";
contract IndexioVaultDeployerV3 { event VaultDeployed(address indexed factory,address indexed creator,address indexed vault,address shareToken);
function deploy(address factory,address creator,string calldata name,string calldata symbol,address[] calldata assets,uint16[] calldata weights,uint16 creatorFeeBps,uint16 creatorIncomeRewardBps) external returns(address vault){IndexioVaultV3 v=new IndexioVaultV3(factory,creator,name,symbol,assets,weights,creatorFeeBps,creatorIncomeRewardBps);vault=address(v);emit VaultDeployed(factory,creator,vault,address(v.shareToken()));}}
