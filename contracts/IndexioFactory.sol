// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IndexioAssetRegistry} from "./IndexioAssetRegistry.sol";
import {IndexioVault} from "./IndexioVault.sol";
import {IndexioVaultDeployer} from "./IndexioVaultDeployer.sol";

contract IndexioFactory is Ownable2Step {
    uint256 public constant MAX_ASSETS = 20;
    uint256 public constant MIN_START_PRICE = 1e17;      // $0.10, 18-decimal display denomination
    uint256 public constant MAX_START_PRICE = 1_000e18; // $1,000
    uint256 public constant GOVERNANCE_DELAY = 2 days;
    uint256 public constant INCOME_SOURCE_DELAY = 1 days;

    IndexioAssetRegistry public immutable registry;
    address public immutable settlementToken;
    IndexioVaultDeployer public immutable vaultDeployer;

    address public feeTreasury;
    address public pendingFeeTreasury;
    uint256 public pendingTreasuryValidAt;

    address[] public allVaults;
    mapping(address => bool) public isIndexVault;
    mapping(address => address) public creatorOf;

    mapping(address => bool) public isExecutionRouter;
    mapping(address => uint256) public pendingExecutionRouterValidAt;
    mapping(address => bool) public isRebalanceRouter;
    mapping(address => uint256) public pendingRebalanceRouterValidAt;

    mapping(address => mapping(address => bool)) public isIncomeSource;
    mapping(address => mapping(address => uint256)) public pendingIncomeSourceValidAt;

    error InvalidConfig();
    error InvalidComposition();
    error InvalidPrice();
    error InvalidTreasury();
    error TooEarly();

    event IndexLaunched(
        address indexed creator,
        address indexed vault,
        address indexed token,
        string name,
        string symbol,
        address[] assets,
        uint16[] weights,
        uint256 initialSharePriceUsd18,
        uint16 distributionBps,
        address incomeDistributor
    );
    event TreasuryChangeProposed(address indexed treasury, uint256 validAt);
    event FeeTreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event ExecutionRouterProposed(address indexed router, uint256 validAt);
    event ExecutionRouterSet(address indexed router, bool approved);
    event RebalanceRouterProposed(address indexed router, uint256 validAt);
    event RebalanceRouterSet(address indexed router, bool approved);
    event IncomeSourceProposed(address indexed vault, address indexed source, uint256 validAt);
    event IncomeSourceSet(address indexed vault, address indexed source, bool approved);
    event VaultClosed(address indexed vault);

    constructor(
        address owner_,
        address registry_,
        address settlement_,
        address treasury_,
        address vaultDeployer_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || registry_ == address(0) || settlement_ == address(0) ||
            treasury_ == address(0) || vaultDeployer_ == address(0) || vaultDeployer_.code.length == 0
        ) {
            revert InvalidConfig();
        }
        registry = IndexioAssetRegistry(registry_);
        settlementToken = settlement_;
        feeTreasury = treasury_;
        vaultDeployer = IndexioVaultDeployer(vaultDeployer_);
    }

    function proposeFeeTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidTreasury();
        pendingFeeTreasury = treasury_;
        pendingTreasuryValidAt = block.timestamp + GOVERNANCE_DELAY;
        emit TreasuryChangeProposed(treasury_, pendingTreasuryValidAt);
    }

    function acceptFeeTreasury() external onlyOwner {
        if (pendingFeeTreasury == address(0) || block.timestamp < pendingTreasuryValidAt) revert TooEarly();
        address old = feeTreasury;
        feeTreasury = pendingFeeTreasury;
        pendingFeeTreasury = address(0);
        pendingTreasuryValidAt = 0;
        emit FeeTreasuryUpdated(old, feeTreasury);
    }

    function launchIndex(
        string calldata name,
        string calldata symbol,
        address[] calldata assets,
        uint16[] calldata weights,
        uint256 initialSharePriceUsd18,
        uint16 distributionBps
    ) external returns (address vault, address token) {
        uint256 n = assets.length;
        if (bytes(name).length == 0 || bytes(name).length > 64 || bytes(symbol).length == 0 || bytes(symbol).length > 12) {
            revert InvalidConfig();
        }
        if (n < 2 || n > MAX_ASSETS || n != weights.length) revert InvalidComposition();
        if (initialSharePriceUsd18 < MIN_START_PRICE || initialSharePriceUsd18 > MAX_START_PRICE) revert InvalidPrice();
        if (distributionBps > 10_000) revert InvalidConfig();

        uint256 sum;
        bool hasSettlement;
        for (uint256 i; i < n; ++i) {
            if (assets[i] == address(0)) revert InvalidComposition();
            for (uint256 j; j < i; ++j) if (assets[j] == assets[i]) revert InvalidComposition();
            sum += weights[i];
            registry.requireAsset(assets[i], weights[i]);
            if (assets[i] == settlementToken) hasSettlement = true;
        }
        if (sum != 10_000) revert InvalidComposition();
        // Growth/Hybrid retains settlement token inside the vault; it must be a constituent.
        if (distributionBps < 10_000 && !hasSettlement) revert InvalidComposition();

        vault = vaultDeployer.deployVault(
            msg.sender, settlementToken, name, symbol, assets, weights, initialSharePriceUsd18, distributionBps
        );
        IndexioVault v = IndexioVault(vault);
        token = address(v.shareToken());
        allVaults.push(vault);
        isIndexVault[vault] = true;
        creatorOf[vault] = msg.sender;

        emit IndexLaunched(
            msg.sender, vault, token, name, symbol, assets, weights, initialSharePriceUsd18, distributionBps,
            address(v.incomeDistributor())
        );
    }

    function proposeExecutionRouter(address router) external onlyOwner {
        if (router == address(0) || router.code.length == 0) revert InvalidConfig();
        pendingExecutionRouterValidAt[router] = block.timestamp + GOVERNANCE_DELAY;
        emit ExecutionRouterProposed(router, pendingExecutionRouterValidAt[router]);
    }

    function activateExecutionRouter(address router) external onlyOwner {
        uint256 t = pendingExecutionRouterValidAt[router];
        if (t == 0 || block.timestamp < t) revert TooEarly();
        isExecutionRouter[router] = true;
        delete pendingExecutionRouterValidAt[router];
        emit ExecutionRouterSet(router, true);
    }

    function disableExecutionRouter(address router) external onlyOwner {
        isExecutionRouter[router] = false;
        delete pendingExecutionRouterValidAt[router];
        emit ExecutionRouterSet(router, false);
    }

    function proposeRebalanceRouter(address router) external onlyOwner {
        if (router == address(0) || router.code.length == 0) revert InvalidConfig();
        pendingRebalanceRouterValidAt[router] = block.timestamp + GOVERNANCE_DELAY;
        emit RebalanceRouterProposed(router, pendingRebalanceRouterValidAt[router]);
    }

    function activateRebalanceRouter(address router) external onlyOwner {
        uint256 t = pendingRebalanceRouterValidAt[router];
        if (t == 0 || block.timestamp < t) revert TooEarly();
        isRebalanceRouter[router] = true;
        delete pendingRebalanceRouterValidAt[router];
        emit RebalanceRouterSet(router, true);
    }

    function disableRebalanceRouter(address router) external onlyOwner {
        isRebalanceRouter[router] = false;
        delete pendingRebalanceRouterValidAt[router];
        emit RebalanceRouterSet(router, false);
    }

    function proposeIncomeSource(address vault, address source) external onlyOwner {
        if (!isIndexVault[vault] || source == address(0) || source.code.length == 0) revert InvalidConfig();
        pendingIncomeSourceValidAt[vault][source] = block.timestamp + INCOME_SOURCE_DELAY;
        emit IncomeSourceProposed(vault, source, pendingIncomeSourceValidAt[vault][source]);
    }

    function activateIncomeSource(address vault, address source) external onlyOwner {
        uint256 t = pendingIncomeSourceValidAt[vault][source];
        if (t == 0 || block.timestamp < t) revert TooEarly();
        isIncomeSource[vault][source] = true;
        delete pendingIncomeSourceValidAt[vault][source];
        emit IncomeSourceSet(vault, source, true);
    }

    function disableIncomeSource(address vault, address source) external onlyOwner {
        isIncomeSource[vault][source] = false;
        delete pendingIncomeSourceValidAt[vault][source];
        emit IncomeSourceSet(vault, source, false);
    }

    function setVaultPause(address vault, bool deposits, bool income, bool rebalance) external onlyOwner {
        if (!isIndexVault[vault]) revert InvalidConfig();
        IndexioVault(vault).setPauseState(deposits, income, rebalance);
    }

    /// @notice Permanently blocks seed/deposit/rebalance while preserving redemptions and already-earned claims.
    function closeVault(address vault) external onlyOwner {
        if (!isIndexVault[vault]) revert InvalidConfig();
        IndexioVault(vault).close();
        emit VaultClosed(vault);
    }

    function vaultCount() external view returns (uint256) { return allVaults.length; }
}
