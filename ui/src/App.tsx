import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi';
import { getNonceMessage, getPortfolio, login, setAllocation } from './api.ts';
import type { Allocation, PortfolioView, Scope } from './types.ts';

// ---------------------------------------------------------------------------
// 1 · Wallet connection (real injected wallet via wagmi)
// ---------------------------------------------------------------------------

const WalletSection = () => {
  const { address, isConnected, connector } = useAccount();
  const { connectors, connect, status, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <section>
        <h2>1 · Wallet</h2>
        <div className="row">
          <span className="pill">{connector?.name ?? 'wallet'}</span>
          <code>{address}</code>
          <button className="ghost" onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>1 · Connect your wallet</h2>
      <div className="row">
        {connectors.length === 0 && (
          <span className="muted">
            No browser wallet detected — install MetaMask (or another injected
            wallet) and reload.
          </span>
        )}
        {connectors.map((c) => (
          <button key={c.uid} onClick={() => connect({ connector: c })}>
            Connect {c.name}
          </button>
        ))}
      </div>
      {status === 'pending' && <span className="muted">connecting…</span>}
      {error && <div className="result bad">{error.message}</div>}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 2 · SIWE sign-in
// ---------------------------------------------------------------------------

const SignInSection = ({
  address,
  onSignedIn,
}: {
  address: `0x${string}`;
  onSignedIn: (token: string, scopes: Scope[]) => void;
}) => {
  const { signMessageAsync } = useSignMessage();
  const [wantTrade, setWantTrade] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signIn = async () => {
    setBusy(true);
    setError('');
    try {
      const msg = await getNonceMessage(address);
      setMessage(msg);
      const signature = await signMessageAsync({ message: msg });
      const scopes: Scope[] = wantTrade
        ? ['portfolio:read', 'portfolio:trade']
        : ['portfolio:read'];
      const out = await login(msg, signature, scopes);
      onSignedIn(out.token, out.principal.scopes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>2 · Sign in with your wallet</h2>
      <label className="consent">
        <input
          type="checkbox"
          checked={wantTrade}
          onChange={(e) => setWantTrade(e.target.checked)}
        />
        also grant <code>portfolio:trade</code> (lets the session re-weight)
      </label>
      <div className="row">
        <button onClick={signIn} disabled={busy}>
          {busy ? 'check your wallet…' : 'Sign-In With Ethereum'}
        </button>
      </div>
      {message && <pre>{message}</pre>}
      {error && <div className="result bad">{error}</div>}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 3 · Portfolio + re-target (AuthZ in action)
// ---------------------------------------------------------------------------

const PortfolioSection = ({
  token,
  scopes,
}: {
  token: string;
  scopes: Scope[];
}) => {
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [draft, setDraft] = useState<Allocation>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refresh = async () => {
    const r = await getPortfolio(token);
    if (r.ok) {
      setPortfolio(r.value);
      setDraft({ ...r.value.targetAllocation });
    } else {
      setResult({ ok: false, text: `${r.code}: ${r.message}` });
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const sum = Object.values(draft).reduce((a, b) => a + b, 0);

  const apply = async () => {
    const r = await setAllocation(token, draft);
    if (r.ok) {
      setResult({
        ok: true,
        text: `applied — version ${r.value.policyVersion}, ${JSON.stringify(r.value.targetAllocation)}`,
      });
      await refresh();
    } else {
      setResult({ ok: false, text: `${r.code}: ${r.message}` });
    }
  };

  return (
    <>
      <section>
        <h2>
          3 · Your portfolio{' '}
          {scopes.map((s) => (
            <span key={s} className="pill">
              {s}
            </span>
          ))}
        </h2>
        {portfolio ? (
          <div className="card">
            {`portfolio : ${portfolio.portfolioId}\n`}
            {`balance   : ${portfolio.totalUsdc.toLocaleString()} USDC\n`}
            {`version   : ${portfolio.policyVersion}\n`}
            {`target    : ${JSON.stringify(portfolio.targetAllocation)}`}
          </div>
        ) : (
          <div className="card">loading…</div>
        )}
      </section>

      <section>
        <h2>
          4 · Re-target allocation{' '}
          <span className="muted">(needs portfolio:trade)</span>
        </h2>
        <div className="sliders">
          {Object.entries(draft).map(([instrument, portion]) => (
            <div className="slider-row" key={instrument}>
              <label>{instrument}</label>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={portion}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [instrument]: Number(e.target.value),
                  }))
                }
              />
              <span>{portion}%</span>
            </div>
          ))}
        </div>
        <div className="row">
          <span className="muted">
            sum: {sum}% {sum === 100 ? '✓' : '(must be 100)'}
          </span>
          <button onClick={apply}>Set target allocation</button>
        </div>
        {result && (
          <div className={`result ${result.ok ? 'ok' : 'bad'}`}>
            <span className="tag">{result.ok ? '✓ applied' : '⛔ denied'}</span>{' '}
            — {result.text}
          </div>
        )}
        <p className="hint">
          Try to break it: push one instrument past 80% (concentration cap).
          With a read-only session, the write is refused outright. Same bounds
          the AI agent hits over <code>/mcp</code>.
        </p>
      </section>
    </>
  );
};

// ---------------------------------------------------------------------------

export const App = () => {
  const { address, isConnected } = useAccount();
  const [token, setToken] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);

  return (
    <main>
      <h1>Ymax portfolio MCP — AuthN / AuthZ demo</h1>
      <p className="sub">
        The <strong>human</strong> front door. Connect a real wallet, sign in
        (AuthN), grant scopes (consent), then act within policy bounds (AuthZ).
        An AI agent uses the same tools over <code>/mcp</code> (see{' '}
        <code>yarn agent</code>).
      </p>

      <WalletSection />

      {isConnected && address && !token && (
        <SignInSection
          address={address}
          onSignedIn={(t, s) => {
            setToken(t);
            setScopes(s);
          }}
        />
      )}

      {token && <PortfolioSection token={token} scopes={scopes} />}
    </main>
  );
};
