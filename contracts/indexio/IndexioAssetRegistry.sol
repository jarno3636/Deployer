// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Timelocked allowlist for assets that may be used by new Indexio deposits/indexes.
/// @dev Disabling is immediate; granting/enlarging permission is delayed.
contract IndexioAssetRegistry is Ownable2Step {
    uint256 public constant CONFIG_DELAY = 2 days;

    struct AssetConfig {
        bool enabled;
        uint16 maxWeightBps;
        uint8 decimals;
    }

    struct PendingAssetConfig {
        uint16 maxWeightBps;
        uint8 decimals;
        uint64 validAt;
        bool exists;
    }

    mapping(address => AssetConfig) public config;
    mapping(address => PendingAssetConfig) public pendingConfig;

    error InvalidConfig();
    error TooEarly();

    event AssetConfigProposed(address indexed asset, uint16 maxWeightBps, uint8 decimals, uint256 validAt);
    event AssetConfigured(address indexed asset, bool enabled, uint16 maxWeightBps, uint8 decimals);
    event AssetDisabled(address indexed asset);

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert InvalidConfig();
    }

    /// @notice Propose enabling an asset or increasing/changing its allowed configuration.
    function proposeAsset(address asset, uint16 maxWeightBps) external onlyOwner {
        if (asset == address(0) || asset.code.length == 0 || maxWeightBps == 0 || maxWeightBps > 10_000) {
            revert InvalidConfig();
        }
        uint8 d;
        try IERC20Metadata(asset).decimals() returns (uint8 x) {
            d = x;
        } catch {
            revert InvalidConfig();
        }
        // 24 decimals is deliberately conservative and keeps UI/math normalization bounded.
        if (d > 24) revert InvalidConfig();

        uint64 validAt = uint64(block.timestamp + CONFIG_DELAY);
        pendingConfig[asset] = PendingAssetConfig(maxWeightBps, d, validAt, true);
        emit AssetConfigProposed(asset, maxWeightBps, d, validAt);
    }

    function activateAsset(address asset) external onlyOwner {
        PendingAssetConfig memory p = pendingConfig[asset];
        if (!p.exists || block.timestamp < p.validAt) revert TooEarly();
        config[asset] = AssetConfig(true, p.maxWeightBps, p.decimals);
        delete pendingConfig[asset];
        emit AssetConfigured(asset, true, p.maxWeightBps, p.decimals);
    }

    /// @notice Emergency removal from new deposits/index creation. Existing holders can still redeem in-kind.
    function disableAsset(address asset) external onlyOwner {
        AssetConfig storage c = config[asset];
        c.enabled = false;
        delete pendingConfig[asset];
        emit AssetDisabled(asset);
    }

    function requireAsset(address asset, uint16 weight) external view returns (uint8) {
        AssetConfig memory c = config[asset];
        if (!c.enabled || weight == 0 || weight > c.maxWeightBps) revert InvalidConfig();
        return c.decimals;
    }
}
