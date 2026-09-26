// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IIndexioVault {
    function creator() external view returns(address);
    function initialSharePriceUsd18() external view returns(uint256);
    function settlementToken() external view returns(address);
    function shareToken() external view returns(address);
    function assets() external view returns(address[] memory);
    function targetWeightsBps() external view returns(uint16[] memory);
    function seeded() external view returns(bool);
    function closed() external view returns(bool);
    function previewDeposit(uint256[] calldata grossAmounts) external view returns(uint256 shares,uint256[] memory acceptedGross,uint256[] memory refunds);
    function seed(address receiver,uint256[] calldata grossAmounts,uint256 initialShares) external returns(uint256);
    function deposit(address receiver,uint256[] calldata grossAmounts,uint256 minShares,uint256 deadline) external returns(uint256 shares,uint256[] memory acceptedGross);
    function redeem(uint256 shares,address receiver,uint256[] calldata minNetAmounts,uint256 deadline) external returns(uint256[] memory);
    function rebalanceTransferOut(address token,address to,uint256 amount) external;
}
