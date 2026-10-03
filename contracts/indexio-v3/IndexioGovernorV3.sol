// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IVotesV3 { function getPastVotes(address,uint256) external view returns(uint256); function getPastTotalSupply(uint256) external view returns(uint256); }
interface IVaultGovV3 { function executeGovernance(uint8,address[] calldata,uint16[] calldata,uint16,uint64) external; function governanceNonce() external view returns(uint64); function validateGovernanceProposal(uint8,address[] calldata,uint16[] calldata,uint16) external view; }
contract IndexioGovernorV3 {
    uint16 constant BPS=10_000;
    uint16 public constant REBALANCE_QUORUM_BPS=1_500;
    uint16 public constant COMPOSITION_QUORUM_BPS=2_500;
    uint16 public constant FEE_QUORUM_BPS=2_500;
    uint16 public constant PROPOSAL_THRESHOLD_BPS=50; // 0.50% of snapshot supply
    uint32 public constant VOTING_PERIOD=3 days;
    uint32 public constant REBALANCE_EXIT=1 days;
    uint32 public constant COMPOSITION_EXIT=3 days;
    uint32 public constant FEE_EXIT=7 days;
    uint32 public constant EXECUTION_GRACE=7 days;
    address public immutable vault; IVotesV3 public immutable token; uint256 public proposalCount;
    struct Proposal{uint8 kind;uint16 quorumBps;uint48 snapshot;uint48 voteEnd;uint48 executeAfter;uint48 executeBefore;uint64 expectedNonce;uint256 forVotes;uint256 againstVotes;uint256 abstainVotes;uint16 newFee;bool executed;bool canceled;bytes32 dataHash;address proposer;}
    mapping(uint256=>Proposal) public proposals; mapping(uint256=>mapping(address=>bool)) public hasVoted;
    event Proposed(uint256 indexed id,uint8 kind,address indexed proposer,uint48 snapshot,uint48 voteEnd,uint16 quorumBps,uint64 expectedNonce,bytes32 dataHash);
    event VoteCast(uint256 indexed id,address indexed voter,uint8 support,uint256 weight); event Queued(uint256 indexed id,uint48 executeAfter,uint48 executeBefore); event Canceled(uint256 indexed id); event Executed(uint256 indexed id);
    constructor(address vault_,address token_){require(vault_!=address(0)&&token_!=address(0),"config");vault=vault_;token=IVotesV3(token_);}
    function propose(uint8 kind,address[] calldata assets,uint16[] calldata weights,uint16 newFee) external returns(uint256 id){
        require(kind<=2,"kind"); uint48 snap=uint48(block.number-1); uint256 supply=token.getPastTotalSupply(snap); require(supply>0,"supply");
        uint256 proposerVotes=token.getPastVotes(msg.sender,snap); require(proposerVotes>=_ceilDiv(supply*PROPOSAL_THRESHOLD_BPS,BPS),"threshold");
        IVaultGovV3(vault).validateGovernanceProposal(kind,assets,weights,newFee);
        bytes32 h=keccak256(abi.encode(kind,assets,weights,newFee)); id=++proposalCount; uint48 end=uint48(block.timestamp+VOTING_PERIOD); uint16 q=_quorumBps(kind); uint64 nonce=IVaultGovV3(vault).governanceNonce();
        proposals[id]=Proposal(kind,q,snap,end,0,0,nonce,0,0,0,newFee,false,false,h,msg.sender); emit Proposed(id,kind,msg.sender,snap,end,q,nonce,h);
    }
    /// support: 0=Against, 1=For, 2=Abstain. All three count toward quorum.
    function vote(uint256 id,uint8 support) external {Proposal storage p=proposals[id];require(p.voteEnd!=0&&block.timestamp<p.voteEnd&&!hasVoted[id][msg.sender]&&support<=2,"vote");uint256 w=token.getPastVotes(msg.sender,p.snapshot);require(w>0,"weight");hasVoted[id][msg.sender]=true;if(support==1)p.forVotes+=w;else if(support==0)p.againstVotes+=w;else p.abstainVotes+=w;emit VoteCast(id,msg.sender,support,w);}
    function queue(uint256 id) external {Proposal storage p=proposals[id];require(p.voteEnd!=0&&block.timestamp>=p.voteEnd&&p.executeAfter==0&&!p.executed&&!p.canceled,"state");require(_passed(p),"failed");uint32 delay=p.kind==2?FEE_EXIT:(p.kind==1?COMPOSITION_EXIT:REBALANCE_EXIT);p.executeAfter=uint48(block.timestamp+delay);p.executeBefore=uint48(uint256(p.executeAfter)+EXECUTION_GRACE);emit Queued(id,p.executeAfter,p.executeBefore);}
    function execute(uint256 id,address[] calldata assets,uint16[] calldata weights,uint16 newFee) external {Proposal storage p=proposals[id];require(p.executeAfter!=0&&block.timestamp>=p.executeAfter&&block.timestamp<=p.executeBefore&&!p.executed&&!p.canceled,"delay");require(keccak256(abi.encode(p.kind,assets,weights,newFee))==p.dataHash,"data");require(IVaultGovV3(vault).governanceNonce()==p.expectedNonce,"stale");p.executed=true;IVaultGovV3(vault).executeGovernance(p.kind,assets,weights,newFee,p.expectedNonce);emit Executed(id);}
    function cancel(uint256 id) external {Proposal storage p=proposals[id];require(!p.executed&&!p.canceled,"state");bool proposerEarly=msg.sender==p.proposer&&block.timestamp<p.voteEnd&&p.forVotes+p.againstVotes+p.abstainVotes==0;bool stale=IVaultGovV3(vault).governanceNonce()!=p.expectedNonce;bool expired=p.executeBefore!=0&&block.timestamp>p.executeBefore;require(proposerEarly||stale||expired,"auth");p.canceled=true;emit Canceled(id);}
    function quorumRequired(uint256 id) public view returns(uint256){Proposal storage p=proposals[id];if(p.snapshot==0)return 0;return _ceilDiv(token.getPastTotalSupply(p.snapshot)*p.quorumBps,BPS);}
    function participation(uint256 id) public view returns(uint256){Proposal storage p=proposals[id];return p.forVotes+p.againstVotes+p.abstainVotes;}
    function quorumReached(uint256 id) external view returns(bool){return participation(id)>=quorumRequired(id);}
    function participationBps(uint256 id) external view returns(uint256){Proposal storage p=proposals[id];if(p.snapshot==0)return 0;uint256 s=token.getPastTotalSupply(p.snapshot);return s==0?0:(participation(id)*BPS/s);}
    function state(uint256 id) external view returns(uint8){Proposal storage p=proposals[id];if(p.voteEnd==0)return 0;if(p.canceled)return 7;if(p.executed)return 6;if(IVaultGovV3(vault).governanceNonce()!=p.expectedNonce)return 9;if(block.timestamp<p.voteEnd)return 1;if(!_passed(p))return 2;if(p.executeAfter==0)return 3;if(block.timestamp<p.executeAfter)return 4;if(block.timestamp<=p.executeBefore)return 5;return 8;}
    function _passed(Proposal storage p) internal view returns(bool){return p.forVotes+p.againstVotes+p.abstainVotes>=_quorumRequired(p)&&p.forVotes>p.againstVotes;}
    function _quorumRequired(Proposal storage p) internal view returns(uint256){return _ceilDiv(token.getPastTotalSupply(p.snapshot)*p.quorumBps,BPS);}
    function _quorumBps(uint8 kind) internal pure returns(uint16){return kind==0?REBALANCE_QUORUM_BPS:(kind==1?COMPOSITION_QUORUM_BPS:FEE_QUORUM_BPS);}
    function _ceilDiv(uint256 a,uint256 b) internal pure returns(uint256){return a==0?0:(a-1)/b+1;}
}
