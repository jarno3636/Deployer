// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IERC20 { function balanceOf(address) external view returns(uint256); function approve(address,uint256) external returns(bool); function transfer(address,uint256) external returns(bool); function transferFrom(address,address,uint256) external returns(bool); }
contract AiStocksIndexRouterV1 {
 error NotOwner(); error NotPendingOwner(); error Reentered(); error ZeroAddress(); error ZeroAmount(); error InvalidLeg(); error TargetNotAllowed(address target); error SpenderNotAllowed(address spender); error LegCallFailed(uint256 index,bytes reason); error TransferFailed(); error ValueNotAccepted();
 event PortfolioExecuted(address indexed investor,uint256 grossUsdc,uint256 feeUsdc,uint256 investedUsdc,uint256 legCount,bytes32 indexed portfolioId);
 event FeeRecipientUpdated(address indexed previousRecipient,address indexed newRecipient); event TargetPermissionUpdated(address indexed target,bool allowed); event SpenderPermissionUpdated(address indexed spender,bool allowed); event OwnershipTransferStarted(address indexed owner,address indexed pendingOwner); event OwnershipTransferred(address indexed previousOwner,address indexed newOwner);
 struct Leg { address target; address spender; uint256 usdcAmount; bytes data; }
 IERC20 public immutable USDC; uint256 public constant FEE_BPS=100; uint256 public constant BPS=10_000; address public owner; address public pendingOwner; address public feeRecipient; mapping(address=>bool) public allowedTargets; mapping(address=>bool) public allowedSpenders; uint256 private locked=1;
 modifier onlyOwner(){if(msg.sender!=owner) revert NotOwner();_;} modifier nonReentrant(){if(locked!=1) revert Reentered();locked=2;_;locked=1;}
 constructor(address usdc_,address feeRecipient_,address owner_){if(usdc_==address(0)||feeRecipient_==address(0)||owner_==address(0)) revert ZeroAddress();USDC=IERC20(usdc_);feeRecipient=feeRecipient_;owner=owner_;emit OwnershipTransferred(address(0),owner_);}
 receive() external payable { revert ValueNotAccepted(); }
 function executePortfolio(uint256 grossUsdc,Leg[] calldata legs,bytes32 portfolioId) external nonReentrant {
  if(grossUsdc==0) revert ZeroAmount(); if(legs.length==0||legs.length>10) revert InvalidLeg(); uint256 fee=(grossUsdc*FEE_BPS)/BPS; uint256 investable=grossUsdc-fee; uint256 assigned;
  for(uint256 i;i<legs.length;++i){Leg calldata leg=legs[i];if(leg.target==address(0)||leg.spender==address(0)||leg.usdcAmount==0||leg.data.length<4) revert InvalidLeg();if(!allowedTargets[leg.target]) revert TargetNotAllowed(leg.target);if(!allowedSpenders[leg.spender]) revert SpenderNotAllowed(leg.spender);assigned+=leg.usdcAmount;} if(assigned>investable) revert InvalidLeg();
  uint256 beforeBalance=USDC.balanceOf(address(this)); _safeTransferFrom(USDC,msg.sender,address(this),grossUsdc); if(USDC.balanceOf(address(this))-beforeBalance!=grossUsdc) revert TransferFailed(); _safeTransfer(USDC,feeRecipient,fee);
  for(uint256 i;i<legs.length;++i){Leg calldata leg=legs[i];_forceApprove(USDC,leg.spender,leg.usdcAmount);(bool ok,bytes memory result)=leg.target.call(leg.data);_forceApprove(USDC,leg.spender,0);if(!ok) revert LegCallFailed(i,result);}
  uint256 ending=USDC.balanceOf(address(this));if(ending>beforeBalance)_safeTransfer(USDC,msg.sender,ending-beforeBalance);emit PortfolioExecuted(msg.sender,grossUsdc,fee,assigned,legs.length,portfolioId);
 }
 function setTargetAllowed(address target,bool allowed) external onlyOwner {if(target==address(0)) revert ZeroAddress();allowedTargets[target]=allowed;emit TargetPermissionUpdated(target,allowed);}
 function setSpenderAllowed(address spender,bool allowed) external onlyOwner {if(spender==address(0)) revert ZeroAddress();allowedSpenders[spender]=allowed;emit SpenderPermissionUpdated(spender,allowed);}
 function setFeeRecipient(address next) external onlyOwner {if(next==address(0)) revert ZeroAddress();address previous=feeRecipient;feeRecipient=next;emit FeeRecipientUpdated(previous,next);}
 function transferOwnership(address next) external onlyOwner {if(next==address(0)) revert ZeroAddress();pendingOwner=next;emit OwnershipTransferStarted(owner,next);}
 function acceptOwnership() external {if(msg.sender!=pendingOwner) revert NotPendingOwner();address previous=owner;owner=msg.sender;pendingOwner=address(0);emit OwnershipTransferred(previous,msg.sender);}
 function rescueToken(address token,address to,uint256 amount) external onlyOwner {if(token==address(USDC)||token==address(0)||to==address(0)) revert InvalidLeg();_safeTransfer(IERC20(token),to,amount);}
 function _safeTransfer(IERC20 token,address to,uint256 amount) private {(bool ok,bytes memory data)=address(token).call(abi.encodeWithSelector(token.transfer.selector,to,amount));if(!ok||(data.length!=0&&!abi.decode(data,(bool)))) revert TransferFailed();}
 function _safeTransferFrom(IERC20 token,address from,address to,uint256 amount) private {(bool ok,bytes memory data)=address(token).call(abi.encodeWithSelector(token.transferFrom.selector,from,to,amount));if(!ok||(data.length!=0&&!abi.decode(data,(bool)))) revert TransferFailed();}
 function _forceApprove(IERC20 token,address spender,uint256 amount) private {(bool ok,bytes memory data)=address(token).call(abi.encodeWithSelector(token.approve.selector,spender,amount));if(ok&&(data.length==0||abi.decode(data,(bool))))return;(ok,data)=address(token).call(abi.encodeWithSelector(token.approve.selector,spender,0));if(!ok||(data.length!=0&&!abi.decode(data,(bool)))) revert TransferFailed();(ok,data)=address(token).call(abi.encodeWithSelector(token.approve.selector,spender,amount));if(!ok||(data.length!=0&&!abi.decode(data,(bool)))) revert TransferFailed();}
}
