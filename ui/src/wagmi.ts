import { http, createConfig } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

/**
 * wagmi config — `injected()` connects to a REAL browser wallet (MetaMask,
 * Rabby, Coinbase Wallet extension, …). SIWE only needs the wallet to sign a
 * message, so a single chain + the injected connector is enough.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: { [mainnet.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
