// Adding, editing and removing the user's own networks. The user types every
// URL: the indexer's HTTP and WebSocket endpoints, and either a Midnight
// node's WebSocket RPC or an HTTP submit URL, and says whether the network
// has DUST. Endpoints the extension's page policy would block are refused
// here, as the engine does; the engine reads the chain's first block from
// the indexer when it stores the network.
import { useEffect, useState } from 'react';
import { TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Loader } from '@cloudflare/kumo/components/loader';
import { ActionFooter, PageHeader, PrimaryButton, Screen, SecondaryButton, Section, Segmented, TextField, Viewport } from './components.jsx';
import { policyBlocks } from '../../../wallet/networks.mjs';
import { ui } from './api.js';

const SUBMISSION = [{ value: 'node', label: 'Midnight node' }, { value: 'submitUrl', label: 'HTTP endpoint' }];

/** Why the extension cannot reach a typed URL, or null (also for one that is not a URL yet: the engine says so on save). */
const blocked = url => {
  try { return url.trim() ? policyBlocks(url.trim()) : null; } catch { return null; }
};

/**
 * The add form (`editing` false) or the edit form of the selected network.
 * `onDone(id)` closes it, with the network to select after an add.
 */
export function NetworkForm({ state, editing, onDone }) {
  const [loaded, setLoaded] = useState(!editing);
  const [values, setValues] = useState({ name: '', networkId: '', indexerHttp: '', indexerWs: '', node: '', submitUrl: '', dust: true });
  const [via, setVia] = useState('node');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!editing) return;
    ui('settings').then(s => {
      setValues(v => ({ ...v, ...s.definition }));
      setVia(s.definition.submitUrl ? 'submitUrl' : 'node');
      setLoaded(true);
    }, e => setError(e.message));
  }, [editing]);
  const set = patch => { setError(null); setValues(v => ({ ...v, ...patch })); };
  const run = async (what, fn) => {
    setBusy(what); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const urls = ['indexerHttp', 'indexerWs', via];
  const ready = values.name.trim() && values.networkId.trim() && urls.every(key => values[key].trim() && !blocked(values[key]));
  const save = () => run('save', async () => {
    const { network } = await ui('saveNetwork', {
      ...(editing ? { network: state.network } : {}), name: values.name, networkId: values.networkId,
      indexerHttp: values.indexerHttp, indexerWs: values.indexerWs, [via]: values[via], dust: values.dust,
    });
    onDone(editing ? null : network);
  });
  const remove = () => run('remove', async () => { await ui('removeNetwork', { network: state.network }); onDone(null); });

  const field = (key, label, placeholder, description) => (
    <TextField label={label} mono value={values[key]} placeholder={placeholder} spellCheck={false} error={blocked(values[key])}
      description={description} onChange={e => set({ [key]: e.target.value })} />
  );
  return (
    <Screen>
      <PageHeader title={editing ? 'Edit network' : 'Add a network'} onBack={() => onDone(null)} />
      {!loaded ? <Viewport className="items-center">{error ? <Banner variant="error" description={error} /> : <Loader />}</Viewport> : (
        <Viewport>
          <TextField label="Name" value={values.name} maxLength={32} onChange={e => set({ name: e.target.value })} description="Shown in the network menu." />
          <TextField label="Network id" mono value={values.networkId} placeholder="undeployed" spellCheck={false} disabled={editing}
            description={editing ? 'Fixed once the network is added: the wallet\'s addresses are made with it.' : 'As the chain\'s addresses carry it, e.g. undeployed in mn_addr_undeployed1…'}
            onChange={e => set({ networkId: e.target.value })} />
          {field('indexerHttp', 'Indexer HTTP', 'http://localhost:8088/api/v4/graphql')}
          {field('indexerWs', 'Indexer WebSocket', 'ws://localhost:8088/api/v4/graphql/ws')}
          <Section title="Transactions go to" gap="gap-3">
            <Segmented label="Where transactions go" options={SUBMISSION} value={via} onChange={next => { setError(null); setVia(next); }} />
            {via === 'node'
              ? field('node', 'Node RPC', 'ws://localhost:9944')
              : field('submitUrl', 'Submit URL', 'http://localhost:8080/submit', 'The wallet POSTs each transaction\'s bytes here (see the wallet\'s documentation for the answers it reads).')}
          </Section>
          <Checkbox label={<span className="text-[13px]">This network has DUST</span>} checked={values.dust} onCheckedChange={dust => set({ dust })} />
          {!values.dust && <p className="text-xs leading-normal text-kumo-subtle">Without DUST, transactions pay no fee, and the wallet shows no DUST.</p>}
          {error && <Banner variant="error" icon={<WarningCircleIcon />} description={error} />}
          {editing && (
            <Section title="Remove">
              {state.ownWallet
                ? <p className="text-xs leading-normal text-kumo-subtle">Remove this network's own wallet first (Settings, Danger zone), then the network.</p>
                : <SecondaryButton className="w-full" tone="danger" icon={TrashIcon} loading={busy === 'remove'} disabled={!!busy} onClick={remove}>Remove network</SecondaryButton>}
            </Section>
          )}
        </Viewport>
      )}
      <ActionFooter primary={<PrimaryButton loading={busy === 'save'} disabled={!!busy || !ready || !loaded} onClick={save}>{editing ? 'Save' : 'Add network'}</PrimaryButton>} />
    </Screen>
  );
}
