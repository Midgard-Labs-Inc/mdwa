// Background service worker: routes extension pages' requests to the engine,
// owns the per-origin dApp permissions (chrome.storage.local), the dApp
// connector's routing and approval windows, and the offscreen document's
// lifecycle. The engine (wallet SDK, vault, IndexedDB) lives in the
// offscreen document's worker; this worker never holds seeds.
// Passwords typed into a page pass through here to the engine and are not
// kept.
import { networksMatching, pagesConnectedOn } from '../../wallet/networks.mjs';

const BUILD = __BUILD_ID__;

let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['WORKERS'],
    justification: 'Runs the Midnight wallet engine (WASM ledger, prover and chain sync) in a worker',
  }).finally(() => { creating = null; });
  await creating;
}

// Requests reach the engine over one Port to the offscreen document. A
// runtime message would be delivered to every extension page as well (the
// popup, approval windows), and some requests are large: a dApp's key
// material arrives in 8 MiB chunks. The Port goes to the offscreen document
// alone.
//
// The offscreen document exists before its script listens. Until then a
// connection finds nobody and is closed at once; only a Port the relay
// greets ({ ready: true }) counts, and connecting is tried again until one
// is. A Port that closes (the offscreen document or this worker went away)
// fails what was waiting on it, and the next request connects again.
// `kind` picks the engine's method table: 'ui' or 'connector'.
const ENGINE_PORT = 'mdwa-engine';
let enginePort = null;
let nextRequest = 0;
const engineWaiting = new Map();

function openEnginePort() {
  return new Promise(resolve => {
    const port = chrome.runtime.connect({ name: ENGINE_PORT });
    let greeted = false;
    port.onMessage.addListener(message => {
      if (message?.ready) { greeted = true; resolve(port); return; }
      const waiter = engineWaiting.get(message?.id);
      if (!waiter) return;
      engineWaiting.delete(message.id);
      waiter(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (enginePort === port) enginePort = null;
      if (!greeted) { resolve(null); return; }
      for (const [id, waiter] of engineWaiting) {
        if (waiter.port !== port) continue;
        engineWaiting.delete(id);
        waiter({ id, error: { message: 'The wallet engine stopped: try again', code: null, locked: false } });
      }
    });
  });
}

let connecting = null;
async function enginePortReady() {
  if (enginePort) return enginePort;
  connecting ??= (async () => {
    await ensureOffscreen();
    for (let attempt = 0; attempt <= 100; attempt++) {
      const port = await openEnginePort();
      if (port) { enginePort = port; return port; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('The wallet engine did not start');
  })().finally(() => { connecting = null; });
  return connecting;
}

async function engine(kind, method, params) {
  const port = await enginePortReady();
  const id = ++nextRequest;
  const reply = await new Promise(resolve => {
    const waiter = message => resolve(message);
    waiter.port = port;
    engineWaiting.set(id, waiter);
    try { port.postMessage({ id, kind, method, params }); } catch (error) {
      engineWaiting.delete(id);
      resolve({ id, error: { message: String(error?.message ?? error), code: null, locked: false } });
    }
  });
  if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.result;
}

// ------------------------------------------------------------ permissions ---
// A site is approved per network (each network has its own addresses):
//   sites: { [network]: { [origin]: { grantedAt, permissions: [methodName] } } }
// The dApp connector adds and reads entries; the UI lists and removes them.
async function sitesByNetwork() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites;
}
async function listSites() {
  const sites = await sitesByNetwork();
  return Object.entries(sites).flatMap(([network, origins]) => Object.entries(origins).map(([origin, s]) => ({
    origin, network, grantedAt: s.grantedAt ?? null, permissions: s.permissions ?? [],
  }))).sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
}
async function forgetSite(origin, network) {
  await updateSites(sites => { if (sites[network]) delete sites[network][origin]; });
}
async function forgetNetwork(network) {
  await updateSites(sites => { delete sites[network]; });
}
// The networks whose approvals a UI call ends, if it succeeds: a removed
// network's, a network's own removed wallet's, or the removed shared
// wallet's on every network that used it. A new wallet starts without them.
async function approvalsEndedBy(method, params) {
  if (method === 'removeNetwork') return [params.network];
  if (method !== 'resetWallet') return [];
  const s = await engine('ui', 'state');
  return s.ownWallet ? [s.network] : s.networks.filter(n => !n.ownWallet).map(n => n.id);
}

// Every change to `sites` goes through this chain, so two requests updating
// it at once cannot overwrite each other's change.
let sitesChain = Promise.resolve();
function updateSites(change) {
  const run = sitesChain.then(async () => {
    const sites = await sitesByNetwork();
    change(sites);
    await chrome.storage.local.set({ sites });
  });
  sitesChain = run.catch(() => {});
  return run;
}
const siteOf = async (network, origin) => (await sitesByNetwork())[network]?.[origin] ?? null;

// -------------------------------------------------------------- approvals ---
// One window per request (approve.html?id=<n>). The page reads
// { kind, origin, params } and answers approve or reject; closing the window
// rejects. `perform` (when set) runs on approval before the window closes,
// so the window can show the wallet working. A transaction's window opens
// before the wallet has balanced it (params.preparing), so a locked wallet
// is unlocked in that same window; the background fills in the description
// and tells the page to read it again (an 'approvalUpdate' message).
const approvals = new Map();   // id -> entry
let nextApproval = 0;

function openApproval(kind, origin, params, perform = null) {
  const id = String(++nextApproval);
  const entry = { id, kind, origin, params, perform, windowId: null, done: false, unlockWaiters: [] };
  entry.decision = new Promise(resolve => { entry.resolve = outcome => { entry.done = true; approvals.delete(id); resolve(outcome); }; });
  approvals.set(id, entry);
  chrome.windows.create({
    url: chrome.runtime.getURL(`approve.html?id=${id}`), type: 'popup', width: 440, height: 680, focused: true,
  }).then(w => {
    entry.windowId = w.id;
    if (entry.done) chrome.windows.remove(w.id).catch(() => {});
  }, () => entry.resolve({ approved: false }));
  return entry;
}
function updateApproval(entry, params) {
  entry.params = { ...entry.params, ...params };
  chrome.runtime.sendMessage({ type: 'approvalUpdate', id: entry.id }).catch(() => {});
}
chrome.windows.onRemoved.addListener(windowId => {
  for (const entry of approvals.values()) if (entry.windowId === windowId) entry.resolve({ approved: false });
});

async function decide(id, approved, choice = null) {
  const entry = approvals.get(id);
  if (!entry) throw new Error('This request is no longer pending');
  if (approved && entry.params?.preparing) throw new Error('The wallet is still preparing this request');
  if (approved && entry.params?.error) throw new Error('This request cannot be approved');
  // A window that offers choices (a connect naming several networks) is
  // approved with one of them.
  if (approved && entry.params?.choices && !entry.params.choices.some(c => c.id === choice)) throw new Error('Choose a network');
  let outcome = { approved, choice };
  if (approved && entry.perform) {
    try { outcome = { approved: true, result: await entry.perform() }; } catch (error) { outcome = { approved: true, error }; }
  }
  entry.resolve(outcome);
  if (entry.windowId !== null) chrome.windows.remove(entry.windowId).catch(() => {});
  return true;
}

// ------------------------------------------------------------ dApp connector ---
// DApp Connector API 4.1.0. The page's object (inject.js) talks to the
// content script, which keeps one Port per page open to this worker. The
// site's origin is the one Chrome reports for that Port, never anything the
// page says.
//
// Permission model:
// - connect(networkId, { endpoint }) asks the user once per site and
//   network (the `connect` window), switching network when it names
//   another (see connect below), and stores the site under `sites`;
//   connect() without a network id does the same on the selected network,
//   never switching. A connection is bound to the network it was made on:
//   after a switch of network, a removed wallet or a disconnected site, every
//   call of that connection fails with Disconnected and getConnectionStatus says
//   'disconnected' until the dApp connects again. A change of network is
//   told to the pages connected on the network left (see changingNetwork).
// - addNetwork (on the wallet object) and watchToken (connected) go beyond
//   the API: a network or a token name the user approves in a window.
// - Free once connected: getConfiguration, getConnectionStatus, hintUsage,
//   the three address methods (Midnight.js needs the shielded keys up
//   front, and addresses are given out to be paid anyway),
//   getUnshieldedBalances (unshielded coins are public on chain),
//   getProvingProvider (the preimages are the dApp's own data, proved with
//   the user's prover) and submitTransaction (it only relays a transaction
//   someone already signed and sealed).
// - Asked per call, in a window, every time: balanceUnsealedTransaction,
//   balanceSealedTransaction, makeTransfer, makeIntent and signData.
// - Behind a permission the user grants per site and network (the
//   `permissions` window, from hintUsage or on first use), because the
//   specification names them as data not to share lightly:
//   getShieldedBalances, getDustBalance (DUST spends are private) and
//   getTxHistory. A refusal is PermissionRejected and stays so for the
//   page's life (its document), even across reconnects, as the
//   specification requires; a grant is stored with the site and shows in
//   the Sites tab.
const WALLET_METHODS = new Set([
  'getShieldedBalances', 'getUnshieldedBalances', 'getDustBalance', 'getShieldedAddresses', 'getUnshieldedAddress',
  'getDustAddress', 'getTxHistory', 'balanceUnsealedTransaction', 'balanceSealedTransaction', 'makeTransfer', 'makeIntent',
  'signData', 'submitTransaction', 'getProvingProvider', 'getConfiguration', 'getConnectionStatus',
]);
const GATED = new Set(['getShieldedBalances', 'getDustBalance', 'getTxHistory']);
// Beside the API's own: hintUsage, and watchToken, which this wallet adds
// (free once connected; the user approves each label in a window).
const EXTRA_METHODS = new Set(['hintUsage', 'watchToken']);
const PROVER_CALLS = { _proverHasKey: 'proverHasKey', _proverPutKey: 'proverPutKey', _proverCheck: 'proverCheck', _proverProve: 'proverProve' };
const CODES = new Set(['InternalError', 'Rejected', 'InvalidRequest', 'PermissionRejected', 'Disconnected', 'InsufficientFunds']);
const apiError = (code, reason) => Object.assign(new Error(reason), { apiCode: code });
const wireError = error => ({
  type: 'DAppConnectorAPIError',
  code: error?.apiCode ?? (CODES.has(error?.code) ? error.code : 'InternalError'),
  reason: String(error?.message ?? error),
});

// Per page (document): the connections it made, the permissions it was
// refused, and where a message to that document goes (`target`). Kept in
// session storage so a restart of this worker forgets none of them; dropped
// when the tab closes.
let sessions = null;
async function loadSessions() {
  sessions ??= (await chrome.storage.session.get('dappSessions')).dappSessions ?? {};
  return sessions;
}
const saveSessions = () => chrome.storage.session.set({ dappSessions: sessions });
async function sessionOf(key, origin, tabId, target) {
  await loadSessions();
  sessions[key] ??= { origin, tabId, target, rejected: [], connections: {} };
  return sessions[key];
}
chrome.tabs.onRemoved.addListener(async tabId => {
  await loadSessions();
  for (const [key, s] of Object.entries(sessions)) if (s.tabId === tabId) delete sessions[key];
  await saveSessions();
});

// The engine is asked on the site's behalf; a locked wallet is unlocked in
// a window first (one window however many requests wait for it).
let unlocking = null;
async function ensureUnlocked(origin) {
  unlocking ??= openApproval('unlock', origin, {}).decision.finally(() => { unlocking = null; });
  if (!(await unlocking).approved) throw apiError('Rejected', 'The wallet is locked');
}
async function walletCall(method, params, origin) {
  try { return await engine('connector', method, { ...params, origin }); } catch (error) {
    if (!error.locked) throw error;
    await ensureUnlocked(origin);
    return engine('connector', method, { ...params, origin });
  }
}

// Asks for permissions once per page, method set and moment: concurrent
// asks for the same methods share one window.
const asking = new Map();
async function askPermissions(session, origin, network, methods) {
  const key = `${origin}|${network}|${methods.join(',')}`;
  if (!asking.has(key)) {
    asking.set(key, openApproval('permissions', origin, { network, methods }).decision.finally(() => asking.delete(key)));
  }
  const { approved } = await asking.get(key);
  if (approved) {
    await updateSites(sites => {
      const site = sites[network]?.[origin];
      if (site) site.permissions = [...new Set([...(site.permissions ?? []), ...methods])];
    });
  } else {
    session.rejected = [...new Set([...session.rejected, ...methods])];
    await saveSessions();
  }
  return approved;
}
async function requirePermission(session, origin, network, method) {
  if (session.rejected.includes(method)) throw apiError('PermissionRejected', `${method} is not allowed for this site`);
  const site = await siteOf(network, origin);
  if (site?.permissions?.includes(method)) return;
  if (!(await askPermissions(session, origin, network, [method]))) throw apiError('PermissionRejected', `${method} is not allowed for this site`);
}

// connect(networkId, { endpoint }) names the networks of the wallet with that
// network id, narrowed by `endpoint` (where transactions go, as
// getConfiguration reports it); connect() without one names the selected
// network alone, so it never switches. One of them selected: as on any connect.
// Otherwise the wallet switches, through the engine's own switch (the old
// network's session stops and saves, and its connections end): silently to
// the network the site is approved on, else after the Connect window, which
// names the network asked for, says that approving switches to it, and lets
// the user pick when several match. A switch is refused while another
// request's window is open or the wallet is busy on the selected network, and
// switching connects run one at a time, so two cannot interleave.
const noWalletOn = name => apiError('InternalError', `No wallet on ${name}: create or restore one in mdwa first`);
const noNetwork = (networkId, endpoint) => apiError('InvalidRequest', `No network ${networkId} in mdwa${endpoint ? ` at ${endpoint}` : ''}: add it to mdwa to connect`);

async function bindConnection(session, origin, context) {
  if (!context.hasWallet) throw noWalletOn(context.name);
  if (!(await siteOf(context.network, origin))) {
    const { approved } = await openApproval('connect', origin, { network: context.network }).decision;
    if (!approved) throw apiError('Rejected', 'The user refused the connection');
    await approveSite(context.network, origin);
  }
  return newConnection(session, context);
}
const approveSite = (network, origin) => updateSites(sites => {
  sites[network] ??= {};
  sites[network][origin] ??= { grantedAt: Date.now(), permissions: [] };
});
async function newConnection(session, context) {
  const connectionId = crypto.randomUUID();
  session.connections[connectionId] = { network: context.network, connectedAt: Date.now() };
  await saveSessions();
  return { connectionId, networkId: context.networkId };
}

async function connect(session, origin, networkId, options) {
  const named = networkId !== undefined && networkId !== null;
  if (named && (typeof networkId !== 'string' || !networkId)) throw apiError('InvalidRequest', 'connect needs a network id');
  if (options !== undefined && options !== null && typeof options !== 'object') throw apiError('InvalidRequest', 'options must be an object');
  const endpoint = named ? options?.endpoint ?? null : null;
  if (endpoint !== null && (typeof endpoint !== 'string' || !URL.canParse(endpoint))) throw apiError('InvalidRequest', 'endpoint must be a URL');
  const context = await engine('connector', 'connectorContext');
  const matching = networksMatching(await engine('connector', 'connectorNetworks'), networkId, endpoint, context.network);
  if (!matching.length) throw noNetwork(networkId, endpoint);
  if (matching.some(n => n.id === context.network)) return bindConnection(session, origin, context);
  return oneSwitchAtATime(() => switchAndConnect(session, origin, networkId, endpoint));
}

let switching = Promise.resolve();
function oneSwitchAtATime(run) {
  const next = switching.then(run);
  switching = next.catch(() => {});
  return next;
}

// A switch must not cut short another request: a window of it still open,
// or the engine at work on the selected network.
function refuseWhileBusy(context) {
  if (approvals.size || context.busy) {
    throw apiError('InternalError', `mdwa is busy with another request on ${context.name}: finish it, then connect again`);
  }
}

async function switchAndConnect(session, origin, networkId, endpoint) {
  // Read again: an earlier connect may have switched meanwhile.
  const context = await engine('connector', 'connectorContext');
  const matching = networksMatching(await engine('connector', 'connectorNetworks'), networkId, endpoint);
  if (!matching.length) throw noNetwork(networkId, endpoint);
  if (matching.some(n => n.id === context.network)) return bindConnection(session, origin, context);
  const withWallet = matching.filter(n => n.hasWallet);
  if (!withWallet.length) throw noWalletOn(matching[0].name);
  const approvedOn = [];
  for (const n of withWallet) if (await siteOf(n.id, origin)) approvedOn.push(n);
  refuseWhileBusy(context);
  let target = withWallet.length === 1 ? withWallet[0] : approvedOn.length === 1 ? approvedOn[0] : null;
  const asked = !target || !approvedOn.includes(target);
  if (asked) {
    const choices = target ? null : withWallet.map(n => ({ id: n.id, name: n.name, node: n.node }));
    const entry = openApproval('connect', origin, { network: target?.id ?? null, networkId, switchFrom: context.name, choices });
    const outcome = await entry.decision;
    if (!outcome.approved) throw apiError('Rejected', 'The user refused the connection');
    target ??= withWallet.find(n => n.id === outcome.choice);
    refuseWhileBusy(await engine('connector', 'connectorContext'));
  }
  await changingNetwork(() => engine('connector', 'switchNetwork', { network: target.id }));
  if (asked) await approveSite(target.id, origin);
  return newConnection(session, await engine('connector', 'connectorContext'));
}

// A change of the selected network (the popup's network menu, removing the
// selected network, a site's connect for another network) is told to the
// pages holding a connection on the network left (pagesConnectedOn), each by
// a message to its own document; no other page learns of it. The notice
// names no network: a page connects again to bind to the new one.
const CHANGES_NETWORK = new Set(['selectNetwork', 'removeNetwork']);
async function changingNetwork(run) {
  const before = await engine('connector', 'connectorContext');
  try { return await run(); } finally {
    const after = await engine('connector', 'connectorContext').catch(() => null);
    if (before.hasWallet && after && after.network !== before.network) {
      const approved = (await sitesByNetwork())[before.network] ?? {};
      for (const page of pagesConnectedOn(Object.values(await loadSessions()), before.network, approved)) {
        chrome.tabs.sendMessage(page.tabId, { type: 'networkChange' }, page.target).catch(() => {});
      }
    }
  }
}

// addNetwork(definition) on the wallet object: a network a site offers. The
// same network id and addresses as one the wallet has is `exists`, without a
// window; anything else is checked as a definition typed in the popup is
// (first block read from its indexer) before the window shows it, and is
// added, not selected, once the user approves.
const DEFINITION_KEYS = ['name', 'networkId', 'indexerHttp', 'indexerWs', 'node', 'submitUrl', 'dust'];
function definitionOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('InvalidRequest', 'addNetwork takes a network definition');
  const unknown = Object.keys(value).filter(k => !DEFINITION_KEYS.includes(k));
  if (unknown.length) throw apiError('InvalidRequest', `A network definition has no ${unknown.join(', ')}`);
  for (const key of ['name', 'networkId', 'indexerHttp', 'indexerWs']) {
    if (typeof value[key] !== 'string') throw apiError('InvalidRequest', `${key} is a string`);
  }
  const via = ['node', 'submitUrl'].filter(k => value[k] !== undefined && value[k] !== null);
  if (via.length !== 1 || typeof value[via[0]] !== 'string') throw apiError('InvalidRequest', 'A network definition has a node or a submitUrl, one of them, as a string');
  if (value.dust !== undefined && value.dust !== null && typeof value.dust !== 'boolean') throw apiError('InvalidRequest', 'dust is true or false');
  return {
    name: value.name, networkId: value.networkId, indexerHttp: value.indexerHttp, indexerWs: value.indexerWs,
    [via[0]]: value[via[0]], dust: value.dust !== false,
  };
}
async function addNetwork(origin, value) {
  const definition = definitionOf(value);
  const checked = await engine('connector', 'checkNetwork', { definition });
  if (checked.exists) return { status: 'exists' };
  const entry = openApproval('addNetwork', origin, { definition: checked.definition },
    () => engine('connector', 'addNetwork', { definition }));
  const outcome = await entry.decision;
  if (!outcome.approved) throw apiError('Rejected', 'The user declined to add the network');
  if (outcome.error) throw outcome.error;
  return outcome.result;
}

/** The connection's network if it is still live, else null. */
async function liveNetwork(connection, origin) {
  if (!connection) return null;
  const context = await engine('connector', 'connectorContext');
  if (!context.hasWallet || context.network !== connection.network) return null;
  return (await siteOf(connection.network, origin)) ? { network: connection.network, networkId: context.networkId } : null;
}

// A request the user approves after the wallet has built it: the window
// opens at once, the wallet balances (after an unlock in that window if
// needed), the window shows the result, and on approval the wallet signs,
// proves and binds it.
async function approveBuilt(kind, origin, network, shown, prepare, params) {
  const entry = openApproval(kind, origin, { network, ...shown, described: null, preparing: true });
  // The window's id is the request's ticket: the engine names it in
  // state.busy while it works on it, and in state.waiting while it waits.
  const ticket = entry.id;
  let prepared;
  for (;;) {
    try { prepared = await engine('connector', prepare, { ...params, origin, ticket }); break; } catch (error) {
      if (error.locked && !entry.done) {
        await Promise.race([new Promise(r => entry.unlockWaiters.push(r)), entry.decision]);
        if (entry.done) throw apiError('Rejected', 'The user rejected the request');
        continue;
      }
      if (entry.done) throw apiError('Rejected', 'The user rejected the request');
      // A malformed request is the site's mistake: the window closes without
      // asking anything. Anything else (not enough funds, a busy wallet) is
      // shown so the user knows why nothing happened.
      if (error.code === 'InvalidRequest') {
        entry.resolve({ approved: false });
        if (entry.windowId !== null) chrome.windows.remove(entry.windowId).catch(() => {});
      } else {
        updateApproval(entry, { preparing: false, error: error.message });
      }
      throw error;
    }
  }
  if (entry.done) {
    await engine('connector', 'cancel', { id: prepared.id }).catch(() => {});
    throw apiError('Rejected', 'The user rejected the request');
  }
  const { id, ...rest } = prepared;
  entry.perform = () => engine('connector', 'complete', { id, origin, ticket });
  updateApproval(entry, { ...rest, preparing: false });
  const outcome = await entry.decision;
  if (!outcome.approved) {
    await engine('connector', 'cancel', { id }).catch(() => {});
    throw apiError('Rejected', 'The user rejected the request');
  }
  if (outcome.error) throw outcome.error;
  return outcome.result;
}

// Options left out arrive as null: JSON has no undefined.
const optionPayFees = options => {
  if (options !== undefined && options !== null && typeof options !== 'object') throw apiError('InvalidRequest', 'options must be an object');
  return options?.payFees ?? true;
};

async function call(session, origin, { connectionId, method, args = [] }) {
  if (typeof method !== 'string' || !Array.isArray(args)) throw apiError('InvalidRequest', 'Malformed request');
  const internal = Object.hasOwn(PROVER_CALLS, method);
  if (!WALLET_METHODS.has(method) && !EXTRA_METHODS.has(method) && !internal) throw apiError('InvalidRequest', `Unknown method ${method}`);
  const live = await liveNetwork(session.connections[connectionId], origin);
  if (method === 'getConnectionStatus') return live ? { status: 'connected', networkId: live.networkId } : { status: 'disconnected' };
  if (!live) throw apiError('Disconnected', 'This connection has ended: connect again');
  const { network } = live;
  if (GATED.has(method)) await requirePermission(session, origin, network, method);
  if (internal) return engine('connector', PROVER_CALLS[method], { ...(args[0] ?? {}), origin });
  switch (method) {
    case 'hintUsage': {
      const names = args[0];
      if (!Array.isArray(names) || names.some(n => !WALLET_METHODS.has(n))) throw apiError('InvalidRequest', 'hintUsage takes connected API method names');
      const site = await siteOf(network, origin);
      const ask = [...new Set(names)].filter(n => GATED.has(n) && !session.rejected.includes(n) && !site?.permissions?.includes(n));
      if (ask.length) await askPermissions(session, origin, network, ask);
      return null;
    }
    // A label a site suggests for a token, on the connection's network: no
    // window when the same label is saved, else the window shows it.
    case 'watchToken': {
      const request = args[0];
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw apiError('InvalidRequest', 'watchToken takes { kind, tokenType, name, … }');
      const checked = await engine('connector', 'checkTokenLabel', { request });
      if (checked.exists) return { status: 'exists' };
      const entry = openApproval('watchToken', origin, { network, ...checked },
        () => engine('connector', 'saveTokenLabel', { network, request }));
      const outcome = await entry.decision;
      if (!outcome.approved) throw apiError('Rejected', 'The user declined the token name');
      if (outcome.error) throw outcome.error;
      return outcome.result;
    }
    case 'getConfiguration':
      return engine('connector', method, { origin });
    // Stored addresses are answered while locked too; those of the shared
    // wallet on a network it has not opened on yet need an unlock.
    case 'getShieldedAddresses':
    case 'getUnshieldedAddress':
    case 'getDustAddress':
      return walletCall(method, {}, origin);
    case 'getShieldedBalances':
    case 'getUnshieldedBalances':
    case 'getDustBalance':
      return walletCall(method, {}, origin);
    case 'getTxHistory':
      return walletCall(method, { pageNumber: args[0], pageSize: args[1] }, origin);
    case 'getProvingProvider':
      return null;
    case 'submitTransaction':
      await walletCall('submitTransaction', { tx: args[0] }, origin);
      return null;
    case 'balanceUnsealedTransaction':
    case 'balanceSealedTransaction': {
      const stage = method === 'balanceSealedTransaction' ? 'sealed' : 'unsealed';
      const payFees = optionPayFees(args[1]);
      if (typeof args[0] !== 'string') throw apiError('InvalidRequest', 'The transaction must be a hex string');
      return approveBuilt('transaction', origin, network, { tx: args[0], stage, payFees }, 'prepareBalance', { tx: args[0], stage, payFees });
    }
    case 'makeTransfer': {
      const payFees = optionPayFees(args[1]);
      return approveBuilt('transfer', origin, network, { outputs: [], payFees }, 'prepareTransfer', { outputs: args[0], payFees });
    }
    case 'makeIntent': {
      const options = args[2];
      if (!options || typeof options !== 'object') throw apiError('InvalidRequest', 'makeIntent needs options { intentId, payFees }');
      // Checked here too, so a request the wallet would refuse opens no window.
      if (options.intentId !== 1 && options.intentId !== 'random') {
        throw apiError('InvalidRequest', 'This wallet creates swap intents in segment 1: use intentId 1 or "random"');
      }
      if (typeof options.payFees !== 'boolean') throw apiError('InvalidRequest', 'makeIntent needs payFees: true or false');
      return approveBuilt('intent', origin, network, { inputs: [], outputs: [], payFees: options.payFees }, 'prepareIntent',
        { inputs: args[0], outputs: args[1], intentId: options.intentId, payFees: options.payFees });
    }
    case 'signData': {
      const [data, options] = args;
      if (typeof data !== 'string') throw apiError('InvalidRequest', 'data must be a string');
      if (!options || !['hex', 'base64', 'text'].includes(options.encoding)) throw apiError('InvalidRequest', 'encoding is hex, base64 or text');
      if (options.keyType !== 'unshielded') throw apiError('InvalidRequest', 'keyType must be "unshielded"');
      if (options.encoding === 'hex' && !/^([0-9a-fA-F]{2})*$/.test(data)) throw apiError('InvalidRequest', 'data is not hex');
      if (options.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw apiError('InvalidRequest', 'data is not base64');
      const entry = openApproval('signData', origin, { network, data, encoding: options.encoding },
        () => engine('connector', 'signData', { data, encoding: options.encoding, keyType: options.keyType, origin }));
      const outcome = await entry.decision;
      if (!outcome.approved) throw apiError('Rejected', 'The user declined to sign');
      if (outcome.error) throw outcome.error;
      return outcome.result;
    }
    default:
      throw apiError('InvalidRequest', `Unknown method ${method}`);
  }
}

async function dappRequest(port, message) {
  const sender = port.sender;
  const origin = sender.origin ?? new URL(sender.url).origin;
  const session = await sessionOf(sender.documentId ?? `${sender.tab.id}:${sender.frameId}`, origin, sender.tab.id,
    sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId });
  if (message.op === 'connect') return connect(session, origin, message.networkId, message.options);
  if (message.op === 'addNetwork') return addNetwork(origin, message.definition);
  if (message.op === 'call') return call(session, origin, message);
  if (message.op === 'blob') {
    // Only a connected page may upload, so an unconnected site cannot fill
    // the engine's memory.
    const connected = await Promise.all(Object.values(session.connections).map(c => liveNetwork(c, origin)));
    if (!connected.some(Boolean)) throw apiError('Disconnected', 'Connect before uploading');
    const { blobId, offset, size, data } = message;
    return engine('connector', 'blobPut', { origin, blobId, offset, size, data });
  }
  throw apiError('InvalidRequest', 'Malformed request');
}

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  const ok = port.name === 'mdwa-connector' && sender?.id === chrome.runtime.id && sender.tab
    && /^https?:\/\//.test(sender.origin ?? sender.url ?? '');
  if (!ok) { port.disconnect(); return; }
  port.onMessage.addListener(message => {
    if (message?.op === 'ping') return;
    const id = message?.id;
    const reply = body => { try { port.postMessage({ id, ...body }); } catch { /* the page went away */ } };
    dappRequest(port, message ?? {}).then(result => reply({ result: result ?? null }), error => reply({ error: wireError(error) }));
  });
});

// UI methods the background answers itself: dApp permissions live here.
const local = {
  sites: async () => listSites(),
  forgetSite: async ({ origin, network } = {}) => {
    if (typeof origin !== 'string' || !origin) throw new Error('origin is required');
    await forgetSite(origin, network ?? (await engine('ui', 'state')).network);
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // UI messages must come from this extension's own pages, never from a
  // content script running inside a web page.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if ((message?.type === 'ui' || message?.type === 'approval' || message?.type === 'build') && !fromExtensionPage) return false;
  if (message?.type === 'build') { respond(BUILD); return false; }
  if (message?.type === 'ui') {
    const method = String(message.method);
    const run = Object.hasOwn(local, method)
      ? local[method](message.params ?? {})
      : (async () => {
        const ended = await approvalsEndedBy(method, message.params ?? {});
        const request = () => engine('ui', method, message.params ?? {});
        const result = await (CHANGES_NETWORK.has(method) ? changingNetwork(request) : request());
        for (const network of ended) await forgetNetwork(network);
        return result;
      })();
    run.then(
      result => respond({ result }),
      error => respond({ error: { message: error.message, code: error.code ?? null, locked: !!error.locked } }),
    );
    return true;
  }
  if (message?.type === 'approval') {
    const entry = approvals.get(String(message.id));
    if (!entry) { respond({ error: { message: 'This request is no longer pending' } }); return false; }
    if (message.action === 'get') { respond({ result: { kind: entry.kind, origin: entry.origin, params: entry.params } }); return false; }
    if (message.action === 'unlocked') {
      for (const wake of entry.unlockWaiters.splice(0)) wake();
      respond({ result: true });
      return false;
    }
    if (message.action === 'decide') {
      decide(entry.id, !!message.approved, typeof message.choice === 'string' ? message.choice : null).then(result => respond({ result }), error => respond({ error: { message: error.message } }));
      return true;
    }
    return false;
  }
  return false;
});

// Start the engine whenever the browser or extension starts, so the popup
// finds it ready (the wallet itself stays locked until the password).
chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); });
