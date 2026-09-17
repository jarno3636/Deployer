// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Non-custodial safety registry for ScanArc's Circle CCTP bridge.
/// @dev Cannot receive, transfer, approve, burn, mint, or withdraw user USDC.
contract ScanArcBridgeRegistryV1 {
    error Unauthorized(); error InvalidAddress(); error InvalidDomain(); error ChainNotFound();
    struct ChainConfig { uint256 chainId; uint32 cctpDomain; address usdc; address tokenMessengerV2; address messageTransmitterV2; bool enabled; }
    address public owner; address public pendingOwner; bool public paused;
    uint256[] private _chainIds;
    mapping(uint256 => ChainConfig) private _chains;
    mapping(uint32 => uint256) public chainIdForDomain;
    event OwnershipTransferStarted(address indexed owner,address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner,address indexed newOwner);
    event PauseChanged(bool paused);
    event ChainConfigured(uint256 indexed chainId,uint32 indexed cctpDomain,address usdc,address tokenMessengerV2,address messageTransmitterV2,bool enabled);
    modifier onlyOwner(){ if(msg.sender!=owner) revert Unauthorized(); _; }
    constructor(address owner_){ if(owner_==address(0)) revert InvalidAddress(); owner=owner_; emit OwnershipTransferred(address(0),owner_); }
    function transferOwnership(address n) external onlyOwner { if(n==address(0)) revert InvalidAddress(); pendingOwner=n; emit OwnershipTransferStarted(owner,n); }
    function acceptOwnership() external { if(msg.sender!=pendingOwner) revert Unauthorized(); address o=owner; owner=msg.sender; pendingOwner=address(0); emit OwnershipTransferred(o,msg.sender); }
    function setPaused(bool v) external onlyOwner { paused=v; emit PauseChanged(v); }
    function configureChain(ChainConfig calldata c) external onlyOwner { _configureChain(c); }
    function configureChains(ChainConfig[] calldata configs) external onlyOwner {
        uint256 n=configs.length;
        for(uint256 i; i<n; ++i) _configureChain(configs[i]);
    }
    function _configureChain(ChainConfig calldata c) internal {
        if(c.chainId==0||c.usdc==address(0)||c.tokenMessengerV2==address(0)||c.messageTransmitterV2==address(0)) revert InvalidAddress();
        ChainConfig memory old=_chains[c.chainId];
        if(old.chainId==0){ if(chainIdForDomain[c.cctpDomain]!=0) revert InvalidDomain(); _chainIds.push(c.chainId); }
        else if(old.cctpDomain!=c.cctpDomain){ chainIdForDomain[old.cctpDomain]=0; uint256 x=chainIdForDomain[c.cctpDomain]; if(x!=0&&x!=c.chainId) revert InvalidDomain(); }
        _chains[c.chainId]=c; chainIdForDomain[c.cctpDomain]=c.chainId;
        emit ChainConfigured(c.chainId,c.cctpDomain,c.usdc,c.tokenMessengerV2,c.messageTransmitterV2,c.enabled);
    }
    function setChainEnabled(uint256 id,bool e) external onlyOwner { ChainConfig storage c=_chains[id]; if(c.chainId==0) revert ChainNotFound(); c.enabled=e; emit ChainConfigured(c.chainId,c.cctpDomain,c.usdc,c.tokenMessengerV2,c.messageTransmitterV2,e); }
    function getChain(uint256 id) external view returns(ChainConfig memory){ return _chains[id]; }
    function getChainIds() external view returns(uint256[] memory){ return _chainIds; }
    function routeEnabled(uint256 a,uint256 b) external view returns(bool){ if(paused||a==b)return false; ChainConfig memory s=_chains[a]; ChainConfig memory d=_chains[b]; return s.enabled&&d.enabled&&s.chainId!=0&&d.chainId!=0; }
}
