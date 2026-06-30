/**
 * AuthN layer [1] — SIWE / EIP-4361 login, then a signed session JWT.
 *
 * Flow:
 *   prepareLogin(address)            -> server builds the exact EIP-4361 message
 *                                       (with a fresh single-use nonce) to sign
 *   completeLogin(message, sig, ...) -> verify signature + nonce, mint a JWT
 *                                       carrying the proven address, portfolio,
 *                                       and granted scopes (the consent result)
 *   principalFromToken(token)        -> verify the JWT, return the Principal
 *
 * The JWT secret and clock are passed in (no ambient authority).
 */

import jwt from 'jsonwebtoken';
import { SiweMessage, generateNonce } from 'siwe';
import type { Principal, Scope } from './types.ts';

export type AuthConfig = {
  domain: string; // RFC-3986 authority, e.g. "localhost:8799" (anti-phishing)
  uri: string; // e.g. "http://localhost:8799"
  chainId: number;
  jwtSecret: string;
  ttlSeconds?: number;
  now?: () => Date;
};

const GRANTABLE: Scope[] = ['portfolio:read', 'portfolio:trade'];

export const makeAuth = ({
  domain,
  uri,
  chainId,
  jwtSecret,
  ttlSeconds = 3600,
  now = () => new Date(),
}: AuthConfig) => {
  // nonce -> issued-at, single use. (Redis/KV in production.)
  const liveNonces = new Set<string>();

  const prepareLogin = (address: string): { message: string } => {
    const nonce = generateNonce();
    liveNonces.add(nonce);
    const message = new SiweMessage({
      domain,
      address,
      statement: 'Sign in to manage your Ymax portfolio.',
      uri,
      version: '1',
      chainId,
      nonce,
      issuedAt: now().toISOString(),
      expirationTime: new Date(now().getTime() + 5 * 60_000).toISOString(),
    }).prepareMessage();
    return { message };
  };

  const completeLogin = async ({
    message,
    signature,
    requestedScopes,
  }: {
    message: string;
    signature: string;
    requestedScopes: Scope[];
  }): Promise<{ token: string; principal: Principal }> => {
    const siwe = new SiweMessage(message);
    // Verifies the signature (ecrecover for EOAs) AND that the embedded nonce
    // matches. For smart-contract wallets, pass a `provider` here so siwe can
    // do the EIP-1271 isValidSignature check instead — see README TODO.
    const { data } = await siwe.verify({ signature, nonce: siwe.nonce });

    if (!liveNonces.delete(data.nonce)) {
      throw new Error('unknown or already-used nonce (replay rejected)');
    }

    // Consent: grant only requested scopes that are grantable. 'portfolio:read'
    // is always included so the agent can at least see the portfolio.
    const scopes = Array.from(
      new Set<Scope>([
        'portfolio:read',
        ...requestedScopes.filter((s) => GRANTABLE.includes(s)),
      ]),
    );

    // The portfolio operated is the connected wallet's OWN portfolio — bound to
    // the SIWE-proven address, not a fixed server config. So the backend acts on
    // the real wallet that signed in.
    const principal: Principal = {
      address: data.address,
      portfolioId: data.address,
      scopes,
    };
    const token = jwt.sign(principal, jwtSecret, { expiresIn: ttlSeconds });
    return { token, principal };
  };

  const principalFromToken = (token: string): Principal => {
    const decoded = jwt.verify(token, jwtSecret) as Principal & {
      iat: number;
      exp: number;
    };
    return {
      address: decoded.address,
      portfolioId: decoded.portfolioId,
      scopes: decoded.scopes,
    };
  };

  return { prepareLogin, completeLogin, principalFromToken };
};

export type Auth = ReturnType<typeof makeAuth>;
