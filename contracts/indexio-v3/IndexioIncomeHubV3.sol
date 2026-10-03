// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
/// @notice Multi-token income accounting. Vault/share token calls sync on balance changes.
contract IndexioIncomeHubV3 {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE=1e36;
    address public immutable vault;
    address public immutable shareToken;
    address public immutable creator;
    uint16 public immutable creatorIncomeRewardBps;
    mapping(address=>uint256) public accPerShare;
    mapping(address=>mapping(address=>uint256)) public debt;
    mapping(address=>mapping(address=>uint256)) public credit;
    mapping(address=>uint256) public accounted;
    event IncomeNotified(address indexed token,uint256 gross,uint256 creatorReward,uint256 distributable);
    event Claimed(address indexed account,address indexed token,address indexed receiver,uint256 amount);
    constructor(address vault_,address shareToken_,address creator_,uint16 rewardBps){require(vault_!=address(0)&&shareToken_!=address(0)&&creator_!=address(0)&&rewardBps<=2000,"config");vault=vault_;shareToken=shareToken_;creator=creator_;creatorIncomeRewardBps=rewardBps;}
    function notifyIncome(address token,uint256 amount,uint256 totalSupply) external {require(msg.sender==vault,"vault");require(totalSupply>0&&amount>0,"amount");uint256 reward=amount*creatorIncomeRewardBps/10_000;if(reward>0)IERC20(token).safeTransfer(creator,reward);uint256 d=amount-reward;accPerShare[token]+=d*SCALE/totalSupply;accounted[token]+=d;emit IncomeNotified(token,amount,reward,d);}
    function sync(address token,address account,uint256 oldBal,uint256 newBal) external {require(msg.sender==shareToken,"share");uint256 a=accPerShare[token];uint256 accrued=oldBal*a/SCALE;uint256 prev=debt[token][account];if(accrued>prev)credit[token][account]+=accrued-prev;debt[token][account]=newBal*a/SCALE;}
    function claim(address token,address receiver,uint256 balance) external returns(uint256 amount){require(receiver!=address(0),"receiver");uint256 accrued=balance*accPerShare[token]/SCALE;uint256 prev=debt[token][msg.sender];amount=credit[token][msg.sender]+(accrued>prev?accrued-prev:0);credit[token][msg.sender]=0;debt[token][msg.sender]=accrued;if(amount>0){accounted[token]-=amount;IERC20(token).safeTransfer(receiver,amount);}emit Claimed(msg.sender,token,receiver,amount);}
}
