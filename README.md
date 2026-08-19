# Tobyworld Contract Deployer

A deliberately tiny mobile-first deployer for `TobyworldMarketplaceV1` on Base mainnet.

## What it does

- Compiles the included Solidity contract with Solidity 0.8.30 during `npm run build`.
- Embeds the resulting ABI + creation bytecode into the production app.
- Connects specifically to Coinbase/Base **EOA / legacy wallet mode** or another injected EOA.
- Forces Base mainnet (chain ID 8453).
- Checks the connected deployer address has no contract bytecode before enabling a normal CREATE deployment.
- Sends the deployment transaction from the connected wallet.
- Waits for confirmation and displays BaseScan transaction + contract links.
- Never asks for or stores a private key.

## Deploy to Vercel

1. Put this folder in a GitHub repository.
2. Import the repository into Vercel.
3. Framework: Next.js (auto-detected).
4. No environment variables are required.
5. Deploy.
6. Open the Vercel URL on your phone and connect your EOA / legacy wallet.

## Important wallet note

Base Account / smart-wallet addresses currently cannot deploy this contract using ordinary CREATE. The Coinbase connector is intentionally configured with `eoaOnly` so mobile Coinbase/Base legacy-wallet users are routed to the compatible wallet type.

## Contract safety

The Solidity constructor itself additionally:

- requires chain ID 8453;
- checks that SEED, Old Lore Land, Canonical Lore Land, USDC, and TOBY contain contract code;
- fixes the initial marketplace fee recipient to the address included in source.

## Recompile locally

```bash
npm install
npm run compile:contract
npm run build
```

The generated ABI and bytecode file is `lib/marketplace.generated.ts` and is regenerated on every production build.
