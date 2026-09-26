// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IIndexioFactory {
    function isIndexVault(address vault) external view returns (bool);
    function creatorOf(address vault) external view returns (address);
    function feeTreasury() external view returns (address);
    function registry() external view returns (address);
    function vaultDeployer() external view returns (address);
    function isIncomeSource(address vault,address source) external view returns (bool);
    function isExecutionRouter(address router) external view returns (bool);
    function isRebalanceRouter(address router) external view returns (bool);
}
