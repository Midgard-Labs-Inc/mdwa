// The test dApp for mdwa's dApp connector (DApp Connector API 4.1.0): a
// button per connector method, each showing its result or error, plus a
// real contract round trip with Midnight.js 5 (deploy the counter contract
// in dapp/contract, then call its `increment` circuit, or `deposit`, which
// also takes NIGHT from the wallet), proven by the wallet through
// getProvingProvider and balanced through balanceUnsealedTransaction.
//
// Midnight.js runs its own ledger copy in this page; only hex strings and
// bytes cross the connector, never a ledger object. Every action is also on
// window.dapp, so scripts/connector-check.mjs can drive the page.
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/v9';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import {
  dappConnectorNetwork, dappConnectorProofProvider, dappConnectorWalletProviders,
} from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Contract, ledger as counterLedger } from './contract/managed/contract/index.js';

const NIGHT = '0'.repeat(64);
const $ = id => document.getElementById(id);
const hexOf = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = text => Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));

// --------------------------------------------------------------- output ---
const show = value => JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Uint8Array) return `<${v.length} bytes> ${hexOf(v.subarray(0, 24))}${v.length > 24 ? '…' : ''}`;
  if (v instanceof Error) return { name: v.name, type: v.type, code: v.code, reason: v.reason, message: v.message };
  return v;
}, 2);
function log(label, value, failed = false) {
  const entry = document.createElement('pre');
  entry.className = failed ? 'err' : 'ok';
  entry.textContent = `${new Date().toLocaleTimeString()}  ${label}\n${typeof value === 'string' ? value : show(value)}`;
  $('log').prepend(entry);
}
/** Runs an action, logs and returns { ok, value } or { ok: false, error }. */
async function run(label, fn) {
  const started = performance.now();
  try {
    const value = await fn();
    log(`${label} (${Math.round(performance.now() - started)} ms)`, value ?? '(no value)');
    return { ok: true, value: JSON.parse(show(value ?? null)), ms: Math.round(performance.now() - started) };
  } catch (error) {
    log(`${label} failed`, error, true);
    console.error(label, error);
    return { ok: false, error: { name: error?.name, type: error?.type, code: error?.code, reason: error?.reason, message: String(error?.message ?? error) } };
  }
}

// --------------------------------------------------------------- wallet ---
const wallets = () => Object.entries(window.midnight ?? {});
let api = null;
let lastTx = null;
// The last preimage Midnight.js had the wallet prove, so the key transport
// test can send a real one with an oversized key.
let lastPreimage = null;
const wallet = () => {
  const found = wallets().find(([, w]) => w?.rdns === 'wallet.mdwa');
  if (!found) throw new Error('mdwa is not installed in this page');
  return found[1];
};

function inspect() {
  const root = Object.getOwnPropertyDescriptor(window, 'midnight');
  return {
    windowMidnight: root ? { writable: root.writable, configurable: root.configurable } : null,
    entries: wallets().map(([key, w]) => {
      const d = Object.getOwnPropertyDescriptor(window.midnight, key);
      return {
        key, uuidV4: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key),
        rdns: w.rdns, name: w.name, apiVersion: w.apiVersion, iconIsDataUrl: String(w.icon).startsWith('data:image/'),
        frozen: Object.isFrozen(w), writable: d.writable, configurable: d.configurable,
      };
    }),
  };
}

const networkId = () => $('network').value.trim();
const myAddresses = async () => ({ ...(await api.getUnshieldedAddress()), ...(await api.getShieldedAddresses()) });

const actions = {
  inspect: async () => inspect(),
  // With an endpoint, connect names one of several networks with this id; a
  // wallet on another network switches (see "Beyond the standard API").
  connect: async (id = networkId(), endpoint = $('endpoint').value.trim()) => {
    api = await wallet().connect(id, endpoint ? { endpoint } : undefined);
    counter.providers = null;
    $('icon').src = wallet().icon;
    return { frozen: Object.isFrozen(api), methods: Object.keys(api), status: await api.getConnectionStatus() };
  },
  addNetwork: async definition => wallet().addNetwork(definition ?? JSON.parse($('definition').value)),
  watchToken: async request => api.watchToken(request ?? JSON.parse($('token').value)),
  // A network id no wallet has: mdwa answers "No network …" (any other id it
  // has, it switches to).
  connectWrongNetwork: async () => wallet().connect('no-such-network'),
  getConnectionStatus: () => api.getConnectionStatus(),
  getConfiguration: () => api.getConfiguration(),
  getShieldedAddresses: () => api.getShieldedAddresses(),
  getUnshieldedAddress: () => api.getUnshieldedAddress(),
  getDustAddress: () => api.getDustAddress(),
  getUnshieldedBalances: () => api.getUnshieldedBalances(),
  getShieldedBalances: () => api.getShieldedBalances(),
  getDustBalance: () => api.getDustBalance(),
  getTxHistory: () => api.getTxHistory(0, 10),
  hintUsage: () => api.hintUsage(['getShieldedBalances', 'getDustBalance', 'getTxHistory', 'getUnshieldedAddress']),

  // Signs a text, then checks the signature two ways: with the ledger's own
  // verifier, and independently as BIP-340 Schnorr over SHA-256 of the
  // prefixed message (the ledger's schnorr hashes the message first).
  signData: async () => {
    const text = $('message').value;
    const signature = await api.signData(text, { encoding: 'text', keyType: 'unshielded' });
    const body = new TextEncoder().encode(text);
    const signed = new Uint8Array([...new TextEncoder().encode(`midnight_signed_message:${body.length}:`), ...body]);
    const kind = signature.scheme === 'ecdsa_secp256k1_sha256' ? 'ecdsa' : 'schnorr';
    return {
      signature,
      ledgerVerifiesPrefixed: ledger.verifySignature({ tag: kind, value: signature.verifyingKey }, signed, { tag: kind, value: signature.signature }),
      ledgerVerifiesUnprefixed: ledger.verifySignature({ tag: kind, value: signature.verifyingKey }, body, { tag: kind, value: signature.signature }),
      bip340OverSha256: kind === 'schnorr' && schnorr.verify(fromHex(signature.signature), sha256(signed), fromHex(signature.verifyingKey)),
    };
  },

  makeTransfer: async () => {
    const { unshieldedAddress } = await myAddresses();
    const recipient = $('recipient').value.trim() || unshieldedAddress;
    const { tx } = await api.makeTransfer([{ kind: 'unshielded', type: NIGHT, value: BigInt($('amount').value), recipient }]);
    lastTx = tx;
    return { txBytes: tx.length / 2 };
  },
  // A transfer whose fee the wallet leaves unpaid (payFees: false), as a dApp
  // with its own fee sponsor would ask; balanceSealedTransaction then pays it.
  makeTransferWithoutFee: async () => {
    const { unshieldedAddress } = await myAddresses();
    const recipient = $('recipient').value.trim() || unshieldedAddress;
    const { tx } = await api.makeTransfer([{ kind: 'unshielded', type: NIGHT, value: BigInt($('amount').value), recipient }], { payFees: false });
    lastTx = tx;
    const parsed = ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(tx));
    return { txBytes: tx.length / 2, dustSpends: [...(parsed.intents?.values() ?? [])].reduce((a, i) => a + (i.dustActions?.spends.length ?? 0), 0) };
  },
  makeShieldedTransfer: async () => {
    const balances = await api.getShieldedBalances();
    const type = Object.keys(balances).find(t => balances[t] > 0n);
    if (!type) throw new Error('No shielded tokens to send');
    const { shieldedAddress } = await myAddresses();
    const { tx } = await api.makeTransfer([{ kind: 'shielded', type, value: 1n, recipient: shieldedAddress }]);
    lastTx = tx;
    return { type, txBytes: tx.length / 2 };
  },
  submitTransaction: async () => {
    if (!lastTx) throw new Error('Make a transaction first');
    await api.submitTransaction(lastTx);
    const id = ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(lastTx)).identifiers()[0];
    lastTx = null;
    return { submitted: id };
  },
  makeIntent: async () => {
    const { shieldedAddress } = await myAddresses();
    const balances = await api.getShieldedBalances().catch(() => ({}));
    const wanted = Object.keys(balances)[0] ?? NIGHT;
    const { tx } = await api.makeIntent(
      [{ kind: 'unshielded', type: NIGHT, value: 1_000_000n }],
      [{ kind: 'shielded', type: wanted, value: 1n, recipient: shieldedAddress }],
      { intentId: 'random', payFees: false },
    );
    lastTx = null;
    const parsed = ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(tx));
    return { txBytes: tx.length / 2, segments: [...(parsed.intents?.keys() ?? [])], imbalances: [...parsed.imbalances(1)].map(([t, v]) => [t, v]) };
  },
  makeIntentBadSegment: () => api.makeIntent([{ kind: 'unshielded', type: NIGHT, value: 1n }], [], { intentId: 5, payFees: false }),
  balanceSealedTransaction: async () => {
    if (!lastTx) throw new Error('Make a transfer first (its sealed transaction is balanced again)');
    const { tx } = await api.balanceSealedTransaction(lastTx);
    lastTx = tx;
    const parsed = ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(tx));
    return { txBytes: tx.length / 2, segments: [...(parsed.intents?.keys() ?? [])], dustSpends: [...(parsed.intents?.values() ?? [])].reduce((a, i) => a + (i.dustActions?.spends.length ?? 0), 0) };
  },

  // Pushes a prover key of `megabytes` MB of zeros through the wallet's key
  // transport and on to the prover: the upload reaches the wallet (twice: the
  // second time the wallet already holds it and nothing is sent), then the
  // prover refuses the key. The preimage is the last one the counter's calls
  // proved, when there was one, so the proof server is sent the whole key.
  // Run it with the wallet proving on a proof server: with a real preimage
  // the in-process prover's check passes, and the SDK answers the prove that
  // then fails only at its 10-minute deadline.
  bigKey: async megabytes => {
    const size = Number(megabytes ?? $('megabytes').value) * 1024 * 1024;
    const big = new Uint8Array(size);
    big[0] = 1;
    const reads = { count: 0 };
    const material = {
      getZKIR: async () => { reads.count++; return new Uint8Array(64); },
      getProverKey: async () => big,
      getVerifierKey: async () => new Uint8Array(32),
    };
    const preimage = lastPreimage ?? new Uint8Array(16);
    const attempt = async provider => {
      const t = performance.now();
      const result = await provider.prove(preimage, 'test/big-key').then(p => `proved (${p.length} bytes)`, e => `${e.code}: ${e.reason}`);
      return { ms: Math.round(performance.now() - t), result };
    };
    const first = await attempt(await api.getProvingProvider(material));
    // A second provider for the same key: the page reads the material again
    // (to hash it), and the wallet answers that it already holds it.
    const second = await attempt(await api.getProvingProvider(material));
    return { bytes: size, realPreimage: !!lastPreimage, materialReads: reads.count, first, second };
  },

  // A proof the wallet must refuse: the counter's real key material with a
  // preimage that is not one. Times how long the wallet takes to say no
  // (a prover that waits for a deadline instead holds every other proof).
  badProof: async () => {
    const keys = new FetchZkConfigProvider(`${window.location.origin}/managed`, { fetchFunc: fetch.bind(window) });
    const provider = await api.getProvingProvider(keys);
    const garbage = crypto.getRandomValues(new Uint8Array(64));
    const attempt = async (name, fn) => {
      const t = performance.now();
      const result = await fn().then(r => `${name} answered (${r.length})`, e => `${e.code}: ${e.reason}`);
      return { ms: Math.round(performance.now() - t), result };
    };
    return {
      check: await attempt('check', () => provider.check(garbage, 'increment')),
      prove: await attempt('prove', () => provider.prove(garbage, 'increment')),
    };
  },

  deploy: async () => {
    const providers = await counterProviders();
    const deployed = await deployContract(providers, { compiledContract: counterContract(), args: [] });
    counter.address = deployed.deployTxData.public.contractAddress;
    $('contract').value = counter.address;
    return { address: counter.address, txId: deployed.deployTxData.public.txId, round: await readRound() };
  },
  increment: async () => {
    const providers = await counterProviders();
    const address = $('contract').value.trim() || counter.address;
    const found = await findDeployedContract(providers, { contractAddress: address, compiledContract: counterContract() });
    const before = await readRound();
    const result = await found.callTx.increment();
    return { txId: result.public.txId, before, after: await readRound() };
  },
  deposit: async () => {
    const providers = await counterProviders();
    const address = $('contract').value.trim() || counter.address;
    const found = await findDeployedContract(providers, { contractAddress: address, compiledContract: counterContract() });
    const result = await found.callTx.deposit(BigInt($('deposit').value));
    return { txId: result.public.txId, round: await readRound() };
  },
  readRound: async () => readRound(),
};

// -------------------------------------------------------------- counter ---
const counter = { providers: null, address: null };
const counterContract = () => CompiledContract.make('counter', Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets('./contract/managed'),
);

// What Midnight.js needs, all from the connected wallet: its network and
// services, its proving (getProvingProvider), its balancing and submission.
async function counterProviders() {
  if (counter.providers) return counter.providers;
  if (!api) throw new Error('Connect first');
  const network = await dappConnectorNetwork(api);
  const zkConfigProvider = new FetchZkConfigProvider(`${window.location.origin}/managed`, { fetchFunc: fetch.bind(window) });
  // The wallet's proving provider, with each preimage noted on the way.
  const recording = {
    getProvingProvider: async keys => {
      const provider = await api.getProvingProvider(keys);
      return {
        check: (preimage, location) => provider.check(preimage, location),
        prove: (preimage, location, binding) => { lastPreimage = preimage; return provider.prove(preimage, location, binding); },
      };
    },
  };
  const proofProvider = await dappConnectorProofProvider(recording, zkConfigProvider, ledger.CostModel.initialCostModel());
  const { walletProvider, midnightProvider } = await dappConnectorWalletProviders(api);
  counter.providers = {
    privateStateProvider: memoryPrivateState(),
    zkConfigProvider,
    proofProvider,
    publicDataProvider: indexerPublicDataProvider({ queryURL: network.indexer.queryURL, subscriptionURL: network.indexer.subscriptionURL, webSocket: WebSocket }),
    walletProvider,
    midnightProvider,
    config: { networkId: network.networkId, ttlSeconds: 3600 },
  };
  return counter.providers;
}
async function readRound() {
  const address = $('contract').value.trim() || counter.address;
  if (!address) return null;
  const read = await (await counterProviders()).publicDataProvider.queryContractState(address);
  if (!read) return null;
  return counterLedger(read.contractState.deserialize({ v9: ContractState }).data).round;
}

// Private state kept in memory for this page: the counter has none, but
// deploying stores the contract's maintenance signing key here.
function memoryPrivateState() {
  const states = new Map();
  const keys = new Map();
  return {
    forContract: address => {
      const contractAddress = address.toLowerCase();
      const scoped = () => { if (!states.has(contractAddress)) states.set(contractAddress, new Map()); return states.get(contractAddress); };
      return {
        contractAddress,
        set: async (id, state) => { scoped().set(id, state); },
        get: async id => states.get(contractAddress)?.get(id) ?? null,
        remove: async id => { states.get(contractAddress)?.delete(id); },
        clear: async () => { states.delete(contractAddress); },
        exportPrivateStates: async () => { throw new Error('not supported'); },
        importPrivateStates: async () => { throw new Error('not supported'); },
      };
    },
    clearAll: async () => states.clear(),
    setSigningKey: async (address, key) => { keys.set(address, key); },
    getSigningKey: async address => keys.get(address) ?? null,
    removeSigningKey: async address => { keys.delete(address); },
    clearSigningKeys: async () => keys.clear(),
    exportSigningKeys: async () => { throw new Error('not supported'); },
    importSigningKeys: async () => { throw new Error('not supported'); },
  };
}

// ------------------------------------------------------------------ page ---
window.dapp = Object.fromEntries(Object.entries(actions).map(([name, fn]) => [name, (...args) => run(name, () => fn(...args))]));
for (const button of document.querySelectorAll('button[data-action]')) {
  button.addEventListener('click', () => window.dapp[button.dataset.action]());
}
log('installed wallets', inspect());
