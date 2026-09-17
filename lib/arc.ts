import { defineChain } from "viem";

export const ARC_RPC_URLS = [
  "https://rpc.mainnet.arc.io",
  "https://rpc.arc-scan.org",
  "https://5042.rpc.thirdweb.com",
] as const;

export const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [...ARC_RPC_URLS] },
    public: { http: [...ARC_RPC_URLS] },
  },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});
