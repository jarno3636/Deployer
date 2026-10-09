// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IFactoryRegisterV338 {
    function registerVault(address vault,address creator,uint16 creatorFeeBps,uint16 rewardBps,uint16 distributionBps,uint256 initialSharePriceUsd18) external;
    function vaultDeployer() external view returns(address);
}
interface IVaultIdentityV338 {
    function factory() external view returns(address);
    function creator() external view returns(address);
    function creatorFeeBps() external view returns(uint16);
    function distributionBps() external view returns(uint16);
    function initialSharePriceUsd18() external view returns(uint256);
    function shareToken() external view returns(address);
    function incomeHub() external view returns(address);
    function governor() external view returns(address);
}

/// @notice Compact-call deployer for the unchanged Indexio V3 vault.
/// @dev Audited Vault creation code is held in two immutable STOP-prefixed code blobs.
///      `deploy` reconstructs it on-chain, verifies its hash, appends constructor args,
///      deploys the vault and registers it with the canonical factory.
contract IndexioVaultDeployerV338 is Ownable {
    bytes32 public immutable vaultCreationCodeHash;
    uint32 public immutable vaultCreationCodeLength;
    address public immutable codeBlobA;
    address public immutable codeBlobB;
    uint32 public immutable codeBlobALength;
    uint32 public immutable codeBlobBLength;
    address public canonicalFactory;
    bool public factoryLocked;

    event FactoryLocked(address indexed factory);
    event VaultDeployed(address indexed factory,address indexed creator,address indexed vault,address shareToken,address incomeHub,address governor,uint16 distributionBps,uint256 initialSharePriceUsd18);

    constructor(address owner_,bytes32 creationCodeHash_,uint32 creationCodeLength_,address blobA_,uint32 blobALength_,address blobB_,uint32 blobBLength_) Ownable(owner_) {
        require(owner_!=address(0)&&creationCodeHash_!=bytes32(0)&&creationCodeLength_>0,"config");
        require(blobA_.code.length==uint256(blobALength_)+1&&blobB_.code.length==uint256(blobBLength_)+1,"blob size");
        require(uint256(blobALength_)+uint256(blobBLength_)==uint256(creationCodeLength_),"blob length");
        vaultCreationCodeHash=creationCodeHash_;
        vaultCreationCodeLength=creationCodeLength_;
        codeBlobA=blobA_; codeBlobB=blobB_;
        codeBlobALength=blobALength_; codeBlobBLength=blobBLength_;
        require(keccak256(_readCreationCode())==creationCodeHash_,"blob hash");
    }

    function setFactoryOnce(address factory) external onlyOwner {
        require(!factoryLocked&&factory.code.length>0,"factory");
        require(IFactoryRegisterV338(factory).vaultDeployer()==address(this),"not canonical");
        canonicalFactory=factory; factoryLocked=true; emit FactoryLocked(factory);
    }

    function deploy(string calldata name,string calldata symbol,address[] calldata assets,uint16[] calldata weights,uint16 creatorFeeBps,uint16 creatorIncomeRewardBps,uint16 distributionBps,uint256 initialSharePriceUsd18) external returns(address vault) {
        require(factoryLocked&&initialSharePriceUsd18>0,"config");
        bytes memory initCode=bytes.concat(_readCreationCode(),abi.encode(canonicalFactory,msg.sender,name,symbol,assets,weights,creatorFeeBps,creatorIncomeRewardBps,distributionBps,initialSharePriceUsd18));
        bytes memory code=initCode;
        assembly ("memory-safe") { vault := create(0,add(code,0x20),mload(code)) }
        require(vault!=address(0)&&vault.code.length>0,"deploy failed");
        IVaultIdentityV338 v=IVaultIdentityV338(vault);
        require(v.factory()==canonicalFactory&&v.creator()==msg.sender&&v.creatorFeeBps()==creatorFeeBps&&v.distributionBps()==distributionBps&&v.initialSharePriceUsd18()==initialSharePriceUsd18,"vault identity");
        require(v.shareToken()!=address(0)&&v.incomeHub()!=address(0)&&v.governor()!=address(0),"components");
        IFactoryRegisterV338(canonicalFactory).registerVault(vault,msg.sender,creatorFeeBps,creatorIncomeRewardBps,distributionBps,initialSharePriceUsd18);
        emit VaultDeployed(canonicalFactory,msg.sender,vault,v.shareToken(),v.incomeHub(),v.governor(),distributionBps,initialSharePriceUsd18);
    }

    function _readCreationCode() internal view returns(bytes memory code) {
        code=new bytes(vaultCreationCodeLength);
        address a=codeBlobA; address b=codeBlobB; uint256 aLen=codeBlobALength; uint256 bLen=codeBlobBLength;
        assembly ("memory-safe") {
            let dst:=add(code,0x20)
            extcodecopy(a,dst,1,aLen)
            extcodecopy(b,add(dst,aLen),1,bLen)
        }
        require(keccak256(code)==vaultCreationCodeHash,"code hash");
    }
}
