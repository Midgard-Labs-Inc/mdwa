// Chain sync: the summary card shown on Home and in the header pill, and the
// Sync details page with per-wallet progress and the connection in use. A
// network without DUST shows two wallets.
import { useEffect, useState } from 'react';
import { Loader } from '@cloudflare/kumo/components/loader';
import { DetailRow, ListCard, PageHeader, Screen, Section, SyncCard, Viewport } from './components.jsx';
import { entryFor } from './endpoints.js';
import { ui } from './api.js';
import { dateTime, hasDust, percentText, withCommas } from './format.js';

/** The header pill's status and label for the engine's sync state. */
export function syncPill(sync) {
  switch (sync?.status) {
    case 'synced': return { status: 'synced', label: 'Synced' };
    case 'syncing': return { status: 'syncing', label: `${Math.floor(sync.percent ?? 0)}%` };
    case 'error': return { status: 'error', label: 'Disconnected' };
    case 'connecting': return { status: 'connecting', label: 'Connecting' };
    default: return { status: 'connecting', label: 'Idle' };
  }
}

/** The sync card: progress while catching up, otherwise the connection state. */
export function SyncSummary({ sync, onClick }) {
  const tip = sync?.tip != null ? `Block ${withCommas(sync.tip)}` : undefined;
  if (sync?.status === 'error') return <SyncCard title="Disconnected from the network" error={sync.error ?? 'Reconnecting…'} onClick={onClick} />;
  if (sync?.status === 'synced') return <SyncCard title="At the chain tip" progress={1} left={tip} onClick={onClick} />;
  if (sync?.status === 'syncing') {
    return <SyncCard title="Catching up with the chain" percent={percentText(sync.percent)} progress={(sync.percent ?? 0) / 100}
      left={sync.tip != null ? `Chain tip ${withCommas(sync.tip)}` : undefined} onClick={onClick} />;
  }
  if (sync?.error) return <SyncCard title="Cannot reach the network yet" error={sync.error} onClick={onClick} />;
  return <SyncCard title="Connecting to the network…" onClick={onClick} />;
}

/**
 * Where the shielded scan starts, in a sentence: the wallet birthday (a new
 * wallet's is the block it was created at), or the start of the chain. When
 * the running session could not start at the birthday, says so and why.
 * With `onlyBirthday`, nothing for a wallet without one.
 */
export function ScanStart({ state, onlyBirthday = false }) {
  const birthday = state.birthday;
  const start = state.sync?.start?.shielded;
  if (!birthday && onlyBirthday) return null;
  const fellBack = birthday && start?.from === 'start' && start.reason;
  return (
    <p className="text-xs leading-normal text-kumo-subtle">
      {birthday
        ? `Scanning shielded tokens from ${dateTime(birthday.time)} (block ${withCommas(birthday.height)}). Shielded tokens received before then are not found.`
        : 'Scanning shielded tokens from the start of the chain.'}
      {fellBack ? ` ${start.reason}.` : ''}
      {!birthday && state.birthdayNote ? ` ${state.birthdayNote}.` : ''}
    </p>
  );
}

const proverText = prover => (prover?.kind === 'server' ? prover.url : 'In this browser (WASM)');

export function SyncDetails({ state, onBack }) {
  const [settings, setSettings] = useState(null);
  useEffect(() => { ui('settings').then(setSettings, () => setSettings({})); }, [state.network]);
  const sync = state.sync;
  const parts = sync?.parts ?? {};
  const entry = entryFor(settings?.endpoints, state.network);
  const row = (label, key) => <DetailRow label={label}>{parts[key] ? percentText(parts[key].percent) : '—'}</DetailRow>;
  return (
    <Screen>
      <PageHeader title="Chain sync" onBack={onBack} />
      <Viewport>
        <SyncSummary sync={sync} />
        <Section title="Progress">
          <ListCard>
            {row('Shielded', 'shielded')}
            {row('Unshielded', 'unshielded')}
            {hasDust(state) && row('DUST', 'dust')}
            <DetailRow label="Chain tip">{sync?.tip != null ? withCommas(sync.tip) : '—'}</DetailRow>
          </ListCard>
        </Section>
        <Section title="Connection">
          {!settings ? <div className="flex justify-center p-4"><Loader /></div> : (
            <ListCard>
              {entry.submitUrl ? <DetailRow label="Submit URL" mono>{entry.submitUrl}</DetailRow> : <DetailRow label="Node" mono>{entry.node ?? '—'}</DetailRow>}
              <DetailRow label="Indexer" mono>{entry.indexerHttp ?? '—'}</DetailRow>
              <DetailRow label="Prover" mono>{proverText(state.prover)}</DetailRow>
            </ListCard>
          )}
        </Section>
        <ScanStart state={state} />
        <p className="text-xs leading-normal text-kumo-subtle">
          The wallet reads the chain through this node and indexer. Your keys never leave this device.
        </p>
      </Viewport>
    </Screen>
  );
}
