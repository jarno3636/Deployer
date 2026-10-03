// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
interface IIncomeSyncV3 { function syncTransfer(address,address,uint256,uint256,uint256,uint256) external; }
contract IndexioShareTokenV3 is ERC20,ERC20Permit,ERC20Votes {address public immutable vault;address public incomeHub;constructor(string memory n,string memory s,address v) ERC20(n,s) ERC20Permit(n){require(v!=address(0),"vault");vault=v;}function setIncomeHub(address h) external {require(msg.sender==vault&&incomeHub==address(0)&&h.code.length>0,"hub");incomeHub=h;}function mint(address to,uint256 amount) external {require(msg.sender==vault,"vault");_mint(to,amount);}function burn(address from,uint256 amount) external {require(msg.sender==vault,"vault");_burn(from,amount);}function _update(address from,address to,uint256 value) internal override(ERC20,ERC20Votes){address h=incomeHub;if(h!=address(0)){uint256 fb=from==address(0)?0:balanceOf(from);uint256 tb=to==address(0)?0:balanceOf(to);IIncomeSyncV3(h).syncTransfer(from,to,fb,from==address(0)?0:fb-value,tb,to==address(0)?0:tb+value);}super._update(from,to,value);}function nonces(address owner) public view override(ERC20Permit,Nonces) returns(uint256){return super.nonces(owner);}}
