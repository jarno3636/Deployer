// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IIndexioFactoryV25 {
    function isIndexVault(address vault) external view returns(bool);
    function creatorOf(address vault) external view returns(address);
    function feeTreasury() external view returns(address);
    function registry() external view returns(address);
    function isExecutionRouter(address router) external view returns(bool);
    function isRebalanceRouter(address router) external view returns(bool);
    function isReinvestmentRouter(address router) external view returns(bool);
    function isIncomeSource(address vault,address source) external view returns(bool);
}
