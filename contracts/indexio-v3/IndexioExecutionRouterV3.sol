// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
/// @notice Adapter allowlist is protocol-level only; vault use requires no per-vault activation.
contract IndexioExecutionRouterV3 is Ownable2Step { address public immutable factory; mapping(address=>bool) public approvedAdapter; event AdapterSet(address indexed adapter,bool approved); constructor(address owner_,address factory_) Ownable(owner_){require(owner_!=address(0)&&factory_.code.length>0,"config");factory=factory_;} function setAdapter(address adapter,bool approved) external onlyOwner {require(!approved||adapter.code.length>0,"adapter");approvedAdapter[adapter]=approved;emit AdapterSet(adapter,approved);} }
