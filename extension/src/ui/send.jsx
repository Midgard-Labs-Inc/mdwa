// Send: recipients with a token and an amount each, then a review of what the
// engine prepared. The wallet is already unlocked, so sending needs no
// password; the engine reports Balancing, Proving and Submitting in `busy`.
// On a network without DUST there is no fee, so none is mentioned.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, ClockCounterClockwiseIcon, PaperPlaneTiltIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import {
  ActionFooter, AddressField, AmountField, BigAmount, DetailRow, Field, IconButton, LinkButton, ListCard, PageHeader,
  PrimaryButton, Screen, SecondaryButton, SectionLabel, TokenAvatar, Viewport,
} from './components.jsx';
import { ui } from './api.js';
import { busyText, currentNetwork, dateTime, dust, hasDust, isNight, networkName, night, quantity, shortAddress, shortType } from './format.js';
import { describeToken, parseTokenAmount, tokenAmount, tokenLetters, tokenTitle, tokenUnit, useTokenLabels } from './tokens.js';

let recipientIds = 0;
const newRecipient = () => ({ id: ++recipientIds, address: '', check: null, type: null, amount: '' });
const capital = text => `${text[0].toUpperCase()}${text.slice(1)}`;
/** A typed amount in the smallest unit, with the token's labelled decimals (NIGHT: 6, unlabelled: whole units). */
const parseFor = (labels, kind, type, text) => parseTokenAmount(describeToken(labels, type, kind), text);

/** What the address check says about a recipient: its kind when usable, otherwise why not. */
function addressVerdict(check, state) {
  if (!check) return { kind: null, error: null };
  if (!check.valid) return { kind: null, error: check.error ?? 'This is not a valid address' };
  if (check.network && check.network !== currentNetwork(state)?.networkId) return { kind: null, error: `This is a ${check.network} address, not ${networkName(state)}` };
  if (check.kind === 'dust') return { kind: null, error: 'This is a DUST address. DUST cannot be sent to it' };
  return { kind: check.kind, error: null };
}

/** The tokens this wallet holds in one address kind, NIGHT first for unshielded. */
const heldIn = (overview, kind) => (kind === 'shielded' ? overview?.shielded : overview?.unshielded) ?? [];

function TokenTrigger({ kind, token, labels, ...props }) {
  const desc = token && describeToken(labels, token.type, kind);
  return (
    <button type="button" {...props}
      className="flex h-11 w-full items-center gap-2.5 rounded-[10px] bg-kumo-control px-3 ring ring-kumo-line text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50 disabled:opacity-60">
      {token ? (
        <>
          <TokenAvatar night={isNight(kind, token.type)} letters={tokenLetters(desc, token.type)} size={28} />
          <span className="flex-1 truncate text-sm font-medium text-kumo-default">{tokenTitle(desc, token.type)}</span>
          <span className="text-xs text-kumo-subtle tabular-nums">{tokenAmount(desc, token.amount)}{desc.symbol ? ` ${desc.symbol}` : ''}</span>
        </>
      ) : <span className="flex-1 text-sm text-kumo-subtle">No tokens held</span>}
      <CaretDownIcon size={12} className="text-kumo-subtle" />
    </button>
  );
}

function TokenPicker({ kind, tokens, selected, labels, onPick }) {
  return (
    <Field label="Token">
      <DropdownMenu>
        <DropdownMenu.Trigger render={<TokenTrigger kind={kind} token={selected} labels={labels} disabled={!tokens.length} aria-label="Choose a token" />} />
        <DropdownMenu.Content>
          <DropdownMenu.Group>
            <DropdownMenu.Label>{capital(kind)} tokens</DropdownMenu.Label>
            {tokens.map(t => {
              const desc = describeToken(labels, t.type, kind);
              return (
                <DropdownMenu.Item key={t.type} onClick={() => onPick(t.type)}>
                  <span className="flex w-full min-w-0 items-center gap-2.5">
                    <TokenAvatar night={isNight(kind, t.type)} letters={tokenLetters(desc, t.type)} size={28} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{desc.name}</span>
                      {!isNight(kind, t.type) && <span className="truncate font-mono text-xs text-kumo-subtle">{shortType(t.type)}</span>}
                    </span>
                    <span className="ml-auto shrink-0 pl-3 text-xs text-kumo-subtle tabular-nums">{tokenAmount(desc, t.amount)} {tokenUnit(desc)}</span>
                  </span>
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu>
    </Field>
  );
}

function RecipientBlock({ index, recipient: r, count, overview, state, labels, allocatedElsewhere, onChange, onRemove }) {
  // The engine is the authority on what an address is: ask it once typing pauses.
  useEffect(() => {
    const address = r.address.trim();
    if (!address) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      const check = await ui('checkAddress', { address }).catch(e => ({ valid: false, error: e.message }));
      if (live) onChange({ check });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [r.address]);   // eslint-disable-line react-hooks/exhaustive-deps

  const { kind: checked, error: addressError } = addressVerdict(r.check, state);
  // Until the address says otherwise, offer what an unshielded address can receive.
  const kind = checked ?? 'unshielded';
  const tokens = heldIn(overview, kind);
  const selected = tokens.find(t => t.type === r.type) ?? tokens[0] ?? null;
  const held = BigInt(selected?.amount ?? 0);
  const available = held - (allocatedElsewhere.get(`${kind}.${selected?.type}`) ?? 0n);
  const desc = selected ? describeToken(labels, selected.type, kind) : describeToken(labels, null, 'unshielded');
  const unit = selected ? tokenUnit(desc) : 'NIGHT';
  let amountError = null;
  if (r.amount && selected) {
    try {
      const value = BigInt(parseTokenAmount(desc, r.amount));
      if (value > available) amountError = 'More than is available';
    } catch (e) { amountError = e.message; }
  }
  const fields = (
    <>
      <AddressField value={r.address} onChange={address => onChange({ address, check: null })} error={addressError}
        placeholder="Recipient address"
        hint={checked && <Badge variant="secondary" className="text-[11px]">{capital(checked)} address</Badge>} />
      <TokenPicker kind={kind} tokens={tokens} selected={selected} labels={labels} onPick={type => onChange({ type, amount: '' })} />
      <AmountField value={r.amount} onChange={amount => onChange({ amount })} unit={unit} error={amountError}
        placeholder={selected && desc.decimals > 0 ? '0.00' : '0'}
        hint={overview ? `Available ${tokenAmount(desc, available > 0n ? available : 0n)}` : undefined}
        onMax={selected ? () => onChange({ amount: tokenAmount(desc, available > 0n ? available : 0n).replace(/,/g, '') }) : undefined} />
    </>
  );
  if (count === 1) return fields;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionLabel title={`Recipient ${index + 1}`} />
        <IconButton icon={XIcon} label={`Remove recipient ${index + 1}`} size={28} iconSize={14} className="text-kumo-subtle" onClick={onRemove} />
      </div>
      {fields}
    </section>
  );
}

/** The amount sent, large: NIGHT with its decimals, a labelled token with its own, anything else as a raw quantity. */
function SentAmount({ output, labels }) {
  if (isNight(output.kind, output.type)) return <BigAmount value={output.amount} size="md" />;
  const desc = describeToken(labels, output.type, output.kind);
  return (
    <span className="flex max-w-full flex-col items-center gap-1">
      <span className="flex items-end tabular-nums">
        <span className="text-[32px] leading-[1.1] font-bold tracking-[-0.8px] text-kumo-default">{desc.labelled ? tokenAmount(desc, output.amount) : quantity(output.amount)}</span>
        <span className={`pb-[3px] pl-1.5 text-sm leading-[1.1] font-semibold text-kumo-subtle ${desc.labelled ? '' : 'font-mono'}`}>{desc.labelled ? desc.symbol : shortType(output.type)}</span>
      </span>
      {desc.labelled && <span className="text-xs text-kumo-subtle">{desc.name} · <span className="font-mono">{shortType(output.type)}</span></span>}
    </span>
  );
}

function Review({ preview, labels, withDust }) {
  const { outputs } = preview;
  const single = outputs.length === 1;
  const kinds = [...new Set(outputs.map(o => o.kind))];
  return (
    <>
      <div className="flex flex-col items-center gap-1.5 pt-1">
        <span className="text-xs font-medium text-kumo-subtle">You're sending</span>
        {single ? <SentAmount output={outputs[0]} labels={labels} /> : <span className="text-[32px] leading-[1.1] font-bold tracking-[-0.8px] text-kumo-default">{outputs.length} payments</span>}
        <span className="flex max-w-full items-center gap-1.5 rounded-full bg-kumo-tint px-2.5 py-1 text-xs">
          <span className="text-kumo-subtle">to</span>
          <span className="truncate font-mono text-kumo-default">{single ? shortAddress(outputs[0].recipient) : `${outputs.length} recipients`}</span>
        </span>
      </div>
      {!single && (
        <ListCard>
          {outputs.map((o, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-[11px] text-[13px]">
              <span className="truncate font-mono text-xs text-kumo-subtle">{shortAddress(o.recipient)}</span>
              <span className="shrink-0 font-medium text-kumo-default tabular-nums">{(() => {
                const desc = describeToken(labels, o.type, o.kind);
                return desc.labelled || desc.fixed ? `${tokenAmount(desc, o.amount)} ${desc.symbol}` : `${quantity(o.amount)} ${shortType(o.type)}`;
              })()}</span>
            </div>
          ))}
        </ListCard>
      )}
      <ListCard>
        <DetailRow label="Kind">{kinds.length === 1 ? capital(kinds[0]) : 'Shielded and unshielded'}</DetailRow>
        {withDust && <DetailRow label="Network fee">{dust(preview.fee, { full: true })} DUST</DetailRow>}
        <DetailRow label="Expires">{dateTime(preview.ttl)}</DetailRow>
      </ListCard>
    </>
  );
}

export function Send({ state, overview, onBack, onDone }) {
  const toasts = useKumoToastManager();
  const [recipients, setRecipients] = useState(() => [newRecipient()]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const labels = useTokenLabels(state.network);
  // A prepared transaction holds coins until it is sent or cancelled, so a
  // preview that is left behind is cancelled when this page closes.
  const open = useRef(null);
  useEffect(() => () => { if (open.current) ui('cancel', { id: open.current }).catch(() => {}); }, []);

  const update = (id, patch) => {
    setError(null);
    setRecipients(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };
  const rows = useMemo(() => recipients.map(r => {
    const { kind } = addressVerdict(r.check, state);
    const k = kind ?? 'unshielded';
    const tokens = heldIn(overview, k);
    return { r, kind, k, token: tokens.find(t => t.type === r.type) ?? tokens[0] };
  }), [recipients, overview, state]);
  // What the recipients other than `id` already take of each token, so MAX leaves them theirs.
  const allocatedExcept = id => {
    const taken = new Map();
    for (const { r, k, token } of rows) {
      if (r.id === id || !token) continue;
      try { taken.set(`${k}.${token.type}`, (taken.get(`${k}.${token.type}`) ?? 0n) + BigInt(parseFor(labels, k, token.type, r.amount))); } catch { /* not a number yet */ }
    }
    return taken;
  };

  const outputs = () => rows.map(({ r, k, token }) => ({ type: token.type, amount: parseFor(labels, k, token.type, r.amount), recipient: r.address.trim() }));
  const ready = overview && rows.every(({ r, kind, k, token }) => {
    if (!kind || !token) return false;
    try { return BigInt(parseFor(labels, k, token.type, r.amount)) > 0n; } catch { return false; }
  });
  // Across all recipients a token cannot be sent for more than is held.
  const allocated = allocatedExcept(null);
  const overspent = rows.some(({ k, token }) => token && (allocated.get(`${k}.${token.type}`) ?? 0n) > BigInt(token.amount));

  const review = async () => {
    setError(null); setBusy('review');
    try {
      const next = await ui('previewSend', { outputs: outputs() });
      open.current = next.id;
      setPreview(next);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const edit = async () => {
    if (busy === 'send') return;
    const id = open.current;
    open.current = null;
    setPreview(null); setError(null);
    if (id) await ui('cancel', { id }).catch(() => {});
  };
  const send = async () => {
    setError(null); setBusy('send');
    try {
      await ui('send', { id: preview.id });
      open.current = null;
      toasts.add({ title: 'Submitted', description: 'The transaction was sent to the network.', variant: 'success' });
      onDone();
    } catch (e) { setError(e.message); setBusy(null); }
  };

  if (preview) {
    return (
      <Screen>
        <PageHeader title="Review" onBack={edit} />
        <Viewport>
          <Review preview={preview} labels={labels} withDust={hasDust(state)} />
          {busy === 'send' && <Banner size="sm" icon={<ClockCounterClockwiseIcon />} description={busyText(state.busy)} />}
          {error && <Banner size="sm" variant="error" description={error} />}
        </Viewport>
        <ActionFooter
          secondary={<SecondaryButton type="button" disabled={busy === 'send'} onClick={edit}>Edit</SecondaryButton>}
          primary={<PrimaryButton icon={PaperPlaneTiltIcon} loading={busy === 'send'} disabled={!!busy} onClick={send}>Send</PrimaryButton>} />
      </Screen>
    );
  }
  return (
    <Screen>
      <PageHeader title="Send" onBack={onBack} />
      <Viewport>
        {recipients.map((r, i) => (
          <RecipientBlock key={r.id} index={i} recipient={r} count={recipients.length} overview={overview} state={state} labels={labels}
            allocatedElsewhere={allocatedExcept(r.id)} onChange={patch => update(r.id, patch)}
            onRemove={() => setRecipients(rs => rs.filter(x => x.id !== r.id))} />
        ))}
        <LinkButton icon={PlusIcon} onClick={() => setRecipients(rs => [...rs, newRecipient()])}>Add another recipient</LinkButton>
        {overspent && <Banner size="sm" variant="error" description="Together the recipients ask for more of a token than this wallet holds." />}
        {/* A transaction or swap offer that has not settled holds whole coins, change and all: say why less is available. */}
        {BigInt(overview?.night?.pending ?? 0) > 0n && (
          <p className="text-[11px] leading-normal text-kumo-subtle">
            {night(overview.night.pending)} NIGHT is held by a transaction or swap offer that has not settled yet. It can be sent once it has.
          </p>
        )}
        {error && <Banner size="sm" variant="error" description={error} />}
        {hasDust(state) && <p className="text-[11px] leading-normal text-kumo-subtle">The network fee is paid in DUST, not in the token you send.</p>}
      </Viewport>
      <ActionFooter primary={<PrimaryButton loading={busy === 'review'} disabled={!!busy || !ready || overspent} onClick={review}>Review</PrimaryButton>} />
    </Screen>
  );
}
