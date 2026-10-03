// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
interface IIncomeSyncV3 { function syncTransfer(address,address,uint256,uint256,uint256,uint256) external; }
/// @notice Indexio shares use direct historical balance checkpoints: one historical share = one vote.
contract IndexioShareTokenV3 is ERC20,ERC20Permit {
    struct Checkpoint { uint48 fromBlock; uint208 value; }
    address public immutable vault; address public incomeHub;
    mapping(address=>Checkpoint[]) private _balanceCheckpoints; Checkpoint[] private _supplyCheckpoints;
    constructor(string memory n,string memory s,address v) ERC20(n,s) ERC20Permit(n){require(v!=address(0),"vault");vault=v;}
    function setIncomeHub(address h) external {require(msg.sender==vault&&incomeHub==address(0)&&h.code.length>0,"hub");incomeHub=h;}
    function mint(address to,uint256 amount) external {require(msg.sender==vault,"vault");_mint(to,amount);}
    function burn(address from,uint256 amount) external {require(msg.sender==vault,"vault");_burn(from,amount);}
    function getPastVotes(address account,uint256 blockNumber) external view returns(uint256){require(blockNumber<block.number,"future");return _lookup(_balanceCheckpoints[account],blockNumber);}
    function getPastTotalSupply(uint256 blockNumber) external view returns(uint256){require(blockNumber<block.number,"future");return _lookup(_supplyCheckpoints,blockNumber);}
    function checkpoints(address account) external view returns(Checkpoint[] memory){return _balanceCheckpoints[account];}
    function _update(address from,address to,uint256 value) internal override {
        address h=incomeHub;
        if(h!=address(0)&&from!=to){uint256 fb=from==address(0)?0:balanceOf(from);uint256 tb=to==address(0)?0:balanceOf(to);IIncomeSyncV3(h).syncTransfer(from,to,fb,from==address(0)?0:fb-value,tb,to==address(0)?0:tb+value);}
        super._update(from,to,value);
        if(from!=address(0))_write(_balanceCheckpoints[from],balanceOf(from));
        if(to!=address(0)&&to!=from)_write(_balanceCheckpoints[to],balanceOf(to));
        if(from==address(0)||to==address(0))_write(_supplyCheckpoints,totalSupply());
    }
    function _write(Checkpoint[] storage a,uint256 value) private {require(value<=type(uint208).max,"checkpoint overflow");uint48 b=uint48(block.number);uint256 n=a.length;if(n>0&&a[n-1].fromBlock==b)a[n-1].value=uint208(value);else a.push(Checkpoint(b,uint208(value)));}
    function _lookup(Checkpoint[] storage a,uint256 blockNumber) private view returns(uint256){uint256 lo;uint256 hi=a.length;while(lo<hi){uint256 mid=(lo+hi)/2;if(a[mid].fromBlock>blockNumber)hi=mid;else lo=mid+1;}return hi==0?0:a[hi-1].value;}
    function nonces(address owner) public view override(ERC20Permit,Nonces) returns(uint256){return super.nonces(owner);}
}
