// The wallet engine, in a dedicated Worker inside the offscreen document. It
// owns the Midnight wallet SDK facade of the selected network (midnight.js),
// the vault and IndexedDB, and answers the UI method table; the dApp
// connector's table sits beside it under its own envelope kind.
//
// Networks are separate wallets: each has its own recovery phrase, password,
// database and snapshots. Only the selected network syncs. Besides the
// built-in networks there are the user's own (wallet/networks.mjs, custom.js),
// kept in the settings.
//
// Unlocking is once per browser session: the password opens the sealed seed,
// and the seeds of every network unlocked since stay in this worker's memory
// until the user locks or the browser closes. While a network is locked
// nothing syncs (the SDK needs the keys to read the chain), and its snapshot
// stays encrypted.
import { firstValueFrom, filter, timeout } from 'rxjs';
import {
  DEFAULT_NETWORK, checkedEndpoints, connectionUrls, defaultEndpoints, endpointsOf, network, networkIds, userNetworkKey,
} from '../../wallet/networks.mjs';
import * as db from './db.js';
import * as vault from './vault.js';
import * as midnight from './midnight.js';
import * as birthdays from './birthday.js';
import * as tokens from './tokens.js';
import * as custom from './custom.js';
import { makeConnector } from './connector.js';

const SNAPSHOT_EVERY_MS = 60000;
const PREVIEW_LIFETIME_MS = 10 * 60 * 1000;
const PUBLISH_EVERY_MS = 250;

// ---------------------------------------------------------------- state ---
// `start` says where each wallet part of the running session started from
// (see midnight.openWallet): shielded `{ from: 'snapshot' | 'birthday' |
// 'start', reason }`, unshielded and DUST 'snapshot' or 'fresh'.
const idleSync = () => ({
  status: 'idle', error: null, percent: 0, parts: { shielded: { percent: 0 }, unshielded: { percent: 0 }, dust: { percent: 0 } }, tip: null,
  start: null, refreshing: false,
});
const state = {
  network: DEFAULT_NETWORK, networks: [], hasWallet: false, locked: false, addresses: null, birthday: null, birthdayNote: null,
  sync: idleSync(), busy: null, waiting: [], prover: { kind: 'wasm', url: '' },
};
let store = db.forNetwork(DEFAULT_NETWORK);   // the selected network's database
let userNetworks = {};                         // the user's network definitions, as stored in the settings
const unlocked = new Map();                    // network -> { seedHex, key } for this browser session
let session = null;                            // the running SDK wallet of the selected network
let retryTimer = null, retryDelay = 2000;
const previews = new Map();                    // id -> { kind, network, recipe, timer, ... }
let nextPreview = 0;

let publishTimer = null, lastPublish = 0;
function publish() {
  clearTimeout(publishTimer);
  const wait = lastPublish + PUBLISH_EVERY_MS - Date.now();
  if (wait > 0) { publishTimer = setTimeout(publish, wait); return; }
  lastPublish = Date.now();
  self.postMessage({ type: 'state', state: snapshot() });
}
const snapshot = () => structuredClone(state);

const lockedError = () => Object.assign(new Error('Unlock the wallet'), { locked: true });
const net = () => network(store.network, userNetworks);
const known = id => networkIds(userNetworks).includes(id);

async function settings() {
  const s = await db.getSettings();
  userNetworks = s.networks ?? {};
  return { network: known(s.network) ? s.network : DEFAULT_NETWORK, endpoints: s.endpoints ?? {} };
}
const endpointsFor = async id => {
  const { endpoints } = await settings();
  return endpointsOf(network(id, userNetworks), endpoints[id]);
};

async function wallet() {
  const w = await store.get('wallet');
  if (!w) throw new Error(`No wallet on ${net().name}`);
  return w;
}

async function reflect() {
  const w = await store.get('wallet');
  state.network = store.network;
  state.hasWallet = !!w;
  state.locked = !!w && !unlocked.has(store.network);
  state.addresses = w ? { unshielded: w.addresses.unshielded, shielded: w.addresses.shielded, dust: w.addresses.dust } : null;
  // Wallets made before birthdays existed have none: they scan from the start.
  state.birthday = w?.birthday ?? null;
  state.birthdayNote = w?.birthdayNote ?? null;
  state.prover = (await endpointsFor(store.network)).prover;
  state.networks = await Promise.all(networkIds(userNetworks).map(async id => {
    const n = network(id, userNetworks);
    return {
      id, name: n.name, networkId: n.networkId, user: n.user, dust: n.dust,
      hasWallet: id === store.network ? !!w : !!(await db.forNetwork(id).get('wallet')),
    };
  }));
}

// -------------------------------------------------------------- records ---
// Snapshots and notes are encrypted with the unlocked seed's record key.
async function readRecord(name) {
  const keys = unlocked.get(store.network);
  if (!keys) return null;
  return vault.decryptJson(keys.key, await store.get(name));
}
async function writeRecord(network, name, value) {
  const keys = unlocked.get(network);
  if (!keys) return;
  await db.forNetwork(network).put(name, await vault.encryptJson(keys.key, value));
}

// What the wallet notes about the transactions it makes itself.
async function noteTransaction(network, ids, note) {
  const keys = unlocked.get(network);
  if (!keys) return;
  const meta = (await vault.decryptJson(keys.key, await db.forNetwork(network).get('txmeta'))) ?? {};
  for (const id of ids) meta[id] = { ...note, at: Date.now() };
  await writeRecord(network, 'txmeta', meta);
}
const txMeta = async () => (await readRecord('txmeta')) ?? {};

// ------------------------------------------------------------- session ---
// A session is one running facade. Every callback checks that its session
// is still the current one: a stopped session may still deliver state.
async function startSession() {
  if (session || !state.hasWallet || state.locked) return;
  clearTimeout(retryTimer);
  const n = net();
  const run = {
    network: n.id, wallet: null, latest: null, subscription: null, timers: [], stopped: false, saving: null, everSynced: false,
    dust: n.dust,
  };
  session = run;
  state.sync = { ...idleSync(), status: 'connecting' };
  publish();
  try {
    const endpoints = await endpointsFor(n.id);
    const urls = connectionUrls(n, endpoints);   // throws the Blockfrost project id message
    // The chain tip, read from the indexer from the start: the SDK keeps
    // trying an endpoint it cannot reach without saying so, so this is also
    // how the user learns that the indexer does not answer.
    const tip = async () => {
      const height = await midnight.indexerTip(urls.indexerHttp);
      if (session !== run) return;
      if (height !== null) {
        state.sync.tip = height;
        if (state.sync.status === 'connecting') state.sync.error = null;
      } else if (state.sync.status === 'connecting') {
        state.sync.error = `The indexer at ${endpoints.indexerHttp} does not answer: check the endpoints in Settings`;
      }
      publish();
    };
    tip();
    run.timers.push(setInterval(tip, 30000));
    // The SDK retries a query the indexer does not offer forever, without
    // saying so: an indexer that lacks one of the wallet's queries (an older
    // or third-party one) is named here instead of syncing without end.
    const missing = await birthdays.missingQueries(urls.indexerHttp, { dust: run.dust });
    if (missing?.length) {
      throw Object.assign(new Error(`The indexer at ${endpoints.indexerHttp} does not offer ${missing.join(', ')}, which this wallet's sync needs`), { permanent: true });
    }
    // A network the user added is the chain it was added with; another chain
    // behind the same URLs is refused rather than synced as this wallet.
    if (n.user) await custom.checkChain(n, urls.indexerHttp);
    const keys = unlocked.get(n.id);
    const stored = await store.get('snapshot');
    let resume = null;
    if (stored && stored.indexerHttp === endpoints.indexerHttp) resume = await vault.decryptJson(keys.key, stored.box);
    const record = await store.get('wallet');
    run.wallet = await midnight.openWallet({
      net: n, endpoints, seed: vault.fromHex(keys.seedHex), snapshot: resume, birthday: record?.birthday ?? null,
    });
    if (run.stopped) { await run.wallet.stop().catch(() => {}); return; }
    state.sync.start = {
      shielded: run.wallet.shieldedStart, unshielded: run.wallet.started.unshielded, dust: run.wallet.started.dust,
    };
    run.indexerHttp = endpoints.indexerHttp;
    run.subscription = run.wallet.facade.state().subscribe({
      next: s => onState(run, s),
      error: error => sessionFailed(run, error),
    });
    run.timers.push(setInterval(() => saveSnapshot(run), SNAPSHOT_EVERY_MS));
  } catch (error) { sessionFailed(run, error); }
}

function onState(run, s) {
  if (session !== run) return;
  const wasSynced = run.latest?.isSynced;
  run.latest = s;
  const sync = midnight.syncOf(s, { dust: run.dust });
  if (s.isSynced) run.everSynced = true;
  // The DUST wallet re-reads its state in a pass every 30 seconds (see
  // midnight.FastDustWallet), and while a pass runs the SDK reports DUST as
  // not quite synced (its progress counts the pass's work, not blocks). Once
  // the session has been synced, such a pass is a refresh rather than a
  // catch-up: the wallet stays 'synced', with `refreshing` set, instead of
  // the pill dropping to a percentage and back every half minute.
  const refreshing = run.everSynced && !s.isSynced && midnight.onlyDustBehind(s);
  // While catching up, a figure never goes back: the DUST pass's total grows
  // as it finds more coins to check, which would otherwise read as progress
  // lost.
  const ahead = (before, now) => (state.sync.status === 'syncing' && now < 100 ? Math.max(before ?? 0, now) : now);
  state.sync = refreshing
    ? { ...state.sync, status: 'synced', percent: 100, parts: { ...sync.parts, dust: { percent: 100 } }, refreshing: true, error: null }
    : {
      ...state.sync, ...sync, refreshing: false, error: null,
      percent: ahead(state.sync.percent, sync.percent),
      parts: Object.fromEntries(Object.entries(sync.parts).map(([k, p]) => [k, { percent: ahead(state.sync.parts?.[k]?.percent, p.percent) }])),
    };
  if (s.isSynced) retryDelay = 2000;
  refreshDustWhileBooked(run, s);
  // Save as soon as the first sync completes: that is the expensive part.
  if (s.isSynced && !wasSynced) saveSnapshot(run);
  publish();
}

// While a transaction of this wallet holds DUST coins booked, the DUST wallet
// is asked for a pass every few seconds instead of every 30 (see
// midnight.refreshDust), so the change of a fee is known, and spendable, as
// soon as the transaction is on chain. Quick passes stop DUST_REFRESH_FOR_MS
// after the last new booking: a booking that outlasts that is not waiting for
// a block (a swap offer holds its coins until it is taken or expires) and is
// left to the regular passes.
const DUST_REFRESH_MS = 3000;
const DUST_REFRESH_FOR_MS = 2 * 60 * 1000;
function refreshDustWhileBooked(run, s) {
  const count = s.dust.pendingCoins.length;
  const more = count > (run.dustBooked ?? 0);
  run.dustBooked = count;
  if (!count) {
    run.dustBookedSince = null;
    stopDustRefresh(run);
    return;
  }
  // A new booking (another fee) starts the quick passes again.
  if (more) run.dustBookedSince = Date.now();
  if (run.dustRefresh || Date.now() - run.dustBookedSince > DUST_REFRESH_FOR_MS) return;
  let busy = false;
  run.dustRefresh = setInterval(async () => {
    if (session !== run || Date.now() - run.dustBookedSince > DUST_REFRESH_FOR_MS) { stopDustRefresh(run); return; }
    if (busy) return;
    busy = true;
    try { await midnight.refreshDust(run.wallet); } finally { busy = false; }
  }, DUST_REFRESH_MS);
  run.timers.push(run.dustRefresh);
}
function stopDustRefresh(run) {
  if (!run.dustRefresh) return;
  clearInterval(run.dustRefresh);
  run.timers.splice(run.timers.indexOf(run.dustRefresh), 1);
  run.dustRefresh = null;
}

function sessionFailed(run, error) {
  if (session !== run) return;
  stopRun(run, { save: false });
  session = null;
  state.sync = { ...state.sync, status: 'error', error: String(error?.message ?? error) };
  publish();
  // A missing Blockfrost project id, or a query the indexer does not offer,
  // does not fix itself by retrying.
  if (error?.permanent || /Blockfrost project id/.test(state.sync.error)) return;
  retryTimer = setTimeout(startSession, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

async function saveSnapshot(run) {
  if (!run.wallet || run.saving || !unlocked.has(run.network)) return run.saving;
  run.saving = (async () => {
    try {
      const keys = unlocked.get(run.network);
      const snap = await run.wallet.serialize();
      await db.forNetwork(run.network).put('snapshot', { indexerHttp: run.indexerHttp, savedAt: snap.savedAt, box: await vault.encryptJson(keys.key, snap) });
    } catch { /* a failed save only costs a longer sync next time */ } finally { run.saving = null; }
  })();
  return run.saving;
}

async function stopRun(run, { save = true } = {}) {
  run.stopped = true;
  for (const t of run.timers) clearInterval(t);
  run.subscription?.unsubscribe();
  if (!run.wallet) return;
  if (save) await saveSnapshot(run);
  await Promise.race([run.wallet.stop().catch(() => {}), new Promise(r => setTimeout(r, 10000))]);
}

async function stopSession({ save = true } = {}) {
  clearTimeout(retryTimer);
  const run = session;
  session = null;
  for (const [id, p] of previews) if (!run || p.network === run.network) await dropPreview(id);
  if (run) await stopRun(run, { save });
  state.sync = idleSync();
}

/** The running wallet of the selected network and its latest state. */
async function live() {
  if (!state.hasWallet) throw new Error(`No wallet on ${net().name}`);
  if (state.locked) throw lockedError();
  if (!session?.wallet) {
    if (state.sync.status === 'error') throw new Error(state.sync.error);
    throw new Error('The wallet is still connecting');
  }
  const s = session.latest ?? await firstValueFrom(session.wallet.facade.state().pipe(timeout(15000)));
  return { run: session, wallet: session.wallet, s };
}

async function synced() {
  const { run, wallet: w } = await live();
  // A DUST refresh pass (see onState) does not hold up a transaction: until
  // the pass ends, the DUST state is the one the previous pass applied, which
  // is what the transaction would be balanced against without it.
  if (!run.latest?.isSynced && !(run.everSynced && midnight.onlyDustBehind(run.latest))) {
    await firstValueFrom(w.facade.state().pipe(filter(s => s.isSynced), timeout(10000))).catch(() => {
      throw new Error('Wait until the wallet is synced');
    });
  }
  return live();
}

// ------------------------------------------------------------- previews ---
function keepPreview(entry) {
  const id = `${++nextPreview}`;
  entry.timer = setTimeout(() => dropPreview(id), PREVIEW_LIFETIME_MS);
  previews.set(id, entry);
  return id;
}
async function dropPreview(id) {
  const p = previews.get(id);
  if (!p) return;
  previews.delete(id);
  clearTimeout(p.timer);
  // Reverting gives the coins the recipe booked back to the wallet.
  if (p.recipe && p.wallet) await p.wallet.facade.revert(p.recipe, 'cancelled').catch(() => {});
}
function takePreview(id, kind) {
  const p = previews.get(String(id));
  if (!p || p.kind !== kind || p.network !== store.network || session?.wallet !== p.wallet) {
    throw new Error('This preview has expired: review it again');
  }
  previews.delete(String(id));
  clearTimeout(p.timer);
  return p;
}

// The wallet does one transaction at a time (and proves one proof at a
// time, see midnight.js). `state.busy` says what it is doing; `ticket` names
// the dApp request it belongs to, so its approval window can tell its own
// work from someone else's. A request from the popup that finds the wallet
// busy is refused at once (the user is looking at it); a dApp's request
// waits its turn, in order, for up to BUSY_WAIT_MS, so that a stuck
// operation cannot hold it forever. `state.waiting` lists the tickets that
// wait.
const BUSY_WAIT_MS = 15 * 60 * 1000;
const busyWaiters = [];
function releaseBusy() {
  state.busy = null;
  const next = busyWaiters.shift();
  // Handed over in the same turn, so nothing can slip in between.
  if (next) next.take();
  state.waiting = busyWaiters.map(w => w.ticket);
  publish();
}
/** Takes the busy slot for `fn`, which gets a function to report its stage. */
/** What a transfer sends to others, as noted for the history (see midnight.historyItem). */
const sentOf = outputs => outputs
  .filter(o => o.recipient !== state.addresses?.shielded && o.recipient !== state.addresses?.unshielded)
  .map(o => ({ kind: o.kind, type: o.type, amount: o.amount }));

async function withBusy(kind, stage, fn, { wait = false, ticket = null } = {}) {
  const take = () => { state.busy = { kind, stage, startedAt: Date.now(), ...(ticket ? { ticket } : {}) }; };
  if (!state.busy) take();
  else if (!wait) throw new Error('The wallet is busy with another transaction');
  else {
    await new Promise((resolve, reject) => {
      const waiter = { ticket, take: () => { clearTimeout(waiter.timer); take(); resolve(); } };
      waiter.timer = setTimeout(() => {
        busyWaiters.splice(busyWaiters.indexOf(waiter), 1);
        state.waiting = busyWaiters.map(w => w.ticket);
        publish();
        reject(new Error(`The wallet was busy with another operation for ${BUSY_WAIT_MS / 60000} minutes: try again`));
      }, BUSY_WAIT_MS);
      busyWaiters.push(waiter);
      state.waiting = busyWaiters.map(w => w.ticket);
      publish();
    });
  }
  publish();
  try {
    return await fn(next => { if (state.busy) { state.busy = { ...state.busy, stage: next }; publish(); } });
  } finally { releaseBusy(); }
}

// ---------------------------------------------------------------- wallet ---
/**
 * Where a new or restored wallet's shielded sync starts: `{ birthday, note }`
 * with `birthday` null for the start of the chain (see birthday.js). A new
 * wallet (`restore` false) is born at the chain's tip: its phrase was made
 * just now, so nothing can have been sent to it before. If the indexer
 * cannot say where the tip is, it is born at the start instead (correct, only
 * slower) and `note` says why. A restored wallet is born at `date`
 * (YYYY-MM-DD) or, without one, at the start; a date the indexer cannot
 * place is refused, since the user asked for it.
 */
async function birthdayFor(restore, date) {
  if (restore && !date) return { birthday: null, note: null };
  if (!restore && date) throw new Error('A wallet birthday is for restoring a wallet');
  if (date) birthdays.birthdayInstant(date);   // a malformed or future date, before any network
  let indexerHttp;
  try { indexerHttp = connectionUrls(net(), await endpointsFor(store.network)).indexerHttp; } catch (error) {
    if (restore) throw error;
    return { birthday: null, note: `The chain tip could not be read (${error.message}), so the wallet scans from the start of the chain` };
  }
  try {
    return { birthday: await birthdays.birthdayBlock(indexerHttp, restore ? date : null), note: null };
  } catch (error) {
    if (restore) throw new Error(`The indexer could not place the wallet birthday: ${error.message}`);
    return { birthday: null, note: `The chain tip could not be read (${error.message}), so the wallet scans from the start of the chain` };
  }
}

async function createWallet({ mnemonic, password, restore = false, birthday: date = null }) {
  if (await store.get('wallet')) throw new Error(`A wallet already exists on ${net().name}`);
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters');
  const seed = await midnight.seedFromMnemonic(mnemonic);
  const seedHex = vault.toHex(seed);
  const addresses = midnight.deriveAddresses(seed, net());
  const { birthday, note } = await birthdayFor(!!restore, date || null);
  const sealed = await vault.seal(seedHex, password);
  await store.put('wallet', {
    network: store.network, sealed, addresses, createdAt: Date.now(), birthday, ...(note ? { birthdayNote: note } : {}),
  });
  await store.delete('snapshot');
  await store.delete('txmeta');
  unlocked.set(store.network, { seedHex, key: await vault.recordKey(seedHex, store.network) });
  await reflect();
  publish();
  startSession();
  return snapshot();
}

async function unlock({ password }) {
  const w = await wallet();
  if (!unlocked.has(store.network)) {
    const seedHex = await vault.open(w.sealed, password);
    unlocked.set(store.network, { seedHex, key: await vault.recordKey(seedHex, store.network) });
  }
  await reflect();
  publish();
  startSession();
  return snapshot();
}

async function lock() {
  await stopSession({ save: true });
  unlocked.clear();
  await reflect();
  publish();
  return snapshot();
}

/** Only the selected network syncs; switching stops the other one. */
async function selectNetwork({ network: id }) {
  if (!known(id)) throw new Error(`Unknown network ${id}`);
  if (id !== store.network) {
    await stopSession({ save: true });
    await db.putSettings({ ...(await db.getSettings()), network: id });
    store = db.forNetwork(id);
    retryDelay = 2000;
    await reflect();
    publish();
    startSession();
  }
  return snapshot();
}

async function resetWallet({ password }) {
  const w = await wallet();
  await vault.open(w.sealed, password);   // throws Wrong password
  await stopSession({ save: false });
  await store.clear();
  unlocked.delete(store.network);
  await reflect();
  publish();
  return snapshot();
}

/**
 * Syncs the wallet again without its snapshot. The shielded wallet starts at
 * the wallet birthday again; with `fromStart` the birthday is removed first,
 * so it scans the whole chain (for a birthday that turned out to be later
 * than the wallet's first shielded coin).
 */
async function rescan({ fromStart = false } = {}) {
  await live().catch(error => { if (error.locked || !state.hasWallet) throw error; });
  await stopSession({ save: false });
  if (fromStart) {
    const record = { ...(await wallet()), birthday: null };
    delete record.birthdayNote;
    await store.put('wallet', record);
  }
  await store.delete('snapshot');
  await reflect();
  publish();
  startSession();
  return snapshot();
}

// -------------------------------------------------------------- settings ---
/** Starts the selected network's session again with what is stored now. */
async function reconnect() {
  await stopSession({ save: true });
  retryDelay = 2000;
  await reflect();
  publish();
  startSession();
}

async function saveSettings({ network: selected, endpoints }) {
  // One network's entry, or a map of entries by network.
  const isEntry = endpoints && typeof endpoints === 'object' && ('node' in endpoints || 'indexerHttp' in endpoints || 'prover' in endpoints);
  const updates = isEntry ? { [selected ?? store.network]: endpoints } : (endpoints ?? {});
  const s = await db.getSettings();
  const next = { ...s, endpoints: { ...(s.endpoints ?? {}) } };
  const changed = [];
  for (const [id, entry] of Object.entries(updates)) {
    if (!known(id)) throw new Error(`Unknown network ${id}`);
    const n = network(id, userNetworks);
    const before = endpointsOf(n, next.endpoints[id]);
    const after = checkedEndpoints(n, entry);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    next.endpoints[id] = after;
    changed.push(id);
    // Snapshots belong to the indexer that produced them.
    if (before.indexerHttp !== after.indexerHttp) await db.forNetwork(id).delete('snapshot');
  }
  await db.putSettings(next);
  if (changed.includes(store.network)) await reconnect();
  else {
    await reflect();
    publish();
  }
  return snapshot();
}

// -------------------------------------------------------------- networks ---
/** Adds a user network (no `network`) or edits one; returns its id. */
async function saveNetwork({ network: id = null, ...fields }) {
  const before = id === null ? null : network(id, userNetworks);
  if (before && !before.user) throw new Error(`${before.name} is built in: change its endpoints in Settings`);
  const name = String(fields.name ?? '').trim();
  if (networkIds(userNetworks).some(other => other !== id && network(other, userNetworks).name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Another network is called ${name}`);
  }
  const def = await custom.defineNetwork(fields, before);
  const key = id ?? userNetworkKey();
  const s = await db.getSettings();
  await db.putSettings({ ...s, networks: { ...(s.networks ?? {}), [key]: def } });
  await settings();
  const now = network(key, userNetworks);
  // Snapshots belong to the indexer that produced them.
  if (before && before.indexerHttp !== now.indexerHttp) await db.forNetwork(key).delete('snapshot');
  if (key === store.network && JSON.stringify({ ...before, name: now.name }) !== JSON.stringify(now)) await reconnect();
  else {
    await reflect();
    publish();
  }
  return { network: key };
}

/** Removes a user network that has no wallet (its wallet is removed first,
 *  with its password, in Settings). */
async function removeNetwork({ network: id }) {
  const n = network(id, userNetworks);
  if (!n.user) throw new Error(`${n.name} is built in`);
  if (await db.forNetwork(id).get('wallet')) throw new Error(`Remove the ${n.name} wallet first (Settings, Danger zone)`);
  await db.forNetwork(id).clear();
  const s = await db.getSettings();
  const networks = { ...s.networks }, endpoints = { ...s.endpoints };
  delete networks[id];
  delete endpoints[id];
  const selected = store.network === id;
  await db.putSettings({ ...s, networks, endpoints, ...(selected ? { network: DEFAULT_NETWORK } : {}) });
  await settings();
  if (selected) {
    store = db.forNetwork(DEFAULT_NETWORK);
    await reconnect();
  } else {
    await reflect();
    publish();
  }
  return snapshot();
}

// --------------------------------------------------------------- UI calls ---
const ui = {
  state: async () => snapshot(),
  generateMnemonic: async () => ({ words: midnight.generateMnemonic() }),
  createWallet, unlock, lock, selectNetwork, resetWallet, rescan, saveSettings, saveNetwork, removeNetwork,
  // Token names (tokens.js): labels are read from the selected network's
  // database whether or not it is unlocked; watchToken asks its indexer.
  ...tokens.uiMethods({
    store: () => store,
    hasWallet: () => state.hasWallet,
    indexerHttp: async () => connectionUrls(net(), await endpointsFor(store.network)).indexerHttp,
    balances: () => (session?.network === store.network && session.latest
      ? { shielded: session.latest.shielded.balances, unshielded: session.latest.unshielded.balances } : null),
  }),
  overview: async () => {
    const { run, wallet: w, s } = await live();
    return { ...midnight.overviewOf(s, w.networkId, new Date(), run), birthday: state.birthday };
  },
  checkAddress: async ({ address }) => midnight.checkAddress(net().networkId, address),
  previewSend: async ({ outputs }) => {
    const { wallet: w } = await synced();
    return withBusy('send', 'balancing', async () => {
      // A network without DUST has nothing to pay a fee with, and charges none.
      const built = await midnight.buildTransfer(w, outputs, { payFees: net().dust });
      const id = keepPreview({ kind: 'send', network: store.network, wallet: w, recipe: built.recipe, outputs: built.outputs, fee: built.fee });
      return { id, outputs: built.outputs, fee: built.fee, ttl: built.ttl };
    });
  },
  send: async ({ id }) => {
    const p = takePreview(id, 'send');
    return withBusy('send', 'proving', async stage => {
      const txId = await midnight.completeRecipe(p.wallet, p.recipe, { onStage: stage });
      await noteTransaction(p.network, [txId], { kind: 'send', origin: null, fee: p.fee, sent: sentOf(p.outputs) });
      return { txId };
    });
  },
  cancel: async ({ id }) => { await dropPreview(String(id)); return {}; },
  dustPreview: async ({ action }) => {
    if (!net().dust) throw new Error('This network has no DUST');
    const { wallet: w } = await synced();
    return withBusy('dust', 'balancing', async () => {
      const built = await midnight.buildDustAction(w, action);
      const id = keepPreview({ kind: 'dust', network: store.network, wallet: w, recipe: built.recipe, action, fee: built.fee });
      const { recipe, ...shown } = built;
      return { id, action, ...shown };
    });
  },
  dustApply: async ({ id }) => {
    const p = takePreview(id, 'dust');
    return withBusy('dust', 'balancing', async stage => {
      let recipe = p.recipe;
      if (!recipe) {
        // Not affordable at preview time: try again now, since DUST has grown.
        const built = await midnight.buildDustAction(p.wallet, p.action);
        if (!built.canPay) throw new Error(`Not enough DUST for the fee yet (short by ${built.shortfall} SPECK)`);
        recipe = built.recipe;
      }
      // The registration is signed as it is built.
      const txId = await midnight.completeRecipe(p.wallet, recipe, { sign: false, onStage: stage });
      await noteTransaction(p.network, [txId], { kind: 'dust', action: p.action, origin: null, fee: p.fee });
      return { txId };
    });
  },
  history: async ({ offset = 0, limit = 50 } = {}) => {
    const { wallet: w, s } = await live();
    const items = await midnight.historyItems(w, s, await txMeta());
    return { total: items.length, items: items.slice(Number(offset), Number(offset) + Number(limit)) };
  },
  txDetail: async ({ hash }) => {
    const { wallet: w, s } = await live();
    return midnight.historyDetail(w, s, String(hash ?? ''), await txMeta());
  },
  describeTx: async ({ tx, stage }) => {
    const { wallet: w, s } = await live();
    return midnight.describeTransaction(w, tx, stage, s);
  },
  settings: async () => {
    const s = await settings();
    const ids = networkIds(userNetworks);
    return {
      network: store.network, birthday: state.birthday, definition: net(),
      endpoints: Object.fromEntries(ids.map(id => [id, endpointsOf(network(id, userNetworks), s.endpoints[id])])),
      defaults: Object.fromEntries(ids.map(id => [id, defaultEndpoints(network(id, userNetworks))])),
    };
  },
};

// ------------------------------------------------------------- connector ---
// The dApp connector's table (envelope kind 'connector', see connector.js).
// The background checks connections and permissions before it calls any of
// these; connectorContext is what it binds a site's connection to.
const connector = {
  connectorContext: async () => ({
    network: store.network, name: net().name, networkId: net().networkId,
    hasWallet: state.hasWallet, locked: state.locked,
  }),
  ...makeConnector({
    context: () => ({ ...net(), network: store.network }),
    live, storedWallet: wallet, endpointsFor, withBusy, releaseBusy, keepPreview, takePreview, dropPreview, noteTransaction, txMeta,
    state, publish,
  }),
};

// ------------------------------------------------------------- messaging ---
const tables = { ui, connector };
// Requests wait for the selected network to be read from the database.
const ready = (async () => {
  store = db.forNetwork((await settings()).network);
  await reflect();
  publish();
})();
self.onmessage = async ({ data }) => {
  const { id, kind, method, params } = data;
  try {
    await ready;
    const table = tables[kind];
    if (!table || !Object.hasOwn(table, method)) throw new Error(`Unknown method ${method}`);
    const result = await table[method](params ?? {});
    self.postMessage({ id, result: result === undefined ? null : result });
  } catch (error) {
    self.postMessage({ id, error: { message: String(error?.message ?? error), code: error?.code ?? null, locked: !!error?.locked } });
  }
};
