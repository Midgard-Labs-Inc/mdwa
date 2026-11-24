// The networks the wallet supports: four built in, and those the user adds.
// Each one has its own wallet (recovery phrase, password, database, dApp
// approvals); nothing is shared.
//
// A network is read through an indexer (HTTP and WebSocket) and takes
// transactions either through a Midnight node (`node`, WebSocket RPC: the
// SDK's own submission) or through an HTTP endpoint (`submitUrl`, see
// extension/src/custom.js). It has DUST unless its definition says
// `dust: false`, in which case nothing pays a fee there.
//
// The built-in endpoints are defaults: every one is editable per network in
// Settings. Blockfrost hosts Mainnet and Preprod and wants a project id,
// which the user types in Settings and which is appended as `?project_id=` to
// all three URLs at connection time only. The id is a credential: it is
// never stored inside a URL and never handed to a dApp (see publicEndpoints).
//
// A network the user adds is stored in the settings (`networks`, by a key of
// its own, see userNetworkKey) with its endpoints in its definition: editing
// the network edits them. Only its prover is a setting, as on the built-in
// ones.
export const NETWORKS = {
  mainnet: {
    name: 'Mainnet', networkId: 'mainnet', blockfrost: true,
    node: 'wss://rpc.midnight-mainnet.blockfrost.io',
    indexerHttp: 'https://midnight-mainnet.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws',
  },
  preprod: {
    name: 'Preprod', networkId: 'preprod', blockfrost: true,
    node: 'wss://rpc.midnight-preprod.blockfrost.io',
    indexerHttp: 'https://midnight-preprod.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
  },
  preview: {
    name: 'Preview', networkId: 'preview',
    node: 'wss://rpc.preview.midnight.network',
    indexerHttp: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
  undeployed: {
    name: 'Undeployed', networkId: 'undeployed',
    node: 'ws://localhost:9944',
    indexerHttp: 'http://localhost:8088/api/v4/graphql',
    indexerWs: 'ws://localhost:8088/api/v4/graphql/ws',
  },
};

export const DEFAULT_NETWORK = 'preview';
export const DEFAULT_PROOF_SERVER = 'http://localhost:6300';

// NIGHT is the unshielded native token: 6 decimals (smallest unit STAR).
// DUST pays fees: 15 decimals (smallest unit SPECK).
export const NIGHT_DECIMALS = 6;
export const DUST_DECIMALS = 15;

/** The definition of network `id`, built in or one of the user's
 *  (`userNetworks`, the settings' `networks`), with its id, `user` and `dust` set. */
export function network(id, userNetworks = {}) {
  const builtIn = Object.hasOwn(NETWORKS, id);
  const n = builtIn ? NETWORKS[id] : Object.hasOwn(userNetworks, id) ? userNetworks[id] : null;
  if (!n) throw new Error(`Unknown network ${id}`);
  return { dust: true, ...n, id, user: !builtIn };
}

/** Every network id: the built-in ones first, then the user's. */
export const networkIds = (userNetworks = {}) => [...Object.keys(NETWORKS), ...Object.keys(userNetworks)];

/** A fresh key for a network the user adds. It never equals a built-in id or
 *  a network id, since two user networks may share a network id (two local
 *  chains are both `undeployed`) and the key names the network's database. */
export const userNetworkKey = () => `user-${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Why the extension cannot reach `url`, or null when it can. The page policy
 * (extension/manifest.json, connect-src) allows any https: and wss: origin,
 * and http: and ws: only on localhost and 127.0.0.1. Hosts a user types
 * cannot be added to it at build time, so an endpoint outside it is refused
 * where it is entered rather than failing at every connection.
 */
export function policyBlocks(url) {
  const u = new URL(url);
  if (u.protocol === 'https:' || u.protocol === 'wss:') return null;
  if ((u.protocol === 'http:' || u.protocol === 'ws:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return null;
  return `The extension may connect to https and wss endpoints, and to http and ws only on localhost and 127.0.0.1: ${u.origin} would be blocked`;
}

/** Where network `n` (a definition) takes transactions: `{ node }` or `{ submitUrl }`. */
const submission = (n, url = key => n[key]) => (n.submitUrl ? { submitUrl: url('submitUrl') } : { node: url('node') });

/** The endpoints network `n` starts with, before the user edits any. */
export function defaultEndpoints(n) {
  return { ...submission(n), indexerHttp: n.indexerHttp, indexerWs: n.indexerWs, projectId: '', prover: { kind: 'wasm', url: DEFAULT_PROOF_SERVER } };
}

/** Stored endpoints merged over the defaults, so a partial record still
 *  works. A user network's endpoints are its definition: only its prover is
 *  read from the stored record. */
export function endpointsOf(n, stored) {
  const d = defaultEndpoints(n);
  const s = (n.user ? { prover: stored?.prover } : stored) ?? {};
  const pick = key => s[key] || d[key];
  return {
    ...submission(n, pick), indexerHttp: pick('indexerHttp'), indexerWs: pick('indexerWs'),
    projectId: (s.projectId ?? '').trim(),
    prover: { kind: s.prover?.kind === 'server' ? 'server' : 'wasm', url: s.prover?.url || d.prover.url },
  };
}

/** Whether `url` is served by Blockfrost, which wants a project id. */
const onBlockfrost = url => /(^|\.)blockfrost\.io$/.test(new URL(url).hostname);

/** The URLs to connect with: the Blockfrost project id goes onto every one.
 *  Throws the message the sync status shows when a Blockfrost network has no
 *  id while one of its endpoints is still on Blockfrost: a network pointed at
 *  the user's own node and indexer needs none. */
export function connectionUrls(n, endpoints) {
  const e = endpointsOf(n, endpoints);
  const needsId = n.blockfrost && [e.node ?? e.submitUrl, e.indexerHttp, e.indexerWs].some(onBlockfrost);
  if (needsId && !e.projectId) throw new Error('Add a Blockfrost project id in Settings');
  const withId = url => {
    if (!e.projectId) return url;
    const u = new URL(url);
    u.searchParams.set('project_id', e.projectId);
    return u.toString();
  };
  return { ...submission(n, key => withId(e[key])), indexerHttp: withId(e.indexerHttp), indexerWs: withId(e.indexerWs), prover: e.prover };
}

/** Network `n`'s endpoints with `entry` applied, checked: each a URL of the
 *  right scheme, and for a user network one the page policy lets the engine
 *  reach (policyBlocks). */
export function checkedEndpoints(n, entry) {
  const e = endpointsOf(n, entry);
  for (const key of [e.submitUrl ? 'submitUrl' : 'node', 'indexerHttp', 'indexerWs']) {
    let u;
    try { u = new URL(e[key]); } catch { throw new Error(`${n.name}: ${key} is not a URL`); }
    const ok = key === 'node' || key === 'indexerWs' ? /^wss?:$/.test(u.protocol) : /^https?:$/.test(u.protocol);
    if (!ok) throw new Error(`${n.name}: ${key} has the wrong scheme (${u.protocol})`);
    const blocked = n.user && policyBlocks(e[key]);
    if (blocked) throw new Error(`${n.name}: ${blocked}`);
  }
  if (e.prover.kind === 'server') {
    try { if (!/^https?:$/.test(new URL(e.prover.url).protocol)) throw new Error(); }
    catch { throw new Error(`${n.name}: the proof server URL must be http or https`); }
  }
  return e;
}

/** Whether two URLs name the same endpoint: the same scheme, host, port and
 *  path, a trailing slash aside (a query, such as a project id, is not part
 *  of it). A string that is not a URL matches nothing. */
export function sameEndpoint(a, b) {
  const key = text => {
    try {
      const u = new URL(String(text).trim());
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch { return null; }
  };
  const k = key(a);
  return k !== null && k === key(b);
}

/** The networks of `list` (`{ networkId, node }`, `node` as a site sees it,
 *  see publicEndpoints) a site's `connect(networkId, { endpoint })` names:
 *  those with that network id, narrowed by `endpoint` when given. */
export const networksMatching = (list, networkId, endpoint = null) => list.filter(n => n.networkId === networkId
  && (endpoint === null || endpoint === undefined || sameEndpoint(n.node, endpoint)));

/** What a dApp may see of the endpoints: the base URLs, never the project id.
 *  A network that takes transactions over HTTP reports its submit URL as the
 *  node, the one string the connector API has for where transactions go. */
export function publicEndpoints(n, endpoints) {
  const e = endpointsOf(n, endpoints);
  return { node: e.node ?? e.submitUrl, indexerHttp: e.indexerHttp, indexerWs: e.indexerWs, prover: e.prover };
}
