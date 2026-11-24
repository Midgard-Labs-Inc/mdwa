// Settings: the connection to the network, proving, locking, rescanning (from
// the birthday, a date or the start of the chain) and removing the wallet.
// Every network keeps its own connection values: a built-in network connects
// through its default provider or through the user's own node and indexer
// (Mainnet has no default). A network the user added shows its definition
// instead: its endpoints are edited, and the network removed, in its form
// (networks.jsx). Before a wallet exists, the welcome screen shows the
// connection and proving only, so a wallet is created through them.
import { useEffect, useState } from 'react';
import { CheckCircleIcon, LockKeyIcon, TrashIcon } from '@phosphor-icons/react';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Loader } from '@cloudflare/kumo/components/loader';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { AddRow, DateField, DetailRow, ListCard, PasswordField, PrimaryButton, SecondaryButton, Section, Segmented, TextField, Viewport } from './components.jsx';
import { DEFAULT_PROOF_SERVER, needsProjectId, sameEndpoint } from '../../../wallet/networks.mjs';
import { entryFor, withEntry } from './endpoints.js';
import { ui } from './api.js';
import { dateTime, localDay, networkName, shortHash, withCommas } from './format.js';

const PROVERS = [
  { kind: 'wasm', title: 'In this browser (WASM)', hint: 'No extra software, slower' },
  { kind: 'server', title: 'Proof server', hint: 'Faster, needs a proof server running' },
];

/** The two ways to prove: one tinted row each, the chosen one checked. */
function ProverChoice({ value, onChange }) {
  return (
    <ListCard>
      {PROVERS.map(p => (
        <button key={p.kind} type="button" role="radio" aria-checked={value === p.kind} onClick={() => onChange(p.kind)}
          className="flex items-center gap-3 px-3.5 py-2.5 text-left outline-none hover:bg-kumo-tint focus-visible:bg-kumo-tint">
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-sm font-semibold text-kumo-default">{p.title}</span>
            <span className="text-xs text-kumo-subtle">{p.hint}</span>
          </span>
          {value === p.kind && <CheckCircleIcon size={18} weight="bold" className="shrink-0 text-accent-fg" />}
        </button>
      ))}
    </ListCard>
  );
}

function RemoveDialog({ title }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setPassword(''); setError(null); } }, [open]);
  const remove = async e => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await ui('resetWallet', { password }); setOpen(false); } catch (x) { setError(x.message); } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={p => <SecondaryButton {...p} className="w-full" tone="danger" icon={TrashIcon}>Remove wallet…</SecondaryButton>} />
      <Dialog size="sm" className="p-6">
        <form onSubmit={remove} className="flex flex-col gap-4">
          <Dialog.Title className="text-base font-semibold text-kumo-default">{title}?</Dialog.Title>
          <Dialog.Description className="text-[13px] leading-normal text-kumo-subtle">Funds stay on chain. Without the recovery phrase you cannot restore access.</Dialog.Description>
          <PasswordField value={password} onChange={e => setPassword(e.target.value)} error={error} autoFocus />
          <div className="flex gap-2">
            <Dialog.Close render={p => <SecondaryButton {...p} type="button">Cancel</SecondaryButton>} />
            <PrimaryButton type="submit" variant="destructive" className="flex-1" loading={busy} disabled={!password}>Remove</PrimaryButton>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

const ADDRESSES = [['node', 'Node RPC', 'wss://…'], ['indexerHttp', 'Indexer HTTP', 'https://…/api/v4/graphql'], ['indexerWs', 'Indexer WebSocket', 'wss://…/api/v4/graphql/ws']];
const addressesOf = entry => Object.fromEntries(ADDRESSES.map(([key]) => [key, entry[key] ?? '']));
const capitalized = text => text[0].toUpperCase() + text.slice(1);

/** Confirms a change of a wallet's indexer, which discards what it synced. */
function IndexerDialog({ name, onConfirm, onClose }) {
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog size="sm" className="p-6">
        <div className="flex flex-col gap-4">
          <Dialog.Title className="text-base font-semibold text-kumo-default">Change the indexer?</Dialog.Title>
          <Dialog.Description className="text-[13px] leading-normal text-kumo-subtle">
            What the wallet synced on {name} through the current indexer is discarded, and {name} syncs again through the new one. Funds stay on chain.
          </Dialog.Description>
          <div className="flex gap-2">
            <Dialog.Close render={p => <SecondaryButton {...p} type="button">Cancel</SecondaryButton>} />
            <PrimaryButton className="flex-1" onClick={onConfirm}>Change indexer</PrimaryButton>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

/**
 * A built-in network's connection: its default provider, shown read-only, or
 * the user's own node and indexer, all three required. The choice starts as
 * stored: addresses other than the defaults are the user's own. A Blockfrost
 * project id is asked for while an address in use is on Blockfrost.
 */
function Connection({ state, name, definition, stored, defaults, onSave }) {
  const own = !definition.provider || !ADDRESSES.every(([key]) => sameEndpoint(stored[key], defaults[key]));
  const [via, setVia] = useState(own ? 'own' : 'default');
  const [typed, setTyped] = useState(own ? addressesOf(stored) : addressesOf({}));
  const [projectId, setProjectId] = useState(stored.projectId ?? '');
  const [confirming, setConfirming] = useState(null);
  const addresses = via === 'own' ? typed : addressesOf(defaults);
  const choices = [
    ...(definition.provider ? [{ value: 'default', label: capitalized(definition.provider) }] : []),
    { value: 'own', label: 'Your own node and indexer' },
  ];
  const ready = Object.values(addresses).every(url => url.trim());
  const next = { ...stored, ...Object.fromEntries(Object.entries(addresses).map(([key, url]) => [key, url.trim()])), projectId };
  // A wallet's synced state belongs to the indexer it came from (the engine
  // discards it when the indexer changes).
  const save = () => (state.hasWallet && stored.indexerHttp && next.indexerHttp !== stored.indexerHttp ? setConfirming(next) : onSave(next));
  return (
    <Section title="Connection" gap="gap-3">
      <Segmented label={`Where ${name} connects`} options={choices} value={via} onChange={setVia} />
      {via === 'own'
        ? ADDRESSES.map(([key, label, placeholder]) => (
          <TextField key={key} label={label} mono value={typed[key]} placeholder={placeholder} spellCheck={false}
            onChange={e => setTyped(t => ({ ...t, [key]: e.target.value }))} />
        ))
        : <ListCard>{ADDRESSES.map(([key, label]) => <DetailRow key={key} label={label} mono>{defaults[key]}</DetailRow>)}</ListCard>}
      {needsProjectId(addresses) && (
        <PasswordField label="Blockfrost project id" mono autoComplete="off" value={projectId} onChange={e => setProjectId(e.target.value)}
          description="From your Blockfrost account. It stays on this device, goes only to Blockfrost, and is never shown to sites." />
      )}
      <SecondaryButton className="w-full" disabled={!ready} onClick={save}>Save connection</SecondaryButton>
      {confirming && <IndexerDialog name={name} onClose={() => setConfirming(null)} onConfirm={() => { onSave(confirming); setConfirming(null); }} />}
    </Section>
  );
}

/** A user network's definition, with Edit opening its form. */
function UserNetwork({ definition, onEdit }) {
  return (
    <Section title="Network" gap="gap-3">
      <ListCard>
        <DetailRow label="Network id" mono>{definition.networkId}</DetailRow>
        <DetailRow label="Indexer HTTP" mono>{definition.indexerHttp}</DetailRow>
        <DetailRow label="Indexer WebSocket" mono>{definition.indexerWs}</DetailRow>
        {definition.submitUrl ? <DetailRow label="Submit URL" mono>{definition.submitUrl}</DetailRow> : <DetailRow label="Node RPC" mono>{definition.node}</DetailRow>}
        <DetailRow label="DUST">{definition.dust ? 'Yes' : 'No: no fees'}</DetailRow>
        <DetailRow label="First block" mono>{shortHash(definition.genesisHash)}</DetailRow>
      </ListCard>
      <SecondaryButton className="w-full" onClick={onEdit}>Edit network</SecondaryButton>
    </Section>
  );
}

export function Settings({ state, onForm }) {
  const toasts = useKumoToastManager();
  const [settings, setSettings] = useState(null);
  const [prover, setProver] = useState(null);
  const name = networkName(state);
  useEffect(() => {
    setSettings(null); setProver(null);
    ui('settings').then(s => { setSettings(s); setProver(entryFor(s.endpoints, state.network).prover); });
  }, [state.network]);
  const stored = entryFor(settings?.endpoints, state.network);

  // Each section saves its own part over what is stored.
  const save = async next => {
    try {
      await ui('saveSettings', { network: state.network, endpoints: withEntry(settings.endpoints, state.network, next) });
      const s = await ui('settings');
      setSettings(s);
      toasts.add({ title: 'Saved', description: state.hasWallet ? 'Reconnecting with the new settings.' : 'A wallet you create or restore here uses them.', variant: 'success' });
    } catch (e) { toasts.add({ title: 'Could not save', description: e.message, variant: 'error' }); }
  };
  const lock = () => ui('lock').catch(e => toasts.add({ title: 'Could not lock', description: e.message, variant: 'error' }));
  const [rescanDate, setRescanDate] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const rescan = async params => {
    setRescanning(true);
    try {
      await ui('rescan', params);
      toasts.add({ title: 'Rescanning', description: 'Balances fill in again as the chain is read.', variant: 'success' });
    } catch (e) { toasts.add({ title: 'Could not rescan', description: e.message, variant: 'error' }); } finally { setRescanning(false); }
  };
  const birthday = state.birthday;
  // As in the restore form: the picker is bounded to today, and a typed date past it is refused too.
  const today = localDay(Date.now());
  const futureDate = rescanDate !== '' && rescanDate > today;
  const removeTitle = state.ownWallet ? `Remove the ${name} wallet` : 'Remove the wallet';

  return (
    <Viewport gap="gap-5">
      {state.hasWallet && <h2 className="px-1 text-lg font-bold text-kumo-default">Settings</h2>}
      {!settings ? <Section title="Connection"><Loader /></Section>
        : settings.definition.user ? <UserNetwork definition={settings.definition} onEdit={() => onForm('edit')} />
          : <Connection key={JSON.stringify(stored)} state={state} name={name} definition={settings.definition} stored={stored}
            defaults={entryFor(settings.defaults, state.network)} onSave={save} />}
      <Section title="Proving" gap="gap-3">
        {!prover ? <Loader /> : (
          <>
            <ProverChoice value={prover.kind} onChange={kind => setProver(p => ({ ...p, kind, url: p.url || DEFAULT_PROOF_SERVER }))} />
            {prover.kind === 'server' && (
              <TextField label="Proof server URL" mono value={prover.url ?? ''} placeholder={DEFAULT_PROOF_SERVER}
                onChange={e => setProver(p => ({ ...p, url: e.target.value }))} spellCheck={false} />
            )}
            <SecondaryButton className="w-full" onClick={() => save({ ...stored, prover })}>Save proving</SecondaryButton>
          </>
        )}
      </Section>
      {state.hasWallet && (
        <>
          <Section title="Session">
            <ListCard>
              <AddRow icon={LockKeyIcon} label="Lock wallet" trailing="Every network asks for its password again" onClick={lock} />
            </ListCard>
          </Section>
          <Section title="History">
            <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
              <span className="text-sm font-semibold text-kumo-default">Rescan</span>
              <p className="text-xs leading-normal text-kumo-subtle">
                {birthday
                  ? `Syncs ${name} again, shielded tokens from the wallet birthday (${dateTime(birthday.time)}, block ${withCommas(birthday.height)}). `
                  : `Syncs ${name} again from the start of the chain. `}
                Use it if balances or activity look wrong. It can take a while.
              </p>
              <SecondaryButton className="w-full" disabled={rescanning} onClick={() => rescan({})}>Rescan</SecondaryButton>
            </div>
            <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
              <span className="text-sm font-semibold text-kumo-default">Rescan from a date</span>
              <p className="text-xs leading-normal text-kumo-subtle">
                {state.ownWallet
                  ? `Moves the wallet birthday on ${name} to this date and syncs ${name} again from it.`
                  : `Moves the wallet birthday on ${name} to this date and syncs ${name} again from it; networks the wallet opens on later start from it too.`}
              </p>
              <DateField label="Wallet birthday" value={rescanDate} max={today} onChange={e => setRescanDate(e.target.value)}
                error={futureDate ? 'The birthday cannot be in the future' : null}
                description={`Shielded tokens received before this date will not be found on ${name}.`} />
              <SecondaryButton className="w-full" disabled={rescanning || !rescanDate || futureDate} onClick={() => rescan({ date: rescanDate })}>Rescan from a date</SecondaryButton>
            </div>
            {birthday && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
                <span className="text-sm font-semibold text-kumo-default">Rescan from the start of the chain</span>
                <p className="text-xs leading-normal text-kumo-subtle">
                  Removes the wallet birthday and scans every shielded transaction since the chain began, to find tokens received
                  before the birthday. It downloads the chain's whole shielded history, which takes much longer than a rescan from the birthday.
                </p>
                <SecondaryButton className="w-full" disabled={rescanning} onClick={() => rescan({ fromStart: true })}>Rescan from the start of the chain</SecondaryButton>
              </div>
            )}
          </Section>
          <Section title="Danger zone">
            <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
              <span className="text-sm font-semibold text-kumo-default">{removeTitle}</span>
              <p className="text-xs leading-normal text-kumo-subtle">
                {state.ownWallet
                  ? `Deletes the wallet ${name} keeps of its own: its encrypted key, history and site approvals, from this browser. Other networks are not touched. `
                  : 'Deletes the encrypted key, and every network\'s history, notes, token labels and site approvals, from this browser. A network with a wallet of its own keeps it. '}
                You need the recovery phrase to restore it.
              </p>
              <RemoveDialog title={state.ownWallet ? removeTitle : 'Remove the wallet from every network'} />
            </div>
          </Section>
        </>
      )}
    </Viewport>
  );
}
