// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndexioFactory} from "./interfaces/IIndexioFactory.sol";
import {IIndexioVault} from "./interfaces/IIndexioVault.sol";
import {IIndexioSwapAdapter} from "./interfaces/IIndexioSwapAdapter.sol";

/// @notice Oracleless, two-party rebalance path: creator proposes scope; Indexio governance executes with current min-out.
/// @dev Assets can only move from one registered constituent to another and output is delivered directly back to the vault.
contract IndexioRebalanceRouter is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant PROPOSAL_DELAY = 1 hours;
    uint256 public constant PROPOSAL_LIFETIME = 3 days;
    uint256 public constant REBALANCE_COOLDOWN = 6 hours;
    uint256 public constant MAX_SOURCE_TURNOVER_BPS = 2_000; // max 20% of a source asset per execution
    uint256 public constant ADAPTER_DELAY = 1 days;
    uint256 private constant BPS = 10_000;

    struct Proposal {
        address tokenIn;
        address tokenOut;
        uint256 maxAmountIn;
        uint64 validAt;
        uint64 expiresAt;
    }

    IIndexioFactory public immutable factory;
    mapping(address => Proposal) public proposalOf;
    mapping(address => uint256) public lastRebalanceAt;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public adapterValidAt;

    error InvalidVault();
    error InvalidAsset();
    error InvalidAmount();
    error InvalidAdapter();
    error NotCreator();
    error TooEarly();
    error Expired();
    error Cooldown();
    error Slippage();
    error UnsupportedTokenBehavior();

    event RebalanceProposed(address indexed vault,address indexed tokenIn,address indexed tokenOut,uint256 maxAmountIn,uint256 validAt,uint256 expiresAt);
    event RebalanceCancelled(address indexed vault);
    event Rebalanced(address indexed vault,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut);
    event AdapterProposed(address indexed adapter,uint256 validAt);
    event AdapterApproval(address indexed adapter,bool approved);

    constructor(address owner_,address factory_) Ownable(owner_) {
        if (owner_ == address(0) || factory_ == address(0)) revert InvalidVault();
        factory = IIndexioFactory(factory_);
    }

    function setPaused(bool p) external onlyOwner { if (p) _pause(); else _unpause(); }

    function proposeAdapter(address adapter) external onlyOwner {
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidAdapter();
        adapterValidAt[adapter] = block.timestamp + ADAPTER_DELAY;
        emit AdapterProposed(adapter,adapterValidAt[adapter]);
    }
    function activateAdapter(address adapter) external onlyOwner {
        uint256 t = adapterValidAt[adapter];
        if (t == 0 || block.timestamp < t) revert TooEarly();
        approvedAdapter[adapter] = true;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter,true);
    }
    function disableAdapter(address adapter) external onlyOwner {
        approvedAdapter[adapter] = false;
        delete adapterValidAt[adapter];
        emit AdapterApproval(adapter,false);
    }

    function proposeRebalance(address vault,address tokenIn,address tokenOut,uint256 maxAmountIn) external whenNotPaused {
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        IIndexioVault v = IIndexioVault(vault);
        if (msg.sender != v.creator()) revert NotCreator();
        if (v.closed()) revert InvalidVault();
        if (tokenIn == tokenOut || maxAmountIn == 0 || !_isConstituent(v,tokenIn) || !_isConstituent(v,tokenOut)) revert InvalidAsset();

        uint64 validAt = uint64(block.timestamp + PROPOSAL_DELAY);
        uint64 expiresAt = uint64(block.timestamp + PROPOSAL_LIFETIME);
        proposalOf[vault] = Proposal(tokenIn,tokenOut,maxAmountIn,validAt,expiresAt);
        emit RebalanceProposed(vault,tokenIn,tokenOut,maxAmountIn,validAt,expiresAt);
    }

    function cancelRebalance(address vault) external {
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        if (msg.sender != IIndexioVault(vault).creator() && msg.sender != owner()) revert NotCreator();
        delete proposalOf[vault];
        emit RebalanceCancelled(vault);
    }

    /// @notice Execution is governance-controlled because, without an oracle, minOut cannot be autonomously judged for fairness.
    function executeRebalance(
        address vault,uint256 amountIn,address adapter,uint256 minAmountOut,bytes calldata routeData,uint256 deadline
    ) external onlyOwner nonReentrant whenNotPaused returns(uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (!factory.isIndexVault(vault)) revert InvalidVault();
        if (!factory.isRebalanceRouter(address(this))) revert InvalidVault();
        IIndexioVault v = IIndexioVault(vault);
        if (v.closed()) revert InvalidVault();

        Proposal memory p = proposalOf[vault];
        if (p.validAt == 0 || block.timestamp < p.validAt) revert TooEarly();
        if (block.timestamp > p.expiresAt) revert Expired();
        if (block.timestamp < lastRebalanceAt[vault] + REBALANCE_COOLDOWN) revert Cooldown();
        if (amountIn == 0 || amountIn > p.maxAmountIn || minAmountOut == 0) revert InvalidAmount();
        if (!approvedAdapter[adapter]) revert InvalidAdapter();

        uint256 vaultSourceBalance = IERC20(p.tokenIn).balanceOf(vault);
        if (amountIn > (vaultSourceBalance * MAX_SOURCE_TURNOVER_BPS) / BPS) revert InvalidAmount();

        uint256 beforeIn = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(p.tokenOut).balanceOf(vault);
        v.rebalanceTransferOut(p.tokenIn,address(this),amountIn);
        if (IERC20(p.tokenIn).balanceOf(address(this)) - beforeIn != amountIn) revert UnsupportedTokenBehavior();

        IERC20(p.tokenIn).safeTransfer(adapter,amountIn);
        amountOut = IIndexioSwapAdapter(adapter).swapExactInput(
            p.tokenIn,p.tokenOut,amountIn,minAmountOut,vault,routeData
        );
        uint256 got = IERC20(p.tokenOut).balanceOf(vault) - beforeOut;
        if (got != amountOut || got < minAmountOut) revert Slippage();

        lastRebalanceAt[vault] = block.timestamp;
        delete proposalOf[vault];
        emit Rebalanced(vault,p.tokenIn,p.tokenOut,amountIn,amountOut);
    }

    function _isConstituent(IIndexioVault v,address token) internal view returns(bool) {
        address[] memory a = v.assets();
        for (uint256 i; i < a.length; ++i) if (a[i] == token) return true;
        return false;
    }
}
