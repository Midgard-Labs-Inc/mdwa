// Activity: the wallet's transactions grouped by month with the signed change
// of each token, and a detail page for one transaction.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeftIcon, ArrowUpRightIcon, ClockCounterClockwiseIcon, CopyIcon } from '@phosphor-icons/react';
import { Empty } from '@cloudflare/kumo/components/empty';
import { Loader } from '@cloudflare/kumo/components/loader';
import { Pagination } from '@cloudflare/kumo/components/pagination';
import { DetailRow, ListCard, PageHeader, Screen, Section, StatusPill, TxRow, Viewport, useCopy } from './components.jsx';
import { ui } from './api.js';
import { dateTime, dust, shortHash, toDate, withCommas } from './format.js';
import { describeToken, tokenAmount, tokenTitle, useTokenLabels } from './tokens.js';

const PER_PAGE = 8;
const monthOf = time => toDate(time)?.toLocaleString('en-US', { month: 'long', year: 'numeric' }) ?? 'Unknown date';
const dayOf = time => {
  const d = toDate(time);
  if (!d) return '—';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
};
const hostOf = origin => { try { return new URL(origin).host; } catch { return origin; } };

const entryPoints = calls => [...new Set((calls ?? []).map(c => c.entryPoint))].join(', ');

/**
 * What the transaction was, in words, from what the engine knows: the kind
 * it noted when this wallet made the transaction ('send', 'dust', 'dapp' with
 * what the site's transaction did, 'offer'), else the direction its tokens
 * moved ('receive', 'send'). A transaction the wallet did not make and that
 * moved no tokens but DUST ('other') is only called a transaction: the
 * wallet does not know what it did.
 */
function titleOf(tx) {
  const host = tx.origin ? hostOf(tx.origin) : 'a site';
  switch (tx.kind) {
    case 'receive': return 'Received';
    case 'send': return 'Sent';
    case 'dust': return tx.action === 'deregister' ? 'DUST deregistration' : 'DUST registration';
    case 'offer': return `Swap offer for ${host}`;
    case 'dapp':
      if (tx.deploys?.length || tx.action === 'deploy') return 'Contract deployment';
      if (tx.calls?.length) return `Call to ${entryPoints(tx.calls)}`;
      if (tx.action === 'transfer') return `Transfer for ${host}`;
      return `Transaction for ${host}`;
    default: return 'Transaction';
  }
}

/** Whether the title already names the site, so the line under it need not. */
const titleNamesSite = tx => !!tx.origin && titleOf(tx).endsWith(hostOf(tx.origin));

// The fee leaves in DUST on every send, so only the other tokens say which way funds moved.
const isIncoming = tx => {
  if (tx.kind === 'receive') return true;
  if (tx.kind !== 'other') return false;
  const moved = tx.deltas.filter(d => d.kind !== 'dust');
  return moved.length > 0 && moved.every(d => BigInt(d.amount) >= 0n);
};

// A swap offer is handed to the site, not submitted by this wallet: it is
// 'offered' until the site's counterparty takes it or its coins are released
// ('expired').
const STATUS = { pending: ['Pending', 'warning'], failed: ['Failed', 'danger'], offered: ['Offered', 'neutral'], expired: ['Expired', 'neutral'] };
const STATUS_TEXT = {
  pending: 'Pending', confirmed: 'Confirmed', finalized: 'Finalized', failed: 'Failed',
  offered: 'Handed to the site, not submitted by this wallet', expired: 'Not taken: its coins were released',
};
const statusPill = status => (STATUS[status] ? <StatusPill tone={STATUS[status][1]}>{STATUS[status][0]}</StatusPill> : null);

/**
 * One signed line per token change; shielded ones carry a small tag. `unit`
 * is compact for the list (the symbol, or the start of an unlabelled type),
 * `label` complete for the detail page.
 */
function deltaLines(deltas, labels) {
  return deltas.map(d => {
    const q = BigInt(d.amount);
    const abs = q < 0n ? -q : q;
    const desc = describeToken(labels, d.type, d.kind);
    const text = d.kind === 'dust' ? dust(abs.toString()) : tokenAmount(desc, abs.toString());
    const label = desc.fixed ? desc.symbol : desc.labelled ? `${desc.name} (${desc.symbol})` : tokenTitle(desc, d.type);
    const unit = desc.symbol ?? `${d.type.slice(0, 6)}…`;
    return { key: `${d.kind}.${d.type}`, type: d.kind === 'dust' ? undefined : d.type, text: `${q < 0n ? '−' : '+'}${text}`, unit, label, positive: q > 0n, tag: d.kind === 'shielded' ? 'shielded' : null };
  });
}

/** `refresh` changes when the list may have: a new block, a sync state, what the wallets applied, the wallet's own work. */
export function Activity({ network, refresh, onOpen }) {
  const labels = useTokenLabels(network);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // A new network starts on its own first page.
  useEffect(() => { setPage(1); }, [network]);
  useEffect(() => {
    let live = true;
    setError(null);
    ui('history', { offset: (page - 1) * PER_PAGE, limit: PER_PAGE }).then(r => { if (live) setData(r); }, e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [page, network, refresh]);
  const months = useMemo(() => {
    const groups = [];
    for (const tx of data?.items ?? []) {
      const month = monthOf(tx.time);
      if (groups.at(-1)?.month !== month) groups.push({ month, txs: [] });
      groups.at(-1).txs.push(tx);
    }
    return groups;
  }, [data]);
  return (
    <Viewport gap="gap-3">
      <div className="flex items-end justify-between px-1">
        <h2 className="text-lg font-bold text-kumo-default">Activity</h2>
        {data && <span className="text-xs text-kumo-subtle">{data.total} transaction{data.total === 1 ? '' : 's'}</span>}
      </div>
      {!data && !error && <div className="flex justify-center p-6"><Loader /></div>}
      {error && <p className="px-1 text-xs text-kumo-danger">{error}</p>}
      {data && !data.total && (
        <Empty size="sm" icon={<ClockCounterClockwiseIcon size={28} />} title="No transactions yet"
          description="Transfers, DUST changes and contract calls of this wallet appear here." />
      )}
      {months.map(({ month, txs }) => (
        <Section key={month} title={month}>
          <ListCard>
            {txs.map(tx => {
              const incoming = isIncoming(tx);
              return (
                <button key={tx.hash} type="button" onClick={() => onOpen(tx.hash)}
                  className="block w-full text-left outline-none hover:bg-kumo-tint focus-visible:bg-kumo-tint">
                  <TxRow incoming={incoming} title={titleOf(tx)} status={statusPill(tx.status)} Arrow={incoming ? ArrowDownLeftIcon : ArrowUpRightIcon}
                    meta={tx.origin && !titleNamesSite(tx) ? `${hostOf(tx.origin)} · ${dayOf(tx.time)}` : `${dayOf(tx.time)} · ${shortHash(tx.hash)}`}
                    deltas={deltaLines(tx.deltas, labels)} />
                </button>
              );
            })}
          </ListCard>
        </Section>
      ))}
      {data?.total > PER_PAGE && <Pagination page={page} setPage={setPage} perPage={PER_PAGE} totalCount={data.total} controls="simple" />}
    </Viewport>
  );
}

// --------------------------------------------------------------- detail --
export function TxDetail({ hash, network, dust: withDust, onBack }) {
  const labels = useTokenLabels(network);
  const [tx, setTx] = useState(undefined);
  const [error, setError] = useState(null);
  const [copied, copy] = useCopy();
  const [rawOpen, setRawOpen] = useState(false);
  useEffect(() => {
    setTx(undefined); setError(null);
    ui('txDetail', { hash }).then(setTx, e => { setError(e.message); setTx(null); });
  }, [hash]);
  const incoming = tx && isIncoming(tx);
  const raw = typeof tx?.raw === 'string' ? tx.raw : null;
  // An offer that never reached a block has no transaction hash: it is named by its first identifier.
  const unsubmitted = tx && (tx.status === 'offered' || tx.status === 'expired');
  return (
    <Screen>
      <PageHeader title="Transaction" onBack={onBack} />
      {tx === undefined ? <Viewport className="items-center"><Loader /></Viewport> : !tx ? (
        <Viewport><p className="text-sm text-kumo-subtle">{error ?? 'This transaction is not in this wallet\'s history.'}</p></Viewport>
      ) : (
        <Viewport>
          <div className="flex flex-col items-center gap-2 pt-1">
            <span className={`flex size-12 items-center justify-center rounded-full ${incoming ? 'bg-kumo-success-tint text-kumo-success' : 'bg-kumo-tint text-kumo-default'}`}>
              {incoming ? <ArrowDownLeftIcon size={22} weight="bold" /> : <ArrowUpRightIcon size={22} weight="bold" />}
            </span>
            <span className="max-w-full truncate px-2 text-[17px] font-bold text-kumo-default">{titleOf(tx)}</span>
            <span className="flex items-center gap-1.5 text-xs text-kumo-subtle">{statusPill(tx.status)}{dateTime(tx.time)}</span>
          </div>
          <Section title="Balance change" trailing="this transaction">
            <ListCard>
              {tx.deltas.length ? deltaLines(tx.deltas, labels).map(d => (
                <DetailRow key={d.key} label={<span className="flex min-w-0 items-center gap-1.5"><span className="truncate" title={d.type}>{d.label}</span>{d.tag && <StatusPill>{d.tag}</StatusPill>}</span>}>
                  <span className={d.positive ? 'text-kumo-success' : undefined}>{d.text}</span>
                </DetailRow>
              )) : <p className="px-4 py-3 text-xs text-kumo-subtle">No change to this wallet's balances</p>}
            </ListCard>
          </Section>
          <Section title="Transaction">
            <ListCard>
              {tx.fee != null && withDust && <DetailRow label="Network fee">{dust(tx.fee, { full: true })} DUST</DetailRow>}
              <button type="button" onClick={() => copy(tx.hash)} className="w-full text-left outline-none hover:bg-kumo-tint" aria-label="Copy transaction hash">
                <DetailRow label={unsubmitted ? 'Identifier' : 'Hash'} mono>{copied ? 'Copied' : <span className="inline-flex items-center gap-1">{shortHash(tx.hash)} <CopyIcon size={11} /></span>}</DetailRow>
              </button>
              {tx.block != null && <DetailRow label="Block">{withCommas(tx.block)}</DetailRow>}
              <DetailRow label="Status">{STATUS_TEXT[tx.status] ?? tx.status}{tx.partial ? ' (partly)' : ''}</DetailRow>
              {tx.origin && <DetailRow label="Requested by" mono>{hostOf(tx.origin)}</DetailRow>}
              {(tx.deploys ?? []).map(address => <DetailRow key={`d${address}`} label="Deployed" mono>{shortHash(address)}</DetailRow>)}
              {(tx.calls ?? []).map((c, i) => <DetailRow key={`c${i}`} label={`Called ${c.entryPoint}`} mono>{shortHash(c.address)}</DetailRow>)}
            </ListCard>
          </Section>
          {raw && (
            <Section title="Raw" trailing={tx.size != null ? `${withCommas(tx.size)} bytes` : undefined}>
              <ListCard>
                <button type="button" onClick={() => setRawOpen(o => !o)} className="flex items-center justify-between px-4 py-[11px] text-left text-[13px] outline-none hover:bg-kumo-tint">
                  <span className="text-kumo-subtle">Serialized transaction</span>
                  <span className="font-medium text-accent-fg">{rawOpen ? 'Hide' : 'Show'}</span>
                </button>
                {rawOpen && (
                  <pre className="max-h-48 overflow-auto bg-kumo-recessed px-4 py-2.5 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all text-kumo-default">{raw}</pre>
                )}
              </ListCard>
            </Section>
          )}
        </Viewport>
      )}
    </Screen>
  );
}
