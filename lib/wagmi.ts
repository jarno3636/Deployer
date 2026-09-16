import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { arc } from './arc';

export const config = createConfig({
  chains: [arc],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [arc.id]: http('https://rpc.mainnet.arc.io'),
  },
  ssr: true,
});
