// Home: balance, quick actions, the engine's busy strip, the DUST summary and
// the unshielded and shielded asset lists (on a network without DUST, nothing
// of DUST is shown). A custom token row opens its Token
// page (name it, or check it against its contract); "Add a token" at the
// bottom of each list registers a token before any of it arrives.
import { ArrowDownLeftIcon, ArrowUpRightIcon, CaretRightIcon, DropIcon } from '@phosphor-icons/react';
import { Loader } from '@cloudflare/kumo/components/loader';
import { AddRow, AssetRow, BigAmount, ListCard, Progress, QuickAction, Section, TokenAvatar, Viewport } from './components.jsx';
import { SyncSummary } from './sync.jsx';
import { NIGHT_TYPE, busyText, dust, hasDust, isNight, night, ratio, shortType } from './format.js';
import { describeToken, tokenAmount, tokenLetters, tokenUnit, useTokenLabels } from './tokens.js';

/** Shown while the engine balances, proves or submits something. */
function BusyStrip({ busy }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-kumo-warning-tint px-3 py-2.5" role="status">
      <Loader size="sm" />
      <span className="text-[13px] font-medium text-kumo-default">{busyText(busy)}</span>
    </div>
  );
}

/** How full the DUST balance is, and registered against unregistered NIGHT; opens the DUST page. */
function DustCard({ dust: d, onOpen }) {
  const fill = ratio(d.balance, d.cap);
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-kumo-hairline bg-kumo-base px-3.5 py-3 text-left outline-none hover:bg-kumo-elevated focus-visible:ring-2 focus-visible:ring-kumo-focus/50">
      <span className="flex w-full items-center gap-2">
        <DropIcon size={14} className="text-accent-fg" />
        <span className="flex-1 text-[13px] font-semibold text-kumo-default tabular-nums">
          {dust(d.balance)} <span className="font-medium text-kumo-subtle">{fill != null ? `of ${dust(d.cap)} DUST` : 'DUST'}{d.updating ? ' · updating' : ''}</span>
        </span>
        <CaretRightIcon size={14} className="text-kumo-subtle" />
      </span>
      {fill != null && <Progress value={fill} label="DUST balance against its cap" />}
      <span className="grid w-full grid-cols-2 gap-3 text-[11px] text-kumo-subtle tabular-nums">
        <span className="flex flex-col gap-0.5"><span>Registered</span><span className="text-xs font-medium text-kumo-default">{night(d.registeredNight)} NIGHT</span></span>
        <span className="flex flex-col gap-0.5"><span>Not registered</span><span className="text-xs font-medium text-kumo-default">{night(d.unregisteredNight)} NIGHT</span></span>
      </span>
    </button>
  );
}

function assetRow(kind, { type, amount }, labels, onOpen) {
  const nightRow = isNight(kind, type);
  const desc = describeToken(labels, type, kind);
  const row = (
    <AssetRow name={desc.name} subtitle={nightRow ? 'NIGHT' : shortType(type)} mono={!nightRow}
      amount={tokenAmount(desc, amount)} unit={tokenUnit(desc)}
      avatar={<TokenAvatar night={nightRow} letters={tokenLetters(desc, type)} />} />
  );
  if (nightRow) return <div key={`${kind}.${type}`}>{row}</div>;
  return (
    <button key={`${kind}.${type}`} type="button" onClick={() => onOpen({ token: { type, kind } })} aria-label={`Open ${desc.name} ${shortType(type)}`}
      className="block w-full text-left outline-none hover:bg-kumo-tint focus-visible:bg-kumo-tint">
      {row}
    </button>
  );
}

function AssetList({ title, kind, assets, labels, onOpen }) {
  return (
    <Section title={title} trailing={assets.length}>
      <ListCard>
        {assets.length ? assets.map(a => assetRow(kind, a, labels, onOpen)) : (
          <p className="px-4 py-3 text-xs text-kumo-subtle">{kind === 'shielded' ? 'No shielded tokens yet' : 'No unshielded tokens yet'}</p>
        )}
        <AddRow label="Add a token" onClick={() => onOpen({ addToken: kind })} />
      </ListCard>
    </Section>
  );
}

export function Home({ state, overview, onOpen }) {
  // NIGHT leads the list; the rest keep the engine's order.
  const unshielded = [...(overview?.unshielded ?? [])].sort((a, b) => (b.type === NIGHT_TYPE) - (a.type === NIGHT_TYPE));
  const shielded = overview?.shielded ?? [];
  const labels = useTokenLabels(state.network);
  const withDust = hasDust(state);
  return (
    <Viewport gap="gap-[18px]">
      {state.sync?.status !== 'synced' && <SyncSummary sync={state.sync} onClick={() => onOpen('sync')} />}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs font-medium text-kumo-subtle">Total balance</span>
        {overview ? <BigAmount value={overview.night?.available ?? '0'} /> : <Loader />}
        {overview && withDust && (
          <span className="text-xs text-kumo-subtle tabular-nums">
            {dust(overview.dust.balance)} DUST available{overview.dust.updating ? ' · updating' : ''}
          </span>
        )}
        {/* NIGHT a transaction of this wallet has taken and not yet settled (its change comes back once it is final). */}
        {overview && BigInt(overview.night?.pending ?? 0) > 0n && (
          <span className="text-[11px] text-kumo-subtle tabular-nums">{night(overview.night.pending)} NIGHT pending</span>
        )}
      </div>
      <div className="flex justify-center gap-4">
        <QuickAction icon={ArrowDownLeftIcon} label="Receive" onClick={() => onOpen('receive')} />
        <QuickAction icon={ArrowUpRightIcon} label="Send" onClick={() => onOpen('send')} />
        {withDust && <QuickAction icon={DropIcon} label="DUST" onClick={() => onOpen('dust')} />}
      </div>
      {state.busy && <BusyStrip busy={state.busy} />}
      {overview && (
        <>
          {withDust && <Section title="DUST"><DustCard dust={overview.dust} onOpen={() => onOpen('dust')} /></Section>}
          <AssetList title="Unshielded" kind="unshielded" assets={unshielded} labels={labels} onOpen={onOpen} />
          <AssetList title="Shielded" kind="shielded" assets={shielded} labels={labels} onOpen={onOpen} />
        </>
      )}
    </Viewport>
  );
}
