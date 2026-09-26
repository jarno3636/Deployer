import { createConfig, fallback, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { base } from 'viem/chains';
import { arc, ARC_RPC_URLS } from './arc';

const BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
] as const;

export const config = createConfig({
  chains: [arc, base],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [arc.id]: fallback(
      ARC_RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 })),
      { rank: true },
    ),
    [base.id]: fallback(
      BASE_RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 })),
      { rank: true },
    ),
  },
  ssr: true,
});
