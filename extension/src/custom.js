// What a network the user defines can need beyond a built-in one: a stand-in
// DUST wallet for a network without DUST, a submission service for a
// network that takes transactions over HTTP, and the check that the chain
// behind its URLs is still the one it was added with. Each depends on one
// field of the definition (wallet/networks.mjs): `dust: false`, `submitUrl`,
// `genesisHash`.
//
// It has no storage and no messaging, like midnight.js.
import { DustAddress, DustWalletState, MidnightBech32m, SyncProgress, VariantState } from '@midnightntwrk/wallet-sdk';
import { SubmissionError, SubmissionEvent } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { NodeClientError } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { BehaviorSubject } from 'rxjs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { checkedEndpoints } from '../../wallet/networks.mjs';
import { gql } from './birthday.js';

const SUBMIT_TIMEOUT_MS = 75000;
const NO_DUST = 'This network has no DUST: transactions there pay no fee';

// ------------------------------------------------------------- DUST ---
/**
 * The DUST wallet of a network without DUST. The SDK's facade needs a DUST
 * wallet and counts it in "synced", and the real one would wait forever for
 * DUST queries such a network does not serve. This one is always synced, at
 * the protocol version the facade's ledger-9 epoch starts at, with no coins,
 * a zero balance and zero fees. It reports the DUST key the seed derives, so
 * the wallet's DUST address is the one the SDK would give it. It sends
 * nothing to the indexer, and refuses to register NIGHT or to pay a fee in
 * DUST.
 */
export function noDustWallet(config, dustSeed) {
  const key = ledger.DustSecretKey.fromSeed(dustSeed);
  const publicKey = key.publicKey;
  key.clear();
  const refuse = () => { throw new Error(NO_DUST); };
  const state = new DustWalletState(config.forks.v9, VariantState.seal('no-dust', null), {
    progress: () => SyncProgress.createSyncProgress({ isConnected: true }),
    totalCoins: () => [], availableCoins: () => [], pendingCoins: () => [],
    publicKey: () => publicKey,
    address: () => new DustAddress(publicKey),
    balance: () => 0n,
    estimateDustGeneration: refuse,
    splitNightUtxos: refuse,
    serialize: () => '',
  });
  const nothing = async () => {};
  const refused = async () => refuse();
  return {
    state: new BehaviorSubject(state),
    start: nothing, stepSync: nothing, stop: nothing, revertTransaction: nothing,
    calculateFee: async () => 0n, estimateFee: async () => 0n,
    serializeState: async () => '',
    waitForSyncedState: async () => state,
    getAddress: async () => new DustAddress(publicKey),
    createDustGenerationTransaction: refused, splitNightUtxosForDustRegistration: refused, attachDustRegistration: refused,
    addDustGenerationSignature: refused, addDustRegistrationSignature: refused, balanceTransactions: refused,
    waitForGeneratedDust: refused, ensureFeeCoverage: refused,
  };
}

// ------------------------------------------------------------ submit ---
/**
 * What an answer of the submit endpoint says of the transaction's inputs
 * (the contract is in docs/technical.md, "HTTP submission"):
 * - 'included': applied in block `height`, wholly (`status` 0) or its
 *   guaranteed segment (`status` 1);
 * - 'refused': in no block, nothing spent: refused before a block
 *   (`worker_rejected`, 400, 413, 415), or failed in block `height` (any
 *   other status);
 * - 'untaken': the endpoint took nothing (`submission_disabled`, `busy`, 429);
 * - 'undetermined': it may or may not be in the chain (`panicked`,
 *   `outcome_unknown`, no height, any other answer).
 */
export function outcomeOf({ status, body }) {
  if (status === 200) {
    if (body.worker_rejected) return 'refused';
    if (!(body.height > 0) || body.status_name === 'panicked' || body.status_name === 'outcome_unknown') return 'undetermined';
    return body.status === 0 || body.status === 1 ? 'included' : 'refused';
  }
  if (status === 400 || status === 413 || status === 415) return 'refused';
  if (status === 429 || (status === 503 && (body.error === 'submission_disabled' || body.error === 'busy'))) return 'untaken';
  return 'undetermined';
}

/**
 * The facade's submission service for a network with a submit URL: the
 * transaction's bytes POSTed as application/octet-stream, the answer read by
 * outcomeOf. The facade gives back the coins a transaction booked only when
 * the error is a SubmissionError whose cause proves no block holds it, so
 * that is what such an answer becomes: a refused transaction as the node
 * client's TransactionInvalidError, with the endpoint's status name, and
 * nothing taken as its ConnectionError. An undetermined answer (or none) is
 * a plain error: the coins stay booked until sync sees the transaction or it
 * expires. An included one resolves; what each segment did, and inclusion
 * itself, are seen by the SDK's own polling of the indexer.
 */
export function submissionService(submitUrl) {
  const excluded = (Cause, bytes, message) => new SubmissionError({ message, cause: new Cause({ message, txData: bytes }) });
  return {
    async submitTransaction(tx) {
      const bytes = tx.serialize();
      let answer;
      try {
        const response = await fetch(submitUrl, {
          method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
        answer = { status: response.status, body: await response.json().catch(() => ({})) ?? {} };
      } catch (error) {
        throw new Error(`The submit endpoint did not answer (${error?.message ?? error}): the transaction may still be included`);
      }
      const { status, body } = answer;
      const outcome = outcomeOf(answer);
      if (outcome === 'included') return SubmissionEvent.Submitted({ tx: bytes, txHash: String(body.hash ?? '') });
      if (outcome === 'refused') {
        throw excluded(NodeClientError.TransactionInvalidError, bytes, `The network refused the transaction (${body.status_name ?? body.error ?? status})`);
      }
      if (outcome === 'untaken') {
        const why = body.error === 'submission_disabled' ? 'it does not accept transactions' : 'it is busy: try again';
        throw excluded(NodeClientError.ConnectionError, bytes, `The submit endpoint took nothing: ${why}`);
      }
      throw new Error(`The submit endpoint could not say whether the transaction was included (${body.status_name ?? body.error ?? status}${body.hash ? `, hash ${body.hash}` : ''}): its coins stay booked until the wallet sees it or it expires`);
    },
    close: async () => {},
  };
}

// ----------------------------------------------------------- identity ---
/** Throws unless `id` is a network id the SDK's address codec accepts. */
export function checkNetworkId(id) {
  if (typeof id !== 'string' || !id) throw new Error('A network id is required');
  if (id !== 'mainnet') MidnightBech32m.validateSegment('network', id);
}

/** The hash of the chain's first block (height 0), from the indexer. */
export async function genesisHash(indexerHttp) {
  const hash = (await gql(indexerHttp, '{ block(offset: { height: 0 }) { hash } }')).block?.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`The indexer at ${indexerHttp} reports no first block`);
  return hash.toLowerCase();
}

/**
 * A user network's definition from what the add or edit form sends, checked
 * (`before` is the definition an edit replaces): its name, network id and
 * indexer URLs, where it takes transactions (`node` or `submitUrl`), whether
 * it has DUST, and the hash of its first block, read from its indexer, so
 * that every start can check the chain is still the same (checkChain). An
 * edit must reach that same chain, and keeps the network id, since the
 * wallet's addresses are made with it.
 */
export async function defineNetwork(fields, before = null) {
  const text = key => String(fields[key] ?? '').trim();
  const def = {
    name: text('name'), networkId: before?.networkId ?? text('networkId'), indexerHttp: text('indexerHttp'), indexerWs: text('indexerWs'),
    ...('submitUrl' in fields ? { submitUrl: text('submitUrl') } : { node: text('node') }), dust: fields.dust !== false,
  };
  if (!def.name || def.name.length > 32) throw new Error('A network name is 1 to 32 characters');
  checkNetworkId(def.networkId);
  checkedEndpoints({ ...def, user: true }, {});
  const hash = await genesisHash(def.indexerHttp);
  if (before && hash !== before.genesisHash) throw new Error(`The indexer at ${def.indexerHttp} serves another chain than ${before.name} was added with`);
  return { ...def, genesisHash: hash };
}

/** Throws a lasting error when the indexer of network `n` serves another
 *  chain than the network was added with. */
export async function checkChain(n, indexerHttp) {
  const found = await genesisHash(indexerHttp);
  if (found !== n.genesisHash) {
    throw Object.assign(new Error(`The indexer at ${indexerHttp} serves another chain (first block ${found.slice(0, 12)}…) than ${n.name} was added with (${n.genesisHash.slice(0, 12)}…)`), { permanent: true });
  }
}
