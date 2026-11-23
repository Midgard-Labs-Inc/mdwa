// Number and text formatting for the popup and approval pages. Amounts arrive
// as decimal strings of the smallest unit (STAR for NIGHT, SPECK for DUST)
// and stay BigInt here: a Number would lose digits beyond 2^53.

/** NIGHT is the only token with a known registry entry: 64 hex zeros. */
export const NIGHT_TYPE = '0'.repeat(64);
export const NIGHT_DECIMALS = 6;
export const DUST_DECIMALS = 15;

const group = digits => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Split a smallest-unit amount into sign, grouped whole part and a fraction of exactly `decimals` digits. */
function split(value, decimals) {
  const n = BigInt(value ?? 0);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const scale = 10n ** BigInt(decimals);
  return { neg, whole: group((abs / scale).toString()), frac: (abs % scale).toString().padStart(decimals, '0') };
}

/** A decimal string like "12.5" or "12" in the smallest unit; throws a readable error otherwise. */
export function parseUnits(text, decimals, unit) {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text ?? '');
  if (!m) throw new Error(`Enter ${unit} like 12.5`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`${unit} has at most ${decimals} decimals`);
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

/** Whole and fraction parts of a NIGHT amount: ["3,056", ".504690"]. */
export function nightParts(value) {
  const { neg, whole, frac } = split(value, NIGHT_DECIMALS);
  return [`${neg ? '-' : ''}${whole}`, `.${frac}`];
}

/** NIGHT with all 6 decimals: "3,056.504690". */
export const night = value => nightParts(value).join('');

/** DUST with 15 decimals when `full`, otherwise cut (never rounded up) to at most 6 fraction digits with trailing zeros dropped. */
export function dust(value, { full = false } = {}) {
  const { neg, whole, frac } = split(value, DUST_DECIMALS);
  const sign = neg ? '-' : '';
  if (full) return `${sign}${whole}.${frac}`;
  const short = frac.slice(0, 6).replace(/0+$/, '');
  // A tiny positive balance would otherwise read as exactly zero.
  if (!short && BigInt(value ?? 0) !== 0n && whole === '0') return `${sign}<0.000001`;
  return `${sign}${whole}${short ? `.${short}` : ''}`;
}

/** A raw token quantity with thousands separators (tokens other than NIGHT have no known decimals). */
export const quantity = value => {
  const n = BigInt(value ?? 0);
  return `${n < 0n ? '-' : ''}${group((n < 0n ? -n : n).toString())}`;
};

/** NIGHT is only the native unshielded token: a shielded token with the same type bytes is not it. */
export const isNight = (kind, type) => kind === 'unshielded' && type === NIGHT_TYPE;

export const shortType = type => (type && type.length > 14 ? `${type.slice(0, 8)}…${type.slice(-4)}` : type);
/** Two letters for an avatar, from a name or a token type (tokens.js names tokens). */
export const tokenLetters = type => type.replace(/^0x/, '').slice(0, 2).toUpperCase() || '?';

/**
 * Bech32m addresses read "mn_addr_preview1abc…": by default keep the prefix
 * through the separator plus four characters, or `head` characters when the
 * space is tight (the header), then the last six. A network id may hold
 * digits and hyphens ("mn_addr_dev-11abc…"); the separator is the last "1",
 * since the data part never has one, which is where the greedy match ends.
 */
export function shortAddress(address, head) {
  if (!address) return '';
  const keep = head ?? (/^mn_[a-z0-9_-]+1/.exec(address)?.[0].length ?? 12) + 4;
  return address.length > keep + 7 ? `${address.slice(0, keep)}…${address.slice(-6)}` : address;
}

/**
 * The header form: only the address type ("mn_addr", "mn_shield-addr", "mn_dust"),
 * never the network, then the last six characters. The network is already
 * shown beside it, and the tail is what tells two addresses apart.
 */
export function compactAddress(address) {
  if (!address) return '';
  const type = /^(mn_(?:shield-addr|addr|dust))(?:_[a-z0-9-]+)?1/.exec(address)?.[1];
  return type && address.length > type.length + 8 ? `${type}…${address.slice(-6)}` : shortAddress(address);
}

/** The last six characters: the header's fallback when even the compact form does not fit. */
export const addressTail = address => (address ? `…${address.slice(-6)}` : '');

/** A hash or an output reference ("hash#index") cut to its start and end, keeping the index. */
export function shortHash(hash, head = 10) {
  if (!hash) return hash;
  const [body, index] = hash.split('#');
  const short = body.length > head + 4 ? `${body.slice(0, head)}…${body.slice(-4)}` : body;
  return index == null ? short : `${short}#${index}`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const withCommas = n => (n == null ? '—' : group(BigInt(n).toString()));

/** Parts of the fill of a DUST balance against its cap, 0..1; null while there is no cap. */
export function ratio(balance, cap) {
  const c = BigInt(cap ?? 0);
  if (c <= 0n) return null;
  const permille = (BigInt(balance ?? 0) * 1000n) / c;
  return Number(permille > 1000n ? 1000n : permille < 0n ? 0n : permille) / 1000;
}

/** A moment from the engine: epoch milliseconds, epoch seconds or an ISO string. */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return new Date(n < 1e11 ? n * 1000 : n);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const dateTime = value => toDate(value)?.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) ?? '—';
export const dayOnly = value => toDate(value)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) ?? '—';
/** The browser's local calendar day of a moment, as YYYY-MM-DD (what a date input holds). */
export const localDay = value => {
  const d = toDate(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** What the engine is doing right now, in the words shown on Home, Send and approvals. */
const BUSY_TEXT = {
  balancing: 'Balancing the transaction…',
  proving: 'Proving… this can take a minute',
  submitting: 'Submitting to the network…',
};
export const busyText = busy => BUSY_TEXT[busy?.stage] ?? 'Working…';

/** The selected network as the engine state lists it: `{ id, name, networkId, user, dust, hasWallet }`. */
export const currentNetwork = state => state.networks.find(n => n.id === state.network);

/** The display name of the selected network, from the engine state. */
export const networkName = state => currentNetwork(state)?.name ?? state.network;

/** Whether the selected network has DUST (and so fees). */
export const hasDust = state => currentNetwork(state)?.dust !== false;

/** A sync percentage (0..100) cut to one decimal, never rounded up to a false 100. */
export const percentText = value => `${(Math.floor(Math.max(0, Math.min(100, Number(value) || 0)) * 10) / 10).toFixed(1)}%`;
