// Settings: the connection to the network, proving, locking, rescanning and
// removing this network's wallet. Every network keeps its own values. A
// network the user added shows its definition instead of the connection
// fields: its endpoints are edited, and the network removed, in its form
// (networks.jsx).
import { useEffect, useState } from 'react';
import { CheckCircleIcon, LockKeyIcon, TrashIcon } from '@phosphor-icons/react';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Loader } from '@cloudflare/kumo/components/loader';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { AddRow, DetailRow, ListCard, PasswordField, PrimaryButton, SecondaryButton, Section, TextField, Viewport } from './components.jsx';
import { DEFAULT_PROOF_SERVER, NETWORKS } from '../../../wallet/networks.mjs';
import { entryFor, withEntry } from './endpoints.js';
import { ui } from './api.js';
import { dateTime, networkName, shortHash, withCommas } from './format.js';

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

function RemoveDialog({ name }) {
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
          <Dialog.Title className="text-base font-semibold text-kumo-default">Remove the {name} wallet?</Dialog.Title>
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
  const [values, setValues] = useState(null);
  const name = networkName(state);
  useEffect(() => {
    setSettings(null); setValues(null);
    ui('settings').then(s => { setSettings(s); setValues(entryFor(s.endpoints, state.network)); });
  }, [state.network]);
  const defaults = entryFor(settings?.defaults, state.network);
  const blockfrost = !!NETWORKS[state.network]?.blockfrost;
  const set = patch => setValues(v => ({ ...v, ...patch }));
  const prover = values?.prover ?? { kind: 'wasm', url: DEFAULT_PROOF_SERVER };

  const save = async (next, title) => {
    try {
      await ui('saveSettings', { network: state.network, endpoints: withEntry(settings.endpoints, state.network, next) });
      setSettings(s => ({ ...s, endpoints: withEntry(s.endpoints, state.network, next) }));
      toasts.add({ title, description: 'Reconnecting with the new settings.', variant: 'success' });
    } catch (e) { toasts.add({ title: 'Could not save', description: e.message, variant: 'error' }); }
  };
  // The project id is the user's credential for the hosted endpoints, not an
  // endpoint: resetting the endpoints leaves it alone.
  const reset = () => {
    const next = { ...values, node: defaults.node, indexerHttp: defaults.indexerHttp, indexerWs: defaults.indexerWs };
    setValues(next);
    save(next, 'Defaults restored');
  };
  const lock = () => ui('lock').catch(e => toasts.add({ title: 'Could not lock', description: e.message, variant: 'error' }));
  const rescan = async fromStart => {
    try {
      await ui('rescan', { fromStart });
      toasts.add({ title: 'Rescanning', description: 'Balances fill in again as the chain is read.', variant: 'success' });
    } catch (e) { toasts.add({ title: 'Could not rescan', description: e.message, variant: 'error' }); }
  };
  const birthday = state.birthday;

  return (
    <Viewport gap="gap-5">
      <h2 className="px-1 text-lg font-bold text-kumo-default">Settings</h2>
      {settings?.definition.user ? <UserNetwork definition={settings.definition} onEdit={() => onForm('edit')} /> : (
        <Section title="Connection" gap="gap-3">
          {!values ? <Loader /> : (
            <>
              <TextField label="Node RPC" mono value={values.node ?? ''} onChange={e => set({ node: e.target.value })} spellCheck={false} />
              <TextField label="Indexer HTTP" mono value={values.indexerHttp ?? ''} onChange={e => set({ indexerHttp: e.target.value })} spellCheck={false} />
              <TextField label="Indexer WebSocket" mono value={values.indexerWs ?? ''} onChange={e => set({ indexerWs: e.target.value })} spellCheck={false} />
              {blockfrost && (
                <PasswordField label="Blockfrost project id" mono autoComplete="off" value={values.projectId ?? ''}
                  onChange={e => set({ projectId: e.target.value })}
                  description="Preprod and Mainnet are served through Blockfrost. The project id stays on this device and is never shown to sites." />
              )}
              <SecondaryButton className="w-full" onClick={() => save(values, 'Saved')}>Save connection</SecondaryButton>
              <SecondaryButton className="w-full" onClick={reset}>Reset to defaults</SecondaryButton>
            </>
          )}
        </Section>
      )}
      <Section title="Proving" gap="gap-3">
        {!values ? <Loader /> : (
          <>
            <ProverChoice value={prover.kind} onChange={kind => set({ prover: { ...prover, kind, url: prover.url || DEFAULT_PROOF_SERVER } })} />
            {prover.kind === 'server' && (
              <TextField label="Proof server URL" mono value={prover.url ?? ''} placeholder={DEFAULT_PROOF_SERVER}
                onChange={e => set({ prover: { ...prover, url: e.target.value } })} spellCheck={false} />
            )}
            <SecondaryButton className="w-full" onClick={() => save(values, 'Saved')}>Save proving</SecondaryButton>
          </>
        )}
      </Section>
      <Section title="Session">
        <ListCard>
          <AddRow icon={LockKeyIcon} label="Lock wallet" trailing="Asks for your password again" onClick={lock} />
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
          <SecondaryButton className="w-full" onClick={() => rescan(false)}>Rescan</SecondaryButton>
        </div>
        {birthday && (
          <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
            <span className="text-sm font-semibold text-kumo-default">Rescan from the start of the chain</span>
            <p className="text-xs leading-normal text-kumo-subtle">
              Removes the wallet birthday and scans every shielded transaction since the chain began, to find tokens received
              before the birthday. It downloads the chain's whole shielded history, which takes much longer than a rescan from the birthday.
            </p>
            <SecondaryButton className="w-full" onClick={() => rescan(true)}>Rescan from the start of the chain</SecondaryButton>
          </div>
        )}
      </Section>
      <Section title="Danger zone">
        <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base p-3.5">
          <span className="text-sm font-semibold text-kumo-default">Remove the {name} wallet</span>
          <p className="text-xs leading-normal text-kumo-subtle">
            Deletes this network's encrypted key, history and site approvals from this browser. Other networks are not touched.
            You need the recovery phrase to restore it.
          </p>
          <RemoveDialog name={name} />
        </div>
      </Section>
    </Viewport>
  );
}
