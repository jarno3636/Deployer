// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface IIndexioIncomeHook { function beforeShareUpdate(address,address) external; function afterShareUpdate(address,address) external; }
contract IndexioShareToken is ERC20 {
 address public immutable vault; IIndexioIncomeHook public incomeHook; bool public hookLocked;
 error OnlyVault(); error HookLocked(); error InvalidHook();
 constructor(string memory n,string memory s,address v) ERC20(n,s){vault=v;}
 modifier onlyVault(){if(msg.sender!=vault) revert OnlyVault();_;}
 function setIncomeHook(address h) external onlyVault {if(hookLocked) revert HookLocked(); if(h==address(0)) revert InvalidHook(); incomeHook=IIndexioIncomeHook(h);hookLocked=true;}
 function mint(address to,uint256 a) external onlyVault {_mint(to,a);} function burn(address from,uint256 a) external onlyVault {_burn(from,a);}
 function _update(address f,address t,uint256 v) internal override {IIndexioIncomeHook h=incomeHook;if(address(h)!=address(0))h.beforeShareUpdate(f,t);super._update(f,t,v);if(address(h)!=address(0))h.afterShareUpdate(f,t);}
}
