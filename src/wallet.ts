import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';

/**
 * Agent-wallet creation (PAK-550 direction).
 *
 * PROTOTYPE SCAFFOLDING — generates a fresh Agoric (`agoric1…`) keypair to stand in as the "agent
 * wallet" that would act on the user's behalf on their Agoric portfolio, and returns only its
 * address. The mnemonic/private key is **not persisted** (discarded when this returns), so the wallet
 * is identity-display only: it demonstrates the "once authenticated, we create a wallet for you" step
 * on the consent screen, nothing more.
 *
 * Making the agent actually able to sign/act requires custody (persist + encrypt the key) and an
 * on-chain delegation step — deliberately out of scope here. See PAK-550.
 */

// Agoric's registered SLIP-44 coin type is 564; addresses use the `agoric` bech32 prefix.
const AGORIC_HD_PATH = "m/44'/564'/0'/0/0";
const AGORIC_PREFIX = 'agoric';

export type AgentWallet = { address: string };

export const createAgentWallet = (): AgentWallet => {
  const mnemonic = generateMnemonic(wordlist, 256); // 24 words
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(AGORIC_HD_PATH);
  if (!node.publicKey)
    throw new Error('failed to derive agent wallet public key');
  // Standard Cosmos secp256k1 address: ripemd160(sha256(compressed pubkey)), bech32-encoded.
  const addressBytes = ripemd160(sha256(node.publicKey));
  const address = bech32.encode(AGORIC_PREFIX, bech32.toWords(addressBytes));
  return { address };
};
