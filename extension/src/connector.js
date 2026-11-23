// The engine's side of the dApp connector (DApp Connector API 4.1.0): the
// methods the background calls with engine('connector', method, params) once
// it has checked the site's connection and permissions and, where the user
// must agree, asked them. Nothing here decides who may call what; it turns a
// request into wallet SDK calls and back into JSON (decimal strings for
// amounts, hex for transactions and keys, base64 for raw bytes).
//
// Transactions that need the user's approval are built in two steps so the
// approval window can show what the balanced transaction really does:
// `prepare*` balances (booking the coins it spends), describes the result
// and keeps the recipe as a preview; `complete` signs, proves and binds it,
// and `cancel` reverts it so its coins are free again.
//
// Delegated proving (getProvingProvider) works on key material the page
// uploads once per browser session: large values arrive as chunked "blobs"
// (blobPut), are checked against the SHA-256 digest the page computed, and
// are kept per site in a size-bounded cache. Preimages carry the user's
// private inputs: they are never logged or stored, only handed to the prover.
//
// On a network without DUST nothing pays a fee, whatever a site asks.
import { firstValueFrom, filter, timeout } from 'rxjs';
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, isInsufficientDustForFeeError } from '@midnightntwrk/wallet-sdk';
import { publicEndpoints } from '../../wallet/networks.mjs';
import * as midnight from './midnight.js';

const TTL_MS = 60 * 60 * 1000;
const SYNC_WAIT_MS = 3 * 60 * 1000;
const BLOB_MAX_BYTES = 512 * 2 ** 20;
const BLOB_LIFETIME_MS = 5 * 60 * 1000;
const KEY_CACHE_BYTES = 384 * 2 ** 20;

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));
const isHex = text => typeof text === 'string' && /^([0-9a-fA-F]{2})+$/.test(text);
const fail = (code, message) => Object.assign(new Error(message), { code });

function fromBase64(text) {
  if (typeof text !== 'string') throw fail('InvalidRequest', 'Expected base64 bytes');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
/** The digest a key material set is cached under: SHA-256 over the SHA-256
 *  of the ZKIR, the prover key and the verifier key, in that order. The page
 *  computes the same (inject.js), so it can ask whether the wallet already
 *  holds a key without sending it. */
async function keyDigest({ ir, proverKey, verifierKey }) {
  const parts = await Promise.all([ir, proverKey, verifierKey].map(sha256));
  const joined = new Uint8Array(96);
  parts.forEach((p, i) => joined.set(p, i * 32));
  return hex(await sha256(joined));
}

// The SDK states shortfalls in several ways; the connector has one code for
// them, which a dApp can show as "insufficient balance".
function classify(error) {
  if (error?.code) return error;
  const text = String(error?.message ?? error);
  if (isInsufficientDustForFeeError(error) || /insufficient|not enough|shortfall/i.test(text)) {
    return Object.assign(error instanceof Error ? error : new Error(text), { code: 'InsufficientFunds' });
  }
  return error;
}
const invalid = fn => {
  try { return fn(); } catch (error) { throw fail('InvalidRequest', String(error?.message ?? error)); }
};

const decimals = record => Object.fromEntries(Object.entries(record ?? {}).map(([type, amount]) => [type, BigInt(amount).toString()]));

/**
 * The connector table. `engine` gives what the engine worker owns:
 * `context()` (the selected network's definition, with `network` its id),
 * `live()`, `storedWallet()`,
 * `endpointsFor(network)`, `withBusy` and `releaseBusy`, `keepPreview`,
 * `takePreview`, `dropPreview`, `noteTransaction`, `txMeta()`, and `state`
 * with `publish()` for the busy indicator.
 *
 * A request a user approves carries the `ticket` of its approval window: it
 * waits its turn when the wallet is busy (withBusy), and the window tells its
 * own work from the work it waits for by that ticket.
 */
export function makeConnector(engine) {
  const { context, live, storedWallet, endpointsFor, withBusy, releaseBusy, keepPreview, takePreview, dropPreview, noteTransaction, txMeta, state, publish } = engine;

  // ------------------------------------------------------------ waiting ---
  // Right after an unlock the wallet takes a moment to start: wait for it
  // rather than failing the site's request.
  async function ready() {
    for (const until = Date.now() + SYNC_WAIT_MS; ;) {
      try { return await live(); } catch (error) {
        if (error.locked || !/still connecting/.test(error.message) || Date.now() > until) throw error;
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // A dApp request may come right after an unlock, while the wallet resumes
  // from its snapshot: wait for sync longer than the popup does.
  async function synced() {
    const { wallet } = await ready();
    const s = await firstValueFrom(wallet.facade.state().pipe(filter(x => x.isSynced), timeout(SYNC_WAIT_MS))).catch(() => {
      throw new Error('The wallet is still syncing: try again when it is synced');
    });
    return { wallet, s };
  }

  // ---------------------------------------------------------- describing ---
  /** What a recipe does, over all its parts: the dApp's transaction and what
   *  the wallet added. Lists are joined, deltas and the fee are summed. */
  function describeRecipe(recipe, s) {
    const parts = midnight.recipeTransactions(recipe).map(tx => midnight.describeLedgerTransaction(tx, s));
    const sumBy = (items, key) => {
      const totals = new Map();
      for (const d of items) {
        const k = `${d.kind}:${d.type}`;
        totals.set(k, { ...d, amount: ((totals.get(k)?.amount ?? 0n) + BigInt(d.amount)) });
      }
      return [...totals.values()].filter(d => d.amount !== 0n).map(d => ({ ...d, amount: d.amount.toString() }));
    };
    const fee = parts.reduce((a, p) => a + BigInt(p.fee), 0n);
    const deltas = sumBy(parts.flatMap(p => p.deltas.filter(d => d.kind !== 'dust')));
    if (fee > 0n) deltas.push({ kind: 'dust', type: 'dust', amount: (-fee).toString() });
    const count = key => parts.reduce((a, p) => a + BigInt(p.shielded[key]), 0n).toString();
    return {
      contractCalls: parts.flatMap(p => p.contractCalls),
      deploys: parts.flatMap(p => p.deploys),
      maintenance: parts.flatMap(p => p.maintenance),
      unshielded: { inputs: parts.flatMap(p => p.unshielded.inputs), outputs: parts.flatMap(p => p.unshielded.outputs) },
      shielded: { inputs: count('inputs'), outputs: count('outputs'), transients: count('transients') },
      dust: { spends: parts.reduce((a, p) => a + p.dust.spends, 0), registrations: parts.reduce((a, p) => a + p.dust.registrations, 0) },
      imbalances: parts.flatMap(p => p.imbalances),
      deltas, fee: fee.toString(), estimatedFee: null,
      parts: parts.length,
    };
  }

  /** Balances or builds under the busy indicator (waiting its turn), keeps
   *  the recipe as a preview and returns its id with the description.
   *  `action` is what the request is: 'balance', 'transfer' or 'offer'. */
  async function prepare(origin, action, ticket, build) {
    return withBusy('dapp', 'balancing', async () => {
      const { wallet, s } = await synced();
      let built;
      try { built = await build(wallet); } catch (error) { throw classify(error); }
      let described;
      try { described = describeRecipe(built.recipe, s); } catch (error) {
        await wallet.facade.revert(built.recipe, 'not describable').catch(() => {});
        throw error;
      }
      const sent = built.shown?.outputs?.map(o => ({ kind: o.kind, type: o.type, amount: o.amount }));
      const id = keepPreview({ kind: 'dapp', network: context().network, wallet, recipe: built.recipe, origin, action, described, fee: described.fee, sent });
      return { id, described, ...(built.shown ?? {}) };
    }, { wait: true, ticket });
  }

  /** What the history says about an approved request: its kind, the site,
   *  the fee and, from the description, what it does on chain. */
  function noteOf(p) {
    const calls = p.described.contractCalls.map(c => ({ address: c.address, entryPoint: c.entryPoint }));
    const deploys = p.described.deploys.map(d => d.address);
    const action = deploys.length ? 'deploy' : calls.length ? 'call' : p.action;
    if (p.action === 'offer') return { kind: 'offer', origin: p.origin, fee: p.fee, deltas: p.described.deltas };
    return {
      kind: 'dapp', action, origin: p.origin, fee: p.fee,
      ...(calls.length ? { calls } : {}), ...(deploys.length ? { deploys } : {}), ...(p.action === 'transfer' && p.sent ? { sent: p.sent } : {}),
    };
  }

  // ------------------------------------------------------------- blobs ---
  // Values too large for one extension message arrive in chunks, each
  // base64, written at its offset. A blob belongs to the site that sent it
  // and is taken (removed) by the request that names it.
  const blobs = new Map();
  function blobPut({ origin, blobId, offset, size, data }) {
    if (typeof blobId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(blobId)) throw fail('InvalidRequest', 'Bad blob id');
    if (!Number.isSafeInteger(size) || size < 0 || size > BLOB_MAX_BYTES) throw fail('InvalidRequest', `A value may be at most ${BLOB_MAX_BYTES} bytes`);
    let blob = blobs.get(blobId);
    if (!blob) {
      blob = { origin, bytes: new Uint8Array(size), received: 0, timer: setTimeout(() => blobs.delete(blobId), BLOB_LIFETIME_MS) };
      blobs.set(blobId, blob);
    }
    if (blob.origin !== origin || blob.bytes.length !== size) throw fail('InvalidRequest', 'Blob mismatch');
    const chunk = fromBase64(data);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + chunk.length > size) throw fail('InvalidRequest', 'Blob chunk out of range');
    blob.bytes.set(chunk, offset);
    blob.received += chunk.length;
    return { received: blob.received };
  }
  function bytesOf(origin, value, name) {
    if (value && typeof value === 'object' && typeof value.$bytes === 'string') return fromBase64(value.$bytes);
    if (value && typeof value === 'object' && typeof value.$blob === 'string') {
      const blob = blobs.get(value.$blob);
      if (!blob || blob.origin !== origin) throw fail('InvalidRequest', `${name}: the upload is missing or expired`);
      if (blob.received < blob.bytes.length) throw fail('InvalidRequest', `${name}: the upload is incomplete`);
      blobs.delete(value.$blob);
      clearTimeout(blob.timer);
      return blob.bytes;
    }
    throw fail('InvalidRequest', `${name} must be bytes`);
  }

  // ---------------------------------------------------------- key cache ---
  // Per site, by key location: the material and its digest. The oldest
  // entries go first when the cache would grow past KEY_CACHE_BYTES.
  const keys = new Map();
  const keyId = (origin, location) => `${origin}\n${location}`;
  function cacheKey(origin, location, digest, material) {
    const size = material.ir.length + material.proverKey.length + material.verifierKey.length;
    keys.delete(keyId(origin, location));
    keys.set(keyId(origin, location), { digest, material, size });
    let total = [...keys.values()].reduce((a, k) => a + k.size, 0);
    for (const [id, k] of keys) {
      if (total <= KEY_CACHE_BYTES || keys.size === 1) break;
      keys.delete(id);
      total -= k.size;
    }
  }
  function cachedKey(origin, location, digest) {
    const entry = keys.get(keyId(origin, location));
    if (!entry || (digest && entry.digest !== digest)) return null;
    // Refresh its place: the most recently used stays longest.
    keys.delete(keyId(origin, location));
    keys.set(keyId(origin, location), entry);
    return entry;
  }

  // Proving shows in state.busy while any dApp proof runs, unless the wallet
  // is already showing its own work there. Holding the busy slot this way
  // keeps the wallet's own transactions from starting meanwhile, and
  // releasing it hands it to whatever request waits next.
  let proving = 0, ownBusy = null;
  async function asProving(fn) {
    proving++;
    if (!state.busy) { ownBusy = { kind: 'dapp', stage: 'proving', startedAt: Date.now() }; state.busy = ownBusy; publish(); }
    try { return await fn(); } finally {
      if (--proving === 0 && ownBusy) {
        if (state.busy === ownBusy) releaseBusy();
        ownBusy = null;
      }
    }
  }
  async function proverFor(origin) {
    const { network } = context();
    const { prover } = await endpointsFor(network);
    const { wallet, s } = await ready();
    return midnight.dappProver(prover, async location => {
      const entry = cachedKey(origin, location, null);
      if (!entry) throw fail('InvalidRequest', `The wallet has no key material for ${location}`);
      return entry.material;
    }, midnight.dappLedgerVersion(wallet, s));
  }
  const preimageOf = (origin, params) => {
    if (typeof params.keyLocation !== 'string' || !params.keyLocation) throw fail('InvalidRequest', 'keyLocation is required');
    if (!params.keyLocation.startsWith('midnight/') && !cachedKey(origin, params.keyLocation, params.digest ?? null)) {
      throw fail('InvalidRequest', `The wallet has no key material for ${params.keyLocation}`);
    }
    return bytesOf(origin, params.preimage, 'preimage');
  };

  const paysFees = payFees => payFees && context().dust;

  // -------------------------------------------------------------- table ---
  return {
    getConfiguration: async () => {
      const n = context();
      const e = publicEndpoints(n, await endpointsFor(n.network));
      return {
        indexerUri: e.indexerHttp, indexerWsUri: e.indexerWs, substrateNodeUri: e.node, networkId: n.networkId,
        // Deprecated in the API, but some dApps still read it: reported while
        // the user proves with a proof server.
        ...(e.prover.kind === 'server' ? { proverServerUri: e.prover.url } : {}),
      };
    },

    getShieldedBalances: async () => decimals((await ready()).s.shielded.balances),
    getUnshieldedBalances: async () => decimals((await ready()).s.unshielded.balances),
    getDustBalance: async () => {
      const { run, s } = await ready();
      return {
        // Right after a fee is paid, the last DUST figure seen until the DUST
        // wallet's next pass learns the change (see midnight.dustBalanceOf).
        balance: midnight.dustBalanceOf(s, run).balance.toString(),
        // The cap of the NIGHT the wallet still holds: DUST whose backing
        // NIGHT is spent only decays.
        cap: s.dust.totalCoins.filter(c => c.dtime === undefined).reduce((a, c) => a + c.maxCap, 0n).toString(),
      };
    },

    // Addresses are derived when the wallet is created and stored with it,
    // so they are answered while the wallet is locked too.
    getShieldedAddresses: async () => {
      const { networkId } = context();
      const a = (await storedWallet()).addresses;
      return {
        shieldedAddress: a.shielded,
        shieldedCoinPublicKey: ShieldedCoinPublicKey.codec.encode(networkId, ShieldedCoinPublicKey.fromHexString(a.coinPublicKey)).asString(),
        shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec.encode(networkId, ShieldedEncryptionPublicKey.fromHexString(a.encryptionPublicKey)).asString(),
      };
    },
    getUnshieldedAddress: async () => ({ unshieldedAddress: (await storedWallet()).addresses.unshielded }),
    getDustAddress: async () => ({ dustAddress: (await storedWallet()).addresses.dust }),

    // The SDK's history has a status per transaction, not per segment: a
    // success is reported for segment 0 (the guaranteed one, which every
    // transaction has), a failure likewise; a partial success says the
    // guaranteed segment succeeded and some fallible one failed, but not
    // which, so only segment 0 is reported. A confirmed transaction has no
    // result yet, so its executionStatus is empty. Pages count from 0.
    // Swap offers are left out: they are transactions this wallet handed to
    // the site and never submitted, so they have no status on chain.
    getTxHistory: async ({ pageNumber, pageSize }) => {
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 0) throw fail('InvalidRequest', 'pageNumber is a whole number from 0');
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw fail('InvalidRequest', 'pageSize is a whole number from 1 to 1000');
      const { wallet, s } = await ready();
      const entries = new Map((await wallet.facade.getAllFromTxHistory()).map(e => [e.hash, e]));
      const items = (await midnight.historyItems(wallet, s, await txMeta())).filter(i => i.status !== 'offered' && i.status !== 'expired');
      const execution = entry => (entry?.status === 'FAILURE' ? { 0: 'Failure' } : { 0: 'Success' });
      return items.slice(pageNumber * pageSize, (pageNumber + 1) * pageSize).map(item => {
        const entry = entries.get(item.hash);
        let txStatus;
        if (item.status === 'pending') txStatus = { status: 'pending' };
        else if (item.status === 'confirmed') txStatus = { status: 'confirmed', executionStatus: {} };
        else if (item.status === 'failed' && entry?.lifecycle?.status === 'rejected') txStatus = { status: 'discarded' };
        else txStatus = { status: 'finalized', executionStatus: execution(entry) };
        return { txHash: item.hash, txStatus };
      });
    },

    // ----------------------------------------------- transactions (step 1) ---
    prepareBalance: async ({ origin, ticket, tx, stage, payFees = true }) => {
      if (!isHex(tx)) throw fail('InvalidRequest', 'The transaction must be a hex string');
      if (typeof payFees !== 'boolean') throw fail('InvalidRequest', 'payFees must be true or false');
      const sealed = stage === 'sealed';
      return prepare(origin, 'balance', ticket, async wallet => {
        const handle = invalid(() => wallet.facade.adoptTransaction(unhex(tx), sealed ? 'Finalized' : 'Unbound'));
        const options = { ttl: new Date(Date.now() + TTL_MS), tokenKindsToBalance: paysFees(payFees) ? 'all' : ['shielded', 'unshielded'] };
        const recipe = sealed
          ? await wallet.facade.balanceFinalizedTransaction(handle, options)
          : await wallet.facade.balanceUnboundTransaction(handle, options);
        return { recipe };
      });
    },
    prepareTransfer: async ({ origin, ticket, outputs, payFees = true }) => {
      if (typeof payFees !== 'boolean') throw fail('InvalidRequest', 'payFees must be true or false');
      const { networkId } = context();
      const list = invalid(() => {
        if (!Array.isArray(outputs) || !outputs.length) throw new Error('desiredOutputs must list at least one output');
        return outputs.map(o => ({ kind: o?.kind, type: o?.type, amount: o?.value, recipient: o?.recipient }));
      });
      invalid(() => midnight.transfersOf(networkId, list));
      return prepare(origin, 'transfer', ticket, async wallet => {
        const built = await midnight.buildTransfer(wallet, list, { payFees: paysFees(payFees) });
        return { recipe: built.recipe, shown: { outputs: built.outputs } };
      });
    },
    // The SDK's initSwap takes no intent id: it puts an unshielded swap in
    // segment 1, so 1 and 'random' are honoured and any other number is
    // refused rather than ignored. Both input kinds are always passed,
    // because initSwap ignores the outputs of a kind whose inputs are absent.
    prepareIntent: async ({ origin, ticket, inputs, outputs, intentId, payFees }) => {
      if (intentId !== 'random' && intentId !== 1) {
        throw fail('InvalidRequest', 'This wallet creates swap intents in segment 1: use intentId 1 or "random"');
      }
      if (typeof payFees !== 'boolean') throw fail('InvalidRequest', 'makeIntent needs payFees: true or false');
      const { networkId } = context();
      const swapInputs = { shielded: {}, unshielded: {} };
      const shownInputs = invalid(() => {
        if (!Array.isArray(inputs) || !Array.isArray(outputs)) throw new Error('desiredInputs and desiredOutputs must be arrays');
        if (!inputs.length && !outputs.length) throw new Error('An intent needs at least one input or output');
        return inputs.map(i => {
          if (i?.kind !== 'shielded' && i?.kind !== 'unshielded') throw new Error('An input kind is shielded or unshielded');
          if (typeof i.type !== 'string' || !/^[0-9a-f]{64}$/i.test(i.type)) throw new Error('A token type is 64 hex characters');
          if (typeof i.value !== 'string' || !/^\d+$/.test(i.value) || BigInt(i.value) <= 0n) throw new Error('Input values are positive amounts');
          const type = i.type.toLowerCase();
          swapInputs[i.kind][type] = (swapInputs[i.kind][type] ?? 0n) + BigInt(i.value);
          return { kind: i.kind, type, amount: i.value };
        });
      });
      const list = outputs.map(o => ({ kind: o?.kind, type: o?.type, amount: o?.value, recipient: o?.recipient }));
      const { transfers, described } = list.length ? invalid(() => midnight.transfersOf(networkId, list)) : { transfers: [], described: [] };
      return prepare(origin, 'offer', ticket, async wallet => {
        const recipe = await wallet.facade.initSwap(swapInputs, transfers, { ttl: new Date(Date.now() + TTL_MS), payFees: paysFees(payFees) });
        return { recipe, shown: { inputs: shownInputs, outputs: described } };
      });
    },

    // ----------------------------------------------- transactions (step 2) ---
    /** Signs, proves and binds an approved preview; returns the sealed hex. */
    complete: async ({ id, origin, ticket }) => {
      const p = takePreview(id, 'dapp');
      if (p.origin !== origin) {
        await p.wallet.facade.revert(p.recipe, 'wrong site').catch(() => {});
        throw fail('InvalidRequest', 'This request belongs to another site');
      }
      return withBusy('dapp', 'proving', async stage => {
        const finalized = await midnight.sealRecipe(p.wallet, p.recipe, { onStage: stage });
        const bytes = finalized.serialize();
        // Noted now, so the history names the site and what the transaction
        // does even if the dApp submits it through another wallet or service.
        const ids = midnight.ledgerTransaction(finalized).identifiers();
        await noteTransaction(p.network, ids, { ...noteOf(p), id: ids[0], ids, size: bytes.length });
        return { tx: hex(bytes) };
      }, { wait: true, ticket });
    },
    cancel: async ({ id }) => { await dropPreview(String(id)); return {}; },

    // Data signing: the request was approved by the background. The message
    // signed is the specification's prefix followed by the decoded bytes, so
    // a signature here can never be a transaction signature. The ledger's
    // schnorr signs the SHA-256 of that message with BIP-340.
    signData: async ({ data, encoding, keyType }) => {
      if (keyType !== 'unshielded') throw fail('InvalidRequest', 'keyType must be "unshielded"');
      const bytes = invalid(() => {
        if (typeof data !== 'string') throw new Error('data must be a string');
        if (encoding === 'text') return new TextEncoder().encode(data);
        if (encoding === 'hex') { if (!/^([0-9a-fA-F]{2})*$/.test(data)) throw new Error('data is not hex'); return unhex(data); }
        if (encoding === 'base64') return fromBase64(data);
        throw new Error('encoding is hex, base64 or text');
      });
      const header = new TextEncoder().encode(`midnight_signed_message:${bytes.length}:`);
      const message = new Uint8Array(header.length + bytes.length);
      message.set(header);
      message.set(bytes, header.length);
      const { wallet } = await ready();
      const signature = wallet.keystore.signData(message);
      const verifyingKey = wallet.keystore.getPublicKey();
      return {
        scheme: signature.tag === 'ecdsa' ? 'ecdsa_secp256k1_sha256' : 'schnorr_bip340',
        data, signature: signature.value, verifyingKey: verifyingKey.value,
      };
    },

    // Relaying: the transaction is already sealed by whoever built it, so the
    // user is not asked. It is noted with the site, for the history: what
    // the wallet noted when it balanced it, or else what the transaction
    // itself says it calls or deploys.
    submitTransaction: async ({ origin, tx }) => {
      if (!isHex(tx)) throw fail('InvalidRequest', 'The transaction must be a hex string');
      const { wallet } = await ready();
      const handle = invalid(() => wallet.facade.adoptTransaction(unhex(tx), 'Finalized'));
      const ledgerTx = midnight.ledgerTransaction(handle);
      const ids = ledgerTx.identifiers();
      const meta = await txMeta();
      const { at, ...known } = ids.map(i => meta[i]).find(Boolean) ?? {};
      let note = known;
      if (!note.kind) {
        const d = midnight.describeLedgerTransaction(ledgerTx, null);
        const calls = d.contractCalls.map(c => ({ address: c.address, entryPoint: c.entryPoint }));
        const deploys = d.deploys.map(x => x.address);
        note = { kind: 'dapp', action: deploys.length ? 'deploy' : calls.length ? 'call' : 'submit', fee: null,
          ...(calls.length ? { calls } : {}), ...(deploys.length ? { deploys } : {}) };
      }
      const txId = await wallet.facade.submitTransaction(handle);
      await noteTransaction(context().network, ids, { ...note, origin });
      return { txId };
    },

    // ------------------------------------------------------ proving ---
    blobPut,
    proverHasKey: async ({ origin, keyLocation, digest }) => ({ cached: !!cachedKey(origin, keyLocation, digest) }),
    proverPutKey: async ({ origin, keyLocation, digest, ir, proverKey, verifierKey }) => {
      if (typeof keyLocation !== 'string' || !keyLocation || keyLocation.startsWith('midnight/')) throw fail('InvalidRequest', 'Bad key location');
      const material = {
        ir: bytesOf(origin, ir, 'ZKIR'), proverKey: bytesOf(origin, proverKey, 'prover key'), verifierKey: bytesOf(origin, verifierKey, 'verifier key'),
      };
      const actual = await keyDigest(material);
      if (digest && digest !== actual) throw fail('InvalidRequest', 'The key material does not match its digest');
      cacheKey(origin, keyLocation, actual, material);
      return { digest: actual, size: material.ir.length + material.proverKey.length + material.verifierKey.length };
    },
    proverCheck: async ({ origin, ...params }) => {
      const preimage = preimageOf(origin, params);
      const prover = await proverFor(origin);
      const result = await asProving(() => prover.check(preimage, params.keyLocation));
      return result.map(v => (v === undefined ? null : v.toString()));
    },
    proverProve: async ({ origin, ...params }) => {
      const preimage = preimageOf(origin, params);
      const binding = params.binding === undefined || params.binding === null ? undefined
        : invalid(() => { if (!/^\d+$/.test(params.binding)) throw new Error('overwriteBindingInput is a decimal string'); return BigInt(params.binding); });
      const prover = await proverFor(origin);
      const proof = await asProving(() => prover.prove(preimage, params.keyLocation, binding));
      return { $bytes: toBase64(proof) };
    },
  };
}

