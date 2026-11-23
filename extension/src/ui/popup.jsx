// The popup (380x600): starting, errors, onboarding, unlock and the wallet
// shell that hosts every screen, and the form for the user's own networks
// over any of them. The engine pushes its whole state, and each screen asks
// for what else it needs through `ui(method)`.
import './theme.js';
import { ensureCurrentBuild } from './fresh.js';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ClockCounterClockwiseIcon, CubeIcon, GearSixIcon, GlobeHemisphereWestIcon, HouseIcon, LockKeyIcon, PencilSimpleIcon, PlusIcon, WarningCircleIcon,
} from '@phosphor-icons/react';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { InputArea } from '@cloudflare/kumo/components/input';
import { Loader } from '@cloudflare/kumo/components/loader';
import { Toasty, useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Mark, networkLook } from './brand.jsx';
import {
  ActionFooter, BottomNav, DateField, Field, Heading, LinkButton, MainHeader, NavItem, NetworkPill, Notice, OnboardingHeader, PageHeader,
  PasswordField, PrimaryButton, Screen, SecondaryButton, Section, SeedWord, SyncPill, Viewport, WalletIdentity,
} from './components.jsx';
import { ui, onState } from './api.js';
import { currentNetwork, hasDust, localDay, networkName, plural } from './format.js';
import { NetworkForm } from './networks.jsx';
import { Home } from './home.jsx';
import { Receive } from './receive.jsx';
import { Send } from './send.jsx';
import { DustPage } from './dust.jsx';
import { Activity, TxDetail } from './activity.jsx';
import { TokenPage } from './token.jsx';
import { Sites } from './sites.jsx';
import { Settings } from './settings.jsx';
import { SyncDetails, syncPill } from './sync.jsx';

// The selected item in a menu: tinted, in the brand color (no checkmark).
const SELECTED = 'bg-kumo-info-tint text-kumo-info data-[highlighted]:bg-kumo-info-tint';

function useEngineState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    ui('state').then(setState).catch(error => setState({ error: error.message }));
    return onState(setState);
  }, []);
  return state;
}

// ------------------------------------------------------------------ network --
/** What the network menu says of a network's wallet: a wallet of its own is
 *  named so only beside the shared one. */
const walletText = (state, n) => {
  if (n.ownWallet && state.sharedWallet) return 'Its own wallet';
  return n.hasWallet ? 'Wallet set up' : 'No wallet yet';
};

/** The network switcher; `onForm('add')` opens the form for a new network. */
function NetworkMenu({ state, onForm }) {
  const toasts = useKumoToastManager();
  const select = async id => {
    try { await ui('selectNetwork', { network: id }); }
    catch (e) { toasts.add({ title: 'Could not switch network', description: e.message, variant: 'error' }); }
  };
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<NetworkPill network={state.network} name={networkName(state)} aria-label="Switch network" />} />
      <DropdownMenu.Content>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Networks</DropdownMenu.Label>
          {state.networks.map(n => (
            <DropdownMenu.Item key={n.id} className={n.id === state.network ? SELECTED : undefined} onClick={() => select(n.id)}>
              <span className="flex items-start gap-3">
                {/* The dot sits on the name's line, with room before the text. */}
                <span className={`mt-[5px] size-2.5 shrink-0 rounded-full ${networkLook(n.id).dot}`} />
                <span className="flex flex-col">
                  <span className="font-medium">{n.name}</span>
                  <span className={`text-xs ${n.id === state.network ? 'text-kumo-info' : 'text-kumo-subtle'}`}>{walletText(state, n)}</span>
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => onForm('add')}>
          <span className="flex items-center gap-3"><PlusIcon size={12} className="shrink-0" /><span className="font-medium">Add a network…</span></span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------ boot & error --
function Booting() {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        <Mark size={56} />
        <span className="flex items-center gap-2">
          <Loader />
          <span className="text-[13px] font-medium text-kumo-subtle">Starting the wallet core…</span>
        </span>
      </div>
    </Screen>
  );
}

function EngineError({ message }) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <div className="flex w-full flex-col items-center gap-3">
          <span className="flex size-[52px] items-center justify-center rounded-full bg-kumo-danger-tint">
            <WarningCircleIcon size={26} className="text-kumo-danger" />
          </span>
          <h1 className="text-[17px] font-bold text-kumo-default">Wallet engine error</h1>
          <p className="text-center text-[13px] text-kumo-subtle">The wallet core could not start in this browser.</p>
          <pre className="w-full rounded-[10px] border border-kumo-hairline bg-kumo-recessed px-3 py-2.5 font-mono text-[11px] leading-normal whitespace-pre-wrap break-words text-kumo-danger">{message}</pre>
        </div>
      </div>
    </Screen>
  );
}

// --------------------------------------------------------------- onboarding --
const FEATURES = [
  { icon: CubeIcon, title: 'Uses endpoints you choose', body: name => `Reads ${name} through an indexer, and sends to a node or a submit URL, all changeable in Settings.` },
  { icon: LockKeyIcon, title: 'Keys stay on this device', body: () => 'Your key is encrypted with your password and never leaves this browser.' },
  { icon: GlobeHemisphereWestIcon, title: 'One wallet, every network', body: () => 'Your recovery phrase opens on every network, built in or added, each with its own addresses.' },
];

function Welcome({ state, name, onPick, onForm }) {
  return (
    <Screen>
      <OnboardingHeader mark={<Mark size={24} />} network={<NetworkMenu state={state} onForm={onForm} />} />
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-6 px-6 pt-6 pb-2">
        <div className="flex flex-col items-center gap-2.5">
          <Mark size={56} />
          <h2 className="text-xl font-bold text-kumo-default">No wallet on {name} yet</h2>
          <p className="text-center text-[13px] leading-normal text-kumo-subtle">Create a new wallet or restore one from your recovery phrase.</p>
        </div>
        <ul className="flex flex-col gap-3.5">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-kumo-info-tint">
                <Icon size={16} className="text-accent-fg" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-kumo-default">{title}</span>
                <span className="text-xs leading-[1.45] text-kumo-subtle">{body(name)}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col">
          <LinkButton icon={GearSixIcon} className="self-center" onClick={() => onPick('settings')}>Connection settings</LinkButton>
          {currentNetwork(state)?.user && <LinkButton icon={PencilSimpleIcon} className="self-center" onClick={() => onForm('edit')}>Edit or remove {name}</LinkButton>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-4">
        <PrimaryButton className="w-full" icon={PlusIcon} onClick={() => onPick('new')}>Create a new wallet</PrimaryButton>
        <SecondaryButton className="w-full" onClick={() => onPick('restore')}>Restore from recovery phrase</SecondaryButton>
      </div>
    </Screen>
  );
}

function Onboarding({ state, name, onForm }) {
  const [mode, setMode] = useState(null);
  const [generated, setGenerated] = useState(null);
  const [words, setWords] = useState('');
  const [birthday, setBirthday] = useState('');
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pick = async next => {
    setMode(next); setError(null);
    if (next === 'new' && !generated) {
      try { setGenerated((await ui('generateMnemonic')).words); } catch (e) { setError(e.message); }
    }
  };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const phrase = mode === 'new' ? generated : words.trim().split(/\s+/);
      await ui('createWallet', {
        mnemonic: phrase.join(' '), password, restore: mode === 'restore',
        ...(mode === 'restore' && birthday ? { birthday } : {}),
      });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!mode) return <Welcome state={state} name={name} onPick={pick} onForm={onForm} />;
  // The endpoints a wallet will be created with: the same Settings, without
  // what needs a wallet.
  if (mode === 'settings') {
    return (
      <Screen>
        <PageHeader title="Settings" onBack={() => setMode(null)} />
        <Settings state={state} onForm={onForm} />
      </Screen>
    );
  }
  const mismatch = confirm.length > 0 && confirm !== password;
  const wordCount = words.trim() ? words.trim().split(/\s+/).length : 0;
  // The picker is bounded to today; a typed date past it is refused too.
  const today = localDay(Date.now());
  const futureBirthday = birthday !== '' && birthday > today;
  const ready = password.length >= 8 && confirm === password && (mode === 'new' ? generated && saved : wordCount >= 12 && !futureBirthday);
  const protect = (
    <Section title="Protect this wallet" gap="gap-3">
      <PasswordField label="Password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
        placeholder="At least 8 characters"
        description="Encrypts your wallet's key on this device, for every network. You enter it once per browser session." />
      <PasswordField label="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password"
        placeholder="Repeat password" error={mismatch ? 'The passwords do not match' : null} />
    </Section>
  );
  return (
    <Screen>
      <PageHeader title={mode === 'new' ? 'Create wallet' : 'Restore wallet'} onBack={() => { if (!busy) { setMode(null); setError(null); } }} />
      <Viewport>
        {mode === 'new' ? (
          <>
            <Heading title="Your recovery phrase" subtitle="Generated on this device from Web Crypto randomness. It is never stored." />
            <Notice>Write these 24 words down in order and keep them offline. Anyone with them controls your funds.</Notice>
            <div className="rounded-xl border border-kumo-hairline bg-kumo-base py-3.5 pr-3.5 pl-2.5">
              {generated ? (
                <ol className="grid grid-cols-3 gap-2">
                  {generated.map((w, i) => <SeedWord key={i} index={i + 1} word={w} />)}
                </ol>
              ) : <div className="flex justify-center py-6"><Loader /></div>}
            </div>
            <Checkbox label={<span className="text-[13px]">I wrote down all 24 words</span>} checked={saved} onCheckedChange={setSaved} />
            <p className="text-xs leading-normal text-kumo-subtle">
              The new wallet starts at the current block of {name}, and on another network at the block of this moment: nothing can have
              been sent to it before, so it skips the chain's history.
            </p>
            {protect}
          </>
        ) : (
          <>
            <Heading title="Restore a wallet" subtitle="Enter your recovery phrase. The wallet reads each network's chain to find your funds." />
            <Field label="Recovery phrase" htmlFor="phrase" description={plural(wordCount, 'word')}>
              <InputArea id="phrase" placeholder="Words separated by spaces" rows={4} value={words} onValueChange={setWords} spellCheck={false}
                className="h-24 resize-none rounded-[10px] bg-kumo-control px-3.5 py-[11px] font-mono text-[13px] leading-normal" />
            </Field>
            <DateField label="Wallet birthday" hint="Optional" value={birthday} max={today} onChange={e => setBirthday(e.target.value)}
              error={futureBirthday ? 'The birthday cannot be in the future' : null}
              description="Leave empty to scan the whole chain. Shielded tokens received before this date will not be found." />
            {protect}
          </>
        )}
        {error && <Banner variant="error" icon={<WarningCircleIcon />} title="Could not create the wallet" description={error} />}
      </Viewport>
      <ActionFooter primary={(
        <PrimaryButton loading={busy} disabled={busy || !ready} onClick={submit}>
          {mode === 'new' ? 'Create wallet' : 'Restore wallet'}
        </PrimaryButton>
      )} />
    </Screen>
  );
}

// ------------------------------------------------------------------- unlock --
function Unlock({ state, name, onForm }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await ui('unlock', { password }); } catch (x) { setError(x.message); setBusy(false); }
  };
  return (
    <Screen>
      <OnboardingHeader mark={<Mark size={24} />} network={<NetworkMenu state={state} onForm={onForm} />} />
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-6 px-6">
          <div className="flex flex-col items-center gap-2.5">
            <Mark size={56} />
            <h2 className="text-xl font-bold text-kumo-default">{state.ownWallet ? `Unlock ${name} wallet` : 'Unlock wallet'}</h2>
            <p className="text-center text-[13px] leading-normal text-kumo-subtle">
              {state.ownWallet && state.sharedWallet
                ? `${name} keeps a wallet of its own: enter its own password. It stays unlocked until you close the browser or lock it.`
                : 'Enter your password. The wallet stays unlocked until you close the browser or lock it.'}
            </p>
          </div>
          <PasswordField value={password} onChange={e => setPassword(e.target.value)} error={error} autoFocus placeholder="Enter your password" />
        </div>
        <ActionFooter primary={<PrimaryButton type="submit" loading={busy} disabled={busy || !password}>Unlock</PrimaryButton>} />
      </form>
    </Screen>
  );
}

// ------------------------------------------------------------------- shell --
const TABS = [
  { value: 'home', label: 'Home', icon: HouseIcon },
  { value: 'activity', label: 'Activity', icon: ClockCounterClockwiseIcon },
  { value: 'sites', label: 'Sites', icon: GlobeHemisphereWestIcon },
  { value: 'settings', label: 'Settings', icon: GearSixIcon },
];

function Wallet({ state, onForm }) {
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('home');
  const [page, setPage] = useState(null);   // a sub-page over the tabs: receive, send, dust, sync, { tx }, { token } or { addToken }
  const sync = state.sync;
  // Balances change as the chain is read and when the engine finishes work, and
  // the pages that move funds hand back to a fresh overview.
  useEffect(() => {
    let live = true;
    ui('overview').then(o => { if (live) setOverview(o); }, () => {});
    return () => { live = false; };
  }, [sync?.status, Math.floor(sync?.percent ?? 0), sync?.applied, state.busy?.stage, page === null]);   // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => setPage(null);

  if (page === 'receive') return <Receive state={state} onBack={back} />;
  if (page === 'send') return <Send state={state} overview={overview} onBack={back} onDone={back} />;
  if (page === 'dust') return <DustPage state={state} overview={overview} onBack={back} />;
  if (page === 'sync') return <SyncDetails state={state} onBack={back} />;
  if (page?.tx) return <TxDetail hash={page.tx} network={state.network} dust={hasDust(state)} onBack={back} />;
  if (page?.token || page?.addToken) return <TokenPage state={state} overview={overview} target={page} onBack={back} />;
  return (
    <Screen>
      <MainHeader identity={<WalletIdentity address={state.addresses?.unshielded} />}
        status={<><SyncPill {...syncPill(sync)} onClick={() => setPage('sync')} /><NetworkMenu state={state} onForm={onForm} /></>} />
      {tab === 'home' && <Home state={state} overview={overview} onOpen={setPage} />}
      {tab === 'activity' && <Activity network={state.network} refresh={`${sync?.tip}:${sync?.status}:${sync?.applied}:${state.busy?.stage}`} onOpen={tx => setPage({ tx })} />}
      {tab === 'sites' && <Sites state={state} />}
      {tab === 'settings' && <Settings state={state} onForm={onForm} />}
      <BottomNav>
        {TABS.map(t => <NavItem key={t.value} icon={t.icon} label={t.label} active={tab === t.value} onClick={() => setTab(t.value)} />)}
      </BottomNav>
    </Screen>
  );
}

function App() {
  const state = useEngineState();
  // 'add', or 'edit' for the selected network, while the network form is open.
  const [form, setForm] = useState(null);
  const toasts = useKumoToastManager();
  if (!state) return <Booting />;
  if (state.error) return <EngineError message={state.error} />;
  if (form) {
    const done = async added => {
      setForm(null);
      if (added) await ui('selectNetwork', { network: added }).catch(e => toasts.add({ title: 'Could not switch network', description: e.message, variant: 'error' }));
    };
    return <NetworkForm key={form} state={state} editing={form === 'edit'} onDone={done} />;
  }
  const name = networkName(state);
  if (!state.hasWallet) return <Onboarding key={state.network} state={state} name={name} onForm={setForm} />;
  if (state.locked) return <Unlock key={state.network} state={state} name={name} onForm={setForm} />;
  return <Wallet key={state.network} state={state} onForm={setForm} />;
}

ensureCurrentBuild().then(current => { if (current) createRoot(document.getElementById('root')).render(<Toasty><App /></Toasty>); });
