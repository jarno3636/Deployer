// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IFactoryRegisterV3 {
    function registerVault(address vault,address creator,uint16 creatorFeeBps,uint16 rewardBps,uint256 initialSharePriceUsd18) external;
    function vaultDeployer() external view returns(address);
}

interface IVaultIdentityV3 {
    function factory() external view returns(address);
    function creator() external view returns(address);
    function creatorFeeBps() external view returns(uint16);
    function initialSharePriceUsd18() external view returns(uint256);
    function shareToken() external view returns(address);
    function incomeHub() external view returns(address);
    function governor() external view returns(address);
}

/// @notice Canonical Indexio V3 vault deployer.
/// @dev The audited vault creation bytecode is supplied as calldata rather than embedded in this
///      contract's runtime. The prefix hash and exact constructor suffix are verified before CREATE,
///      keeping this deployer well below EIP-170 while preserving canonical vault creation.
contract IndexioVaultDeployerV3 is Ownable {
    bytes32 public immutable vaultCreationCodeHash;
    uint32 public immutable vaultCreationCodeLength;
    address public canonicalFactory;
    bool public factoryLocked;

    event FactoryLocked(address indexed factory);
    event VaultDeployed(
        address indexed factory,
        address indexed creator,
        address indexed vault,
        address shareToken,
        address incomeHub,
        address governor,
        uint256 initialSharePriceUsd18
    );

    constructor(address owner_, bytes32 creationCodeHash_, uint32 creationCodeLength_) Ownable(owner_) {
        require(owner_ != address(0), "owner");
        require(creationCodeHash_ != bytes32(0) && creationCodeLength_ > 0, "vault code");
        vaultCreationCodeHash = creationCodeHash_;
        vaultCreationCodeLength = creationCodeLength_;
    }

    function setFactoryOnce(address factory) external onlyOwner {
        require(!factoryLocked && factory.code.length > 0, "factory");
        require(IFactoryRegisterV3(factory).vaultDeployer() == address(this), "not canonical");
        canonicalFactory = factory;
        factoryLocked = true;
        emit FactoryLocked(factory);
    }

    function deploy(
        bytes calldata initCode,
        string calldata name,
        string calldata symbol,
        address[] calldata assets,
        uint16[] calldata weights,
        uint16 creatorFeeBps,
        uint16 creatorIncomeRewardBps,
        uint256 initialSharePriceUsd18
    ) external returns(address vault) {
        require(factoryLocked && initialSharePriceUsd18 > 0, "config");

        bytes memory expectedArgs = abi.encode(
            canonicalFactory,
            msg.sender,
            name,
            symbol,
            assets,
            weights,
            creatorFeeBps,
            creatorIncomeRewardBps,
            initialSharePriceUsd18
        );
        uint256 creationLength = uint256(vaultCreationCodeLength);
        require(initCode.length == creationLength + expectedArgs.length, "init length");
        require(keccak256(initCode[:creationLength]) == vaultCreationCodeHash, "vault bytecode");
        require(keccak256(initCode[creationLength:]) == keccak256(expectedArgs), "constructor args");

        bytes memory code = initCode;
        assembly ("memory-safe") {
            vault := create(0, add(code, 0x20), mload(code))
        }
        require(vault != address(0) && vault.code.length > 0, "deploy failed");

        IVaultIdentityV3 v = IVaultIdentityV3(vault);
        require(
            v.factory() == canonicalFactory &&
            v.creator() == msg.sender &&
            v.creatorFeeBps() == creatorFeeBps &&
            v.initialSharePriceUsd18() == initialSharePriceUsd18,
            "vault identity"
        );

        IFactoryRegisterV3(canonicalFactory).registerVault(
            vault,
            msg.sender,
            creatorFeeBps,
            creatorIncomeRewardBps,
            initialSharePriceUsd18
        );
        emit VaultDeployed(
            canonicalFactory,
            msg.sender,
            vault,
            v.shareToken(),
            v.incomeHub(),
            v.governor(),
            initialSharePriceUsd18
        );
    }
}
