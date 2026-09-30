// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IndexioVaultV25} from "./IndexioVaultV25.sol";
import {IndexioVaultDeployerV25} from "./IndexioVaultDeployerV25.sol";

interface IIndexioAssetRegistryV25 {
    function requireAsset(address asset,uint16 weight) external view returns(uint8);
}

/// @notice Indexio V2.5 factory with a one-time fast bootstrap window.
/// @dev During bootstrap the Safe can wire the initial reviewed protocol immediately.
///      Once finalizeBootstrap() is called, bootstrap can NEVER be reopened and all NEW
///      privileged additions use proposal/activation delays. Revocations remain immediate.
contract IndexioFactoryV25 is Ownable2Step {
    uint256 public constant MAX_ASSETS = 20;
    uint256 public constant MIN_START_PRICE = 1e17;
    uint256 public constant MAX_START_PRICE = 1_000e18;
    uint256 public constant ROUTER_DELAY = 24 hours;
    uint256 public constant INCOME_SOURCE_DELAY = 6 hours;
    uint256 public constant TREASURY_DELAY = 24 hours;
    uint256 public constant DEFAULT_REINVESTMENT_DELAY = 24 hours;

    IIndexioAssetRegistryV25 public immutable registry;
    address public immutable settlementToken;
    IndexioVaultDeployerV25 public immutable vaultDeployer;
    address public feeTreasury;
    address public defaultReinvestmentRouter;
    bool public bootstrapFinalized;

    address[] public allVaults;
    mapping(address => bool) public isIndexVault;
    mapping(address => address) public creatorOf;
    mapping(address => bool) public isExecutionRouter;
    mapping(address => bool) public isRebalanceRouter;
    mapping(address => bool) public isReinvestmentRouter;
    mapping(address => mapping(address => bool)) public isIncomeSource;

    mapping(address => uint256) public pendingExecutionRouterValidAt;
    mapping(address => uint256) public pendingRebalanceRouterValidAt;
    mapping(address => uint256) public pendingReinvestmentRouterValidAt;
    mapping(address => mapping(address => uint256)) public pendingIncomeSourceValidAt;
    address public pendingFeeTreasury;
    uint256 public pendingFeeTreasuryValidAt;
    address public pendingDefaultReinvestmentRouter;
    uint256 public pendingDefaultReinvestmentRouterValidAt;

    error InvalidConfig();
    error InvalidComposition();
    error InvalidPrice();
    error InvalidTreasury();
    error BootstrapClosed();
    error BootstrapAlreadyFinalized();
    error TooEarly();
    error NothingPending();

    event IndexLaunched(address indexed creator,address indexed vault,address indexed token,string name,string symbol,address[] assets,uint16[] weights,uint256 initialSharePriceUsd18,uint16 distributionBps,address incomeDistributor);
    event FeeTreasuryUpdated(address indexed oldTreasury,address indexed newTreasury);
    event FeeTreasuryProposed(address indexed treasury,uint256 validAt);
    event ExecutionRouterSet(address indexed router,bool approved);
    event RebalanceRouterSet(address indexed router,bool approved);
    event ReinvestmentRouterSet(address indexed router,bool approved);
    event RouterProposed(bytes32 indexed role,address indexed router,uint256 validAt);
    event IncomeSourceSet(address indexed vault,address indexed source,bool approved);
    event IncomeSourceProposed(address indexed vault,address indexed source,uint256 validAt);
    event DefaultReinvestmentRouterSet(address indexed router);
    event DefaultReinvestmentRouterProposed(address indexed router,uint256 validAt);
    event BootstrapFinalized(address indexed owner);
    event VaultClosed(address indexed vault);
    event VaultAccidentalTokenRecovered(address indexed vault,address indexed token,address indexed recipient,uint256 amount);

    constructor(address owner_,address registry_,address settlement_,address treasury_,address vaultDeployer_) Ownable(owner_) {
        if(owner_==address(0)||registry_==address(0)||settlement_==address(0)||treasury_==address(0)||vaultDeployer_==address(0)||registry_.code.length==0||settlement_.code.length==0||vaultDeployer_.code.length==0) revert InvalidConfig();
        registry=IIndexioAssetRegistryV25(registry_);
        settlementToken=settlement_;
        feeTreasury=treasury_;
        vaultDeployer=IndexioVaultDeployerV25(vaultDeployer_);
    }

    // ---------- one-time bootstrap ----------
    function setFeeTreasury(address treasury_) external onlyOwner {
        if(bootstrapFinalized) revert BootstrapClosed();
        _setFeeTreasury(treasury_);
    }
    function setExecutionRouter(address router,bool approved) external onlyOwner {
        if(bootstrapFinalized && approved) revert BootstrapClosed();
        _setExecutionRouter(router,approved);
    }
    function setRebalanceRouter(address router,bool approved) external onlyOwner {
        if(bootstrapFinalized && approved) revert BootstrapClosed();
        _setRebalanceRouter(router,approved);
    }
    function setReinvestmentRouter(address router,bool approved) external onlyOwner {
        if(bootstrapFinalized && approved) revert BootstrapClosed();
        _setReinvestmentRouter(router,approved);
    }
    function setDefaultReinvestmentRouter(address router) external onlyOwner {
        if(bootstrapFinalized) revert BootstrapClosed();
        _setDefaultReinvestmentRouter(router);
    }
    function setIncomeSource(address vault,address source,bool approved) external onlyOwner {
        if(bootstrapFinalized && approved) revert BootstrapClosed();
        _setIncomeSource(vault,source,approved);
    }
    function finalizeBootstrap() external onlyOwner {
        if(bootstrapFinalized) revert BootstrapAlreadyFinalized();
        if(defaultReinvestmentRouter==address(0)||!isReinvestmentRouter[defaultReinvestmentRouter]) revert InvalidConfig();
        bootstrapFinalized=true;
        emit BootstrapFinalized(msg.sender);
    }

    // ---------- post-bootstrap delayed additions ----------
    function proposeExecutionRouter(address router) external onlyOwner { _requirePostBootstrap(); _validContractWhenEnabling(router,true); uint256 t=block.timestamp+ROUTER_DELAY; pendingExecutionRouterValidAt[router]=t; emit RouterProposed(keccak256("EXECUTION"),router,t); }
    function activateExecutionRouter(address router) external onlyOwner { _activatePending(pendingExecutionRouterValidAt[router]); delete pendingExecutionRouterValidAt[router]; _setExecutionRouter(router,true); }
    function proposeRebalanceRouter(address router) external onlyOwner { _requirePostBootstrap(); _validContractWhenEnabling(router,true); uint256 t=block.timestamp+ROUTER_DELAY; pendingRebalanceRouterValidAt[router]=t; emit RouterProposed(keccak256("REBALANCE"),router,t); }
    function activateRebalanceRouter(address router) external onlyOwner { _activatePending(pendingRebalanceRouterValidAt[router]); delete pendingRebalanceRouterValidAt[router]; _setRebalanceRouter(router,true); }
    function proposeReinvestmentRouter(address router) external onlyOwner { _requirePostBootstrap(); _validContractWhenEnabling(router,true); uint256 t=block.timestamp+ROUTER_DELAY; pendingReinvestmentRouterValidAt[router]=t; emit RouterProposed(keccak256("REINVESTMENT"),router,t); }
    function activateReinvestmentRouter(address router) external onlyOwner { _activatePending(pendingReinvestmentRouterValidAt[router]); delete pendingReinvestmentRouterValidAt[router]; _setReinvestmentRouter(router,true); }

    function proposeIncomeSource(address vault,address source) external onlyOwner {
        _requirePostBootstrap();
        if(!isIndexVault[vault]||source==address(0)||source.code.length==0) revert InvalidConfig();
        uint256 t=block.timestamp+INCOME_SOURCE_DELAY;
        pendingIncomeSourceValidAt[vault][source]=t;
        emit IncomeSourceProposed(vault,source,t);
    }
    function activateIncomeSource(address vault,address source) external onlyOwner {
        _activatePending(pendingIncomeSourceValidAt[vault][source]);
        delete pendingIncomeSourceValidAt[vault][source];
        _setIncomeSource(vault,source,true);
    }

    function proposeFeeTreasury(address treasury_) external onlyOwner {
        _requirePostBootstrap();
        if(treasury_==address(0)) revert InvalidTreasury();
        pendingFeeTreasury=treasury_;
        pendingFeeTreasuryValidAt=block.timestamp+TREASURY_DELAY;
        emit FeeTreasuryProposed(treasury_,pendingFeeTreasuryValidAt);
    }
    function activateFeeTreasury() external onlyOwner {
        _activatePending(pendingFeeTreasuryValidAt);
        address t=pendingFeeTreasury;
        pendingFeeTreasury=address(0); pendingFeeTreasuryValidAt=0;
        _setFeeTreasury(t);
    }

    function proposeDefaultReinvestmentRouter(address router) external onlyOwner {
        _requirePostBootstrap();
        if(!isReinvestmentRouter[router]) revert InvalidConfig();
        pendingDefaultReinvestmentRouter=router;
        pendingDefaultReinvestmentRouterValidAt=block.timestamp+DEFAULT_REINVESTMENT_DELAY;
        emit DefaultReinvestmentRouterProposed(router,pendingDefaultReinvestmentRouterValidAt);
    }
    function activateDefaultReinvestmentRouter() external onlyOwner {
        _activatePending(pendingDefaultReinvestmentRouterValidAt);
        address r=pendingDefaultReinvestmentRouter;
        pendingDefaultReinvestmentRouter=address(0); pendingDefaultReinvestmentRouterValidAt=0;
        _setDefaultReinvestmentRouter(r);
    }

    // ---------- index lifecycle ----------
    function launchIndex(string calldata name,string calldata symbol,address[] calldata assets,uint16[] calldata weights,uint256 initialSharePriceUsd18,uint16 distributionBps) external returns(address vault,address token) {
        if(!bootstrapFinalized) revert BootstrapClosed();
        uint256 n=assets.length;
        if(bytes(name).length==0||bytes(name).length>64||bytes(symbol).length==0||bytes(symbol).length>12) revert InvalidConfig();
        if(n<2||n>MAX_ASSETS||n!=weights.length) revert InvalidComposition();
        if(initialSharePriceUsd18<MIN_START_PRICE||initialSharePriceUsd18>MAX_START_PRICE) revert InvalidPrice();
        if(distributionBps>10_000) revert InvalidConfig();
        uint256 sum;
        for(uint256 i;i<n;++i){
            if(assets[i]==address(0)||weights[i]==0) revert InvalidComposition();
            for(uint256 j;j<i;++j) if(assets[j]==assets[i]) revert InvalidComposition();
            sum+=weights[i]; registry.requireAsset(assets[i],weights[i]);
        }
        if(sum!=10_000) revert InvalidComposition();
        if(distributionBps<10_000 && (defaultReinvestmentRouter==address(0)||!isReinvestmentRouter[defaultReinvestmentRouter])) revert InvalidConfig();

        vault=vaultDeployer.deployVault(msg.sender,settlementToken,name,symbol,assets,weights,initialSharePriceUsd18,distributionBps);
        IndexioVaultV25 v=IndexioVaultV25(vault); token=address(v.shareToken());
        allVaults.push(vault); isIndexVault[vault]=true; creatorOf[vault]=msg.sender;

        // Compound/Hybrid vaults automatically trust the already-reviewed default reinvestment router.
        // This removes a per-vault waiting period without granting any new router authority.
        if(distributionBps<10_000){
            isIncomeSource[vault][defaultReinvestmentRouter]=true;
            emit IncomeSourceSet(vault,defaultReinvestmentRouter,true);
        }

        emit IndexLaunched(msg.sender,vault,token,name,symbol,assets,weights,initialSharePriceUsd18,distributionBps,address(v.incomeDistributor()));
    }

    function setVaultPause(address vault,bool deposits,bool income,bool rebalance,bool reinvestment) external onlyOwner {
        if(!isIndexVault[vault]) revert InvalidConfig();
        IndexioVaultV25(vault).setPauseState(deposits,income,rebalance,reinvestment);
    }
    function closeVault(address vault) external onlyOwner { if(!isIndexVault[vault]) revert InvalidConfig(); IndexioVaultV25(vault).close(); emit VaultClosed(vault); }
    /// @notice Recover only unrelated ERC-20s accidentally sent to a vault; destination is fixed to the current fee treasury.
    function recoverVaultAccidentalToken(address vault,address token,uint256 amount) external onlyOwner { if(!isIndexVault[vault]||token==address(0)||amount==0) revert InvalidConfig(); address recipient=feeTreasury; if(recipient==address(0)) revert InvalidTreasury(); IndexioVaultV25(vault).recoverAccidentalToken(token,recipient,amount); emit VaultAccidentalTokenRecovered(vault,token,recipient,amount); }
    function vaultCount() external view returns(uint256){ return allVaults.length; }

    // ---------- internal ----------
    function _setFeeTreasury(address treasury_) internal { if(treasury_==address(0)) revert InvalidTreasury(); address old=feeTreasury; feeTreasury=treasury_; emit FeeTreasuryUpdated(old,treasury_); }
    function _setExecutionRouter(address router,bool approved) internal { _validContractWhenEnabling(router,approved); isExecutionRouter[router]=approved; if(!approved) delete pendingExecutionRouterValidAt[router]; emit ExecutionRouterSet(router,approved); }
    function _setRebalanceRouter(address router,bool approved) internal { _validContractWhenEnabling(router,approved); isRebalanceRouter[router]=approved; if(!approved) delete pendingRebalanceRouterValidAt[router]; emit RebalanceRouterSet(router,approved); }
    function _setReinvestmentRouter(address router,bool approved) internal { _validContractWhenEnabling(router,approved); isReinvestmentRouter[router]=approved; if(!approved){ delete pendingReinvestmentRouterValidAt[router]; if(defaultReinvestmentRouter==router){ defaultReinvestmentRouter=address(0); emit DefaultReinvestmentRouterSet(address(0)); } } emit ReinvestmentRouterSet(router,approved); }
    function _setDefaultReinvestmentRouter(address router) internal { if(router==address(0)||!isReinvestmentRouter[router]) revert InvalidConfig(); defaultReinvestmentRouter=router; emit DefaultReinvestmentRouterSet(router); }
    function _setIncomeSource(address vault,address source,bool approved) internal { if(!isIndexVault[vault]||source==address(0)||(approved&&source.code.length==0)) revert InvalidConfig(); isIncomeSource[vault][source]=approved; if(!approved) delete pendingIncomeSourceValidAt[vault][source]; emit IncomeSourceSet(vault,source,approved); }
    function _validContractWhenEnabling(address target,bool approved) internal view { if(target==address(0)||(approved&&target.code.length==0)) revert InvalidConfig(); }
    function _requirePostBootstrap() internal view { if(!bootstrapFinalized) revert BootstrapClosed(); }
    function _activatePending(uint256 validAt) internal view { if(validAt==0) revert NothingPending(); if(block.timestamp<validAt) revert TooEarly(); }
}
