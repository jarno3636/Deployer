import { getAddress } from "viem";

export const CCTP_V2 = {
  tokenMessengerV2: getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"),
  messageTransmitterV2: getAddress("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"),
  tokenMinterV2: getAddress("0xfd78EE919681417d192449715b2594ab58f5D002"),
} as const;

// Circle-issued native USDC + CCTP V2 domains. Keep this list in sync with
// config/cctp-mainnet.json and Circle's published mainnet address tables.
export const CCTP_MAINNET_CHAINS = [
  { name: "Ethereum", chainId: 1n, domain: 0, usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), enabled: true },
  { name: "Avalanche", chainId: 43114n, domain: 1, usdc: getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"), enabled: true },
  { name: "Optimism", chainId: 10n, domain: 2, usdc: getAddress("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"), enabled: true },
  { name: "Arbitrum", chainId: 42161n, domain: 3, usdc: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), enabled: true },
  { name: "Base", chainId: 8453n, domain: 6, usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), enabled: true },
  { name: "Polygon PoS", chainId: 137n, domain: 7, usdc: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), enabled: true },
  { name: "Unichain", chainId: 130n, domain: 10, usdc: getAddress("0x078D782b760474a361dDA0AF3839290b0EF57AD6"), enabled: true },
  { name: "Linea", chainId: 59144n, domain: 11, usdc: getAddress("0x176211869cA2b568f2A7D4EE941E073a821EE1ff"), enabled: true },
  { name: "Sonic", chainId: 146n, domain: 13, usdc: getAddress("0x29219dd400f2Bf60E5a23d13Be72B486D4038894"), enabled: true },
  { name: "World Chain", chainId: 480n, domain: 14, usdc: getAddress("0x79A02482A880bCe3F13E09da970dC34dB4cD24D1"), enabled: true },
  { name: "Monad", chainId: 143n, domain: 15, usdc: getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"), enabled: true },
  { name: "Sei", chainId: 1329n, domain: 16, usdc: getAddress("0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"), enabled: true },
  { name: "HyperEVM", chainId: 999n, domain: 19, usdc: getAddress("0xb88339CB7199b77E23DB6E890353E22632Ba630f"), enabled: true },
  { name: "Arc", chainId: 5042n, domain: 26, usdc: getAddress("0x3600000000000000000000000000000000000000"), enabled: true },
] as const;

// Kept for the deployer UI. Networks should only be placed here when their
// native-USDC/CCTP configuration has not yet been verified.
export const CCTP_PENDING_DOMAINS: readonly { name: string; domain: number }[] = [];
