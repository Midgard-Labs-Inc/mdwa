// The Midnight side of the engine: everything that talks to the wallet SDK.
// Building the facade from a seed (or resuming it from a snapshot), reading
// its state, building, signing, proving and submitting transactions, DUST
// registration, history and transaction descriptions all go through
// @midnightntwrk/wallet-sdk; this module only adapts its objects to the
// engine's JSON (decimal strings, hex, Bech32m). The wallets are the SDK's,
// composed from its public exports for a faster first sync: DUST on the
// SDK's projections sync, and the shielded wallet started at the wallet
// birthday (see "fast sync" below and birthday.js), with sync that stops on
// an indexer's notice that it dropped blocks (see "rewind" below).
//
// A network without DUST, or one that takes transactions over HTTP, gets
// custom.js's stand-in DUST wallet or submission service instead.
//
// It has no storage and no messaging, so the same code runs in the extension's
// engine worker and under Node (scripts/smoke.mjs).
import {
  InMemoryTransactionHistoryStorage, MidnightBech32m, PublicKey, ShieldedAddress, Token,
  UnshieldedAddress, DustAddress, WalletEntrySchema, WalletFacade, WalletSeeds, createKeystore,
  ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, generateMnemonicWords, isInsufficientDustForFeeError,
  lifecycleTransactionTraits, mergeWalletEntries, validateMnemonic, ProtocolVersion,
  CustomForkingShieldedWallet, CustomForkingUnshieldedWallet,
} from '@midnightntwrk/wallet-sdk';
import { makeIndexerChainVersionProbe } from '@midnightntwrk/wallet-sdk/capabilities';
import { TransactionLifecycleServiceImpl } from '@midnightntwrk/wallet-sdk/capabilities/transactionLifecycle';
import {
  fromV8ProvingProvider, fromV9ProvingProvider, makeVersionedProvingServiceEffect, wrapVersionedEffectService,
} from '@midnightntwrk/wallet-sdk/capabilities/proving';
import { WasmProver } from '@midnightntwrk/wallet-sdk/prover-client/effect';
import { CustomForkingDustWallet, dustVariantConfigurations, dustWalletProbes } from '@midnightntwrk/wallet-sdk/dust';
import { V1Builder as DustV1Builder } from '@midnightntwrk/wallet-sdk/dust/v1';
import { V2Builder as DustV2Builder, SyncService as DustSyncService } from '@midnightntwrk/wallet-sdk/dust/v2';
import { CoreWallet as ShieldedCoreV1, V1Builder as ShieldedV1Builder } from '@midnightntwrk/wallet-sdk/shielded/v1';
import {
  CoreWallet as ShieldedCoreV2, Migration as ShieldedMigration, Sync as ShieldedSync, V2Builder as ShieldedV2Builder,
} from '@midnightntwrk/wallet-sdk/shielded/v2';
import { V1Builder as UnshieldedV1Builder } from '@midnightntwrk/wallet-sdk/unshielded/v1';
import {
  Migration as UnshieldedMigration, Sync as UnshieldedSync, V2Builder as UnshieldedV2Builder,
} from '@midnightntwrk/wallet-sdk/unshielded/v2';
import { Effect, Option, Stream } from 'effect';
import * as ledger from '@midnightntwrk/ledger-v9';
import * as ledgerV8 from '@midnightntwrk/ledger-v8';
import { mnemonicToSeed } from '@scure/bip39';
import { connectionUrls } from '../../wallet/networks.mjs';
import { gql, shieldedAnchor, zswapCollapsedUpdate } from './birthday.js';
import { noDustWallet, submissionService } from './custom.js';

export const NIGHT = Token.night;
const SNAPSHOT_VERSION = 1;
const TTL_MS = 30 * 60 * 1000;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));
const sum = values => values.reduce((a, b) => a + b, 0n);

// ------------------------------------------------------------------ keys ---
/** 24 fresh BIP-39 words. */
export const generateMnemonic = () => generateMnemonicWords(256);

/** The 64-byte BIP-39 seed of a recovery phrase (English list, no passphrase),
 *  checked with the SDK's own validator. */
export async function seedFromMnemonic(mnemonic) {
  const words = (Array.isArray(mnemonic) ? mnemonic.join(' ') : String(mnemonic ?? ''))
    .normalize('NFKD').toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length) || !validateMnemonic(words.join(' '))) {
    throw new Error('This is not a valid recovery phrase');
  }
  return new Uint8Array(await mnemonicToSeed(words.join(' ')));
}

/** The wallet's three addresses and shielded keys on network `net` (a
 *  definition, wallet/networks.mjs), straight from the seed with the same
 *  derivations the SDK's wallets start from (WalletSeeds, then the ledger's
 *  key objects), so they are known before any connection and while the
 *  wallet is locked. */
export function deriveAddresses(seed, net) {
  const { networkId } = net;
  const seeds = WalletSeeds.fromMasterSeed(seed);
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);
  const zswap = ledger.ZswapSecretKeys.fromSeed(seeds.shielded);
  const dust = ledger.DustSecretKey.fromSeed(seeds.dust);
  try {
    const shielded = new ShieldedAddress(ShieldedCoinPublicKey.fromHexString(zswap.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(zswap.encryptionPublicKey));
    return {
      unshielded: keystore.getBech32Address().asString(),
      shielded: MidnightBech32m.encode(networkId, shielded).asString(),
      dust: MidnightBech32m.encode(networkId, new DustAddress(dust.publicKey)).asString(),
      coinPublicKey: zswap.coinPublicKey,
      encryptionPublicKey: zswap.encryptionPublicKey,
    };
  } finally { zswap.clear(); dust.clear(); }
}

// ---------------------------------------------------------------- facade ---
/** The SDK configuration of network `net`. connectionUrls throws the
 *  Blockfrost message when a project id is needed and missing. */
export function sdkConfiguration(net, endpoints, txHistoryStorage) {
  const urls = connectionUrls(net, endpoints);
  return {
    networkId: net.networkId,
    costParameters: { feeBlocksMargin: 5 },
    // Submission goes through the node; sync also cross-checks the indexer
    // against this node's finalized head. A network with a submit URL has
    // no node: the SDK then skips that check, and custom.js submits.
    ...(urls.node ? { relayURL: new URL(urls.node) } : {}),
    indexerClientConnection: { indexerHttpUrl: urls.indexerHttp, indexerWsUrl: urls.indexerWs },
    // A proof server is one URL for whichever ledger version a transaction
    // belongs to. The in-process prover is set up by wasmProvingService below
    // (this entry only tells the SDK a prover exists).
    ...(urls.prover.kind === 'server'
      ? { provingServerUrl: new URL(urls.prover.url) }
      : { provers: { v8: { kind: 'wasm' }, v9: { kind: 'wasm' } } }),
    txHistoryStorage,
  };
}

// The SDK's in-process prover starts one proof worker per proof, and the
// ledger asks for every proof of a transaction at once. Each worker holds its
// circuit's keys and parameters, so a transfer with a shielded spend runs
// eight workers and several GB together, more than one browser renderer may
// hold (it crashes; two at a time still peaked at 4 GB). So the engine builds
// the same proving service the SDK would (its WasmProver with each ledger
// version's key material, routed by the fork schedule), with the provider's
// check and prove calls queued to run one at a time.
//
// The queue is one for the whole engine: the wallet's v8 and v9 proofs and
// the proofs a dApp asks for through the connector (dappProver below) all
// wait in it, so no two proofs ever run at once, whoever asked.
const WASM_PROOFS_AT_ONCE = 1;
const proofQueue = [];
let proofsRunning = 0;
const nextProof = () => {
  if (proofsRunning < WASM_PROOFS_AT_ONCE && proofQueue.length) { proofsRunning++; proofQueue.shift()(); }
};
/** `fn` run through the engine's single proof queue. */
export const oneProofAtATime = fn => (...args) => new Promise((resolve, reject) => {
  proofQueue.push(() => Promise.resolve().then(() => fn(...args)).then(resolve, reject).finally(() => { proofsRunning--; nextProof(); }));
  nextProof();
});
function limited(provider) {
  return { check: oneProofAtATime(provider.check), prove: oneProofAtATime(provider.prove), lookupKey: provider.lookupKey };
}

// The SDK's key material for Midnight's own circuits (zswap, DUST) and the
// public parameters every circuit needs. Each provider reads a file once, so
// one per ledger version is kept for the engine's life and shared by the
// wallet's prover and the dApp prover.
const builtinKeys = {};
export const builtinKeyMaterial = version => (builtinKeys[version] ??= version === 'v8'
  ? WasmProver.makeV8KeyMaterialProvider() : WasmProver.makeV9KeyMaterialProvider());

async function wasmProvingService(forks) {
  const provider = async keyMaterialProvider =>
    (await Effect.runPromise(WasmProver.create({ keyMaterialProvider }))).asProvingProvider();
  const v9 = fromV9ProvingProvider(limited(await provider(builtinKeyMaterial('v9'))));
  const entries = [{ range: ProtocolVersion.epochOf(forks.v9, forks.v9), value: v9 }];
  if (forks.v9 > ProtocolVersion.MinSupportedVersion) {
    const v8 = fromV8ProvingProvider(limited(await provider(builtinKeyMaterial('v8'))));
    entries.unshift({ range: ProtocolVersion.epochOf(ProtocolVersion.MinSupportedVersion, forks.v9), value: v8 });
  }
  return wrapVersionedEffectService(makeVersionedProvingServiceEffect({ entries }));
}

// The header a serialized ZKIR v3 circuit starts with. The SDK's WasmProver
// picks its proof worker (zkir-v3 or zkir-v2) by the same header, but does
// not export that choice; checking in this worker has to pick the same
// runtime, so it reads the same bytes.
const ZKIR_V3_HEADER = new TextEncoder().encode('midnight:ir-source[v3-generic]:');
const isZkirV3 = ir => ir?.length >= ZKIR_V3_HEADER.length && ZKIR_V3_HEADER.every((b, i) => ir[i] === b);
// Loaded on the first dApp check: most sessions never prove a dApp circuit.
const zkirRuntime = ir => (isZkirV3(ir) ? import('@midnightntwrk/zkir-v3') : import('@midnightntwrk/zkir-v2'));

/**
 * The ledger version a dApp's proofs are for: the one the chain is at now,
 * read as the SDK reads it (the facade's active protocol version against the
 * fork schedule it was configured with). Every Midnight network runs ledger
 * 9 as of November 2026, and a dApp can only get a transaction included at
 * the chain's current version, so on any current network this is 'v9'. It is
 * 'v8' only on a chain of the previous node line (protocol versions below
 * forks.v9, e.g. an old local devnet), which the SDK still syncs and builds
 * for; there a dApp's proofs need ledger-8 framing and key material.
 */
export const dappLedgerVersion = (wallet, state) => (state.activeProtocolVersion >= wallet.forks.v9 ? 'v9' : 'v8');

/**
 * A prover for the circuits a dApp brings (the connector's
 * getProvingProvider), proving with the prover the user picked for the
 * network: the SDK's WasmProver in this worker, or the proof server, which
 * is sent the dApp's key material with each request because it only holds
 * Midnight's own. Circuits named `midnight/...` (zswap, DUST) use the SDK's
 * key material for `version` ('v8' or 'v9', see dappLedgerVersion);
 * `lookupDappKey(keyLocation)` gives `{ ir, proverKey, verifierKey }` for the
 * dApp's. Every proof goes through the engine's one proof queue. Preimages
 * carry the user's private inputs: nothing here logs or keeps them.
 *
 * With the WASM prover every check and prove is first checked here, in this
 * worker, with the ZKIR package's own `check` (the function the SDK's proof
 * worker runs). The SDK's proof worker answers a check or prove that fails
 * with nothing at all: it rethrows inside a promise chain, the worker gets
 * an unhandled rejection rather than an error event, and the caller waits
 * for the SDK's 10-minute deadline. Since proofs run one at a time, one bad
 * preimage from a site would hold up every proof, the wallet's own too.
 * Checked here, a preimage that does not satisfy its circuit is refused in
 * milliseconds with the runtime's own message and never reaches the queue.
 * A dApp check is answered by that check alone: it is the same computation,
 * and it needs no worker. What this cannot catch is a prove that fails after
 * its check passed (a prover key that does not belong to its circuit); that
 * one still waits for the SDK's deadline.
 */
export function dappProver(prover, lookupDappKey, version = 'v9') {
  const framing = version === 'v8' ? ledgerV8 : ledger;
  const builtin = builtinKeyMaterial(version);
  const isBuiltin = location => location.startsWith('midnight/');
  if (prover.kind === 'server') {
    const post = async (path, body) => {
      const response = await fetch(new URL(path, prover.url), {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body,
      });
      if (!response.ok) throw new Error(`The proof server answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const dappKey = async location => (isBuiltin(location) ? undefined : lookupDappKey(location));
    return {
      check: oneProofAtATime(async (preimage, location) =>
        framing.parseCheckResult(await post('/check', framing.createCheckPayload(preimage, (await dappKey(location))?.ir)))),
      prove: oneProofAtATime(async (preimage, location, binding) =>
        post('/prove', framing.createProvingPayload(preimage, binding, await dappKey(location)))),
    };
  }
  const keyMaterialProvider = {
    lookupKey: async location => (isBuiltin(location) ? builtin.lookupKey(location) : lookupDappKey(location)),
    getParams: k => builtin.getParams(k),
  };
  const check = async (preimage, location) => {
    const material = await keyMaterialProvider.lookupKey(location);
    const zkir = await zkirRuntime(material?.ir);
    return zkir.check(preimage, { lookupKey: l => (l === location ? Promise.resolve(material) : keyMaterialProvider.lookupKey(l)), getParams: keyMaterialProvider.getParams });
  };
  const provider = Effect.runSync(WasmProver.create({ keyMaterialProvider })).asProvingProvider();
  const prove = oneProofAtATime(provider.prove);
  return {
    check,
    prove: async (preimage, location, binding) => { await check(preimage, location); return prove(preimage, location, binding); },
  };
}

// ------------------------------------------------------------ fast sync ---
// How often the DUST wallet looks at the chain again once it is synced. Each
// look is a whole projections pass (one nullifier lookup per DUST coin held,
// see FastDustWallet), so the SDK's default of 5 s costs bandwidth for no
// gain: DUST changes only when the wallet pays a fee or its NIGHT moves.
const DUST_PASS_INTERVAL_MS = 30000;

/**
 * One DUST pass now, outside the 30-second rhythm (the SDK's stepSync, which
 * takes the keys of both ledger versions and uses the running variant's).
 * After this wallet pays a fee, the DUST coin it spent stays booked and its
 * change unknown until a pass sees the transaction on chain; with passes 30
 * seconds apart, a second transaction made in between would find no DUST to
 * pay with. The engine calls this every few seconds while coins are booked
 * (see engine-worker.js). A pass already running makes this one a no-op (the
 * SDK lets one pass run at a time), and the ledger-8 variant, which has no
 * stepped sync, refuses it, which is ignored: it syncs by events anyway.
 */
export async function refreshDust(wallet) {
  const keys = { v8: ledgerV8.DustSecretKey.fromSeed(wallet.seeds.dust), v9: ledger.DustSecretKey.fromSeed(wallet.seeds.dust) };
  try { await wallet.facade.dust.stepSync(keys); } catch { /* the next pass catches up */ } finally { keys.v8.clear(); keys.v9.clear(); }
}

// ---------------------------------------------------------------- rewind ---
// Some indexers show blocks before they are permanent, and can drop them:
// the blocks may come back later, and the transaction ids and event ids after
// the last permanent block are numbered anew. Such an indexer ends every open
// subscription with a GraphQL error whose `extensions.code` is CHAIN_REWOUND,
// and answers it again to a subscription resumed from an id it no longer
// knows. The SDK's sync streams retry a failed subscription from the same id
// for ever, so the wallet would keep the dropped coins and never sync again;
// the code is only visible on the error those streams fail with (the SDK's
// ClientError keeps the GraphQL errors as its cause). So the wallets are the
// SDK's, composed as its own UnshieldedWallet and ShieldedWallet are, with
// their sync services wrapped: on CHAIN_REWOUND the stream stops quietly and
// `onRewound` is called, for the engine to discard the synced state and sync
// again (engine-worker.js). Any other failure goes on to the SDK's retry.
const CHAIN_REWOUND = 'CHAIN_REWOUND';

/** Whether a sync stream's failure is the indexer's CHAIN_REWOUND. */
export function isChainRewound(error) {
  for (let e = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (Array.isArray(e)) return e.some(x => x?.extensions?.code === CHAIN_REWOUND);
  }
  return false;
}

/** A sync service factory whose updates stop, and call `onRewound`, on CHAIN_REWOUND. */
export const rewindAware = (makeService, onRewound) => (...args) => {
  const service = makeService(...args);
  return {
    ...service,
    updates: (...state) => service.updates(...state).pipe(Stream.catchAll(error => {
      if (!isChainRewound(error)) return Stream.fail(error);
      onRewound();
      return Stream.never;
    })),
  };
};

const unshieldedWallet = (configuration, onRewound) => CustomForkingUnshieldedWallet(
  { ...configuration, chainVersionProbe: configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration) },
  { builder: new UnshieldedV1Builder().withDefaults(), configuration },
  {
    builder: new UnshieldedV2Builder().withDefaults()
      .withSync(rewindAware(UnshieldedSync.makeDefaultSyncService, onRewound), UnshieldedSync.makeDefaultSyncCapability)
      .withMigration(() => UnshieldedMigration.makeCrossLedgerMigration()),
    configuration,
  },
);

// withSync drops the start material withDefaults set up, as for DUST below.
const shieldedWallet = (configuration, onRewound) => CustomForkingShieldedWallet(
  { ...configuration, chainVersionProbe: configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration) },
  { builder: new ShieldedV1Builder().withDefaults(), configuration },
  {
    builder: new ShieldedV2Builder().withDefaults()
      .withSync(rewindAware(ShieldedSync.makeEventsSyncService, onRewound), ShieldedSync.makeEventsSyncCapability)
      .withStartAuxDefaults().withMigration(() => ShieldedMigration.makeCrossLedgerMigration()),
    configuration,
  },
);

/** The protocol version of the chain's tip block, for the DUST wallet's start. */
const tipVersionProbe = indexerHttp => async () => {
  const data = await gql(indexerHttp, '{ block { protocolVersion } }');
  if (!data.block) throw new Error('The indexer reports no block');
  return ProtocolVersion.ProtocolVersion(BigInt(data.block.protocolVersion));
};

/**
 * The SDK's forking DUST wallet with its ledger-9 variant on the SDK's
 * "projections" sync (SyncService.makeEventLessSyncService) instead of the
 * default replay of every DUST event since genesis, which on a public
 * network is most of what a fresh wallet downloads. A projections pass asks
 * the indexer for the DUST generations of this wallet's own DUST address,
 * resolves which of them were spent through nullifier lookups that match on
 * a prefix only (so the indexer cannot tell which nullifier is the wallet's),
 * and takes the DUST commitment tree as one collapsed update, then checks
 * both tree roots against the block it read. Passes repeat every
 * DUST_PASS_INTERVAL_MS (the configuration's backgroundSyncInterval, which
 * the SDK's projections service reads).
 *
 * The chain-version probe asks for the tip's version, not block 0's as the
 * SDK's default does: projections keep no event cursor, so a fresh wallet
 * has no history to replay and starts on the variant the chain is on now.
 * That is only right because the ledger-9 variant syncs by projections; with
 * event replay it would skip the chain's ledger-8 events. A snapshot made by
 * the event replay of an earlier version of this wallet is resumed as is: the
 * SDK accepts it (dust/v2 Sync.resumableBy refuses only the opposite pairing)
 * and its first pass re-reads the address's generations from block 0.
 *
 * The ledger-8 variant keeps the SDK's event replay: it only runs on a chain
 * still on ledger 8, or for a snapshot written there, and hands over to the
 * ledger-9 variant at the fork as the SDK's own DustWallet does.
 */
function FastDustWallet(config, onRewound) {
  const configuration = {
    ...config,
    backgroundSyncInterval: DUST_PASS_INTERVAL_MS,
    chainVersionProbe: tipVersionProbe(config.indexerClientConnection.indexerHttpUrl),
  };
  const { v1, v2, migration } = dustVariantConfigurations(configuration);
  return CustomForkingDustWallet(
    { ...configuration, ...dustWalletProbes(configuration) },
    { builder: new DustV1Builder().withDefaults(), configuration: v1 },
    {
      // withSync drops the start material withDefaults set up, so it is set
      // up again after it.
      builder: new DustV2Builder().withDefaults()
        .withSync(rewindAware(DustSyncService.makeEventLessSyncService, onRewound), DustSyncService.makeEventLessSyncCapability)
        .withStartAuxDefaults().withMigration(migration),
      configuration: v2,
    },
  );
}

/**
 * A shielded wallet (a shielded wallet class `Shielded`, see shieldedWallet) that starts
 * at a birthday anchor (birthday.js shieldedAnchor) instead of the chain's
 * first event: an empty state of the variant the anchor's ledger version
 * belongs to, fast-forwarded by the indexer's collapsed update of the zswap
 * Merkle tree over [0, anchor.mtIndex], with its event cursor on the anchor
 * event. Sync then replays only the events after it. This is the path the
 * SDK's own restore takes (startAtVariant with a state), so the wallet is an
 * ordinary one from there on: it snapshots, resumes and crosses forks as any
 * other. Coins received before the anchor are not found.
 */
function startShieldedAtAnchor(Shielded, config, seeds, anchor, update) {
  const version = ProtocolVersion.ProtocolVersion(anchor.protocolVersion);
  const v9 = version >= config.forks.v9;
  const [Core, Ledger] = v9 ? [ShieldedCoreV2, ledger] : [ShieldedCoreV1, ledgerV8];
  const variant = Option.getOrThrowWith(Shielded.variantFor(version), () => new Error(`No shielded wallet variant for protocol version ${version}`));
  // The state keeps the public keys only; the facade's start() hands the
  // wallet its secret keys.
  const keys = Ledger.ZswapSecretKeys.fromSeed(seeds.shielded);
  let state;
  try { state = Core.withProtocolVersion(Core.initEmpty(keys, config.networkId), version); } finally { keys.clear(); }
  state = Core.applyCollapsedUpdate(state, Ledger.MerkleTreeCollapsedUpdate.deserialize(update.bytes));
  if (state.state.firstFree !== anchor.mtIndex + 1n) {
    throw new Error(`The collapsed update ends the tree at ${state.state.firstFree}, not ${anchor.mtIndex + 1n}`);
  }
  state = Core.updateProgress(state, { appliedIndex: BigInt(anchor.eventId) });
  return Shielded.startAtVariant(Shielded, variant, state);
}

/**
 * Builds and starts the facade for network `net` (a definition,
 * wallet/networks.mjs) from the 64-byte seed.
 * `snapshot` (what serialize() returned earlier) resumes the three wallets,
 * the history and the lifecycle records instead of syncing from the start.
 * A snapshot whose history the SDK cannot read is ignored as a whole; a
 * wallet part the SDK will not restore (an unreadable blob, or a position its
 * sync cannot continue from) starts afresh on its own.
 *
 * `birthday` (`{ height }`, or null for the start of the chain) is where a
 * shielded wallet that starts afresh begins (see startShieldedAtAnchor). If
 * the indexer cannot place it (no anchor query, no collapsed update, an
 * inconsistent answer), the shielded wallet starts at the beginning of the
 * chain instead, and `shieldedStart.reason` says why.
 *
 * `onRewound` is called when the indexer answers a wallet's sync with
 * CHAIN_REWOUND (see "rewind" above); that wallet's sync then stops.
 */
export async function openWallet({ net, endpoints, seed, snapshot = null, birthday = null, onRewound = () => {} }) {
  const { networkId } = net;
  const urls = connectionUrls(net, endpoints);
  const seeds = WalletSeeds.fromMasterSeed(seed);
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);
  let resume = snapshot?.version === SNAPSHOT_VERSION ? snapshot : null;
  let history = new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
  if (resume) {
    try { history = InMemoryTransactionHistoryStorage.restore(resume.history, WalletEntrySchema, mergeWalletEntries); }
    catch { resume = null; }
  }
  const configuration = sdkConfiguration(net, endpoints, history);
  // How each part started: 'snapshot', or afresh ('birthday' or 'start').
  const started = { shielded: null, unshielded: null, dust: null };
  let shieldedStart = { from: 'start', reason: null };
  const restoreOr = async (Wallet, part, fresh) => {
    if (resume) {
      try { const w = Wallet.restore(resume[part]); started[part] = 'snapshot'; return w; } catch { /* starts afresh below */ }
    }
    started[part] = 'fresh';
    return fresh();
  };
  const freshShielded = async (Shielded, config) => {
    if (!birthday) return Shielded.startWithSeed(seeds.shielded);
    const indexerHttp = config.indexerClientConnection.indexerHttpUrl;
    try {
      const anchor = await shieldedAnchor(indexerHttp, birthday.height, config.forks.v9);
      if (!anchor) {
        shieldedStart = { from: 'start', reason: 'The chain has no shielded outputs before the wallet birthday, so there is nothing to skip' };
        return Shielded.startWithSeed(seeds.shielded);
      }
      const wallet = startShieldedAtAnchor(Shielded, config, seeds, anchor, await zswapCollapsedUpdate(indexerHttp, anchor.mtIndex));
      shieldedStart = { from: 'birthday', reason: null, anchor: { height: anchor.height, eventId: anchor.eventId, mtIndex: anchor.mtIndex.toString() } };
      return wallet;
    } catch (error) {
      shieldedStart = { from: 'start', reason: `The indexer could not start the shielded sync at the wallet birthday (${String(error?.message ?? error).slice(0, 300)}), so it syncs from the start of the chain` };
      return Shielded.startWithSeed(seeds.shielded);
    }
  };
  const facade = await WalletFacade.init({
    configuration,
    shielded: config => restoreOr(shieldedWallet(config, onRewound), 'shielded',
      () => freshShielded(shieldedWallet(config, onRewound), config)),
    unshielded: config => restoreOr(unshieldedWallet(config, onRewound), 'unshielded',
      () => unshieldedWallet(config, onRewound).startWithPublicKey(PublicKey.fromKeyStore(keystore))),
    dust: config => (!net.dust ? noDustWallet(config, seeds.dust)
      : restoreOr(FastDustWallet(config, onRewound), 'dust', () => FastDustWallet(config, onRewound).startWithSeed(seeds.dust))),
    ...(urls.submitUrl ? { submissionService: () => submissionService(urls.submitUrl) } : {}),
    ...(configuration.provers ? { provingService: config => wasmProvingService(config.forks) } : {}),
    ...(resume?.lifecycle ? {
      transactionLifecycleService: (config, { clock }) =>
        TransactionLifecycleServiceImpl.restore(resume.lifecycle, lifecycleTransactionTraits(config.forks.v9), config, clock),
    } : {}),
  });
  await facade.start(seeds);
  if (started.shielded === 'snapshot') shieldedStart = { from: 'snapshot', reason: null };
  return {
    net, networkId, facade, keystore, seeds, history, started, shieldedStart,
    // Where the chain hands over between ledger versions, as the facade
    // resolved it (the SDK's default schedule: none is configured here).
    forks: WalletFacade.resolveConfiguration(configuration).forks,
    /** Everything needed to resume: three wallet snapshots, history, lifecycle. */
    async serialize() {
      const [shielded, unshielded, dust, historyText, lifecycle] = await Promise.all([
        facade.shielded.serializeState(), facade.unshielded.serializeState(), facade.dust.serializeState(),
        history.serialize(), facade.transactionLifecycleService.serializeState(),
      ]);
      return {
        version: SNAPSHOT_VERSION, savedAt: Date.now(),
        shielded: String(shielded), unshielded: String(unshielded), dust: String(dust),
        history: String(historyText), lifecycle: String(lifecycle),
      };
    },
    stop: () => facade.stop(),
  };
}

// ----------------------------------------------------------------- state ---
const percentOf = (applied, highest, done) => {
  if (done) return 100;
  if (!highest || highest <= 0n) return 0;
  const p = Number((applied * 10000n) / highest) / 100;
  return Math.max(0, Math.min(99.99, p));
};

/** The engine's sync block from one facade state. Without `dust` (a network
 *  without DUST, whose DUST wallet is a stand-in), the shielded and
 *  unshielded wallets only. */
export function syncOf(s, { dust = true } = {}) {
  const synced = s.isSynced;
  const sh = s.shielded.progress, un = s.unshielded.progress, du = s.dust.progress;
  const parts = {
    shielded: { percent: percentOf(sh.appliedIndex, sh.highestRelevantWalletIndex, synced || sh.isStrictlyComplete?.()) },
    unshielded: { percent: percentOf(un.appliedId, un.highestTransactionId, synced || un.isStrictlyComplete?.()) },
    ...(dust ? { dust: { percent: percentOf(du.appliedIndex, du.highestRelevantWalletIndex, synced || du.isStrictlyComplete?.()) } } : {}),
  };
  const connected = sh.isConnected && un.isConnected && du.isConnected;
  const shown = Object.values(parts);
  const percent = synced ? 100 : Math.round(shown.reduce((a, p) => a + p.percent, 0) / shown.length * 100) / 100;
  // The three wallets report connected one by one, and one can be reading
  // blocks while another still connects (seen on Preview): progress counts
  // as syncing.
  return { status: synced ? 'synced' : connected || percent > 0 ? 'syncing' : 'connecting', percent, parts };
}

/** A key that changes whenever a wallet applies something from the chain or
 *  books coins, while the sync status and percentage can stay as they were:
 *  what the popup re-reads balances and activity on. */
export function appliedOf(s) {
  const progress = [s.shielded.progress.appliedIndex, s.unshielded.progress.appliedId, s.dust.progress.appliedIndex];
  return [...progress, s.shielded.pendingCoins.length, s.unshielded.pendingCoins.length].join(':');
}

/** Whether a facade state is synced but for a DUST pass that is running:
 *  shielded and unshielded level with the chain, DUST connected. */
export function onlyDustBehind(s) {
  return !!s && s.shielded.progress.isStrictlyComplete() && s.unshielded.progress.isStrictlyComplete() && s.dust.progress.isConnected;
}

/** Bech32m addresses and shielded public keys from a facade state. */
export function addressesOf(s, networkId) {
  return {
    unshielded: MidnightBech32m.encode(networkId, s.unshielded.address).asString(),
    shielded: MidnightBech32m.encode(networkId, s.shielded.address).asString(),
    dust: MidnightBech32m.encode(networkId, s.dust.address).asString(),
    coinPublicKey: s.shielded.coinPublicKey.toHexString(),
    encryptionPublicKey: s.shielded.encryptionPublicKey.toHexString(),
  };
}

const utxoRef = u => `${u.utxo.intentHash}#${u.utxo.outputNo}`;
const tokenList = balances => Object.entries(balances ?? {})
  .map(([type, amount]) => ({ type, amount: BigInt(amount).toString() }))
  .sort((a, b) => (a.type === NIGHT ? -1 : b.type === NIGHT ? 1 : a.type.localeCompare(b.type)));

/**
 * The DUST balance to show: `{ balance, updating }`. A transaction that pays
 * a fee books the DUST coin it spends, and the coin it gets back as change is
 * only learned from the chain by the DUST wallet's next pass (see
 * refreshDust). In between the SDK's balance leaves the booked
 * coin out, and with a single DUST coin reads 0 although the wallet has DUST.
 * So while coins are booked, the figure shown is the larger of the SDK's and
 * the last one seen with nothing booked, flagged `updating`. `memo` (an
 * object kept for the running wallet) holds that last figure.
 */
export function dustBalanceOf(s, memo = {}, now = new Date()) {
  const balance = s.dust.balance(now);
  if (!s.dust.pendingCoins.length) {
    memo.settledDust = balance;
    return { balance, updating: false };
  }
  const settled = memo.settledDust ?? 0n;
  return { balance: settled > balance ? settled : balance, updating: true };
}

/** The overview the popup's home screen shows. `memo`: see dustBalanceOf. */
export function overviewOf(s, networkId, now = new Date(), memo = {}) {
  const available = s.unshielded.balances?.[NIGHT] ?? 0n;
  const pending = sum(s.unshielded.pendingCoins.filter(c => c.utxo.type === NIGHT).map(c => c.utxo.value));
  const coins = s.unshielded.availableCoins.filter(c => c.utxo.type === NIGHT);
  const registered = coins.filter(c => c.meta.registeredForDustGeneration);
  const unregistered = coins.filter(c => !c.meta.registeredForDustGeneration);
  const shown = dustBalanceOf(s, memo, now);
  return {
    night: { available: available.toString(), pending: pending.toString() },
    unshielded: tokenList(s.unshielded.balances),
    shielded: tokenList(s.shielded.balances),
    dust: {
      balance: shown.balance.toString(),
      updating: shown.updating,
      // The cap of the NIGHT the wallet still holds, as the connector reports
      // it: DUST whose backing NIGHT was spent (a send, a registration that
      // moved it) has a decay time and only shrinks.
      cap: sum(s.dust.totalCoins.filter(c => c.dtime === undefined).map(c => c.maxCap)).toString(),
      registered: registered.length, unregistered: unregistered.length,
      registeredNight: sum(registered.map(c => c.utxo.value)).toString(),
      unregisteredNight: sum(unregistered.map(c => c.utxo.value)).toString(),
    },
    addresses: addressesOf(s, networkId),
  };
}

// -------------------------------------------------------------- addresses ---
const KINDS = { 'shield-addr': ['shielded', ShieldedAddress], addr: ['unshielded', UnshieldedAddress], dust: ['dust', DustAddress] };

/** What an address is and whether it belongs to this network. */
export function checkAddress(networkId, address) {
  let parsed;
  try { parsed = MidnightBech32m.parse(String(address ?? '').trim()); }
  catch { return { valid: false, kind: null, network: null, error: 'Not a Midnight address' }; }
  const network = typeof parsed.network === 'string' ? parsed.network : 'mainnet';
  const known = KINDS[parsed.type];
  if (!known) return { valid: false, kind: null, network, error: `Not an address (${parsed.type})` };
  const [kind, Class] = known;
  if (network !== networkId) return { valid: false, kind, network, error: `This address is for ${network}, not ${networkId}` };
  try { parsed.decode(Class, networkId); }
  catch (error) { return { valid: false, kind, network, error: `Malformed ${kind} address: ${error.message}` }; }
  return { valid: true, kind, network, error: null };
}

function parseRecipient(networkId, recipient) {
  const check = checkAddress(networkId, recipient);
  if (!check.valid) throw new Error(check.error);
  if (check.kind === 'dust') throw new Error('DUST cannot be sent: use a shielded or unshielded address');
  const parsed = MidnightBech32m.parse(String(recipient).trim());
  return { kind: check.kind, address: parsed.decode(KINDS[parsed.type][1], networkId) };
}

const amountOf = text => {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) throw new Error('Amounts are decimal strings of the smallest unit');
  const n = BigInt(text);
  if (n <= 0n) throw new Error('Amounts must be more than zero');
  return n;
};
const tokenOf = type => {
  const t = String(type ?? NIGHT).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('A token type is 64 hex characters');
  return t;
};

// ------------------------------------------------------- transaction bytes ---
const MARKERS = {
  Unproven: ['signature', 'pre-proof', 'pre-binding'],
  Unbound: ['signature', 'proof', 'pre-binding'],
  Finalized: ['signature', 'proof', 'binding'],
};
/** The ledger-v9 transaction inside an SDK handle (for reading only). */
export function ledgerTransaction(handle) {
  return ledger.Transaction.deserialize(...MARKERS[handle.stage], handle.serialize());
}

/** DUST a transaction pays: the sum of its DUST spends' fees. */
function dustPaid(tx) {
  let paid = 0n;
  for (const intent of tx.intents?.values() ?? []) for (const spend of intent.dustActions?.spends ?? []) paid += spend.vFee;
  return paid;
}

async function feeOf(facade, handle) {
  const paid = dustPaid(ledgerTransaction(handle));
  return paid > 0n ? paid : facade.calculateTransactionFee(handle);
}

// ------------------------------------------------------------------- send ---
/** Balances a transfer and pays its fee with DUST. The recipe books the coins
 *  it spends; send or revert it. */
export async function buildTransfer(wallet, outputs, { payFees = true } = {}) {
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('Add at least one recipient');
  const { transfers, described } = transfersOf(wallet.networkId, outputs);
  const ttl = new Date(Date.now() + TTL_MS);
  const recipe = await wallet.facade.transferTransaction(transfers, { ttl, payFees });
  const fee = payFees ? await feeOf(wallet.facade, recipe.transaction) : 0n;
  return { recipe, outputs: described, fee: fee.toString(), ttl: ttl.toISOString() };
}

/** Outputs (`{ type, amount, recipient, kind? }`, amounts as decimal
 *  strings) as the facade's transfers, grouped by kind. A stated `kind` must
 *  match the recipient address's kind. */
export function transfersOf(networkId, outputs) {
  const groups = { shielded: [], unshielded: [] };
  const described = outputs.map(o => {
    const { kind, address } = parseRecipient(networkId, o.recipient);
    if (o.kind !== undefined && o.kind !== kind) throw new Error(`${String(o.recipient).trim()} is a ${kind} address, not a ${o.kind} one`);
    const type = tokenOf(o.type);
    const amount = amountOf(o.amount);
    groups[kind].push({ type, amount, receiverAddress: address });
    return { kind, type, amount: amount.toString(), recipient: String(o.recipient).trim() };
  });
  const transfers = Object.entries(groups).filter(([, list]) => list.length).map(([type, list]) => ({ type, outputs: list }));
  return { transfers, described };
}

/** Finishes a recipe without submitting it: signs its unshielded inputs,
 *  proves and binds it. Returns the finalized handle. The facade reverts the
 *  recipe itself when proving or binding fails. */
export async function sealRecipe(wallet, recipe, { onStage = () => {} } = {}) {
  const signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  onStage('proving');
  return wallet.facade.finalizeRecipe(signed);
}

/** A recipe's parts as ledger-v9 transactions, for describing. */
export function recipeTransactions(recipe) {
  const parts = recipe.type === 'FINALIZED_TRANSACTION' ? [recipe.originalTransaction, recipe.balancingTransaction]
    : recipe.type === 'UNBOUND_TRANSACTION' ? [recipe.baseTransaction, recipe.balancingTransaction]
      : [recipe.transaction];
  return parts.filter(Boolean).map(ledgerTransaction);
}

/** Signs (unshielded inputs), proves, binds and submits a recipe.
 *  `onStage` hears 'proving' and 'submitting'. Returns the transaction id. */
export async function completeRecipe(wallet, recipe, { sign = true, onStage = () => {} } = {}) {
  const signed = sign ? await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync) : recipe;
  onStage('proving');
  const finalized = await wallet.facade.finalizeRecipe(signed);
  onStage('submitting');
  return wallet.facade.submitTransaction(finalized);
}

// ------------------------------------------------------------------- DUST ---
const nightUtxos = (s, registered) => s.unshielded.availableCoins
  .filter(c => c.utxo.type === NIGHT && c.meta.registeredForDustGeneration === registered);

/**
 * Builds a DUST registration (all unregistered NIGHT) or deregistration (all
 * registered NIGHT). A first registration pays its fee from the DUST its own
 * NIGHT has generated; when that is not enough yet, the result says so
 * (`canPay: false`, `waitSeconds` when the SDK can say how long) instead of
 * throwing.
 */
export async function buildDustAction(wallet, action) {
  const s = await wallet.facade.waitForSyncedState();
  const register = action === 'register';
  if (!register && action !== 'deregister') throw new Error('action is register or deregister');
  const utxos = nightUtxos(s, !register);
  if (!utxos.length) throw new Error(register ? 'There is no unregistered NIGHT' : 'No NIGHT is registered for DUST generation');
  const listed = utxos.map(u => ({ ref: utxoRef(u), amount: u.utxo.value.toString() }));
  const pk = wallet.keystore.getPublicKey();
  try {
    // A registration pays its own fee; a deregistration is built without one
    // and then balanced with DUST, as the SDK's deregistration example does.
    const recipe = register
      ? await wallet.facade.registerNightUtxosForDustGeneration(utxos, pk, wallet.keystore.signDataAsync)
      : await wallet.facade.balanceUnprovenTransaction(
        (await wallet.facade.deregisterFromDustGeneration([...utxos], pk, wallet.keystore.signDataAsync)).transaction,
        { ttl: new Date(Date.now() + TTL_MS), tokenKindsToBalance: ['dust'] });
    const fee = register ? (await wallet.facade.estimateRegistration(utxos)).fee : await feeOf(wallet.facade, recipe.transaction);
    return { recipe, utxos: listed, fee: fee.toString(), canPay: true };
  } catch (error) {
    if (!isInsufficientDustForFeeError(error)) throw error;
    return {
      recipe: null, utxos: listed, fee: error.fee.toString(), canPay: false,
      shortfall: error.shortfall.toString(),
      waitSeconds: error.estimate?._tag === 'Reachable' && error.estimate.seconds !== undefined ? Number(error.estimate.seconds) : null,
    };
  }
}

// ---------------------------------------------------------------- history ---
const STATUS = { SUCCESS: 'finalized', PARTIAL_SUCCESS: 'finalized', FAILURE: 'failed' };

function historyStatus(entry, lifecycle) {
  if (entry.lifecycle?.status === 'rejected') return 'failed';
  if (entry.lifecycle?.status === 'finalized') return STATUS[entry.status] ?? 'finalized';
  const live = lifecycle.find(l => l.identifiers.some(id => entry.identifiers.includes(id)));
  return live?.status._tag === 'Confirmed' ? 'confirmed' : 'pending';
}

// A transaction hash; the SDK keys a transaction it cannot hash yet (one not
// proved and bound) by its serialized bytes instead.
const isTxHash = text => /^[0-9a-f]{64}$/i.test(text);

/** What the wallet noted about a dApp's transaction, as history item fields. */
const dappFields = meta => ({
  ...(meta?.action ? { action: meta.action } : {}),
  ...(meta?.calls ? { calls: meta.calls } : {}),
  ...(meta?.deploys ? { deploys: meta.deploys } : {}),
});

/** One history entry as the popup lists it. `mine` is the set of this
 *  wallet's own unshielded address forms (Bech32m and hex), to tell its
 *  outputs from others'. `meta` is what the wallet noted when it made the
 *  transaction itself: its kind ('send', 'dust' with `action`, 'dapp' with
 *  `action`, `calls` and `deploys`, or 'offer'), the site that asked, and
 *  the fee. A swap offer is a finalized transaction this wallet hands to the
 *  site and never submits: the SDK only records it once it releases the
 *  offer's coins, and then under its bytes, so it is shown by its first
 *  identifier, as 'offered' until then and 'expired' after. */
export function historyItem(entry, { lifecycle = [], mine = null, meta = null }) {
  const totals = new Map();
  const add = (kind, type, amount) => {
    const key = `${kind}:${type}`;
    totals.set(key, { kind, type, amount: (totals.get(key)?.amount ?? 0n) + amount });
  };
  for (const c of entry.shielded?.receivedCoins ?? []) add('shielded', c.type, BigInt(c.value));
  for (const c of entry.shielded?.spentCoins ?? []) add('shielded', c.type, -BigInt(c.value));
  // The SDK's shielded history leaves out the change a transaction pays back
  // to this wallet, so a shielded spend reads as the whole coin spent. For a
  // transfer the wallet made itself, what left it is what it sent.
  if (meta?.sent?.some(o => o.kind === 'shielded')) {
    for (const key of [...totals.keys()]) if (key.startsWith('shielded:')) totals.delete(key);
    for (const o of meta.sent) if (o.kind === 'shielded') add('shielded', o.type, -BigInt(o.amount));
  }
  for (const u of entry.unshielded?.createdUtxos ?? []) if (!mine || mine.has(u.owner)) add('unshielded', u.tokenType, BigInt(u.value));
  for (const u of entry.unshielded?.spentUtxos ?? []) if (!mine || mine.has(u.owner)) add('unshielded', u.tokenType, -BigInt(u.value));
  // DUST is not a coin whose value a history entry carries (it grows and
  // decays); what the wallet loses to a transaction it paid for is the fee.
  // The SDK fills `fees` once the indexer reports the transaction; until then
  // a transaction this wallet made shows the fee it noted when sending.
  const fee = entry.fees ?? (meta?.fee !== undefined && meta?.fee !== null ? BigInt(meta.fee) : null);
  // A fee the wallet noted is one it paid itself, even when the SDK's entry
  // has no DUST section for the transaction (seen for a site's transfer).
  const paidHere = (entry.dust?.spentUtxos?.length ?? 0) > 0 || (meta?.fee !== undefined && meta?.fee !== null && BigInt(meta.fee) > 0n);
  if (paidHere && fee) add('dust', 'dust', -BigInt(fee));
  const deltas = [...totals.values()].filter(d => d.amount !== 0n).map(d => ({ ...d, amount: d.amount.toString() }));
  const finalized = entry.lifecycle?.status === 'finalized' ? entry.lifecycle.finalizedBlock : undefined;
  const when = finalized?.timestamp ?? entry.timestamp ?? entry.lifecycle?.submittedAt ?? entry.lifecycle?.rejectedAt;
  // Without a note from the wallet itself, the kind is read off the deltas:
  // tokens out is a send, tokens in a receive; anything else (a contract call
  // paid in DUST, a registration made elsewhere) is 'other'.
  const derived = deltas.some(d => d.kind !== 'dust' && d.amount.startsWith('-')) ? 'send'
    : deltas.some(d => d.kind !== 'dust') ? 'receive' : 'other';
  const offer = meta?.kind === 'offer';
  // An offer someone took is a transaction on chain like any other; one that
  // never was is reported by the SDK as rejected when it releases its coins.
  let status = historyStatus(entry, lifecycle);
  if (offer && !isTxHash(entry.hash)) status = entry.lifecycle?.status === 'rejected' ? 'expired' : 'offered';
  return {
    hash: isTxHash(entry.hash) ? entry.hash : (meta?.id ?? entry.identifiers[0] ?? entry.hash),
    status,
    partial: entry.status === 'PARTIAL_SUCCESS',
    time: when ? new Date(when).getTime() : (meta?.at ?? null),
    block: finalized?.height ?? null,
    kind: meta?.kind ?? derived,
    ...(meta?.kind === 'dust' && meta.action ? { action: meta.action } : {}),
    ...dappFields(meta),
    // An offer's balance change is what the wallet noted when it made it:
    // the SDK records nothing of a transaction that never reached a block.
    deltas: offer && !deltas.length && meta.deltas ? meta.deltas : deltas,
    fee: fee === null || fee === undefined ? null : BigInt(fee).toString(),
    origin: meta?.origin ?? null,
    identifiers: [...entry.identifiers],
  };
}

/** A swap offer the wallet noted that the SDK has no entry for yet. */
const offerItem = (id, meta) => ({
  hash: id, status: 'offered', partial: false, time: meta.at ?? null, block: null, kind: 'offer',
  deltas: meta.deltas ?? [], fee: meta.fee ?? null, origin: meta.origin ?? null, identifiers: meta.ids ?? [id],
});

/**
 * The SDK's history, newest first, as history items. Entries the SDK keys by
 * serialized bytes are transactions that never left the wallet (a preview
 * the user cancelled, a request a site's user rejected, a proof that
 * failed): the SDK records their coins' release as a rejection, but they are
 * not transactions anyone saw, so they are left out. Swap offers are the
 * exception: they are kept, by identifier, with the offers the SDK has not
 * recorded yet.
 */
export async function historyItems(wallet, state, txMeta = {}) {
  const entries = await wallet.facade.getAllFromTxHistory();
  const lifecycle = state?.lifecycle ?? [];
  const mine = state ? new Set([state.unshielded.address.hexString, MidnightBech32m.encode(wallet.networkId, state.unshielded.address).asString()]) : null;
  const metaFor = e => txMeta[e.hash] ?? e.identifiers.map(id => txMeta[id]).find(Boolean) ?? null;
  const items = [];
  const recorded = new Set();
  for (const e of entries) {
    const meta = metaFor(e);
    if (!isTxHash(e.hash) && meta?.kind !== 'offer') continue;
    if (meta?.kind === 'offer') recorded.add(meta.id);
    items.push(historyItem(e, { lifecycle, mine, meta }));
  }
  for (const [id, meta] of Object.entries(txMeta)) {
    if (meta.kind === 'offer' && meta.id === id && !recorded.has(id)) items.push(offerItem(id, meta));
  }
  return items.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity));
}

/** Everything the SDK has on one history entry, as JSON. */
export async function historyDetail(wallet, state, hashOrId, txMeta = {}) {
  const entries = await wallet.facade.getAllFromTxHistory();
  const entry = entries.find(e => e.hash === hashOrId || e.identifiers.includes(hashOrId));
  if (!entry) {
    // An offer the SDK has not recorded is known only from the wallet's note.
    const meta = txMeta[hashOrId];
    return meta?.kind === 'offer' ? { ...offerItem(meta.id, meta), size: meta.size ?? null, raw: null, described: null } : null;
  }
  const item = (await historyItems(wallet, state, txMeta)).find(i => i.identifiers.some(id => entry.identifiers.includes(id)) || i.hash === entry.hash);
  if (!item) return null;
  const lifecycle = (state?.lifecycle ?? []).find(l => l.identifiers.some(id => entry.identifiers.includes(id)));
  let raw = null, size = null, described = null;
  const handle = lifecycle?.transaction?._tag === 'Some' ? lifecycle.transaction.value : null;
  if (handle) {
    const bytes = handle.serialize();
    raw = hex(bytes);
    size = bytes.length;
    try { described = describeLedgerTransaction(ledgerTransaction(handle), state); } catch { described = null; }
  }
  return {
    ...item,
    identifiers: [...entry.identifiers],
    protocolVersion: entry.protocolVersion ?? null,
    sdkStatus: entry.status ?? null,
    lifecycle: entry.lifecycle ? JSON.parse(JSON.stringify(entry.lifecycle)) : null,
    shielded: jsonable(entry.shielded ?? null),
    unshielded: jsonable(entry.unshielded ?? null),
    dust: jsonable(entry.dust ?? null),
    lifecycleStatus: lifecycle ? jsonable(lifecycle.status) : null,
    size, raw, described,
  };
}

/** Deep copy with bigints as decimal strings, bytes as hex, dates as ms. */
export function jsonable(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof Date) return value.getTime();
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), jsonable(v)]));
  if (Array.isArray(value)) return value.map(jsonable);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  return value;
}

// --------------------------------------------------------------- describe ---
const STAGES = { unsealed: 'Unbound', sealed: 'Finalized', unproven: 'Unproven' };
const entryPointName = e => {
  if (typeof e === 'string') return e;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(e);
  return /^[\x20-\x7e]+$/.test(text) ? text : hex(e);
};

/** What a ledger transaction does, as far as the ledger API exposes it, and
 *  how it moves this wallet's unshielded tokens. */
export function describeLedgerTransaction(tx, state) {
  // Ledger-v9 verifying keys are { tag, value } records: compare the values.
  const keyText = key => (key && typeof key === 'object' ? `${key.tag}:${key.value}` : String(key));
  const vk = state?.unshielded.verifyingKey;
  const myKey = state ? keyText(typeof vk === 'function' ? vk.call(state.unshielded) : vk) : null;
  const myAddress = state ? state.unshielded.address.hexString : null;
  const contractCalls = [], deploys = [], maintenance = [], unshieldedInputs = [], unshieldedOutputs = [];
  let dustSpends = 0, dustRegistrations = 0, fee = 0n;
  for (const [segment, intent] of tx.intents ?? []) {
    for (const action of intent.actions) {
      if ('entryPoint' in action) contractCalls.push({ segment, address: action.address, entryPoint: entryPointName(action.entryPoint) });
      else if ('initialState' in action) deploys.push({ segment, address: action.address });
      else maintenance.push({ segment, address: action.address });
    }
    for (const [offer, guaranteed] of [[intent.guaranteedUnshieldedOffer, true], [intent.fallibleUnshieldedOffer, false]]) {
      for (const i of offer?.inputs ?? []) {
        unshieldedInputs.push({ segment, guaranteed, type: i.type, amount: i.value.toString(), owner: keyText(i.owner), mine: keyText(i.owner) === myKey,
          ref: `${i.intentHash}#${i.outputNo}` });
      }
      for (const o of offer?.outputs ?? []) {
        unshieldedOutputs.push({ segment, guaranteed, type: o.type, amount: o.value.toString(), owner: o.owner, mine: o.owner === myAddress });
      }
    }
    for (const spend of intent.dustActions?.spends ?? []) { dustSpends++; fee += spend.vFee; }
    dustRegistrations += intent.dustActions?.registrations?.length ?? 0;
  }
  const offers = [tx.guaranteedOffer, ...(tx.fallibleOffer?.values() ?? [])].filter(Boolean);
  const shielded = {
    inputs: sum(offers.map(o => BigInt(o.inputs.length))).toString(),
    outputs: sum(offers.map(o => BigInt(o.outputs.length))).toString(),
    transients: sum(offers.map(o => BigInt(o.transients.length))).toString(),
  };
  const net = new Map();
  for (const i of unshieldedInputs) if (i.mine) net.set(i.type, (net.get(i.type) ?? 0n) - BigInt(i.amount));
  for (const o of unshieldedOutputs) if (o.mine) net.set(o.type, (net.get(o.type) ?? 0n) + BigInt(o.amount));
  const deltas = [...net].filter(([, a]) => a !== 0n).map(([type, amount]) => ({ kind: 'unshielded', type, amount: amount.toString() }));
  if (fee > 0n) deltas.push({ kind: 'dust', type: 'dust', amount: (-fee).toString() });
  const imbalances = [];
  for (const segment of [0, ...(tx.intents?.keys() ?? [])].filter((v, i, a) => a.indexOf(v) === i)) {
    try {
      for (const [type, amount] of tx.imbalances(segment)) if (amount !== 0n) imbalances.push({ segment, type: jsonable(type), amount: amount.toString() });
    } catch { /* a segment the transaction does not have */ }
  }
  // An unproven transaction (a part a recipe has not proved yet) has no hash.
  const attempt = fn => { try { return fn(); } catch { return null; } };
  return {
    hash: attempt(() => tx.transactionHash()), identifiers: attempt(() => tx.identifiers()) ?? [],
    contractCalls, deploys, maintenance,
    unshielded: { inputs: unshieldedInputs, outputs: unshieldedOutputs },
    shielded, dust: { spends: dustSpends, registrations: dustRegistrations },
    imbalances, deltas, fee: fee.toString(),
  };
}

/** describeTx for hex bytes from outside the wallet (a dApp): read with the
 *  ledger version the facade is acting at, then described. `fee` is what the
 *  transaction already pays in DUST; `estimatedFee` is the SDK's estimate of
 *  what it costs once this wallet balances it. */
export async function describeTransaction(wallet, txHex, stage, state) {
  const sdkStage = STAGES[stage];
  if (!sdkStage) throw new Error('stage is unsealed or sealed');
  if (typeof txHex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(txHex)) throw new Error('tx is a hex string');
  const handle = wallet.facade.adoptTransaction(unhex(txHex), sdkStage);
  const described = describeLedgerTransaction(ledgerTransaction(handle), state);
  let estimatedFee = null;
  try { estimatedFee = (await wallet.facade.estimateTransactionFee(handle)).toString(); } catch { /* not balanceable as is */ }
  return { stage, ...described, estimatedFee, size: txHex.length / 2 };
}

// ------------------------------------------------------------------- tip ---
/** The indexer's latest block height, or null. */
export async function indexerTip(indexerHttpUrl) {
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }), signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    const height = Number(body?.data?.block?.height);
    return Number.isFinite(height) ? height : null;
  } catch { return null; }
}
