// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IndexioShareToken,IIndexioIncomeHook} from "./IndexioShareToken.sol";

/// @notice Cumulative per-share accounting for recognized cash income.
/// @dev Remainder dust is carried into the next recognition event rather than stranded.
contract IndexioIncomeDistributor is IIndexioIncomeHook, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant ACC = 1e36;

    IERC20 public immutable incomeToken;
    IndexioShareToken public immutable shareToken;
    address public immutable vault;

    uint256 public accIncomePerShare;
    uint256 public pendingRemainder;
    uint256 public totalIncomeReceived;
    uint256 public totalIncomeAllocated;
    uint256 public totalIncomeClaimed;

    mapping(address => uint256) public debt;
    mapping(address => uint256) public accrued;

    error OnlyShare();
    error OnlyVault();
    error NoShares();
    error ZeroAmount();
    error InvalidReceiver();

    event IncomeRecorded(uint256 newIncome,uint256 allocated,uint256 carriedRemainder,uint256 accIncomePerShare);
    event IncomeClaimed(address indexed account,address indexed receiver,uint256 amount);

    constructor(address token,address share,address vault_) {
        incomeToken = IERC20(token);
        shareToken = IndexioShareToken(share);
        vault = vault_;
    }

    modifier onlyShare() { if (msg.sender != address(shareToken)) revert OnlyShare(); _; }

    function recordIncome(uint256 amount) external nonReentrant {
        if (msg.sender != vault) revert OnlyVault();
        if (amount == 0) revert ZeroAmount();
        uint256 supply = shareToken.totalSupply();
        if (supply == 0) revert NoShares();

        uint256 beforeBal = incomeToken.balanceOf(address(this));
        incomeToken.safeTransferFrom(msg.sender,address(this),amount);
        uint256 got = incomeToken.balanceOf(address(this)) - beforeBal;
        if (got != amount) revert ZeroAmount();

        totalIncomeReceived += got;
        uint256 distributable = got + pendingRemainder;
        uint256 delta = Math.mulDiv(distributable, ACC, supply);
        if (delta == 0) {
            pendingRemainder = distributable;
            emit IncomeRecorded(got,0,pendingRemainder,accIncomePerShare);
            return;
        }

        uint256 allocated = Math.mulDiv(delta, supply, ACC);
        pendingRemainder = distributable - allocated;
        totalIncomeAllocated += allocated;
        accIncomePerShare += delta;
        emit IncomeRecorded(got,allocated,pendingRemainder,accIncomePerShare);
    }

    function beforeShareUpdate(address from,address to) external onlyShare {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
    }

    function afterShareUpdate(address from,address to) external onlyShare {
        if (from != address(0)) debt[from] = Math.mulDiv(shareToken.balanceOf(from),accIncomePerShare,ACC);
        if (to != address(0)) debt[to] = Math.mulDiv(shareToken.balanceOf(to),accIncomePerShare,ACC);
    }

    function _settle(address account) internal {
        uint256 gross = Math.mulDiv(shareToken.balanceOf(account),accIncomePerShare,ACC);
        uint256 d = debt[account];
        if (gross > d) accrued[account] += gross - d;
        debt[account] = gross;
    }

    function claimable(address account) public view returns(uint256) {
        uint256 gross = Math.mulDiv(shareToken.balanceOf(account),accIncomePerShare,ACC);
        return accrued[account] + (gross > debt[account] ? gross - debt[account] : 0);
    }

    function claim(address receiver) external nonReentrant returns(uint256 amount) {
        if (receiver == address(0)) revert InvalidReceiver();
        _settle(msg.sender);
        amount = accrued[msg.sender];
        if (amount == 0) return 0;
        accrued[msg.sender] = 0;
        totalIncomeClaimed += amount;
        incomeToken.safeTransfer(receiver,amount);
        emit IncomeClaimed(msg.sender,receiver,amount);
    }
}
