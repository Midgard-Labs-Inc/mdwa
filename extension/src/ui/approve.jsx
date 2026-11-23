// The approval window (440x680): what a dApp asks for, shown for the six
// request kinds, with Reject and the primary action pinned at the bottom.
// The wallet is unlocked once per session, so the request itself needs no
// password; a locked wallet shows the unlock form first (and a seventh kind,
// 'unlock', is only that form: a site asked for something that needs the
// wallet unlocked).
//
// Transactions, transfers and swap offers open before the wallet has built
// them (params.preparing): the background balances once the wallet is
// unlocked, fills in `described` and sends 'approvalUpdate', and the window
// reads the request again. Approve stays disabled until then; a request
// the wallet could not build shows why (params.error) and can only be
// closed. While the wallet finishes something else first, the window says
// it is waiting (the engine names the request's ticket, the window's id, in
// state.busy once it works on it).
//
// Tokens are named as in the popup (tokens.js): NIGHT and DUST by their
// fixed names, a custom token by the label the user saved for it on this
// network, with its decimals. On a network without DUST there is no fee, so
// no fee line.
import './theme.js';
import { ensureCurrentBuild } from './fresh.js';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowsLeftRightIcon, CheckIcon, ClockCounterClockwiseIcon, GlobeHemisphereWestIcon, LockKeyOpenIcon, PaperPlaneTiltIcon, PenNibIcon,
  PlugsConnectedIcon, ShieldCheckIcon, SignatureIcon, WarningCircleIcon,
} from '@phosphor-icons/react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { Loader } from '@cloudflare/kumo/components/loader';
import { Input } from '@cloudflare/kumo/components/input';
import { Text } from '@cloudflare/kumo/components/text';
import { Actions, AppHeader, NetworkBadge } from './brand.jsx';
import { ui, onState } from './api.js';
import { busyText, dust, shortAddress, shortType } from './format.js';
import { describeToken, tokenAmount, tokenTitle, tokenUnit, useTokenLabels } from './tokens.js';

const id = new URLSearchParams(location.search).get('id');
const approval = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'approval', id, action, ...extra });

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <Text variant="secondary" size="sm">{label}</Text>
      <div className="min-w-0 text-right text-sm tabular-nums">{children}</div>
    </div>
  );
}

// What each connector method lets the site do, in the words shown to the user.
const METHOD_TEXT = {
  getConfiguration: 'Read which network and services this wallet uses',
  getConnectionStatus: 'Check whether this wallet is connected',
  getShieldedAddresses: 'See your shielded address',
  getUnshieldedAddress: 'See your unshielded address',
  getDustAddress: 'See your DUST address',
  getShieldedBalances: 'See your shielded token balances',
  getUnshieldedBalances: 'See your unshielded token balances',
  getDustBalance: 'See your DUST balance and cap',
  getTxHistory: 'Read your transaction history',
  balanceUnsealedTransaction: 'Add your coins and the fee to a transaction, then ask you to approve it',
  balanceSealedTransaction: 'Add your coins and the fee to a sealed transaction, then ask you to approve it',
  makeTransfer: 'Ask you to approve a transfer from this wallet',
  makeIntent: 'Ask you to approve a swap offer from this wallet',
  signData: 'Ask you to sign a message',
  submitTransaction: 'Submit a transaction to the network',
  getProvingProvider: 'Use this wallet to prove transactions',
  hintUsage: 'Tell this wallet which requests it plans to make',
};

/**
 * One token amount: its name, the amount with a sign, and a tag for shielded
 * ones. A labelled token shows its name, symbol and scaled amount, with its
 * short type under the amount (a label is the user's own name for a type,
 * so the type stays in view); an unlabelled one its raw quantity and type.
 */
function TokenLine({ item, labels, sign = '' }) {
  const { kind, type } = item;
  const value = item.amount ?? item.value ?? '0';
  const negative = BigInt(value) < 0n;
  const abs = (negative ? -BigInt(value) : BigInt(value)).toString();
  const desc = describeToken(labels, type, kind);
  const shown = negative ? '−' : sign;
  return (
    <Row label={(
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{tokenTitle(desc, type)}</span>
        {kind === 'shielded' && <Badge variant="secondary" className="shrink-0 text-[11px]">shielded</Badge>}
      </span>
    )}>
      <span className={shown === '+' ? 'text-kumo-success' : 'text-kumo-default'}>{shown}{tokenAmount(desc, abs)} {tokenUnit(desc)}</span>
      {!desc.fixed && <div className="font-mono text-[11px] text-kumo-subtle">{shortType(type)}</div>}
    </Row>
  );
}

function Collapsed({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between outline-none">
          <span>{title}</span>
          <span className="font-medium text-accent-fg">{open ? 'Hide' : 'Show'}</span>
        </button>
      </LayerCard.Secondary>
      {open && <LayerCard.Primary>{children}</LayerCard.Primary>}
    </LayerCard>
  );
}

const dustText = value => dust(value ?? '0', { full: true });

const Pre = ({ children }) => (
  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-kumo-tint p-2.5 font-mono text-xs text-kumo-default">{children}</pre>
);

/** The wallet's side of a balanced transaction: token changes and the DUST fee. */
function Effect({ described, payFees, labels, dustFee }) {
  if (!described) {
    return <Banner variant="error" icon={<WarningCircleIcon />} title="Cannot describe this transaction" description="The wallet could not work out what it does. Only approve it if you trust this site." />;
  }
  const deltas = described.deltas ?? [];
  return (
    <LayerCard>
      <LayerCard.Secondary>Effect on this wallet</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline">
        {deltas.filter(d => d.kind !== 'dust').map(d => <TokenLine key={`${d.kind}.${d.type}`} item={d} labels={labels} sign="+" />)}
        {!deltas.some(d => d.kind !== 'dust') && <Row label="Tokens"><Text variant="secondary" size="sm">No change</Text></Row>}
        {dustFee && (
          <Row label="Network fee">
            {payFees === false ? <Text variant="secondary" size="sm">Not paid by this wallet</Text> : `${dustText(described.fee)} DUST`}
          </Row>
        )}
        {dustFee && payFees !== false && described.estimatedFee && described.estimatedFee !== described.fee && (
          <Row label="Estimated fee">{`${dustText(described.estimatedFee)} DUST`}</Row>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Contracts({ described }) {
  const calls = described?.contractCalls ?? [];
  const deploys = described?.deploys ?? [];
  if (!calls.length && !deploys.length) return null;
  return (
    <LayerCard>
      <LayerCard.Secondary>Contract activity</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline">
        {deploys.map(d => (
          <Row key={`d${d.address}`} label="Deploys a contract"><span className="font-mono text-xs">{shortAddress(d.address, 10)}</span></Row>
        ))}
        {calls.map((c, i) => (
          <Row key={`c${i}`} label="Calls"><span className="font-mono text-xs">{c.entryPoint}</span><div className="font-mono text-[11px] text-kumo-subtle">{shortAddress(c.address, 10)}</div></Row>
        ))}
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** What the transaction is made of, for a closer look. */
function Details({ described }) {
  if (!described) return null;
  const mine = list => list.filter(x => x.mine).length;
  const inputs = described.unshielded?.inputs ?? [];
  const outputs = described.unshielded?.outputs ?? [];
  return (
    <Collapsed title="Details">
      <div className="flex flex-col divide-y divide-kumo-hairline">
        <Row label="Unshielded inputs">{inputs.length} ({mine(inputs)} yours)</Row>
        <Row label="Unshielded outputs">{outputs.length} ({mine(outputs)} to you)</Row>
        <Row label="Shielded inputs / outputs">{described.shielded?.inputs ?? '0'} / {described.shielded?.outputs ?? '0'}</Row>
        <Row label="DUST spends">{described.dust?.spends ?? 0}</Row>
        {(described.maintenance?.length ?? 0) > 0 && <Row label="Contract updates">{described.maintenance.length}</Row>}
        {(described.dust?.registrations ?? 0) > 0 && <Row label="DUST registrations">{described.dust.registrations}</Row>}
      </div>
    </Collapsed>
  );
}

/** What the wallet is doing about this request while it is prepared: its
 *  own work on it, or waiting for another operation to finish first. */
function preparingText(state) {
  if (state.busy?.ticket === id) return busyText(state.busy, state.sync);
  if (state.busy || state.waiting?.includes(id)) return 'Waiting for the wallet to finish another transaction…';
  return 'Preparing the transaction…';
}

/** Shown while the wallet balances the request. */
function Preparing({ state }) {
  return (
    <LayerCard>
      <LayerCard.Primary className="flex items-center gap-2.5 py-3">
        <Loader />
        <Text variant="secondary" size="sm">{preparingText(state)}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Outputs({ title, outputs, labels }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline">
        {outputs.map((o, i) => (
          <div key={i} className="py-1">
            <TokenLine item={o} labels={labels} />
            {o.recipient && <div className="flex items-center justify-end gap-1.5 pb-1 font-mono text-[11px] text-kumo-subtle">to {shortAddress(o.recipient)}</div>}
          </div>
        ))}
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** The message as text when it is printable, otherwise as hex. */
function Payload({ data, encoding }) {
  let bytes = null;
  try {
    if (encoding === 'hex') bytes = Uint8Array.from(data.match(/../g) ?? [], b => parseInt(b, 16));
    else if (encoding === 'base64') bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  } catch { /* shown as sent */ }
  let text = encoding === 'text' ? data : null;
  if (bytes) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/^[\P{C}\n\t]*$/u.test(decoded)) text = decoded;
    } catch { /* binary payload */ }
  }
  const hex = bytes ? Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') : data;
  return <Pre>{text ?? hex}</Pre>;
}

const COPY = {
  unlock: { title: 'Unlock mdwa?', icon: LockKeyOpenIcon, action: 'Unlock' },
  connect: { title: 'Connect to this site?', icon: PlugsConnectedIcon, action: 'Connect' },
  permissions: { title: 'Allow these requests?', icon: ShieldCheckIcon, action: 'Allow' },
  transaction: { title: 'Approve transaction?', icon: SignatureIcon, action: 'Approve' },
  transfer: { title: 'Send from this wallet?', icon: PaperPlaneTiltIcon, action: 'Send' },
  intent: { title: 'Create swap offer?', icon: ArrowsLeftRightIcon, action: 'Create offer' },
  signData: { title: 'Sign message?', icon: PenNibIcon, action: 'Sign' },
};

function Body({ request, networkLabel, state, labels }) {
  const { kind, params } = request;
  const dustFee = state.networks.find(n => n.id === params.network)?.dust !== false;
  if (params.error) {
    return <Banner variant="error" icon={<WarningCircleIcon />} title="The wallet cannot do this" description={params.error} />;
  }
  if (params.preparing) return <Preparing state={state} />;
  switch (kind) {
    case 'unlock':
      return <Text variant="secondary" size="sm">The wallet is unlocked.</Text>;
    case 'connect':
      return (
        <LayerCard>
          <LayerCard.Secondary>On {networkLabel}, this site will be able to</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-2">
            {['See your addresses and unshielded balances', 'Prove transactions with this wallet and submit them',
              'Ask you to approve transactions, transfers, swap offers and signatures',
              'Ask you before it sees shielded balances, DUST or history'].map(line => (
              <span key={line} className="flex items-start gap-2 text-sm"><CheckIcon size={14} className="mt-0.5 shrink-0 text-kumo-success" /> {line}</span>
            ))}
            <Text variant="secondary" size="xs">It can never move funds or sign without your approval.</Text>
          </LayerCard.Primary>
        </LayerCard>
      );
    case 'permissions':
      return (
        <LayerCard>
          <LayerCard.Secondary>This site asks to</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline">
            {params.methods.map(m => (
              <div key={m} className="flex flex-col gap-0.5 py-2">
                <span className="text-sm">{METHOD_TEXT[m] ?? 'Use this wallet feature'}</span>
                <span className="font-mono text-[11px] text-kumo-subtle">{m}</span>
              </div>
            ))}
          </LayerCard.Primary>
        </LayerCard>
      );
    case 'transaction':
      return (
        <>
          <Contracts described={params.described} />
          <Effect described={params.described} payFees={params.payFees} labels={labels} dustFee={dustFee} />
          <Details described={params.described} />
          <Collapsed title={`Transaction from the site (${params.stage}, hex)`}><Pre>{params.tx}</Pre></Collapsed>
        </>
      );
    case 'transfer':
      return (
        <>
          <Outputs title="This wallet will send" outputs={params.outputs} labels={labels} />
          <Effect described={params.described} payFees={params.payFees} labels={labels} dustFee={dustFee} />
          <Details described={params.described} />
        </>
      );
    case 'intent':
      return (
        <>
          {params.inputs.length > 0 && <Outputs title="You give" outputs={params.inputs} labels={labels} />}
          {params.outputs.length > 0 && <Outputs title="You ask for" outputs={params.outputs} labels={labels} />}
          {params.described && <Effect described={params.described} payFees={params.payFees} labels={labels} dustFee={dustFee} />}
          <Details described={params.described} />
        </>
      );
    case 'signData':
      return (
        <LayerCard>
          <LayerCard.Secondary className="flex items-center justify-between">
            <span>Message</span>
            <Badge variant="secondary">{params.encoding}</Badge>
          </LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-2">
            <Payload data={params.data} encoding={params.encoding} />
            <Text variant="secondary" size="xs">The site gets a signature by this wallet's key, which another program may accept as your consent, even to move funds. Sign only what you expect from this site.</Text>
          </LayerCard.Primary>
        </LayerCard>
      );
    default:
      return <Banner variant="error" description={`This window does not know the request "${kind}".`} />;
  }
}

function App() {
  const [request, setRequest] = useState(null);
  const [state, setState] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [unlockError, setUnlockError] = useState(null);
  const [deciding, setDeciding] = useState(null);   // 'approve' | 'reject' while the engine answers
  const labels = useTokenLabels(state?.network);
  useEffect(() => {
    const load = () => approval('get').then(r => (r?.error ? setError(r.error.message) : setRequest(r.result)));
    load();
    ui('state').then(setState);
    const listener = message => { if (message?.type === 'approvalUpdate' && message.id === id) load(); };
    chrome.runtime.onMessage.addListener(listener);
    const stop = onState(setState);
    return () => { stop(); chrome.runtime.onMessage.removeListener(listener); };
  }, []);
  // An 'unlock' request is done once the wallet is unlocked, here or elsewhere.
  const unlockDone = request?.kind === 'unlock' && state && !(state.hasWallet && state.locked);
  useEffect(() => { if (unlockDone) approval('decide', { approved: true }).then(() => window.close()); }, [unlockDone]);
  if (error && !request) return <div className="p-4"><Banner variant="error" description={error} /></div>;
  if (!request || !state) return <div className="flex items-center justify-center gap-2 p-8"><Loader /><Text variant="secondary">Loading…</Text></div>;

  const copy = COPY[request.kind] ?? { title: 'Approve request?', icon: SignatureIcon, action: 'Approve' };
  const network = request.params?.network ?? state.network;
  const networkLabel = state.networks.find(n => n.id === network)?.name ?? network;
  const locked = state.hasWallet && state.locked;
  const decide = async approved => {
    setDeciding(approved ? 'approve' : 'reject'); setError(null);
    const reply = await approval('decide', { approved });
    if (reply?.error) { setError(reply.error.message); setDeciding(null); return; }
    window.close();
  };
  const unlock = async () => {
    setDeciding('unlock'); setUnlockError(null);
    try {
      await ui('unlock', { password });
      setPassword('');
      await approval('unlocked');
    } catch (e) { setUnlockError(e.message); } finally { setDeciding(null); }
  };
  const Icon = copy.icon;
  const working = deciding === 'approve';
  const blocked = !!request.params?.preparing || !!request.params?.error;
  return (
    <form className="flex min-h-screen flex-col" onSubmit={e => { e.preventDefault(); if (locked) unlock(); else if (!blocked) decide(true); }}>
      <AppHeader network={<NetworkBadge network={network} name={networkLabel} />} />
      <main className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-kumo-info-tint text-accent-fg"><Icon size={20} /></span>
          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="heading" as="h2">{copy.title}</Text>
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-subtle">
              <GlobeHemisphereWestIcon size={14} className="shrink-0" />
              <span className="truncate font-mono">{request.origin}</span>
            </span>
          </div>
        </div>
        {locked ? (
          <Input type="password" label="Password" value={password} onChange={e => setPassword(e.target.value)} autoFocus
            autoComplete="current-password" description={`Unlocks ${state.ownWallet ? `the ${networkLabel} wallet` : 'the wallet'} so you can review this request.`}
            error={unlockError ?? undefined} variant={unlockError ? 'error' : 'default'} />
        ) : <Body request={request} networkLabel={networkLabel} state={state} labels={labels} />}
        {working && <Banner size="sm" icon={<ClockCounterClockwiseIcon />} description={preparingText(state)} />}
        {error && <Banner variant="error" size="sm" description={error} />}
        <div className="mt-auto">
          <Actions
            secondary={<Button type="button" size="lg" disabled={deciding !== null} onClick={() => decide(false)}>{request.params?.error ? 'Close' : 'Reject'}</Button>}
            primary={locked
              ? <Button type="submit" variant="primary" size="lg" loading={deciding === 'unlock'} disabled={deciding !== null || !password}>Unlock</Button>
              : <Button type="submit" variant="primary" size="lg" loading={working} disabled={deciding !== null || blocked}>{copy.action}</Button>} />
        </div>
      </main>
    </form>
  );
}

ensureCurrentBuild().then(current => { if (current) createRoot(document.getElementById('root')).render(<App />); });
