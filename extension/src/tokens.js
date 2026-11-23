// Names for custom tokens: local labels the user gives a token, and the
// "watch token" check that ties a token type to the contract that mints it.
//
// A custom token's raw type is a one-way commitment of a 32-byte domain
// separator and the minting contract's address (ledger-v9 rawTokenType), so
// a wallet cannot read a token's contract off its type. Someone has to supply
// the pair; the engine recomputes the type and compares. That proves which
// contract mints the type, never that the name the contract stores is honest,
// so a label from a contract keeps the contract address for the UI to show.
//
// Labels live in the network's own database (db.js, key `tokenLabels`), in
// the clear: they hold nothing secret (a name the user typed, or public
// contract data), and keeping them outside the seed-encrypted records lets
// every view read them whether or not the wallet is unlocked, and lets a
// label survive a rescan. resetWallet clears the whole database, labels too.
//
// Contract metadata is read from the contract's public state as the indexer
// serves it, decoded with ledger-v9 (ContractState) and Compact's runtime
// type descriptors (@midnight-ntwrk/compact-runtime). Only plain values cross
// between the two packages: no ledger object of the runtime's scope reaches
// the wallet SDK. See readMetadata for which layouts are recognised and why
// anything else yields no metadata.
//
// No storage handle or messaging of its own: the engine passes its store and
// what it knows, so this module also runs under Node.
import { ContractState, encodeContractAddress, rawTokenType } from '@midnightntwrk/ledger-v9';
import {
  CompactTypeBoolean, CompactTypeBytes, CompactTypeOpaqueString, CompactTypeUnsignedInteger,
} from '@midnight-ntwrk/compact-runtime';

const LABELS_KEY = 'tokenLabels';
const NIGHT = '0'.repeat(64);
const KINDS = ['shielded', 'unshielded'];

// Names and symbols that would pass a custom token off as one of the
// network's own tokens or as the wallet itself.
export const RESERVED = ['night', 'tnight', 'dust', 'tdust', 'midnight', 'mdwa'];
export const LIMITS = { name: 32, symbol: 8, decimals: 18 };

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));
const chars = text => [...text].length;
const fold = text => text.trim().toLowerCase();
// Control and format characters (bidi overrides, zero-width joiners) can make
// a label read as something it is not.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// --------------------------------------------------------------- inputs ---
/** A raw token type: 64 hex characters, lowercase. NIGHT's type is not a custom token. */
export function tokenTypeOf(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('A token type is 64 hex characters');
  return t;
}

const kindOf = kind => {
  if (!KINDS.includes(kind)) throw new Error('kind is shielded or unshielded');
  return kind;
};

/**
 * A contract address as a user pastes it. Midnight's tooling (midnight-js
 * deployContract, the indexer, compact-runtime) prints contract addresses as
 * 64 hex characters; Midnight has no Bech32m form for them (the wallet SDK's
 * address format knows shielded, unshielded and DUST addresses only). A 0x
 * prefix, surrounding space and capitals are tolerated. The ledger's own
 * codec decides whether the bytes are a contract address.
 */
export function contractAddressOf(text) {
  let a = String(text ?? '').trim();
  if (/^0x/i.test(a)) a = a.slice(2);
  a = a.toLowerCase();
  if (/^mn_/.test(a)) throw new Error('This is a wallet address. A contract address is 64 hex characters');
  if (!/^[0-9a-f]+$/.test(a)) throw new Error('A contract address is 64 hex characters');
  try { encodeContractAddress(a); } catch { throw new Error('This is not a contract address (expected 32 bytes as 64 hex characters)'); }
  return a;
}

/**
 * The 32-byte domain separator from what the user typed: 64 hex characters
 * (0x allowed) are the bytes themselves; anything else is the text a contract
 * wrote as `pad(32, "…")`. The Compact language reference (Expressions,
 * Literals) defines pad(n, s) as "a byte vector containing the UTF-8 encoding
 * of s followed by 0 bytes up to the padded length n", and a static error
 * when s is longer than n. That is exactly Compact's runtime types composed:
 * Opaque<"string"> holds the UTF-8 bytes of a string, and Bytes<32> takes a
 * shorter value and fills it with zero bytes on the right, refusing a longer
 * one. Hex input cannot be confused with text: 64 characters of text would
 * be 64 bytes, too long for a domain separator. Text is used as typed, not
 * trimmed or normalised, since the contract's literal is exact. Empty is
 * null: the caller may take the contract's own `_domain`.
 */
export function domainSeparatorOf(input) {
  const text = String(input ?? '');
  const trimmed = text.trim();
  if (!trimmed) return null;
  const h = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(trimmed);
  if (h) return unhex(h[1].toLowerCase());
  const encoded = CompactTypeOpaqueString.toValue(text);
  if (encoded[0].length > 32) throw new Error(`The domain separator text is ${encoded[0].length} bytes; it can be at most 32`);
  return new CompactTypeBytes(32).fromValue(encoded);
}

/** The raw token type a contract mints under a domain separator (ledger-v9). */
export const deriveTokenType = (domainBytes, address) => rawTokenType(domainBytes, address);

// --------------------------------------------------------------- labels ---
/** Every label of a store's network: `[{ type, kind, name, symbol, decimals, source, contract?, updatedAt }]`. */
export async function listLabels(store) {
  return Object.values((await store.get(LABELS_KEY)) ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

const keyOf = (kind, type) => `${kind}:${type}`;

/**
 * A label checked against the rules and the network's other labels. Two
 * labels may share a name or symbol only when they are the same raw type in
 * its two kinds: shielded and unshielded coins of one type come from the same
 * contract and domain separator, so they are the same token.
 */
export function checkLabel({ type, kind, name, symbol, decimals }, others = []) {
  const t = tokenTypeOf(type);
  if (t === NIGHT && kind === 'unshielded') throw new Error('NIGHT cannot be renamed');
  const k = kindOf(kind);
  const n = String(name ?? '').trim();
  const s = String(symbol ?? '').trim();
  if (chars(n) < 1 || chars(n) > LIMITS.name) throw new Error(`The name is 1 to ${LIMITS.name} characters`);
  if (chars(s) < 1 || chars(s) > LIMITS.symbol) throw new Error(`The symbol is 1 to ${LIMITS.symbol} characters`);
  if (HIDDEN.test(n) || HIDDEN.test(s)) throw new Error('Names and symbols cannot contain control or invisible characters');
  if (RESERVED.includes(fold(n))) throw new Error(`"${n}" is reserved`);
  if (RESERVED.includes(fold(s))) throw new Error(`"${s}" is reserved`);
  const d = typeof decimals === 'string' && /^\d+$/.test(decimals.trim()) ? Number(decimals.trim()) : decimals ?? 0;
  if (!Number.isInteger(d) || d < 0 || d > LIMITS.decimals) throw new Error(`Decimals are a whole number from 0 to ${LIMITS.decimals}`);
  for (const o of others) {
    if (o.type === t) continue;
    if (fold(o.name) === fold(n)) throw new Error(`Another token is already named "${o.name}"`);
    if (fold(o.symbol) === fold(s)) throw new Error(`Another token already has the symbol ${o.symbol}`);
  }
  return { type: t, kind: k, name: n, symbol: s, decimals: d };
}

/**
 * Saves a label. With `contract: { address, domainSeparator }` the engine
 * recomputes the type from the pair and refuses a pair that does not give
 * this type, so `source: 'contract'` is never just the caller's word. Without
 * it, a label that was already tied to a contract keeps that proof (it is
 * about the type, not the name); otherwise the label is the user's own.
 */
export async function setLabel(store, params) {
  const all = (await store.get(LABELS_KEY)) ?? {};
  const label = checkLabel(params, Object.values(all).filter(l => !(l.type === tokenTypeOf(params.type) && l.kind === params.kind)));
  let contract = null;
  if (params.contract) {
    const address = contractAddressOf(params.contract.address);
    const domain = domainSeparatorOf(params.contract.domainSeparator);
    if (!domain) throw new Error('Enter the domain separator');
    if (deriveTokenType(domain, address) !== label.type) throw new Error('This contract and domain separator do not produce this token');
    contract = { address, domainSeparator: hex(domain) };
  } else {
    contract = all[keyOf(label.kind, label.type)]?.contract ?? null;
  }
  const saved = { ...label, source: contract ? 'contract' : 'user', ...(contract ? { contract } : {}), updatedAt: Date.now() };
  await store.put(LABELS_KEY, { ...all, [keyOf(label.kind, label.type)]: saved });
  return saved;
}

/**
 * A label a site suggests (the connector's watchToken), checked as a typed
 * one is against the network's labels `all` (as stored, by `kind:type`).
 * A symbol left out is the name when the name fits a symbol, since every
 * label has one. `contract` and `domainSeparator` come together; the pair
 * must produce the token type. Returns `{ label, contract, exists, replaces }`:
 * `exists` when the same name, symbol and decimals (and contract, when
 * given) are saved already, `replaces` the label it would change, or null.
 */
export function pageLabel(request, all = {}) {
  const { kind, tokenType, name, symbol, decimals, contract: address, domainSeparator } = request ?? {};
  if (typeof tokenType !== 'string' || typeof name !== 'string') throw new Error('tokenType and name are strings');
  if (symbol !== undefined && symbol !== null && typeof symbol !== 'string') throw new Error('symbol is a string');
  if (decimals !== undefined && decimals !== null && !Number.isInteger(decimals)) throw new Error(`Decimals are a whole number from 0 to ${LIMITS.decimals}`);
  const given = [address, domainSeparator].filter(v => v !== undefined && v !== null);
  if (given.length === 1 || given.some(v => typeof v !== 'string')) throw new Error('contract and domainSeparator are strings, given together');
  const type = tokenTypeOf(tokenType);
  const others = Object.values(all).filter(l => !(l.type === type && l.kind === kind));
  const shortName = chars(name.trim()) <= LIMITS.symbol ? name.trim() : null;
  if ((symbol ?? null) === null && !shortName) throw new Error(`A name over ${LIMITS.symbol} characters needs a symbol of 1 to ${LIMITS.symbol}`);
  const label = checkLabel({ type, kind, name, symbol: symbol ?? shortName, decimals: decimals ?? 0 }, others);
  let contract = null;
  if (given.length) {
    const contractAddress = contractAddressOf(address);
    const domain = domainSeparatorOf(domainSeparator);
    if (!domain) throw new Error('The domain separator is empty');
    if (deriveTokenType(domain, contractAddress) !== label.type) throw new Error('This contract and domain separator do not produce this token type');
    contract = { address: contractAddress, domainSeparator: hex(domain) };
  }
  const saved = all[keyOf(label.kind, label.type)] ?? null;
  const exists = !!saved && saved.name === label.name && saved.symbol === label.symbol && saved.decimals === label.decimals
    && (!contract || (saved.contract?.address === contract.address && saved.contract?.domainSeparator === contract.domainSeparator));
  return { label, contract, exists, replaces: saved && !exists ? { name: saved.name, symbol: saved.symbol, decimals: saved.decimals } : null };
}

/** Every label of a store's network, by `kind:type`. */
export const labelMap = async store => (await store.get(LABELS_KEY)) ?? {};

export async function removeLabel(store, { type, kind }) {
  const all = (await store.get(LABELS_KEY)) ?? {};
  delete all[keyOf(kindOf(kind), tokenTypeOf(type))];
  await store.put(LABELS_KEY, all);
  return {};
}

// ------------------------------------------------------- contract state ---
/** The contract's current state from the indexer (GraphQL v4), or null when there is no such contract. */
export async function fetchContractState(indexerHttpUrl, address) {
  let response;
  try {
    response = await fetch(indexerHttpUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query($a: HexEncoded!) { contractAction(address: $a) { state } }', variables: { a: address } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) { throw new Error(`The indexer did not answer: ${error.message}`); }
  if (!response.ok) throw new Error(`The indexer answered ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`The indexer refused the query: ${body.errors[0].message}`);
  const state = body.data?.contractAction?.state;
  return state ? ContractState.deserialize(unhex(state)) : null;
}

// What a state value is, as far as layouts care: a cell is named by its
// alignment (Opaque values are 'compress' atoms, Bytes<n> and Uint<8 * n>
// are n-byte atoms, Boolean is one byte), anything else by its class.
function shapeOf(value) {
  const kind = value.type();
  if (kind !== 'cell') return kind;
  const a = value.asCell().alignment;
  if (a.length !== 1 || a[0].tag !== 'atom') return 'cell';
  return a[0].value.tag === 'compress' ? 'opaque' : a[0].value.tag === 'bytes' ? `b${a[0].value.length}` : 'cell';
}

/**
 * The OpenZeppelin Compact token layouts this wallet recognises. Compact
 * keeps a contract's ledger fields as one array of state values in the order
 * the compiled contract lays them out, and the chain keeps no field names, so
 * a field can only be found by knowing the whole layout. These are the
 * layouts compactc 0.36.1 (language 0.28) produces for the deployable
 * contracts of OpenZeppelin compact-contracts v0.5.0-alpha.2
 * (commit f85f1a2) that issue native shielded tokens, measured by building
 * each contract's initial state and reading it back with ledger-v9:
 *   - a contract whose only token module is NativeShieldedToken
 *     (_domain, _isInitialized, _name, _symbol, _decimals),
 *   - one whose only token module is NativeShieldedTokenCore or
 *     NativeShieldedTokenFamily (no single _domain: one name for every type
 *     the contract mints),
 *   - the ZOwnableNativeShieldedToken preset (example and mock),
 *   - the NativeShieldedTokenIssuer multisig preset (example and mocks).
 * Positions count from 0 in the top-level array.
 */
const LAYOUTS = [
  { id: 'oz:NativeShieldedToken', shape: ['b32', 'b1', 'opaque', 'opaque', 'b1'], domain: 0, initialized: 1, name: 2, symbol: 3, decimals: 4 },
  { id: 'oz:NativeShieldedTokenCore', shape: ['b1', 'opaque', 'opaque', 'b1'], domain: null, initialized: 0, name: 1, symbol: 2, decimals: 3 },
  { id: 'oz:ZOwnableNativeShieldedToken', shape: ['b1', 'b32', 'b8', 'b32', 'b32', 'b1', 'opaque', 'opaque', 'b1', 'map', 'map'],
    domain: 4, initialized: 5, name: 6, symbol: 7, decimals: 8 },
  { id: 'oz:NativeShieldedTokenIssuer', shape: ['b8', 'b32', 'b32', 'map', 'b1', 'b1', 'b32', 'b1', 'opaque', 'opaque', 'b1', 'b8'],
    domain: 6, initialized: 7, name: 8, symbol: 9, decimals: 10 },
];

const entryName = e => (typeof e === 'string' ? e : new TextDecoder().decode(e));
const cellOf = (fields, i) => [...fields[i].asCell().value];

/** An Opaque<"string"> cell, only when its bytes are well-formed UTF-8 (the runtime's decoder would replace bad bytes). */
function stringCell(fields, i) {
  const value = cellOf(fields, i);
  const bytes = value[0] ?? new Uint8Array();
  const text = CompactTypeOpaqueString.fromValue(value);
  return hex(CompactTypeOpaqueString.toValue(text)[0]) === hex(bytes) ? text : null;
}

/**
 * Name, symbol and decimals from a contract's state, or null. A layout is
 * used only when every top-level field matches its shape exactly, the token
 * module says it is initialised, the strings are well-formed, and one more
 * piece of evidence ties the shape to the OpenZeppelin module rather than to
 * a contract that merely has fields of the same kinds in the same order:
 * either the contract has the module's `name`, `symbol` and `decimals`
 * entry points, or the domain separator the user supplied is the one stored
 * where the layout says `_domain` is. Anything short of that is no metadata:
 * a wrong name shown as coming from the contract is worse than none.
 *
 * Returns `{ layout, name, symbol, decimals, domain }`; `domain` is the
 * stored `_domain` (bytes) or null for layouts without one.
 */
export function readMetadata(contractState, suppliedDomain = null) {
  const fields = contractState.data.state.asArray();
  if (!fields) return null;
  const shape = fields.map(shapeOf);
  const layout = LAYOUTS.find(l => l.shape.length === shape.length && l.shape.every((s, i) => s === shape[i]));
  if (!layout) return null;
  try {
    if (CompactTypeBoolean.fromValue(cellOf(fields, layout.initialized)) !== true) return null;
    const name = stringCell(fields, layout.name);
    const symbol = stringCell(fields, layout.symbol);
    const decimals = Number(new CompactTypeUnsignedInteger(255n, 1).fromValue(cellOf(fields, layout.decimals)));
    const domain = layout.domain === null ? null : new CompactTypeBytes(32).fromValue(cellOf(fields, layout.domain));
    if (name === null || symbol === null) return null;
    const ops = new Set(contractState.operations().map(entryName));
    const hasEntryPoints = ['name', 'symbol', 'decimals'].every(op => ops.has(op));
    const domainAgrees = !!(domain && suppliedDomain && hex(domain) === hex(suppliedDomain));
    if (!hasEntryPoints && !domainAgrees) return null;
    return { layout: layout.id, name, symbol, decimals, domain };
  } catch { return null; }
}

// ---------------------------------------------------------------- watch ---
/**
 * watchToken: which token a contract and domain separator stand for.
 * `balances` is `{ shielded: { [type]: bigint }, unshielded: {...} }` from the
 * running wallet, or null when it is not running (then `held` is empty and
 * `balancesKnown` false). With no domain separator the contract's stored
 * `_domain` is used, but only from a recognised layout.
 *
 * Returns `{ type, address, domainSeparator, contractFound, held: [{ kind,
 * amount }], balancesKnown, metadata: null | { name, symbol, decimals,
 * domainMatches, layout } }`. `domainMatches` says whether the contract's own
 * `_domain` is the one used (null when its layout stores none); a contract
 * whose stored name belongs to another of its domains is not describing this
 * token, and the UI does not offer that name.
 */
export async function watchToken({ address, domainSeparator }, { indexerHttp, balances }) {
  const contract = contractAddressOf(address);
  const supplied = domainSeparatorOf(domainSeparator);
  let state = null, stateError = null;
  try { state = await fetchContractState(indexerHttp, contract); } catch (error) { stateError = error; }
  const found = state ? readMetadata(state, supplied) : null;
  const domain = supplied ?? found?.domain ?? null;
  if (!domain) {
    if (stateError) throw stateError;
    if (!state) throw new Error('There is no contract at this address on this network. Enter its domain separator to check it anyway');
    throw new Error('Enter the domain separator: this contract\'s state does not say which one it uses');
  }
  const type = deriveTokenType(domain, contract);
  const held = [];
  for (const kind of KINDS) {
    const amount = balances?.[kind]?.[type];
    if (amount !== undefined && BigInt(amount) !== 0n) held.push({ kind, amount: BigInt(amount).toString() });
  }
  return {
    type, address: contract, domainSeparator: hex(domain),
    contractFound: !!state, held, balancesKnown: !!balances,
    metadata: found ? {
      name: found.name, symbol: found.symbol, decimals: found.decimals, layout: found.layout,
      domainMatches: found.domain ? hex(found.domain) === hex(domain) : null,
    } : null,
  };
}

// ------------------------------------------------------------- UI table ---
/**
 * The engine's UI methods for token names. `ctx` gives what the engine owns:
 * `store()` the selected network's database, `hasWallet()`, `indexerHttp()`
 * the URL to query (with a Blockfrost project id when the network needs one)
 * and `balances()` the running wallet's balances or null.
 */
export function uiMethods(ctx) {
  const needWallet = () => { if (!ctx.hasWallet()) throw new Error('Set up a wallet on this network first'); };
  return {
    tokenLabels: async () => listLabels(ctx.store()),
    setTokenLabel: async params => { needWallet(); return setLabel(ctx.store(), params); },
    removeTokenLabel: async params => { needWallet(); return removeLabel(ctx.store(), params); },
    watchToken: async params => watchToken(params, { indexerHttp: await ctx.indexerHttp(), balances: ctx.balances() }),
  };
}
