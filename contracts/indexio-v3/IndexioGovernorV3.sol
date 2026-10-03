// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
interface IVotesV3 { function getPastVotes(address,uint256) external view returns(uint256); function getPastTotalSupply(uint256) external view returns(uint256); }
interface IVaultGovV3 { function executeGovernance(uint8,address[] calldata,uint16[] calldata,uint16) external; }
contract IndexioGovernorV3 {
    uint16 constant BPS=10_000; uint16 constant QUORUM_BPS=2_000; uint32 constant VOTING_PERIOD=3 days; uint32 constant REBALANCE_EXIT=1 days; uint32 constant COMPOSITION_EXIT=3 days; uint32 constant FEE_EXIT=7 days;
    address public immutable vault; IVotesV3 public immutable token; uint256 public proposalCount;
    struct Proposal{uint8 kind;uint48 snapshot;uint48 voteEnd;uint48 executeAfter;uint256 forVotes;uint256 againstVotes;uint16 newFee;bool executed;bytes32 dataHash;}
    mapping(uint256=>Proposal) public proposals; mapping(uint256=>mapping(address=>bool)) public hasVoted;
    event Proposed(uint256 indexed id,uint8 kind,uint48 snapshot,uint48 voteEnd,bytes32 dataHash); event VoteCast(uint256 indexed id,address indexed voter,bool support,uint256 weight); event Executed(uint256 indexed id);
    constructor(address vault_,address token_){require(vault_!=address(0)&&token_!=address(0),"config");vault=vault_;token=IVotesV3(token_);}
    function propose(uint8 kind,address[] calldata assets,uint16[] calldata weights,uint16 newFee) external returns(uint256 id){require(kind<=2,"kind");uint48 snap=uint48(block.number-1);require(token.getPastVotes(msg.sender,snap)>0,"holder");bytes32 h=keccak256(abi.encode(kind,assets,weights,newFee));id=++proposalCount;uint48 end=uint48(block.timestamp+VOTING_PERIOD);proposals[id]=Proposal(kind,snap,end,0,0,0,newFee,false,h);emit Proposed(id,kind,snap,end,h);}
    function vote(uint256 id,bool support) external {Proposal storage p=proposals[id];require(p.voteEnd!=0&&block.timestamp<p.voteEnd&&!hasVoted[id][msg.sender],"vote");uint256 w=token.getPastVotes(msg.sender,p.snapshot);require(w>0,"weight");hasVoted[id][msg.sender]=true;if(support)p.forVotes+=w;else p.againstVotes+=w;emit VoteCast(id,msg.sender,support,w);}
    function queue(uint256 id) external {Proposal storage p=proposals[id];require(p.voteEnd!=0&&block.timestamp>=p.voteEnd&&p.executeAfter==0&&!p.executed,"state");uint256 supply=token.getPastTotalSupply(p.snapshot);require(p.forVotes+p.againstVotes>=supply*QUORUM_BPS/BPS&&p.forVotes>p.againstVotes,"failed");uint32 delay=p.kind==2?FEE_EXIT:(p.kind==1?COMPOSITION_EXIT:REBALANCE_EXIT);p.executeAfter=uint48(block.timestamp+delay);}
    function execute(uint256 id,address[] calldata assets,uint16[] calldata weights,uint16 newFee) external {Proposal storage p=proposals[id];require(p.executeAfter!=0&&block.timestamp>=p.executeAfter&&!p.executed,"delay");require(keccak256(abi.encode(p.kind,assets,weights,newFee))==p.dataHash,"data");p.executed=true;IVaultGovV3(vault).executeGovernance(p.kind,assets,weights,newFee);emit Executed(id);}
}
