// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IndexioVaultV25} from "./IndexioVaultV25.sol";
contract IndexioVaultDeployerV25 {
    bytes32 public constant DEPLOYER_ID=keccak256("INDEXIO_VAULT_DEPLOYER_V2_5");
    error InvalidCaller(); event VaultDeployed(address indexed factory,address indexed creator,address indexed vault);
    function deployVault(address creator,address settlementToken,string calldata name,string calldata symbol,address[] calldata assets,uint16[] calldata weights,uint256 initialSharePriceUsd18,uint16 distributionBps) external returns(address vault){
        if(msg.sender.code.length==0)revert InvalidCaller(); IndexioVaultV25 v=new IndexioVaultV25(msg.sender,creator,settlementToken,name,symbol,assets,weights,initialSharePriceUsd18,distributionBps);vault=address(v);emit VaultDeployed(msg.sender,creator,vault);
    }
}
