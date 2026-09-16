# ScanArc Router Deployment Kit

This package contains the reviewed-build candidate for a transparent ScanArc routing adapter and a MetaMask-first deployer derived from the earlier Base deployment flow.

## Fixed deployment settings

- Network: Arc mainnet (`5042`)
- RPC: `https://rpc.mainnet.arc.io`
- Explorer: `https://explorer.arc.io`
- Arc USDC ERC-20 interface: `0x3600000000000000000000000000000000000000`
- Owner/deployer: `0x25BE27a17580F59206061B8823E3c0FbC1F7c52E`
- Fee recipient: `0x25BE27a17580F59206061B8823E3c0FbC1F7c52E`
- ScanArc fee: `25` basis points (`0.25%`), immutable
- Solidity: `0.8.30`, optimizer enabled, `200` runs

## What the contract does

1. Routes buys and sells only through token/curve pairs explicitly approved by the owner.
2. Charges 0.25% transparently and sends it immediately to the immutable fee recipient.
3. Measures actual token/USDC balance changes rather than trusting a venue return value.
4. Enforces user minimum output, deadlines, reentrancy protection, approval cleanup and contract-code checks.
5. Uses a two-step ownership transfer so ownership cannot be accidentally sent to an unusable address.

It does **not** custody deposits, create liquidity, upgrade itself, change the fee, or permit arbitrary external calls.

## Important safety boundary

Successful compilation is not an independent security audit. Do not activate ScanArc in-app routing until an independent reviewer checks the source, the deployed bytecode is verified, and small-value buy/sell tests pass. Until then, ScanArc should keep linking directly to Arcfun or the graduated DEX.

## Run the deployer

```bash
npm install
npm run build
npm run dev
```

Open the local URL, connect MetaMask using the exact approved deployer wallet, switch to Arc, acknowledge the safety gate, and review the wallet transaction before signing.

The deployer:

- rejects any wallet other than the approved owner;
- validates Arc USDC contract code;
- predicts the CREATE address before broadcast;
- estimates gas and adds a 20% buffer;
- avoids automatic double-deployment if a wallet reports a broadcast failure;
- validates `owner`, `feeRecipient`, `FEE_BPS`, and `usdc` after deployment.

## Constructor arguments

1. `usdc_`: `0x3600000000000000000000000000000000000000`
2. `feeRecipient_`: `0x25BE27a17580F59206061B8823E3c0FbC1F7c52E`
3. `owner_`: `0x25BE27a17580F59206061B8823E3c0FbC1F7c52E`

## After deployment

1. Save the router contract address and transaction hash.
2. Verify the exact source on Arc Explorer or Sourcify using compiler `0.8.30`, optimizer enabled, 200 runs.
3. Compare the explorer owner, recipient, fee and USDC values against the fixed settings above.
4. Independently verify each Arcfun token/curve pair before calling `setPair`.
5. Use the included deployer to register the first verified pair.
6. Test one very small buy and sell; confirm received amounts and the fee-recipient USDC change.
7. Obtain an independent security review before public routing.
8. Only then configure ScanArc with the deployed router address.

## Included files

- `contracts/ScanArcRouter.sol` — self-contained router source
- `artifacts/ScanArcRouter.abi.json` — compiled ABI
- `artifacts/ScanArcRouter.bin` — compiled creation bytecode
- `src/Deployer.tsx` — guarded MetaMask deployer and pair registration UI
- `src/lib/scanarc-router.generated.ts` — typed deployer artifacts
- `DEPLOYMENT-CHECKLIST.md` — sign-off checklist
