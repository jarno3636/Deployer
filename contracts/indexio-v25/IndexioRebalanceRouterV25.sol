// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndexioFactoryV25} from "./interfaces/IIndexioFactoryV25.sol";
import {IIndexioVaultV25} from "./interfaces/IIndexioVaultV25.sol";
import {IIndexioSwapAdapterV25} from "./interfaces/IIndexioSwapAdapterV25.sol";

/// @notice Immediate but controlled two-party rebalance path: creator defines scope; governance executes within a hard turnover cap.
contract IndexioRebalanceRouterV25 is Ownable2Step,ReentrancyGuard,Pausable {
    using SafeERC20 for IERC20; uint256 public constant MAX_SOURCE_TURNOVER_BPS=2_000;uint256 private constant BPS=10_000;uint256 public constant MAX_SLIPPAGE_BPS=500;
    struct Proposal{address tokenIn;address tokenOut;uint256 maxAmountIn;uint64 validUntil;uint64 nonce;}
    IIndexioFactoryV25 public immutable factory;mapping(address=>Proposal) public proposalOf;mapping(address=>uint64) public proposalNonce;mapping(address=>bool) public approvedAdapter; uint256 public constant ADAPTER_DELAY=6 hours; bool public bootstrapFinalized; mapping(address=>uint256) public pendingAdapterValidAt;
    error InvalidVault();error BootstrapClosed();error BootstrapAlreadyFinalized();error TooEarly();error NothingPending();error InvalidAsset();error InvalidAmount();error InvalidAdapter();error NotCreator();error Expired();error Slippage();error UnsupportedTokenBehavior();
    event RebalanceAuthorized(address indexed vault,address indexed tokenIn,address indexed tokenOut,uint256 maxAmountIn,uint64 validUntil,uint64 nonce);event RebalanceCancelled(address indexed vault,uint64 nonce);event Rebalanced(address indexed vault,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint64 nonce);event AdapterApproval(address indexed adapter,bool approved);event AdapterProposed(address indexed adapter,uint256 validAt);event BootstrapFinalized(address indexed owner);
    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);
    constructor(address owner_,address factory_) Ownable(owner_){if(owner_==address(0)||factory_==address(0)||factory_.code.length==0)revert InvalidVault();factory=IIndexioFactoryV25(factory_);}
    function setPaused(bool p) external onlyOwner{if(p)_pause();else _unpause();}
    function setAdapter(address adapter,bool approved) external onlyOwner {
        if(bootstrapFinalized&&approved)revert BootstrapClosed();
        _setAdapter(adapter,approved);
    }
    function proposeAdapter(address adapter) external onlyOwner {
        if(!bootstrapFinalized)revert BootstrapClosed();
        if(adapter==address(0)||adapter.code.length==0)revert InvalidAdapter();
        uint256 t=block.timestamp+ADAPTER_DELAY;pendingAdapterValidAt[adapter]=t;emit AdapterProposed(adapter,t);
    }
    function activateAdapter(address adapter) external onlyOwner {
        uint256 t=pendingAdapterValidAt[adapter];if(t==0)revert NothingPending();if(block.timestamp<t)revert TooEarly();
        delete pendingAdapterValidAt[adapter];_setAdapter(adapter,true);
    }
    function finalizeBootstrap() external onlyOwner {if(bootstrapFinalized)revert BootstrapAlreadyFinalized();bootstrapFinalized=true;emit BootstrapFinalized(msg.sender);}
    function _setAdapter(address adapter,bool approved) internal {
        if(adapter==address(0)||(approved&&adapter.code.length==0))revert InvalidAdapter();
        approvedAdapter[adapter]=approved;if(!approved)delete pendingAdapterValidAt[adapter];emit AdapterApproval(adapter,approved);
    }
    function authorizeRebalance(address vault,address tokenIn,address tokenOut,uint256 maxAmountIn,uint64 validUntil) external whenNotPaused {
        if(!factory.isIndexVault(vault))revert InvalidVault();IIndexioVaultV25 v=IIndexioVaultV25(vault);if(msg.sender!=v.creator())revert NotCreator();if(v.closed())revert InvalidVault();if(tokenIn==tokenOut||maxAmountIn==0||validUntil<=block.timestamp||!_isConstituent(v,tokenIn)||!_isConstituent(v,tokenOut))revert InvalidAsset();uint64 n=++proposalNonce[vault];proposalOf[vault]=Proposal(tokenIn,tokenOut,maxAmountIn,validUntil,n);emit RebalanceAuthorized(vault,tokenIn,tokenOut,maxAmountIn,validUntil,n);
    }
    function cancelRebalance(address vault) external {if(!factory.isIndexVault(vault))revert InvalidVault();if(msg.sender!=IIndexioVaultV25(vault).creator()&&msg.sender!=owner())revert NotCreator();uint64 n=proposalOf[vault].nonce;delete proposalOf[vault];emit RebalanceCancelled(vault,n);}
    function executeRebalance(address vault,uint256 amountIn,address adapter,uint256 quotedAmountOut,uint256 minAmountOut,bytes calldata routeData,uint256 deadline) external onlyOwner nonReentrant whenNotPaused returns(uint256 amountOut){
        if(block.timestamp>deadline)revert Expired();if(!factory.isIndexVault(vault)||!factory.isRebalanceRouter(address(this)))revert InvalidVault();IIndexioVaultV25 v=IIndexioVaultV25(vault);if(v.closed())revert InvalidVault();Proposal memory p=proposalOf[vault];if(p.nonce==0||block.timestamp>p.validUntil)revert Expired();if(amountIn==0||amountIn>p.maxAmountIn||quotedAmountOut==0||minAmountOut==0)revert InvalidAmount();if(minAmountOut<(quotedAmountOut*(BPS-MAX_SLIPPAGE_BPS))/BPS||minAmountOut>quotedAmountOut)revert Slippage();if(!approvedAdapter[adapter])revert InvalidAdapter();uint256 bal=IERC20(p.tokenIn).balanceOf(vault);if(amountIn>(bal*MAX_SOURCE_TURNOVER_BPS)/BPS)revert InvalidAmount();uint256 beforeIn=IERC20(p.tokenIn).balanceOf(address(this));uint256 beforeOut=IERC20(p.tokenOut).balanceOf(vault);v.rebalanceTransferOut(p.tokenIn,address(this),amountIn);if(IERC20(p.tokenIn).balanceOf(address(this))-beforeIn!=amountIn)revert UnsupportedTokenBehavior();IERC20(p.tokenIn).safeTransfer(adapter,amountIn);amountOut=IIndexioSwapAdapterV25(adapter).swapExactInput(p.tokenIn,p.tokenOut,amountIn,minAmountOut,vault,routeData);uint256 got=IERC20(p.tokenOut).balanceOf(vault)-beforeOut;if(got!=amountOut||got<minAmountOut)revert Slippage();delete proposalOf[vault];emit Rebalanced(vault,p.tokenIn,p.tokenOut,amountIn,amountOut,p.nonce);
    }
    function _isConstituent(IIndexioVaultV25 v,address token) internal view returns(bool){address[] memory a=v.assets();for(uint256 i;i<a.length;++i)if(a[i]==token)return true;return false;}

    /// @notice Recover an ERC-20 accidentally sent outside an active atomic operation. Recipient is fixed to owner/Safe.
    function recoverAccidentalToken(address token,uint256 amount) external onlyOwner nonReentrant {
        if(token==address(0)||amount==0)revert InvalidAmount();
        address recipient=owner();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }
}
