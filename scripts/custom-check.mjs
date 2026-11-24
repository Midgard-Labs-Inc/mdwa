#!/usr/bin/env node
// Checks the engine's code for networks the user defines (wallet/networks.mjs,
// extension/src/custom.js) under Node against an in-process stub of an
// indexer and an HTTP submit endpoint. It needs no network and no browser.
//
//   node scripts/custom-check.mjs
//
// Covered: definitions (a node or a submit URL, with or without DUST), their
// validation and the page policy check; when a built-in network can connect
// and where its Blockfrost project id goes; how narrowly its DUST sync looks
// up spends; the chain-identity check; the start-up capability check
// per DUST switch; the HTTP submission outcomes as the facade classifies them;
// the stand-in DUST wallet against the SDK's interface and the facade's
// "synced".
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FacadeState, MidnightBech32m, ProtocolVersion, UnshieldedAddress, WalletSeeds } from '@midnightntwrk/wallet-sdk';
import { classifySubmissionFailure } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import * as ledger from '@midnightntwrk/ledger-v9';
import { checkedEndpoints, connectionUrls, defaultEndpoints, dustAnonymityLevel, network, policyBlocks, publicEndpoints } from '../wallet/networks.mjs';
import * as custom from '../extension/src/custom.js';
import { missingQueries } from '../extension/src/birthday.js';
import { sdkConfiguration, syncOf } from '../extension/src/midnight.js';
import { compactAddress, shortAddress } from '../extension/src/ui/format.js';

let checks = 0;
const ok = async (label, fn) => { await fn(); checks++; console.log(`ok  ${label}`); };

// ------------------------------------------------------------- the stub ---
const stub = { genesis: 'ab'.repeat(32), submit: null };
const SERVED = { Query: ['block', 'transactions'], Subscription: ['blocks', 'unshieldedTransactions', 'zswapLedgerEvents'] };
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/graphql') {
    const { query } = JSON.parse(Buffer.concat(chunks));
    if (query.includes('__type')) return json(200, { data: { q: { fields: SERVED.Query.map(name => ({ name })) }, s: { fields: SERVED.Subscription.map(name => ({ name })) } } });
    return json(200, { data: { block: stub.genesis ? { hash: stub.genesis } : null } });
  }
  if (req.url === '/submit') {
    assert.equal(req.headers['content-type'], 'application/octet-stream');
    return json(...stub.submit);
  }
  json(404, {});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------- definitions ---
const indexer = { indexerHttp: `${base}/graphql`, indexerWs: `${base.replace('http', 'ws')}/graphql/ws` };
const user = {
  'user-000000000001': { name: 'Local', networkId: 'undeployed', ...indexer, node: 'ws://localhost:9944', dust: true, genesisHash: 'ab'.repeat(32) },
  'user-000000000002': { name: 'Dev', networkId: 'dev-1', ...indexer, submitUrl: `${base}/submit`, dust: false, genesisHash: 'ab'.repeat(32) },
};
const withNode = network('user-000000000001', user);
const withSubmit = network('user-000000000002', user);

await ok('a user network with a submit URL has no node, and reports the submit URL to sites', () => {
  assert.equal(withSubmit.dust, false);
  const urls = connectionUrls(withSubmit, {});
  assert.equal(urls.submitUrl, `${base}/submit`);
  assert.equal('node' in urls, false);
  assert.equal(publicEndpoints(withSubmit, {}).node, `${base}/submit`);
});
await ok('a built-in network needs all three addresses, and a project id only where one is on Blockfrost, which alone gets it', () => {
  const mainnet = network('mainnet'), preprod = network('preprod');
  const own = { node: 'wss://node.example', indexerHttp: 'https://indexer.example/graphql', indexerWs: 'wss://indexer.example/graphql/ws' };
  assert.throws(() => connectionUrls(mainnet, {}), e => e.permanent && /^Mainnet needs a node and an indexer/.test(e.message));
  assert.equal(checkedEndpoints(mainnet, {}).node, undefined);
  assert.throws(() => checkedEndpoints(mainnet, { node: own.node }), /indexerHttp is not a URL/);
  assert.throws(() => connectionUrls(preprod, {}), e => e.permanent && /project id, or use your own node and indexer/.test(e.message));
  assert.deepEqual(connectionUrls(preprod, { ...own, projectId: 'id' }), { ...own, prover: { kind: 'wasm', url: 'http://localhost:6300' } });
  const mixed = connectionUrls(mainnet, { ...own, node: 'wss://rpc.midnight-mainnet.blockfrost.io', projectId: 'id' });
  assert.deepEqual([mixed.node, mixed.indexerHttp], ['wss://rpc.midnight-mainnet.blockfrost.io/?project_id=id', own.indexerHttp]);
});
await ok('DUST spend lookups narrow (anonymity level 0) only on a built-in network read through the user\'s own indexer', () => {
  const preview = network('preview'), preprod = network('preprod');
  const own = { node: 'wss://node.example', indexerHttp: 'https://indexer.example/graphql', indexerWs: 'wss://indexer.example/graphql/ws' };
  assert.equal(dustAnonymityLevel(preview, {}), undefined);
  assert.equal(dustAnonymityLevel(preview, { ...defaultEndpoints(preview), indexerHttp: `${preview.indexerHttp}/` }), undefined);
  assert.equal(dustAnonymityLevel(preprod, { projectId: 'id' }), undefined);
  assert.equal(dustAnonymityLevel(preview, own), 0);
  assert.equal(dustAnonymityLevel(preprod, { ...defaultEndpoints(preprod), indexerHttp: own.indexerHttp, indexerWs: own.indexerWs }), 0);
  assert.equal(dustAnonymityLevel(network('mainnet'), own), 0);
  assert.equal(dustAnonymityLevel(preprod, { ...defaultEndpoints(preprod), node: own.node }), undefined);
  assert.equal(dustAnonymityLevel(preview, { ...own, indexerWs: preview.indexerWs }), undefined);
  assert.equal(dustAnonymityLevel(network('mainnet'), { ...own, indexerHttp: 'https://midnight-mainnet.blockfrost.io/api/v0', indexerWs: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws' }), undefined);
  assert.equal(dustAnonymityLevel({ ...preview, dust: false }, own), undefined);
  // A user network, typed in or offered by a site (the stored definition is the same), keeps the default.
  assert.equal(dustAnonymityLevel(withNode, {}), undefined);
  assert.equal(dustAnonymityLevel(withSubmit, {}), undefined);
  assert.equal(sdkConfiguration(preview, {}).anonymityLevel, undefined);
  assert.equal(sdkConfiguration(preview, own).anonymityLevel, 0);
});
await ok('an unknown network key is refused, an inherited object property included', () => {
  assert.throws(() => network('nowhere', user), /Unknown network/);
  assert.throws(() => network('toString', user), /Unknown network/);
});
await ok('the page policy allows https, wss and localhost http only', () => {
  for (const url of ['https://chain.example', 'wss://chain.example/ws', 'http://localhost:8080', 'ws://127.0.0.1:9944']) assert.equal(policyBlocks(url), null);
  for (const url of ['http://192.168.1.5:8080', 'ws://chain.example', 'http://[::1]:8080']) assert.match(policyBlocks(url), /would be blocked/);
});
await ok('network ids follow the SDK address codec, and show in short forms', () => {
  custom.checkNetworkId('dev-1');
  custom.checkNetworkId('mainnet');
  assert.throws(() => custom.checkNetworkId('bad_id'), /disallowed characters/);
  assert.throws(() => custom.checkNetworkId(''), /required/);
  const address = MidnightBech32m.encode('dev-1', new UnshieldedAddress(Buffer.alloc(32, 7))).asString();
  assert.equal(compactAddress(address), `mn_addr…${address.slice(-6)}`);
  assert.equal(shortAddress(address), `${address.slice(0, 'mn_addr_dev-11'.length + 4)}…${address.slice(-6)}`);
});

await ok('the add form\'s fields become a definition, with the chain\'s first block', async () => {
  const fields = { name: ' Dev ', networkId: 'dev-1', ...indexer, submitUrl: `${base}/submit`, dust: false };
  assert.deepEqual(await custom.defineNetwork(fields), { name: 'Dev', networkId: 'dev-1', ...indexer, submitUrl: `${base}/submit`, dust: false, genesisHash: 'ab'.repeat(32) });
  const viaNode = await custom.defineNetwork({ name: 'Local', networkId: 'undeployed', ...indexer, node: 'ws://localhost:9944', dust: true });
  assert.deepEqual([viaNode.node, viaNode.dust, 'submitUrl' in viaNode], ['ws://localhost:9944', true, false]);
  const edited = await custom.defineNetwork({ ...fields, networkId: 'other' }, withSubmit);
  assert.equal(edited.networkId, 'dev-1');
});
for (const [label, change, pattern] of [
  ['an empty name', { name: '' }, /name is 1 to 32/],
  ['a bad network id', { networkId: 'bad_id' }, /disallowed characters/],
  ['an indexer the policy blocks', { indexerHttp: 'http://192.168.1.5/graphql' }, /would be blocked/],
  ['a submit URL that is not http', { submitUrl: 'ws://localhost:8080/submit' }, /wrong scheme/],
  ['a node that is not a WebSocket', { submitUrl: undefined, node: 'http://localhost:9944' }, /wrong scheme/],
]) {
  const fields = { name: 'Dev', networkId: 'dev-1', ...indexer, submitUrl: `${base}/submit`, dust: false, ...change };
  if (fields.submitUrl === undefined) delete fields.submitUrl;
  await ok(`a definition is refused: ${label}`, () => assert.rejects(custom.defineNetwork(fields), pattern));
}

// ------------------------------------------------------------- identity ---
await ok('the first block identifies the chain: the same one passes', async () => {
  assert.equal(await custom.genesisHash(indexer.indexerHttp), 'ab'.repeat(32));
  await custom.checkChain(withNode, indexer.indexerHttp);
});
await ok('another chain behind the same URLs is refused for good', async () => {
  stub.genesis = 'cd'.repeat(32);
  const error = await custom.checkChain(withNode, indexer.indexerHttp).then(() => null, e => e);
  assert.match(error.message, /serves another chain/);
  assert.equal(error.permanent, true);
  await assert.rejects(custom.defineNetwork({ name: 'Dev', ...indexer, submitUrl: `${base}/submit`, dust: false }, withSubmit), /another chain/);
  stub.genesis = null;
  await assert.rejects(custom.genesisHash(indexer.indexerHttp), /no first block/);
});
await ok('the capability check asks for DUST queries only with DUST', async () => {
  assert.deepEqual(await missingQueries(indexer.indexerHttp, { dust: false }), []);
  assert.deepEqual(await missingQueries(indexer.indexerHttp),
    ['Query.dustCommitmentMerkleTreeUpdate', 'Subscription.dustGenerations', 'Subscription.dustNullifierTransactions']);
});

// ----------------------------------------------------------- submission ---
const service = custom.submissionService(`${base}/submit`);
const tx = { serialize: () => new Uint8Array([0x6d, 1, 2, 3]) };
const receipt = (status, status_name, extra = {}) => [200, { status, status_name, height: 9, worker_rejected: false, hash: 'ef'.repeat(32), ...extra }];
const outcome = async answer => {
  stub.submit = answer;
  return service.submitTransaction(tx, 'Finalized').then(r => r._tag, e => classifySubmissionFailure(e)._tag);
};
for (const [label, answer, expected] of [
  ['status 0 resolves', receipt(0, 'success'), 'Submitted'],
  ['status 1 (partial success) resolves', receipt(1, 'partial_success'), 'Submitted'],
  ['a receipt that failed in its block frees the coins', receipt(0x105, 'balance_check_failure'), 'NotIncluded'],
  ['a refused receipt frees the coins', receipt(0x8005, 'decode', { height: 0, worker_rejected: true }), 'NotIncluded'],
  ['400 frees the coins', [400, { error: 'invalid_transaction' }], 'NotIncluded'],
  ['503 submission_disabled frees the coins', [503, { error: 'submission_disabled' }], 'NotIncluded'],
  ['502 outcome_unknown keeps them booked', [502, { error: 'outcome_unknown' }], 'Undetermined'],
  ['a panicked receipt keeps them booked', receipt(0xffff, 'panicked'), 'Undetermined'],
]) await ok(`submission: ${label}`, async () => assert.equal(await outcome(answer), expected));
await ok('submission: a failed receipt names its status; no answer keeps the coins booked', async () => {
  stub.submit = receipt(0x105, 'balance_check_failure');
  await assert.rejects(service.submitTransaction(tx), /balance_check_failure/);
  const lost = await custom.submissionService('http://127.0.0.1:9/submit').submitTransaction(tx).then(() => null, e => e);
  assert.equal(classifySubmissionFailure(lost)._tag, 'Undetermined');
});

// ----------------------------------------------------------------- DUST ---
await ok('the stand-in DUST wallet has every member of the SDK interface, asks nothing, and is synced', async () => {
  const sdkTypes = readFileSync(fileURLToPath(import.meta.resolve('@midnightntwrk/wallet-sdk-dust-wallet')).replace(/index\.js$/, 'DustWalletAPI.d.ts'), 'utf8');
  const api = sdkTypes.slice(sdkTypes.indexOf('export type DustWalletAPI'), sdkTypes.indexOf('export type DustGenerationRates'));
  const members = [...api.matchAll(/^ {4}(?:readonly )?(\w+)[(:<]/gm)].map(m => m[1]);
  assert.ok(members.length >= 18, `read ${members.length} members`);
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches++; return realFetch(...args); };
  const dustSeed = WalletSeeds.fromMasterSeed(new Uint8Array(64).fill(7)).dust;
  const wallet = custom.noDustWallet({ forks: { v9: ProtocolVersion.V9NativeForkVersion } }, dustSeed);
  for (const m of members) assert.equal(typeof wallet[m], m === 'state' ? 'object' : 'function', m);
  await wallet.start({}); await wallet.stepSync({}); await wallet.revertTransaction(tx);
  assert.equal(await wallet.calculateFee([]), 0n);
  assert.equal(await wallet.estimateFee([]), 0n);
  await assert.rejects(wallet.balanceTransactions([], new Date()), /no DUST/);
  await assert.rejects(wallet.createDustGenerationTransaction(undefined, new Date(), [], null, undefined), /no DUST/);
  const state = await wallet.waitForSyncedState();
  assert.equal(state.protocolVersion, ProtocolVersion.V9NativeForkVersion);
  assert.equal(state.balance(new Date()), 0n);
  assert.deepEqual([state.totalCoins, state.availableCoins, state.pendingCoins], [[], [], []]);
  assert.equal(state.publicKey, ledger.DustSecretKey.fromSeed(dustSeed).publicKey);
  await wallet.stop();
  globalThis.fetch = realFetch;
  assert.equal(fetches, 0);

  const complete = { isConnected: true, isStrictlyComplete: () => true, appliedIndex: 5n, highestRelevantWalletIndex: 5n, appliedId: 5n, highestTransactionId: 5n };
  const version = ProtocolVersion.V9NativeForkVersion;
  const synced = new FacadeState({ progress: complete, protocolVersion: version }, { progress: complete, protocolVersion: version }, state, { records: [] }, version);
  assert.equal(synced.isSynced, true);
  assert.deepEqual(syncOf(synced, { dust: false }), { status: 'synced', percent: 100, parts: { shielded: { percent: 100 }, unshielded: { percent: 100 } } });
  const behind = new FacadeState({ progress: { ...complete, isStrictlyComplete: () => false } }, { progress: complete }, state, { records: [] });
  assert.equal(behind.isSynced, false);
});

server.close();
console.log(`\n${checks} checks passed`);
