// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IndexioShareToken} from "./IndexioShareToken.sol";
import {IndexioIncomeDistributor} from "./IndexioIncomeDistributor.sol";
import {IIndexioFactoryV25} from "./interfaces/IIndexioFactoryV25.sol";

interface IRegistryV25 { function requireAsset(address,uint16) external view returns(uint8); }

contract IndexioVaultV25 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant BPS=10_000;
    uint256 public constant INDEXIO_TRANSACTION_FEE_BPS=100;

    address public immutable factory;
    address public immutable creator;
    address public immutable settlementToken;
    IndexioShareToken public immutable shareToken;
    IndexioIncomeDistributor public immutable incomeDistributor;
    uint256 public immutable initialSharePriceUsd18;
    uint16 public immutable distributionBps;
    address[] private _assets;
    uint16[] private _weights;

    bool public seeded;
    bool public depositsPaused;
    bool public incomePaused;
    bool public rebalancePaused;
    bool public reinvestmentPaused;
    bool public closed;

    error OnlyFactory(); error OnlyExecutionRouter(); error OnlyRebalanceRouter(); error OnlyReinvestmentRouter();
    error InvalidAmount(); error InvalidReceiver(); error NotSeeded(); error AlreadySeeded(); error Slippage(); error UnsupportedToken(); error InvalidTreasury();
    error DepositsPaused(); error IncomePaused(); error RebalancePaused(); error ReinvestmentPaused(); error VaultClosed(); error UnapprovedIncomeSource(); error ReinvestmentRequired(); error AssetDisabled(); error ProtectedToken();

    event Seeded(address indexed creator,uint256 shares,uint256[] fees);
    event Deposited(address indexed caller,address indexed receiver,uint256 shares,uint256[] acceptedGross,uint256[] refunds,uint256[] fees);
    event Redeemed(address indexed owner,address indexed receiver,uint256 shares,uint256[] netAmounts,uint256[] fees);
    event IncomeProcessed(address indexed source,uint256 gross,uint256 distributed,uint256 reinvestable);
    event PauseState(bool depositsPaused,bool incomePaused,bool rebalancePaused,bool reinvestmentPaused);
    event VaultClosedPermanently();
    event RebalanceAssetReleased(address indexed router,address indexed token,uint256 amount);
    event AccidentalTokenRecovered(address indexed token,address indexed recipient,uint256 amount);

    constructor(address factory_,address creator_,address settlement_,string memory name_,string memory symbol_,address[] memory assets_,uint16[] memory weights_,uint256 initialSharePriceUsd18_,uint16 distributionBps_) {
        factory=factory_; creator=creator_; settlementToken=settlement_; _assets=assets_; _weights=weights_; initialSharePriceUsd18=initialSharePriceUsd18_; distributionBps=distributionBps_;
        shareToken=new IndexioShareToken(name_,symbol_,address(this));
        incomeDistributor=new IndexioIncomeDistributor(settlement_,address(shareToken),address(this));
        shareToken.setIncomeHook(address(incomeDistributor));
    }
    modifier onlyFactory(){ if(msg.sender!=factory) revert OnlyFactory(); _; }
    function assets() external view returns(address[] memory){return _assets;}
    function targetWeightsBps() external view returns(uint16[] memory){return _weights;}
    function assetCount() external view returns(uint256){return _assets.length;}
    function feeTreasury() public view returns(address){return IIndexioFactoryV25(factory).feeTreasury();}
    function previewNetAmount(uint256 gross) public pure returns(uint256 net,uint256 fee){ if(gross==0)return(0,0); fee=Math.mulDiv(gross,INDEXIO_TRANSACTION_FEE_BPS,BPS,Math.Rounding.Ceil); if(fee>=gross)return(0,fee); net=gross-fee; }

    function previewDeposit(uint256[] calldata grossAmounts) external view returns(uint256 shares,uint256[] memory acceptedGross,uint256[] memory refunds){ return _previewDeposit(grossAmounts); }
    function seed(address receiver,uint256[] calldata grossAmounts,uint256 initialShares) external nonReentrant returns(uint256 shares){
        if(closed)revert VaultClosed(); if(depositsPaused)revert DepositsPaused(); if(seeded)revert AlreadySeeded(); if(!IIndexioFactoryV25(factory).isExecutionRouter(msg.sender))revert OnlyExecutionRouter(); if(receiver!=creator||initialShares==0)revert InvalidReceiver();
        uint256[] memory fees=_pullSeed(msg.sender,grossAmounts); seeded=true; shares=initialShares; shareToken.mint(receiver,shares); emit Seeded(receiver,shares,fees);
    }
    function deposit(address receiver,uint256[] calldata grossAmounts,uint256 minShares,uint256 deadline) external nonReentrant returns(uint256 shares,uint256[] memory acceptedGross){
        if(block.timestamp>deadline)revert Slippage(); if(closed)revert VaultClosed(); if(depositsPaused)revert DepositsPaused(); if(!seeded)revert NotSeeded(); if(receiver==address(0))revert InvalidReceiver();
        uint256[] memory refunds;(shares,acceptedGross,refunds)=_previewDeposit(grossAmounts); if(shares==0||shares<minShares)revert Slippage();
        address treasury=feeTreasury(); if(treasury==address(0)||treasury==address(this))revert InvalidTreasury(); uint256[] memory fees=new uint256[](_assets.length);
        for(uint256 i;i<_assets.length;++i){(uint256 net,uint256 fee)=previewNetAmount(acceptedGross[i]); if(net==0)revert InvalidAmount(); _pullExact(_assets[i],msg.sender,address(this),net); if(fee>0)_pullExact(_assets[i],msg.sender,treasury,fee); fees[i]=fee;}
        shareToken.mint(receiver,shares); emit Deposited(msg.sender,receiver,shares,acceptedGross,refunds,fees);
    }
    function redeem(uint256 shares,address receiver,uint256[] calldata minNetAmounts,uint256 deadline) external nonReentrant returns(uint256[] memory netAmounts){
        if(block.timestamp>deadline)revert Slippage(); if(receiver==address(0)||shares==0||minNetAmounts.length!=_assets.length)revert InvalidReceiver(); uint256 supply=shareToken.totalSupply(); if(shares>supply||shareToken.balanceOf(msg.sender)<shares)revert InvalidAmount();
        address treasury=feeTreasury(); if(treasury==address(0)||treasury==address(this))revert InvalidTreasury(); netAmounts=new uint256[](_assets.length); uint256[] memory fees=new uint256[](_assets.length);
        for(uint256 i;i<_assets.length;++i){uint256 bal=IERC20(_assets[i]).balanceOf(address(this)); uint256 gross=shares==supply?bal:Math.mulDiv(bal,shares,supply);(uint256 net,uint256 fee)=previewNetAmount(gross);if(net<minNetAmounts[i])revert Slippage();netAmounts[i]=net;fees[i]=fee;}
        shareToken.burn(msg.sender,shares); if(shares==supply){closed=true;depositsPaused=true;rebalancePaused=true;reinvestmentPaused=true;emit VaultClosedPermanently();}
        for(uint256 i;i<_assets.length;++i){if(fees[i]>0)IERC20(_assets[i]).safeTransfer(treasury,fees[i]);if(netAmounts[i]>0)IERC20(_assets[i]).safeTransfer(receiver,netAmounts[i]);} emit Redeemed(msg.sender,receiver,shares,netAmounts,fees);
    }

    /// @notice Full-distribution income path. Hybrid/Compound must use processIncomeForReinvestment atomically via an approved Reinvestment Router.
    function processIncome(uint256 amount) external nonReentrant returns(uint256 distributed){
        if(incomePaused)revert IncomePaused(); if(!seeded||amount==0||shareToken.totalSupply()==0)revert InvalidAmount(); if(!IIndexioFactoryV25(factory).isIncomeSource(address(this),msg.sender))revert UnapprovedIncomeSource(); if(distributionBps!=BPS)revert ReinvestmentRequired();
        _pullExact(settlementToken,msg.sender,address(this),amount); distributed=amount; _recordDistributed(distributed); emit IncomeProcessed(msg.sender,amount,distributed,0);
    }

    /// @notice Hybrid/Compound path. The reinvestable portion is returned directly to the approved Reinvestment Router in the same transaction.
    function processIncomeForReinvestment(uint256 amount) external nonReentrant returns(uint256 distributed,uint256 reinvestable){
        if(incomePaused)revert IncomePaused(); if(reinvestmentPaused)revert ReinvestmentPaused(); if(!seeded||amount==0||shareToken.totalSupply()==0)revert InvalidAmount();
        IIndexioFactoryV25 f=IIndexioFactoryV25(factory); if(!f.isReinvestmentRouter(msg.sender))revert OnlyReinvestmentRouter(); if(!f.isIncomeSource(address(this),msg.sender))revert UnapprovedIncomeSource();
        _pullExact(settlementToken,msg.sender,address(this),amount); distributed=Math.mulDiv(amount,distributionBps,BPS); reinvestable=amount-distributed; if(reinvestable==0)revert ReinvestmentRequired();
        if(distributed>0)_recordDistributed(distributed); IERC20(settlementToken).safeTransfer(msg.sender,reinvestable); emit IncomeProcessed(msg.sender,amount,distributed,reinvestable);
    }

    function rebalanceTransferOut(address token,address to,uint256 amount) external nonReentrant {
        if(rebalancePaused)revert RebalancePaused(); if(closed)revert VaultClosed(); if(!IIndexioFactoryV25(factory).isRebalanceRouter(msg.sender))revert OnlyRebalanceRouter(); if(!_isConstituent(token)||to==address(0)||amount==0)revert InvalidAmount(); IERC20(token).safeTransfer(to,amount); emit RebalanceAssetReleased(msg.sender,token,amount);
    }
    function setPauseState(bool deposits,bool income,bool rebalance,bool reinvestment) external onlyFactory {depositsPaused=deposits;incomePaused=income;rebalancePaused=rebalance;reinvestmentPaused=reinvestment;emit PauseState(deposits,income,rebalance,reinvestment);}
    function close() external onlyFactory {closed=true;depositsPaused=true;rebalancePaused=true;reinvestmentPaused=true;emit VaultClosedPermanently();}

    /// @notice Recover an unrelated ERC-20 accidentally sent directly to this vault.
    /// @dev Constituents, settlementToken, and this vault's own share token are always protected. Factory sends recovery to its configured treasury.
    function recoverAccidentalToken(address token,address recipient,uint256 amount) external onlyFactory nonReentrant {
        if(token==address(0)||recipient==address(0)||amount==0)revert InvalidAmount();
        if(token==settlementToken||token==address(shareToken)||_isConstituent(token))revert ProtectedToken();
        IERC20(token).safeTransfer(recipient,amount);
        emit AccidentalTokenRecovered(token,recipient,amount);
    }

    function _recordDistributed(uint256 amount) internal { IERC20(settlementToken).forceApprove(address(incomeDistributor),amount); incomeDistributor.recordIncome(amount); IERC20(settlementToken).forceApprove(address(incomeDistributor),0); }
    function _previewDeposit(uint256[] calldata grossAmounts) internal view returns(uint256 shares,uint256[] memory acceptedGross,uint256[] memory refunds){
        uint256 n=_assets.length;if(grossAmounts.length!=n)revert InvalidAmount();acceptedGross=new uint256[](n);refunds=new uint256[](n);uint256 supply=shareToken.totalSupply();if(!seeded||supply==0)return(0,acceptedGross,refunds);uint256 minRatio=type(uint256).max;
        for(uint256 i;i<n;++i){IRegistryV25(IIndexioFactoryV25(factory).registry()).requireAsset(_assets[i],_weights[i]);uint256 bal=IERC20(_assets[i]).balanceOf(address(this));if(bal==0)revert InvalidAmount();(uint256 net,)=previewNetAmount(grossAmounts[i]);if(net==0)revert InvalidAmount();uint256 r=Math.mulDiv(net,1e18,bal);if(r<minRatio)minRatio=r;}
        shares=Math.mulDiv(supply,minRatio,1e18);if(shares==0)return(0,acceptedGross,refunds);
        for(uint256 i;i<n;++i){uint256 bal=IERC20(_assets[i]).balanceOf(address(this));uint256 neededNet=Math.mulDiv(bal,shares,supply,Math.Rounding.Ceil);uint256 gross=Math.mulDiv(neededNet,BPS,BPS-INDEXIO_TRANSACTION_FEE_BPS,Math.Rounding.Ceil);while(gross>0){(uint256 net,)=previewNetAmount(gross);if(net>=neededNet)break;gross++;}if(gross>grossAmounts[i])revert Slippage();acceptedGross[i]=gross;refunds[i]=grossAmounts[i]-gross;}
    }
    function _pullSeed(address from,uint256[] calldata grossAmounts) internal returns(uint256[] memory fees){if(grossAmounts.length!=_assets.length)revert InvalidAmount();address treasury=feeTreasury();if(treasury==address(0)||treasury==address(this))revert InvalidTreasury();fees=new uint256[](_assets.length);for(uint256 i;i<_assets.length;++i){IRegistryV25(IIndexioFactoryV25(factory).registry()).requireAsset(_assets[i],_weights[i]);(uint256 net,uint256 fee)=previewNetAmount(grossAmounts[i]);if(net==0)revert InvalidAmount();_pullExact(_assets[i],from,address(this),net);if(fee>0)_pullExact(_assets[i],from,treasury,fee);fees[i]=fee;}}
    function _pullExact(address token,address from,address to,uint256 amount) internal {uint256 beforeBal=IERC20(token).balanceOf(to);IERC20(token).safeTransferFrom(from,to,amount);if(IERC20(token).balanceOf(to)-beforeBal!=amount)revert UnsupportedToken();}
    function _isConstituent(address token) internal view returns(bool){for(uint256 i;i<_assets.length;++i)if(_assets[i]==token)return true;return false;}
}
