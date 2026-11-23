// Background service worker: routes extension pages' requests to the engine,
// owns the per-origin dApp permissions (chrome.storage.local), the dApp
// connector's routing and approval windows, and the offscreen document's
// lifecycle. The engine (wallet SDK, vault, IndexedDB) lives in the
// offscreen document's worker; this worker never holds seeds.
// Passwords typed into a page pass through here to the engine and are not
// kept.

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

async function decide(id, approved) {
  const entry = approvals.get(id);
  if (!entry) throw new Error('This request is no longer pending');
  if (approved && entry.params?.preparing) throw new Error('The wallet is still preparing this request');
  if (approved && entry.params?.error) throw new Error('This request cannot be approved');
  let outcome = { approved };
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
// - connect(networkId) asks the user once per site and network (the
//   `connect` window) and stores the site under `sites`. A connection is
//   bound to the network it was made on: after the user switches network,
//   removes the wallet or disconnects the site, every call of that
//   connection fails with Disconnected and getConnectionStatus says
//   'disconnected' until the dApp connects again.
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
const PROVER_CALLS = { _proverHasKey: 'proverHasKey', _proverPutKey: 'proverPutKey', _proverCheck: 'proverCheck', _proverProve: 'proverProve' };
const CODES = new Set(['InternalError', 'Rejected', 'InvalidRequest', 'PermissionRejected', 'Disconnected', 'InsufficientFunds']);
const apiError = (code, reason) => Object.assign(new Error(reason), { apiCode: code });
const wireError = error => ({
  type: 'DAppConnectorAPIError',
  code: error?.apiCode ?? (CODES.has(error?.code) ? error.code : 'InternalError'),
  reason: String(error?.message ?? error),
});

// Per page (document): the connections it made and the permissions it was
// refused. Kept in session storage so a restart of this worker forgets
// neither; dropped when the tab closes.
let sessions = null;
async function loadSessions() {
  sessions ??= (await chrome.storage.session.get('dappSessions')).dappSessions ?? {};
  return sessions;
}
const saveSessions = () => chrome.storage.session.set({ dappSessions: sessions });
async function sessionOf(key, origin, tabId) {
  await loadSessions();
  sessions[key] ??= { origin, tabId, rejected: [], connections: {} };
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

async function connect(session, origin, networkId) {
  if (typeof networkId !== 'string' || !networkId) throw apiError('InvalidRequest', 'connect needs a network id');
  const context = await engine('connector', 'connectorContext');
  if (!context.hasWallet) throw apiError('InternalError', `No wallet on ${context.name}: create or restore one in mdwa first`);
  if (networkId !== context.networkId) {
    throw apiError('InvalidRequest', `mdwa is on ${context.name} (${context.networkId}), not ${networkId}: switch network in mdwa to connect`);
  }
  if (!(await siteOf(context.network, origin))) {
    const { approved } = await openApproval('connect', origin, { network: context.network }).decision;
    if (!approved) throw apiError('Rejected', 'The user refused the connection');
    await updateSites(sites => {
      sites[context.network] ??= {};
      sites[context.network][origin] ??= { grantedAt: Date.now(), permissions: [] };
    });
  }
  const connectionId = crypto.randomUUID();
  session.connections[connectionId] = { network: context.network, connectedAt: Date.now() };
  await saveSessions();
  return { connectionId, networkId: context.networkId };
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
  if (!WALLET_METHODS.has(method) && method !== 'hintUsage' && !internal) throw apiError('InvalidRequest', `Unknown method ${method}`);
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
  const session = await sessionOf(sender.documentId ?? `${sender.tab.id}:${sender.frameId}`, origin, sender.tab.id);
  if (message.op === 'connect') return connect(session, origin, message.networkId);
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
        const result = await engine('ui', method, message.params ?? {});
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
      decide(entry.id, !!message.approved).then(result => respond({ result }), error => respond({ error: { message: error.message } }));
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
