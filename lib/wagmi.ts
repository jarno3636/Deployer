import { createConfig, fallback, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { arc, ARC_RPC_URLS } from './arc';

export const config = createConfig({
  chains: [arc],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [arc.id]: fallback(
      ARC_RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 })),
      { rank: true },
    ),
  },
  ssr: true,
});
