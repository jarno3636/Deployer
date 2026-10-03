// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
contract IndexioShareTokenV3 is ERC20, ERC20Permit, ERC20Votes {
    address public immutable vault;
    constructor(string memory n,string memory s,address v) ERC20(n,s) ERC20Permit(n){require(v!=address(0),"vault");vault=v;}
    function mint(address to,uint256 amount) external {require(msg.sender==vault,"vault");_mint(to,amount);}
    function burn(address from,uint256 amount) external {require(msg.sender==vault,"vault");_burn(from,amount);}
    function nonces(address owner) public view override(ERC20Permit,Nonces) returns(uint256){return super.nonces(owner);}
}
