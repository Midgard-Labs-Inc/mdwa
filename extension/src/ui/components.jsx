// The popup's building blocks, on Kumo primitives. Colors are Kumo tokens;
// `accent-fg` (styles.css) is the blue for text and icons on neutral surfaces.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import {
  ArrowLeftIcon, ArrowsClockwiseIcon, CalendarBlankIcon, CaretDownIcon, CaretRightIcon, CheckIcon,
  ClipboardTextIcon, CopyIcon, EyeIcon, EyeSlashIcon, MoonIcon, PlusCircleIcon, WarningCircleIcon,
} from '@phosphor-icons/react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { InputArea } from '@cloudflare/kumo/components/input';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { networkLook } from './brand.jsx';
import { addressTail, compactAddress, nightParts, tokenLetters } from './format.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Copy to the clipboard; `copied` is true for a moment afterwards. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async text => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

// ------------------------------------------------------------- identity --
/** Round tinted badge with the moon glyph: this wallet's identity in the header. */
export function WalletAvatar({ size = 32 }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-kumo-info-tint text-accent-fg"
      style={{ width: size, height: size }}>
      <MoonIcon size={Math.round(size * 0.5)} weight="bold" />
    </span>
  );
}

// ---------------------------------------------------------------- pills --
const SYNC_LOOK = {
  synced: { pill: 'bg-kumo-success-tint text-kumo-success', dot: 'bg-kumo-success' },
  syncing: { pill: 'bg-kumo-warning-tint text-kumo-warning', icon: true },
  connecting: { pill: 'bg-kumo-tint text-kumo-subtle', dot: 'bg-kumo-badge-neutral' },
  error: { pill: 'bg-kumo-danger-tint text-kumo-danger', dot: 'bg-kumo-danger' },
};

/** Sync status in the header; opens Sync details. */
export function SyncPill({ status, label, onClick }) {
  const look = SYNC_LOOK[status] ?? SYNC_LOOK.connecting;
  return (
    <button type="button" onClick={onClick} aria-label={`Chain sync: ${label}`}
      className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-[9px] text-xs whitespace-nowrap font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50', look.pill)}>
      {look.icon ? <ArrowsClockwiseIcon size={12} weight="bold" /> : <span className={cx('size-1.5 rounded-full', look.dot)} />}
      {label}
    </button>
  );
}

/** Network name with its color dot; a menu trigger when `caret` is set. */
export function NetworkPill({ network, name, caret = true, className, ...props }) {
  const Tag = caret ? 'button' : 'span';
  return (
    <Tag {...(caret ? { type: 'button' } : {})} {...props}
      className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border whitespace-nowrap border-kumo-line bg-kumo-base pl-[9px] text-xs font-medium text-kumo-default',
        caret ? 'pr-2 outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50' : 'pr-[9px]', className)}>
      <span className={cx('size-1.5 rounded-full', networkLook(network).dot)} />
      {name}
      {caret && <CaretDownIcon size={10} className="text-kumo-subtle" />}
    </Tag>
  );
}

// -------------------------------------------------------------- buttons --
export function IconButton({ icon: Icon, label, size = 36, iconSize = 18, className, ...props }) {
  return (
    <Button variant="ghost" shape="square" aria-label={label} {...props}
      className={cx('rounded-[10px] p-0', className)} style={{ width: size, height: size }}>
      <Icon size={iconSize} />
    </Button>
  );
}

const BIG = 'h-11 gap-2 rounded-[10px] px-4 text-[15px] font-semibold justify-center';

export function PrimaryButton({ className, icon: Icon, children, ...props }) {
  return (
    <Button variant="primary" {...props} className={cx(BIG, className)} icon={Icon ? <Icon size={16} /> : undefined}>
      {children}
    </Button>
  );
}

export function SecondaryButton({ className, icon: Icon, tone, children, ...props }) {
  return (
    <Button variant="secondary" {...props}
      className={cx(BIG, tone === 'danger' && '!text-kumo-danger', className)}
      icon={Icon ? <Icon size={16} /> : undefined}>
      {children}
    </Button>
  );
}

/** The accent text button: "Add another recipient". */
export function LinkButton({ icon: Icon, children, className, ...props }) {
  return (
    <Button variant="ghost" {...props} className={cx('h-8 gap-1.5 self-start px-1 text-[13px] font-semibold !text-accent-fg', className)}
      icon={Icon ? <Icon size={14} /> : undefined}>
      {children}
    </Button>
  );
}

/** Round brand button with a label below: Receive, Send, Activity. */
export function QuickAction({ icon: Icon, label, onClick, disabled, title }) {
  return (
    <div className="flex w-[76px] flex-col items-center gap-2" title={title}>
      <Button variant="primary" shape="circle" aria-label={label} onClick={onClick} disabled={disabled}
        className="size-12 shadow-[0_2px_6px_rgb(0_0_0/0.1)]">
        <Icon size={20} weight="bold" />
      </Button>
      <span className="text-xs font-medium text-kumo-default">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- chrome --
/** Wallet screens: identity on the left, sync and network. */
export function MainHeader({ identity, status }) {
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-base px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">{identity}</div>
      <div className="flex shrink-0 items-center gap-1.5">{status}</div>
    </header>
  );
}

/** The wallet identity: its name and the short unshielded address with a copy control. */
export function WalletIdentity({ address }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <WalletAvatar />
      <span className="@container flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-sm font-semibold whitespace-nowrap text-kumo-default">Wallet</span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-kumo-subtle">
          {/* The type prefix goes first when the pills leave little room: the tail stays. */}
          <span className="hidden truncate @min-[108px]:inline" title={address}>{address ? compactAddress(address) : '…'}</span>
          <span className="truncate @min-[108px]:hidden" title={address}>{address ? addressTail(address) : '…'}</span>
          {address && (
            <button type="button" aria-label="Copy address" title="Copy address" onClick={() => copy(address)}
              className="-m-1 shrink-0 rounded p-1 outline-none hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus/50">
              {copied ? <CheckIcon size={11} className="text-kumo-success" /> : <CopyIcon size={11} />}
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

/** Sub-pages: back, centered title, an optional trailing action. */
export function PageHeader({ title, onBack, trailing }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-hairline bg-kumo-base px-2.5">
      <IconButton icon={ArrowLeftIcon} label="Back" onClick={onBack} />
      <h1 className="text-base font-semibold text-kumo-default">{title}</h1>
      <div className="flex size-9 items-center justify-end">{trailing}</div>
    </header>
  );
}

export function OnboardingHeader({ mark, network }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-hairline bg-kumo-base px-4">
      <span className="flex items-center gap-2">
        {mark}
        <h1 className="text-[15px] font-semibold text-kumo-default">mdwa</h1>
      </span>
      {network}
    </header>
  );
}

export function NavItem({ icon: Icon, label, active, onClick, badge }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
      className={cx('flex h-[52px] w-20 flex-col items-center justify-center gap-1 rounded-lg text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50',
        active ? 'font-semibold text-accent-fg' : 'font-medium text-kumo-subtle hover:text-kumo-default')}>
      <span className="relative">
        <Icon size={20} />
        {badge && (
          <span className="absolute -top-1.5 -right-2 flex size-3.5 items-center justify-center rounded-full border-2 border-kumo-base bg-kumo-warning text-[8px] leading-none font-bold text-white">{badge}</span>
        )}
      </span>
      {label}
    </button>
  );
}

export function BottomNav({ children }) {
  return (
    <nav className="flex h-[60px] shrink-0 items-center justify-around border-t border-kumo-hairline bg-kumo-base px-4 py-1">
      {children}
    </nav>
  );
}

/** Pinned bottom bar: an optional compact secondary, the wide primary. */
export function ActionFooter({ secondary, primary }) {
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-kumo-hairline bg-kumo-base px-4 pt-3 pb-4">
      {secondary && <div className="shrink-0">{secondary}</div>}
      <div className="flex min-w-0 flex-1 [&>button]:w-full">{primary}</div>
    </footer>
  );
}

/** The scrolling middle between a pinned header and bottom bar. */
export function Viewport({ children, className, gap = 'gap-4' }) {
  return (
    <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
      <div className={cx('flex flex-col p-4', gap, className)}>{children}</div>
    </div>
  );
}

/** Fixed 380x600 popup: pinned header, scrolling middle, pinned bottom. */
export function Screen({ children }) {
  return <div className="flex h-[600px] w-[380px] flex-col overflow-hidden bg-kumo-canvas">{children}</div>;
}

export function Heading({ title, subtitle }) {
  return (
    <div className="flex flex-col gap-1 px-1">
      <h2 className="text-lg font-bold text-kumo-default">{title}</h2>
      {subtitle && <p className="text-xs leading-normal text-kumo-subtle">{subtitle}</p>}
    </div>
  );
}

/** A row of exclusive choices drawn with the network pill's chip look. */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full border border-kumo-line bg-kumo-tint p-1">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
          className={cx('min-h-7 flex-1 rounded-full px-2 py-1 text-xs leading-tight font-medium outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50',
            o.value === value ? 'border border-kumo-line bg-kumo-base font-semibold text-kumo-default' : 'border border-transparent text-kumo-subtle hover:text-kumo-default')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A thin progress bar, `value` 0..1, in the sync card's style. */
export function Progress({ value, label }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-kumo-fill" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span className="block h-full rounded-full bg-kumo-brand transition-[width]" style={{ width: `${value * 100}%` }} />
    </span>
  );
}

/** The big NIGHT amount on Home and the review: whole part, faded fraction, unit. */
export function BigAmount({ value, unit = 'NIGHT', size = 'lg' }) {
  const [whole, frac] = nightParts(value);
  const lg = size === 'lg';
  return (
    <span className="flex items-end tabular-nums">
      <span className={lg ? 'text-4xl leading-[1.1] font-bold tracking-[-1px] text-kumo-default' : 'text-[32px] leading-[1.1] font-bold tracking-[-0.8px] text-kumo-default'}>{whole}</span>
      <span className={lg ? 'pb-[3px] text-lg leading-[1.1] font-semibold text-kumo-subtle' : 'pb-[3px] text-base leading-[1.1] font-semibold text-kumo-subtle'}>{frac}</span>
      <span className={lg ? 'pb-1 pl-1.5 text-[15px] leading-[1.1] font-semibold text-kumo-subtle' : 'pb-[3px] pl-1.5 text-sm leading-[1.1] font-semibold text-kumo-subtle'}>{unit}</span>
    </span>
  );
}

// ----------------------------------------------------------------- lists --
export function SectionLabel({ title, trailing }) {
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[11px] font-semibold tracking-[0.6px] text-kumo-subtle uppercase">{title}</span>
      {trailing != null && <span className="text-[11px] font-medium text-kumo-subtle">{trailing}</span>}
    </div>
  );
}

/** A titled group: section label above a list card (or anything). */
export function Section({ title, trailing, gap = 'gap-2', children }) {
  return (
    <section className={cx('flex flex-col', gap)}>
      <SectionLabel title={title} trailing={trailing} />
      {children}
    </section>
  );
}

/** White rounded card whose rows are separated by hairlines. */
export function ListCard({ children, className }) {
  return (
    <div className={cx('flex flex-col overflow-hidden rounded-xl border border-kumo-hairline bg-kumo-base [&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-kumo-hairline', className)}>
      {children}
    </div>
  );
}

export function TokenAvatar({ letters, size = 36, night: isNight }) {
  if (isNight) {
    return (
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-linear-to-b from-[color-mix(in_oklch,var(--color-kumo-brand),white_15%)] to-kumo-brand text-white">
        <MoonIcon size={18} weight="bold" />
      </span>
    );
  }
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-kumo-tint font-semibold text-kumo-subtle', size >= 36 ? 'text-xs' : 'text-[11px]')}
      style={{ width: size, height: size }}>
      {letters}
    </span>
  );
}

export function AssetRow({ name, label, subtitle, mono = true, amount, unit, avatar }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      {avatar ?? <TokenAvatar letters={tokenLetters(name)} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-kumo-default">{name}</span>
          {label && <Badge variant="secondary" className="text-[11px]">{label}</Badge>}
        </span>
        <span className={cx('truncate text-kumo-subtle', mono ? 'font-mono text-[11px]' : 'text-xs')}>{subtitle}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-sm font-semibold text-kumo-default tabular-nums">{amount}</span>
        {unit && <span className="text-[11px] text-kumo-subtle">{unit}</span>}
      </div>
    </div>
  );
}

export function DetailRow({ label, children, mono, strong }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[11px] text-[13px]">
      <span className="shrink-0 text-kumo-subtle">{label}</span>
      <span className={cx('min-w-0 truncate text-right text-kumo-default tabular-nums', strong ? 'font-bold' : 'font-medium', mono && 'font-mono text-xs')}>
        {children}
      </span>
    </div>
  );
}

/** One transaction: direction, status, date and hash, and its signed changes per token. */
export function TxRow({ incoming, title, status, meta, deltas, Arrow }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', incoming ? 'bg-kumo-success-tint text-kumo-success' : 'bg-kumo-tint text-kumo-default')}>
        <Arrow size={16} weight="bold" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* A title that names a site can be long: it has the row's width and
            wraps to a second line rather than losing its end; the status
            pill leads the line under it. */}
        <span className="line-clamp-2 text-sm font-semibold break-words text-kumo-default">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          {status}
          <span className="truncate text-[11px] text-kumo-subtle">{meta}</span>
        </span>
      </div>
      <Deltas deltas={deltas} />
    </div>
  );
}

/** Signed per-token changes, right-aligned; `tag` marks shielded ones. */
function Deltas({ deltas }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      {deltas.map(d => (
        <span key={d.key} className="flex items-baseline gap-1">
          <span className={cx('text-[13px] font-semibold tabular-nums', d.positive ? 'text-kumo-success' : 'text-kumo-default')}>{d.text}</span>
          <span className="text-[11px] font-medium text-kumo-subtle">{d.unit}</span>
          {d.tag && <span className="rounded-full bg-kumo-tint px-1.5 text-[10px] leading-[16px] font-semibold text-kumo-subtle">{d.tag}</span>}
        </span>
      ))}
    </div>
  );
}

/** A small status pill: pending or failed. */
export function StatusPill({ tone, children }) {
  const look = tone === 'danger' ? 'bg-kumo-danger-tint text-kumo-danger' : tone === 'success' ? 'bg-kumo-success-tint text-kumo-success'
    : tone === 'warning' ? 'bg-kumo-warning-tint text-kumo-warning' : 'bg-kumo-tint text-kumo-subtle';
  return <span className={cx('shrink-0 rounded-full px-1.5 text-[10px] leading-[16px] font-semibold', look)}>{children}</span>;
}

export function AddRow({ icon: Icon = PlusCircleIcon, label, trailing, trailingMono, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left outline-none hover:bg-kumo-tint focus-visible:bg-kumo-tint disabled:pointer-events-none disabled:opacity-60">
      <Icon size={18} className="shrink-0 text-accent-fg" />
      <span className="flex-1 text-[13px] font-semibold text-accent-fg">{label}</span>
      {trailing && <span className={cx('text-kumo-subtle', trailingMono ? 'font-mono text-[11px]' : 'text-xs')}>{trailing}</span>}
    </button>
  );
}

export function SeedWord({ index, word }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] leading-normal">
      <span className="w-5 shrink-0 text-right text-kumo-subtle" aria-hidden="true">{index}</span>
      <span className="truncate text-kumo-default">{word}</span>
    </li>
  );
}

// ----------------------------------------------------------------- forms --
/** Label row (label, optional hint), a control, then description or error. */
export function Field({ label, hint, description, error, htmlFor, labelId, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(label || hint) && (
        <div className="flex items-center justify-between gap-2">
          <label id={labelId} htmlFor={htmlFor} className="text-[13px] font-medium text-kumo-default">{label}</label>
          {hint && <span className="text-xs text-kumo-subtle tabular-nums">{hint}</span>}
        </div>
      )}
      {children}
      {error ? <p className="text-xs leading-[1.45] text-kumo-danger">{error}</p>
        : description && <p className="text-xs leading-[1.45] text-kumo-subtle">{description}</p>}
    </div>
  );
}

const CONTROL = 'rounded-[10px] bg-kumo-control';

/** A 44px text input, optionally monospaced, with a trailing addon. */
export function TextField({ label, hint, description, error, mono, trailing, inputRef, className, autoFocus, ...input }) {
  const id = useId();
  const own = useRef(null);
  const ref = inputRef ?? own;
  // Focus without scrolling the viewport (autoFocus would scroll it into view).
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={label} hint={hint} description={description} error={error} htmlFor={id} labelId={`${id}l`}>
      <InputGroup size="lg" className={cx(CONTROL, error && 'ring-kumo-danger')}>
        <InputGroup.Input id={id} ref={ref} aria-labelledby={`${id}l`} aria-invalid={error ? true : undefined} {...input}
          className={cx('pl-3.5', mono ? 'font-mono text-[13px]' : 'text-sm', className)} />
        {trailing}
      </InputGroup>
    </Field>
  );
}

/** Password input (masked) with a show/hide toggle. */
export function PasswordField({ label = 'Password', autoComplete = 'current-password', ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <TextField label={label} type={shown ? 'text' : 'password'} autoComplete={autoComplete} spellCheck={false} {...props}
      trailing={(
        <InputGroup.Addon align="end">
          <IconButton icon={shown ? EyeSlashIcon : EyeIcon} label={shown ? 'Hide password' : 'Show password'} size={32}
            className="text-kumo-subtle" onClick={() => setShown(s => !s)} />
        </InputGroup.Addon>
      )} />
  );
}

/** Date input (YYYY-MM-DD) whose calendar button opens the native picker. */
export function DateField(props) {
  const ref = useRef(null);
  return (
    <TextField type="date" inputRef={ref} {...props} className="[&::-webkit-calendar-picker-indicator]:hidden"
      trailing={(
        <InputGroup.Addon align="end">
          <IconButton icon={CalendarBlankIcon} label="Pick a date" size={32} className="text-kumo-subtle"
            onClick={() => ref.current?.showPicker?.()} />
        </InputGroup.Addon>
      )} />
  );
}

/** Large amount with MAX and the unit. */
export function AmountField({ label = 'Amount', hint, description, error, value, onChange, onMax, maxBusy, placeholder = '0.00', unit = 'NIGHT' }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} description={description} error={error} htmlFor={id} labelId={`${id}l`}>
      <InputGroup size="lg" className={cx(CONTROL, 'h-14', error && 'ring-kumo-danger')}>
        <InputGroup.Input id={id} aria-labelledby={`${id}l`} inputMode="decimal" placeholder={placeholder} value={value} aria-invalid={error ? true : undefined}
          onChange={e => onChange(e.target.value)}
          className="pl-4 text-2xl font-semibold tracking-[-0.4px] tabular-nums placeholder:text-kumo-placeholder" />
        <InputGroup.Addon align="end" className="gap-2 pr-3">
          {onMax && (
            <Button variant="ghost" size="xs" onClick={onMax} loading={maxBusy}
              className="h-6 rounded-md bg-kumo-info-tint px-2 text-[11px] font-bold tracking-[0.4px] !text-accent-fg hover:bg-kumo-info-tint">
              MAX
            </Button>
          )}
          <span className="text-sm font-semibold text-kumo-subtle">{unit}</span>
        </InputGroup.Addon>
      </InputGroup>
    </Field>
  );
}

/** Multi-line monospaced address with a Paste chip. */
export function AddressField({ label = 'To', hint, value, onChange, placeholder, error }) {
  const id = useId();
  const paste = async () => {
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) onChange(text.trim());
  };
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <div className="relative">
        <InputArea id={id} value={value} onValueChange={onChange} placeholder={placeholder} rows={1} spellCheck={false}
          aria-invalid={error ? true : undefined}
          className={cx(CONTROL, 'min-h-11 w-full resize-none py-[11px] pl-3.5 font-mono text-[13px] leading-normal break-all [field-sizing:content]', value ? 'pr-3.5' : 'pr-20')} />
        {!value && (
          <Button variant="ghost" size="xs" onClick={paste} icon={<ClipboardTextIcon size={12} />}
            className="absolute top-[11px] right-2.5 h-[22px] gap-1 rounded-md bg-kumo-tint px-2 text-[11px] font-semibold">
            Paste
          </Button>
        )}
      </div>
    </Field>
  );
}

// -------------------------------------------------------------- feedback --
export function Notice({ children }) {
  return (
    <div className="flex gap-2.5 rounded-[10px] bg-kumo-warning-tint px-3 py-2.5">
      <WarningCircleIcon size={16} className="mt-px shrink-0 text-kumo-warning" />
      <p className="text-xs leading-[1.45] text-kumo-default">{children}</p>
    </div>
  );
}

/** Chain sync progress; a link to Sync details when `onClick` is set. */
export function SyncCard({ title, percent, progress, left, right, onClick, error }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag {...(onClick ? { type: 'button', onClick } : {})}
      className={cx('flex w-full flex-col gap-2 rounded-xl border border-kumo-hairline bg-kumo-base px-3.5 py-3 text-left',
        onClick && 'outline-none hover:bg-kumo-elevated focus-visible:ring-2 focus-visible:ring-kumo-focus/50')}>
      <span className="flex w-full items-center gap-2">
        <ArrowsClockwiseIcon size={14} className={error ? 'text-kumo-danger' : 'text-kumo-warning'} />
        <span className="flex-1 text-[13px] font-semibold text-kumo-default">{title}</span>
        {percent && <span className="text-[13px] font-semibold text-accent-fg tabular-nums">{percent}</span>}
        {onClick && <CaretRightIcon size={14} className="text-kumo-subtle" />}
      </span>
      {progress != null && <Progress value={progress} label="Sync progress" />}
      {(left || right) && (
        <span className="flex w-full justify-between text-[11px] text-kumo-subtle tabular-nums">
          <span>{left}</span><span>{right}</span>
        </span>
      )}
      {error && <span className="text-xs text-kumo-danger">{error}</span>}
    </Tag>
  );
}

/** The address as a QR code (byte mode, error correction M). */
export function AddressQR({ value }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { size: n, path: d };
  }, [value]);
  return (
    <div className="flex size-[188px] items-center justify-center rounded-xl border border-kumo-hairline bg-white p-3">
      <svg viewBox={`0 0 ${size} ${size}`} className="size-[164px]" shapeRendering="crispEdges" role="img" aria-label="Address QR code">
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}
