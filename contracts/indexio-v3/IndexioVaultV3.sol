// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IndexioShareTokenV3} from "./IndexioShareTokenV3.sol";
import {IndexioIncomeHubV3} from "./IndexioIncomeHubV3.sol";
import {IndexioGovernorV3} from "./IndexioGovernorV3.sol";

interface IFactoryV3 {
    function registry() external view returns(address);
    function feeTreasury() external view returns(address);
    function safetyController() external view returns(address);
    function settlementToken() external view returns(address);
    function executionRouter() external view returns(address);
    function transferPolicy() external view returns(address);
}
interface IRegistryCheckV3 { function requireAsset(address,uint16) external view returns(uint8); }
interface ITransferPolicyV3 { function expectedReceiveBps(address) external view returns(uint16); }
interface ISafetyV3 { function depositsPaused(address) external view returns(bool); function tradingPaused(address) external view returns(bool); }
interface IShareIdentityV3 { function vault() external view returns(address); }
interface IIncomeIdentityV3 {
    function vault() external view returns(address);
    function shareToken() external view returns(address);
    function creator() external view returns(address);
    function creatorIncomeRewardBps() external view returns(uint16);
    function distributionBps() external view returns(uint16);
}
interface IGovernorIdentityV3 { function vault() external view returns(address); function token() external view returns(address); }

contract IndexioVaultV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint16 constant BPS=10_000;
    uint16 public constant INDEXIO_FEE_BPS=100;
    // Reject substantial disproportionate payments rather than gifting an
    // unintended excess of one constituent to existing shareholders.
    uint16 public constant MAX_DEPOSIT_IMBALANCE_BPS=100;

    address public immutable factory;
    address public immutable creator;
    uint16 public immutable creatorFeeBps;
    uint16 public immutable distributionBps;
    uint256 public immutable initialSharePriceUsd18;

    IndexioShareTokenV3 public shareToken;
    IndexioIncomeHubV3 public incomeHub;
    IndexioGovernorV3 public governor;
    bool public initialized;
    bool public seeded;
    bool public closed;
    uint64 public governanceNonce;
    address[] private _assets;
    uint16[] private _weights;
    mapping(address=>bool) public historicalAsset;
    mapping(address=>uint16) public lastObservedReceiveBps;

    event ComponentsInitialized(address indexed shareToken,address indexed incomeHub,address indexed governor);
    event Deposited(address indexed caller,address indexed receiver,uint256 shares);
    event Redeemed(address indexed owner,address indexed receiver,uint256 shares);
    event VaultClosed();
    event CompositionUpdated(address[] assets,uint16[] weights);
    event PreSeedCompositionUpdated(address indexed creator,address[] assets,uint16[] weights);
    event TransferBehaviorObserved(address indexed token,address indexed recipient,uint256 requested,uint256 received,uint16 receiveBps);

    modifier ready(){require(initialized,"not initialized");_;}

    constructor(address f,address c,string memory n,string memory s,address[] memory a,uint16[] memory w,uint16 cf,uint16 rewardBps,uint16 distributionBps_,uint256 initialPrice){
        require(f.code.length>0&&c!=address(0)&&bytes(n).length>0&&bytes(s).length>0&&cf<=100&&rewardBps<=2000&&distributionBps_<=10_000&&initialPrice>0,"config");
        factory=f;
        creator=c;
        creatorFeeBps=cf;
        distributionBps=distributionBps_;
        initialSharePriceUsd18=initialPrice;
        _validate(a,w);
        _assets=a;
        _weights=w;
        for(uint256 i;i<a.length;i++)historicalAsset[a[i]]=true;

        IndexioShareTokenV3 share=new IndexioShareTokenV3(n,s,address(this));
        IndexioIncomeHubV3 hub=new IndexioIncomeHubV3(address(this),address(share),c,rewardBps,distributionBps_);
        IndexioGovernorV3 gov=new IndexioGovernorV3(address(this),address(share));
        shareToken=share;
        incomeHub=hub;
        governor=gov;
        share.setIncomeHub(address(hub));
        initialized=true;
        emit ComponentsInitialized(address(share),address(hub),address(gov));
    }

    function assets() external view returns(address[] memory){return _assets;}
    function weights() external view returns(uint16[] memory){return _weights;}
    function executionRouter() external view returns(address){return IFactoryV3(factory).executionRouter();}
    function expectedReceiveBps(address token) public view returns(uint16){return ITransferPolicyV3(IFactoryV3(factory).transferPolicy()).expectedReceiveBps(token);}

    /// @notice Creator may freely fix assets/weights before the first successful investment.
    /// @dev Once seeded, direct creator editing is permanently disabled and shareholder governance takes over.
    function updatePreSeedComposition(address[] calldata a,uint16[] calldata w) external ready nonReentrant {
        require(msg.sender==creator,"creator");
        require(!seeded&&!closed&&shareToken.totalSupply()==0,"already active");
        _validate(a,w);
        _assets=a;
        _weights=w;
        for(uint256 i;i<a.length;i++)historicalAsset[a[i]]=true;
        emit PreSeedCompositionUpdated(msg.sender,a,w);
        emit CompositionUpdated(a,w);
    }

    function seed(address receiver,uint256[] calldata gross,uint256 shares) external ready nonReentrant returns(uint256 minted){
        require(!seeded&&!closed&&shareToken.totalSupply()==0,"seeded");
        require(!ISafetyV3(IFactoryV3(factory).safetyController()).depositsPaused(address(this))&&!ISafetyV3(IFactoryV3(factory).safetyController()).tradingPaused(address(this)),"paused");
        require(msg.sender==IFactoryV3(factory).executionRouter()&&receiver==creator,"router/creator");
        require(receiver!=address(0)&&gross.length==_assets.length&&shares>0,"input");
        _validate(_assets,_weights);
        address treasury=IFactoryV3(factory).feeTreasury();
        uint256 weightedScale18;
        for(uint256 i;i<_assets.length;i++){
            require(gross[i]>0,"zero");
            uint256 protocolFee=gross[i]*INDEXIO_FEE_BPS/BPS;
            uint256 creatorFee=gross[i]*creatorFeeBps/BPS;
            uint256 net=gross[i]-protocolFee-creatorFee;
            require(net>0,"net");
            uint256 actualNet=_pullReceived(_assets[i],msg.sender,address(this),net);
            if(protocolFee>0)_pullReceived(_assets[i],msg.sender,treasury,protocolFee);
            if(creatorFee>0)_pullReceived(_assets[i],msg.sender,creator,creatorFee);
            uint256 ratio=Math.min(1e18,Math.mulDiv(actualNet,1e18,net));
            weightedScale18+=Math.mulDiv(uint256(_weights[i]),ratio,BPS);
        }
        minted=Math.mulDiv(shares,weightedScale18,1e18);
        require(minted>0&&minted<=type(uint208).max,"shares");
        seeded=true;
        shareToken.mint(receiver,minted);
        emit Deposited(msg.sender,receiver,minted);
        return minted;
    }

    function deposit(uint256[] calldata gross,address receiver,uint256 minSharesOut,uint256 deadline) external ready nonReentrant returns(uint256 shares){
        require(block.timestamp<=deadline,"deadline");
        require(seeded&&!closed,"not active");
        require(!ISafetyV3(IFactoryV3(factory).safetyController()).depositsPaused(address(this)),"paused");
        require(receiver!=address(0)&&gross.length==_assets.length,"input");
        _validate(_assets,_weights);
        uint256 supply=shareToken.totalSupply();
        require(supply>0,"supply");
        uint256 feeBps=INDEXIO_FEE_BPS+creatorFeeBps;
        uint256 candidate=type(uint256).max;
        uint256[] memory beforeBal=new uint256[](_assets.length);
        for(uint256 i;i<_assets.length;i++){
            require(gross[i]>0,"zero");
            beforeBal[i]=IERC20(_assets[i]).balanceOf(address(this));
            require(beforeBal[i]>0,"empty asset");
            uint256 nominalNet=gross[i]*(BPS-feeBps)/BPS;
            uint256 expectedNet=Math.mulDiv(nominalNet,expectedReceiveBps(_assets[i]),BPS);
            candidate=Math.min(candidate,Math.mulDiv(expectedNet,supply,beforeBal[i]));
        }
        require(candidate>0,"shares");
        address treasury=IFactoryV3(factory).feeTreasury();
        shares=type(uint256).max;
        uint256[] memory capacities=new uint256[](_assets.length);
        for(uint256 i;i<_assets.length;i++){
            uint256 requiredActual=Math.mulDiv(beforeBal[i],candidate,supply,Math.Rounding.Ceil);
            uint256 rbps=expectedReceiveBps(_assets[i]);
            uint256 requiredNominal=Math.mulDiv(requiredActual,BPS,rbps,Math.Rounding.Ceil);
            uint256 acceptedGross=Math.mulDiv(requiredNominal,BPS,BPS-feeBps,Math.Rounding.Ceil);
            require(acceptedGross<=gross[i],"ratio");
            uint256 protocolFee=acceptedGross*INDEXIO_FEE_BPS/BPS;
            uint256 creatorFee=acceptedGross*creatorFeeBps/BPS;
            uint256 nominalNet=acceptedGross-protocolFee-creatorFee;
            uint256 actualNet=_pullReceived(_assets[i],msg.sender,address(this),nominalNet);
            if(protocolFee>0)_pullReceived(_assets[i],msg.sender,treasury,protocolFee);
            if(creatorFee>0)_pullReceived(_assets[i],msg.sender,creator,creatorFee);
            capacities[i]=Math.mulDiv(actualNet,supply,beforeBal[i]);
            shares=Math.min(shares,capacities[i]);
        }
        require(shares>0&&shares>=minSharesOut,"shares");
        for(uint256 i;i<capacities.length;i++){
            uint256 tolerance=Math.mulDiv(shares,MAX_DEPOSIT_IMBALANCE_BPS,BPS,Math.Rounding.Ceil);
            require(capacities[i]-shares<=tolerance+1,"imbalanced deposit");
        }
        shareToken.mint(receiver,shares);
        emit Deposited(msg.sender,receiver,shares);
    }

    function redeem(uint256 shares,address receiver,uint256[] calldata minAmountsOut,uint256 deadline) external ready nonReentrant returns(uint256[] memory amounts){
        require(block.timestamp<=deadline,"deadline");
        require(shares>0&&receiver!=address(0),"input");
        uint256 supply=shareToken.totalSupply();
        require(minAmountsOut.length==_assets.length,"mins");
        bool finalRedemption=shares==supply;
        require(shares<=shareToken.balanceOf(msg.sender),"shares");
        amounts=new uint256[](_assets.length);
        shareToken.burn(msg.sender,shares);
        address treasury=IFactoryV3(factory).feeTreasury();
        for(uint256 i;i<_assets.length;i++){
            uint256 start=IERC20(_assets[i]).balanceOf(address(this));
            uint256 gross=Math.mulDiv(start,shares,supply);
            uint256 p=gross*INDEXIO_FEE_BPS/BPS;
            uint256 c=gross*creatorFeeBps/BPS;
            uint256 nominal=gross-p-c;
            if(p>0)_pushReceived(_assets[i],treasury,p);
            if(c>0)_pushReceived(_assets[i],creator,c);
            amounts[i]=_pushReceived(_assets[i],receiver,nominal);
            require(amounts[i]>=minAmountsOut[i],"min out");
            require(start-IERC20(_assets[i]).balanceOf(address(this))<=gross,"excess debit");
        }
        if(finalRedemption){closed=true;emit VaultClosed();}
        emit Redeemed(msg.sender,receiver,shares);
    }

    function redeemFromRouter(address owner,uint256 shares,address receiver,uint256[] calldata minAmountsOut,uint256 deadline) external ready nonReentrant returns(uint256[] memory amounts){
        require(msg.sender==IFactoryV3(factory).executionRouter(),"router");
        require(block.timestamp<=deadline,"deadline");
        require(shares>0&&receiver!=address(0),"input");
        uint256 supply=shareToken.totalSupply();
        require(minAmountsOut.length==_assets.length&&shares<=shareToken.balanceOf(owner),"shares/mins");
        bool finalRedemption=shares==supply;
        amounts=new uint256[](_assets.length);
        shareToken.burnFromAuthorized(owner,msg.sender,shares);
        address treasury=IFactoryV3(factory).feeTreasury();
        for(uint256 i;i<_assets.length;i++){
            uint256 start=IERC20(_assets[i]).balanceOf(address(this));
            uint256 gross=Math.mulDiv(start,shares,supply);
            uint256 p=gross*INDEXIO_FEE_BPS/BPS;
            uint256 c=gross*creatorFeeBps/BPS;
            uint256 nominal=gross-p-c;
            if(p>0)_pushReceived(_assets[i],treasury,p);
            if(c>0)_pushReceived(_assets[i],creator,c);
            amounts[i]=_pushReceived(_assets[i],receiver,nominal);
            require(amounts[i]>=minAmountsOut[i],"min out");
            require(start-IERC20(_assets[i]).balanceOf(address(this))<=gross,"excess debit");
        }
        if(finalRedemption){closed=true;emit VaultClosed();}
        emit Redeemed(owner,receiver,shares);
    }

    function transferForRebalance(address token,address to,uint256 amount) external ready nonReentrant returns(uint256 received) {
        require(msg.sender==IFactoryV3(factory).executionRouter()&&to!=address(0)&&amount>0,"router/input");
        bool current;
        for(uint256 i;i<_assets.length;i++)if(token==_assets[i]){current=true;break;}
        require(current,"asset");
        received=_pushReceived(token,to,amount);
    }

    function notifyIncome(address token) external ready {
        require(token.code.length>0,"token");
        bool ok=token==IFactoryV3(factory).settlementToken()||historicalAsset[token];
        require(ok,"unsupported income");
        if(distributionBps<10_000){bool current;for(uint256 i;i<_assets.length;i++)if(token==_assets[i]){current=true;break;}require(current,"compound token not current asset");}
        incomeHub.notifyIncome(token);
    }

    function validateGovernanceProposal(uint8 kind,address[] calldata a,uint16[] calldata w,uint16 nf) external view ready {
        require(kind<=1&&nf==0,"kind/fee");
        _validate(a,w);
        if(kind==0){require(a.length==_assets.length,"assets");for(uint256 i;i<a.length;i++)require(a[i]==_assets[i],"rebalance assets");}
    }

    function executeGovernance(uint8 kind,address[] calldata a,uint16[] calldata w,uint16 nf,uint64 expectedNonce) external ready {
        require(msg.sender==address(governor),"governor");
        require(expectedNonce==governanceNonce&&kind<=1&&nf==0,"stale/kind");
        require(!closed,"closed");
        require(!ISafetyV3(IFactoryV3(factory).safetyController()).tradingPaused(address(this)),"trading paused");
        _validate(a,w);
        if(kind==0){
            require(a.length==_assets.length,"assets");
            for(uint256 i;i<a.length;i++)require(a[i]==_assets[i],"rebalance assets");
        }else{
            for(uint256 i;i<_assets.length;i++){
                bool keep;
                for(uint256 j;j<a.length;j++)if(a[j]==_assets[i]){keep=true;break;}
                if(!keep)require(IERC20(_assets[i]).balanceOf(address(this))==0,"removed balance");
            }
        }
        _assets=a;
        _weights=w;
        for(uint256 i;i<a.length;i++)historicalAsset[a[i]]=true;
        governanceNonce++;
        emit CompositionUpdated(a,w);
    }

    function _pullReceived(address token,address from,address to,uint256 amount) internal returns(uint256 received) {
        uint256 senderBefore=IERC20(token).balanceOf(from);
        uint256 beforeBal=IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from,to,amount);
        uint256 senderAfter=IERC20(token).balanceOf(from);
        require(senderBefore>=senderAfter&&senderBefore-senderAfter==amount,"sender debit");
        received=IERC20(token).balanceOf(to)-beforeBal;
        require(received>0&&received<=amount,"received");
        _enforceTransferFloor(token,amount,received);
        _recordTransfer(token,to,amount,received);
    }

    function _pushReceived(address token,address to,uint256 amount) internal returns(uint256 received) {
        // A tiny proportional withdrawal can round one constituent to zero.
        // Skipping that leg allows holders to exit instead of reverting every
        // small redemption. All nonzero transfers still enforce tax limits.
        if(amount==0)return 0;
        uint256 senderBefore=IERC20(token).balanceOf(address(this));
        uint256 beforeBal=IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to,amount);
        uint256 senderAfter=IERC20(token).balanceOf(address(this));
        require(senderBefore>=senderAfter&&senderBefore-senderAfter==amount,"sender debit");
        received=IERC20(token).balanceOf(to)-beforeBal;
        require(received>0&&received<=amount,"received");
        _enforceTransferFloor(token,amount,received);
        _recordTransfer(token,to,amount,received);
    }

    function _recordTransfer(address token,address to,uint256 requested,uint256 received) internal {
        uint256 bps=Math.min(uint256(BPS),Math.mulDiv(received,BPS,requested));
        // Observed rates are informational only: never override the owner-controlled policy.
        emit TransferBehaviorObserved(token,to,requested,received,uint16(bps));
    }

    function _enforceTransferFloor(address token,uint256 requested,uint256 received) internal view {
        uint256 policyBps=ITransferPolicyV3(IFactoryV3(factory).transferPolicy()).expectedReceiveBps(token);
        // One smallest token unit accommodates integer rounding in fee-on-transfer implementations.
        uint256 minimum=Math.mulDiv(requested,policyBps,BPS);
        if(minimum>0)minimum-=1;
        require(received>=minimum,"transfer exceeds policy");
    }

    function _validate(address[] memory a,uint16[] memory w) internal view {
        require(a.length>0&&a.length==w.length&&a.length<=20,"composition");
        uint256 sum;
        address r=IFactoryV3(factory).registry();
        for(uint256 i;i<a.length;i++){
            IRegistryCheckV3(r).requireAsset(a[i],w[i]);
            sum+=w[i];
            for(uint256 j;j<i;j++)require(a[j]!=a[i],"duplicate");
        }
        require(sum==BPS,"weights");
    }
}
