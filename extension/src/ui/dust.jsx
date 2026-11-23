// DUST: what it is, how much this wallet has and how fast it can grow, and
// the two ways to change that: register NIGHT for DUST generation, or stop it.
// Both go through a preview the engine holds coins for until it is applied or
// cancelled.
import { useEffect, useRef, useState } from 'react';
import { ClockCounterClockwiseIcon, DropIcon } from '@phosphor-icons/react';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Loader } from '@cloudflare/kumo/components/loader';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { ActionFooter, DetailRow, ListCard, Notice, PageHeader, PrimaryButton, Progress, Screen, SecondaryButton, Section, Viewport } from './components.jsx';
import { ui } from './api.js';
import { busyText, dust, night, plural, ratio, shortHash } from './format.js';

const ACTIONS = {
  register: { title: 'Register NIGHT for DUST', confirm: 'Register', blurb: 'These NIGHT outputs will start generating DUST for this wallet.' },
  deregister: { title: 'Stop generating DUST', confirm: 'Stop generating', blurb: 'These NIGHT outputs will stop generating DUST. What is already generated stays, and decays slowly.' },
};

/** Roughly how long, from the SDK's estimate in seconds. */
function waitText(seconds) {
  if (seconds == null) return null;
  if (seconds < 90) return 'about a minute';
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}

/** Why a DUST action cannot be paid for yet, with what the engine knows: how much DUST is missing and how long it should take. */
function ShortNotice({ preview }) {
  const wait = waitText(preview.waitSeconds);
  return (
    <Notice>
      The fee is paid in DUST, and this wallet does not have enough yet
      {preview.shortfall ? <> (short by <span className="tabular-nums">{dust(preview.shortfall, { full: true })}</span> DUST)</> : null}.
      {' '}A first registration pays with the DUST its own NIGHT starts generating
      {wait ? <>, which should be enough in {wait}.</> : '.'}
    </Notice>
  );
}

function Review({ action, preview }) {
  const copy = ACTIONS[action];
  return (
    <>
      <div className="flex flex-col gap-1 px-1">
        <h2 className="text-lg font-bold text-kumo-default">{copy.title}</h2>
        <p className="text-xs leading-normal text-kumo-subtle">{copy.blurb}</p>
      </div>
      {!preview.canPay && <ShortNotice preview={preview} />}
      <Section title="NIGHT outputs" trailing={preview.utxos.length}>
        <ListCard>
          {preview.utxos.map(u => (
            <DetailRow key={u.ref} label={<span className="font-mono text-xs">{shortHash(u.ref, 12)}</span>}>{night(u.amount)} NIGHT</DetailRow>
          ))}
        </ListCard>
      </Section>
      <ListCard>
        <DetailRow label="Network fee">{dust(preview.fee, { full: true })} DUST</DetailRow>
      </ListCard>
    </>
  );
}

export function DustPage({ state, overview, onBack }) {
  const toasts = useKumoToastManager();
  const [staged, setStaged] = useState(null);   // { action, preview } while a preview is held
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const open = useRef(null);
  useEffect(() => () => { if (open.current) ui('cancel', { id: open.current }).catch(() => {}); }, []);

  const stage = async action => {
    setError(null); setBusy(action);
    try {
      const preview = await ui('dustPreview', { action });
      open.current = preview.id;
      setStaged({ action, preview });
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const discard = async () => {
    if (busy === 'apply') return;
    const id = open.current;
    open.current = null;
    setStaged(null); setError(null);
    if (id) await ui('cancel', { id }).catch(() => {});
  };
  // The preview of an action the wallet cannot pay for yet holds no coins:
  // checking again builds a fresh one, now that more DUST has grown.
  const recheck = async () => {
    const { action } = staged;
    await discard();
    await stage(action);
  };
  const apply = async () => {
    setError(null); setBusy('apply');
    try {
      await ui('dustApply', { id: staged.preview.id });
      open.current = null;
      setStaged(null);
      toasts.add({ title: 'Submitted', description: 'The transaction was sent to the network.', variant: 'success' });
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  if (staged) {
    return (
      <Screen>
        <PageHeader title="Review" onBack={discard} />
        <Viewport>
          <Review action={staged.action} preview={staged.preview} />
          {busy === 'apply' && <Banner size="sm" icon={<ClockCounterClockwiseIcon />} description={busyText(state.busy, state.sync)} />}
          {error && <Banner size="sm" variant="error" description={error} />}
        </Viewport>
        <ActionFooter
          secondary={<SecondaryButton type="button" disabled={busy === 'apply'} onClick={discard}>Edit</SecondaryButton>}
          primary={staged.preview.canPay
            ? <PrimaryButton loading={busy === 'apply'} disabled={!!busy} onClick={apply}>{ACTIONS[staged.action].confirm}</PrimaryButton>
            : <PrimaryButton loading={!!busy} disabled={!!busy} onClick={recheck}>Check again</PrimaryButton>} />
      </Screen>
    );
  }

  const d = overview?.dust;
  const fill = d ? ratio(d.balance, d.cap) : null;
  const canRegister = d && BigInt(d.unregisteredNight) > 0n;
  const canStop = d && BigInt(d.registeredNight) > 0n;
  const idle = !state.busy && !busy;
  return (
    <Screen>
      <PageHeader title="DUST" onBack={onBack} />
      <Viewport>
        <p className="px-1 text-[13px] leading-normal text-kumo-subtle">
          DUST pays the network fee of every transaction. It is generated over time by NIGHT that you register for it.
        </p>
        {!d ? <div className="flex justify-center p-6"><Loader /></div> : (
          <>
            <div className="flex flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base px-3.5 py-3">
              <span className="flex items-center gap-2">
                <DropIcon size={14} className="text-accent-fg" />
                <span className="flex-1 text-xs font-medium text-kumo-subtle">Balance</span>
                {/* A fee was just paid: the figure is the last one before it, until the chain confirms the change. */}
                {d.updating && <span className="text-[11px] text-kumo-subtle">Updating after a fee</span>}
              </span>
              <span className="text-2xl font-bold tracking-[-0.4px] text-kumo-default tabular-nums">{dust(d.balance)} <span className="text-sm font-semibold text-kumo-subtle">DUST</span></span>
              {fill != null && <Progress value={fill} label="DUST balance against its cap" />}
              <span className="flex w-full justify-between text-[11px] text-kumo-subtle tabular-nums">
                <span>{fill != null ? `${Math.round(fill * 100)}% of the cap` : 'No cap while nothing is registered'}</span>
                <span>Cap {dust(d.cap)} DUST</span>
              </span>
            </div>
            <ListCard>
              <DetailRow label="Registered NIGHT">{night(d.registeredNight)} · {plural(d.registered, 'UTXO')}</DetailRow>
              <DetailRow label="Not registered">{night(d.unregisteredNight)} · {plural(d.unregistered, 'UTXO')}</DetailRow>
            </ListCard>
            {/* NIGHT a pending transaction holds is in neither list until it settles (a registration moves its own NIGHT). */}
            {BigInt(overview.night?.pending ?? 0) > 0n && (
              <p className="px-1 text-xs leading-normal text-kumo-subtle">
                {night(overview.night.pending)} NIGHT is in a transaction that has not settled yet and shows here once it has.
              </p>
            )}
          </>
        )}
        {state.busy && <Banner size="sm" icon={<ClockCounterClockwiseIcon />} description={busyText(state.busy, state.sync)} />}
        {error && <Banner size="sm" variant="error" description={error} />}
      </Viewport>
      {(canRegister || canStop) && (
        <footer className="flex shrink-0 flex-col gap-2 border-t border-kumo-hairline bg-kumo-base px-4 pt-3 pb-4">
          {canRegister && (
            <PrimaryButton className="w-full" icon={DropIcon} disabled={!idle} loading={busy === 'register'} onClick={() => stage('register')}>Register NIGHT for DUST</PrimaryButton>
          )}
          {canStop && (
            <SecondaryButton className="w-full" disabled={!idle} loading={busy === 'deregister'} onClick={() => stage('deregister')}>Stop generating</SecondaryButton>
          )}
        </footer>
      )}
    </Screen>
  );
}
