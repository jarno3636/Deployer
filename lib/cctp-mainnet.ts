import { getAddress } from "viem";

export const CCTP_V2 = {
  tokenMessengerV2: getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"),
  messageTransmitterV2: getAddress("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"),
  tokenMinterV2: getAddress("0xfd78EE919681417d192449715b2594ab58f5D002"),
} as const;

export const CCTP_MAINNET_CHAINS = [
  { name: "Ethereum", chainId: 1n, domain: 0, usdc: getAddress("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), enabled: true },
  { name: "Avalanche", chainId: 43114n, domain: 1, usdc: getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"), enabled: true },
  { name: "Optimism", chainId: 10n, domain: 2, usdc: getAddress("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"), enabled: true },
  { name: "Arbitrum", chainId: 42161n, domain: 3, usdc: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), enabled: true },
  { name: "Base", chainId: 8453n, domain: 6, usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), enabled: true },
  { name: "Polygon PoS", chainId: 137n, domain: 7, usdc: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), enabled: true },
  { name: "Arc", chainId: 5042n, domain: 26, usdc: getAddress("0x3600000000000000000000000000000000000000"), enabled: true },
] as const;

export const CCTP_PENDING_DOMAINS = [
  { name: "Unichain", domain: 10 },
  { name: "Linea", domain: 11 },
  { name: "Sonic", domain: 13 },
  { name: "World Chain", domain: 14 },
  { name: "Monad", domain: 15 },
  { name: "Sei", domain: 16 },
  { name: "HyperEVM", domain: 19 },
] as const;
