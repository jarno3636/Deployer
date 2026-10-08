// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice V3.2 LI.FI adapter with reusable infrastructure allowlists, not per-token routes.
/// @dev During bootstrap the owner may approve trusted LI.FI targets, spenders and selectors immediately.
///      After bootstrap, additions require 6 hours; removals are immediate. Execution still enforces exact
///      input consumption and recipient minimum-output balance deltas.
contract IndexioLifiSwapAdapterV3 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_ROUTE_DATA_BYTES = 16_384;
    uint256 public constant ALLOWLIST_DELAY = 6 hours;
    address public immutable callerRouter;
    bool public bootstrapFinalized;
    // Recovery is deliberately fail-closed. An independent protection oracle must
    // positively certify the token as unrelated to every active/historical index.
    address public immutable recoveryTreasury;
    address public immutable recoveryOracle;
    uint256 public constant RECOVERY_DELAY = 48 hours;
    struct Recovery { uint256 amount; uint256 validAt; }
    mapping(address => Recovery) public pendingRecovery;
    event RecoveryProposed(address indexed token,uint256 amount,uint256 validAt);
    event RecoveryCancelled(address indexed token);


    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public allowedSpender;
    mapping(bytes4 => bool) public allowedSelector;
    mapping(bytes32 => uint256) public pendingInfrastructureValidAt;

    error OnlyCallerRouter(); error InvalidAddress(); error InvalidRoute(); error InvalidAmount();
    error UntrustedLifiInfrastructure(); error SwapFailed(bytes reason); error InputNotConsumed(); error Slippage();
    error BootstrapClosed(); error BootstrapAlreadyFinalized(); error TooEarly(); error NothingPending();

    event TargetSet(address indexed target,bool allowed);
    event SpenderSet(address indexed spender,bool allowed);
    event SelectorSet(bytes4 indexed selector,bool allowed);
    event InfrastructureProposed(uint8 indexed kind,bytes32 indexed value,uint256 validAt);
    event BootstrapFinalized(address indexed owner);
    event SwapExecuted(address indexed tokenIn,address indexed tokenOut,address indexed recipient,uint256 amountIn,uint256 amountOut,address target,address spender,bytes4 selector);
    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);

    constructor(address owner_, address callerRouter_, address recoveryTreasury_, address recoveryOracle_) Ownable(owner_) {
        if(owner_==address(0)||callerRouter_==address(0)||callerRouter_.code.length==0) revert InvalidAddress();
        if(recoveryTreasury_==address(0)||recoveryOracle_.code.length==0) revert InvalidAddress();
        callerRouter=callerRouter_;
        recoveryTreasury=recoveryTreasury_;
        recoveryOracle=recoveryOracle_;
    }
    modifier onlyCaller(){if(msg.sender!=callerRouter)revert OnlyCallerRouter();_;}

    function setTarget(address target,bool allowed) external onlyOwner { if(bootstrapFinalized&&allowed) revert BootstrapClosed(); _setTarget(target,allowed); }
    function setSpender(address spender,bool allowed) external onlyOwner { if(bootstrapFinalized&&allowed) revert BootstrapClosed(); _setSpender(spender,allowed); }
    function setSelector(bytes4 selector,bool allowed) external onlyOwner { if(bootstrapFinalized&&allowed) revert BootstrapClosed(); _setSelector(selector,allowed); }

    function proposeTarget(address target) external onlyOwner { _propose(1,bytes32(uint256(uint160(target))),target!=address(0)&&target.code.length>0); }
    function proposeSpender(address spender) external onlyOwner { _propose(2,bytes32(uint256(uint160(spender))),spender!=address(0)&&spender.code.length>0); }
    function proposeSelector(bytes4 selector) external onlyOwner { _propose(3,bytes32(selector),selector!=bytes4(0)); }
    function activateTarget(address target) external onlyOwner { _activate(1,bytes32(uint256(uint160(target)))); _setTarget(target,true); }
    function activateSpender(address spender) external onlyOwner { _activate(2,bytes32(uint256(uint160(spender)))); _setSpender(spender,true); }
    function activateSelector(bytes4 selector) external onlyOwner { _activate(3,bytes32(selector)); _setSelector(selector,true); }

    function finalizeBootstrap() external onlyOwner { if(bootstrapFinalized) revert BootstrapAlreadyFinalized(); bootstrapFinalized=true; emit BootstrapFinalized(msg.sender); }

    function _pendingKey(uint8 kind,bytes32 value) internal pure returns(bytes32){ return keccak256(abi.encode(kind,value)); }
    function _propose(uint8 kind,bytes32 value,bool valid) internal { if(!bootstrapFinalized) revert BootstrapClosed(); if(!valid) revert InvalidAddress(); uint256 t=block.timestamp+ALLOWLIST_DELAY; pendingInfrastructureValidAt[_pendingKey(kind,value)]=t; emit InfrastructureProposed(kind,value,t); }
    function _activate(uint8 kind,bytes32 value) internal { bytes32 key=_pendingKey(kind,value); uint256 t=pendingInfrastructureValidAt[key]; if(t==0) revert NothingPending(); if(block.timestamp<t) revert TooEarly(); delete pendingInfrastructureValidAt[key]; }
    function _setTarget(address target,bool allowed) internal { if(target==address(0)||(allowed&&target.code.length==0)) revert InvalidAddress(); allowedTarget[target]=allowed; emit TargetSet(target,allowed); }
    function _setSpender(address spender,bool allowed) internal { if(spender==address(0)||(allowed&&spender.code.length==0)) revert InvalidAddress(); allowedSpender[spender]=allowed; emit SpenderSet(spender,allowed); }
    function _setSelector(bytes4 selector,bool allowed) internal { if(selector==bytes4(0)) revert InvalidRoute(); allowedSelector[selector]=allowed; emit SelectorSet(selector,allowed); }

    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,address recipient,bytes calldata routeData) external onlyCaller nonReentrant returns(uint256 amountOut){
        if(tokenIn==address(0)||tokenOut==address(0)||recipient==address(0)||tokenIn==tokenOut||amountIn==0||minOut==0)revert InvalidAmount();
        if(routeData.length==0||routeData.length>MAX_ROUTE_DATA_BYTES)revert InvalidRoute();
        (address target,address spender,bytes memory callData)=abi.decode(routeData,(address,address,bytes));
        if(callData.length<4)revert InvalidRoute();
        bytes4 selector; assembly { selector := mload(add(callData,32)) }
        if(!allowedTarget[target]||!allowedSpender[spender]||!allowedSelector[selector])revert UntrustedLifiInfrastructure();

        uint256 inBefore=IERC20(tokenIn).balanceOf(address(this)); if(inBefore<amountIn)revert InvalidAmount();
        uint256 outBefore=IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).forceApprove(spender,amountIn);
        (bool ok,bytes memory reason)=target.call(callData);
        IERC20(tokenIn).forceApprove(spender,0);
        if(!ok)revert SwapFailed(reason);
        uint256 inAfter=IERC20(tokenIn).balanceOf(address(this)); if(inAfter+amountIn!=inBefore)revert InputNotConsumed();
        amountOut=IERC20(tokenOut).balanceOf(recipient)-outBefore; if(amountOut<minOut)revert Slippage();
        emit SwapExecuted(tokenIn,tokenOut,recipient,amountIn,amountOut,target,spender,selector);
    }

    /// @notice Oracle must fail closed on unknown assets, historical holdings,
    ///         income tokens, vault shares, settlement assets and pending operations.
    function proposeRecovery(address token,uint256 amount) external onlyOwner {
        if(token.code.length==0||amount==0) revert InvalidAmount();
        if(!_recoverable(token,amount)) revert InvalidRoute();
        uint256 when=block.timestamp+RECOVERY_DELAY;
        pendingRecovery[token]=Recovery(amount,when);
        emit RecoveryProposed(token,amount,when);
    }
    function cancelRecovery(address token) external onlyOwner {
        delete pendingRecovery[token]; emit RecoveryCancelled(token);
    }
    function executeRecovery(address token) external onlyOwner nonReentrant {
        Recovery memory r=pendingRecovery[token];
        if(r.validAt==0||block.timestamp<r.validAt) revert TooEarly();
        if(!_recoverable(token,r.amount)) revert InvalidRoute();
        delete pendingRecovery[token];
        IERC20(token).safeTransfer(recoveryTreasury,r.amount);
        emit AccidentalTokenRecovered(token,recoveryTreasury,r.amount);
    }
    function _recoverable(address token,uint256 amount) internal view returns(bool) {
        if(token.code.length==0||amount==0||IERC20(token).balanceOf(address(this))<amount) return false;
        // ERC20 allowance left over from a swap must never be recoverable.
        // Oracle is a separately deployed immutable protocol-wide guardian.
        (bool ok,bytes memory data)=recoveryOracle.staticcall(
            abi.encodeWithSignature("canRecover(address,address,uint256)",address(this),token,amount)
        );
        return ok&&data.length==32&&abi.decode(data,(bool));
    }
}
