#!/usr/bin/env node
// Drives the engine's Midnight logic (extension/src/midnight.js) under Node
// against a real network: a fresh recovery phrase, sync to the tip, addresses
// and balances, then a snapshot and a resume from it. A fresh phrase is a new
// wallet, so it is born at the chain's tip as the extension's are (see
// extension/src/birthday.js); with --seed it scans from the start.
//
//   node scripts/smoke.mjs [--network preview]
//   [--node ws://host:port] [--indexer http://host:port] [--proof-server http://host:port]
//
// --indexer is the indexer's origin; its /api/v4/graphql paths are added.
//
// With --seed <hex> (a master seed, e.g. a local devnet's funded genesis seed
// on --network undeployed) it also sends NIGHT and a shielded token to a fresh
// second wallet, which registers its NIGHT for DUST generation and then
// deregisters it; those need funds.
import { firstValueFrom, filter, timeout } from 'rxjs';
import {
  addressesOf, buildDustAction, buildTransfer, checkAddress, completeRecipe, deriveAddresses, generateMnemonic,
  historyItems, NIGHT, openWallet, overviewOf, seedFromMnemonic, syncOf,
} from '../extension/src/midnight.js';
import { birthdayBlock } from '../extension/src/birthday.js';
import { endpointsOf, network as networkOf } from '../wallet/networks.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const net = networkOf(args.network ?? 'preview');
const endpoints = endpointsOf(net, {
  ...(args.node ? { node: args.node } : {}),
  ...(args.indexer ? {
    indexerHttp: `${args.indexer}/api/v4/graphql`,
    indexerWs: `${args.indexer.replace(/^http/, 'ws')}/api/v4/graphql/ws`,
  } : {}),
  ...(args['proof-server'] ? { prover: { kind: 'server', url: args['proof-server'] } } : {}),
});
const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const json = value => JSON.stringify(value, null, 2);

async function synced(wallet, label) {
  let last = 0;
  const sub = wallet.facade.state().subscribe(s => {
    if (Date.now() - last < 15000) return;
    last = Date.now();
    log(label, json(syncOf(s)));
  });
  try {
    return await firstValueFrom(wallet.facade.state().pipe(filter(s => s.isSynced), timeout(20 * 60 * 1000)));
  } finally { sub.unsubscribe(); }
}

let seed;
if (args.seed) {
  seed = Uint8Array.from(args.seed.match(/../g), b => parseInt(b, 16));
  log('master seed given on the command line');
} else {
  const words = generateMnemonic();
  if (words.length !== 24) throw new Error('expected 24 words');
  seed = await seedFromMnemonic(words);
  log(`fresh recovery phrase (${words.length} words) -> ${seed.length}-byte seed`);
}
const derived = deriveAddresses(seed, net);

const birthday = args.seed ? null : await birthdayBlock(endpoints.indexerHttp);
log('wallet birthday', json(birthday));
const first = await openWallet({ net, endpoints, seed, birthday });
log('shielded sync starts from', json(first.shieldedStart));
const s1 = await synced(first, 'first sync');
log('synced');
const overview = overviewOf(s1, first.networkId);
log('overview', json(overview));
for (const key of Object.keys(derived)) {
  if (derived[key] !== overview.addresses[key]) throw new Error(`derived ${key} differs from the facade's: ${derived[key]} vs ${overview.addresses[key]}`);
}
log('addresses derived from the seed match the synced facade');
for (const kind of ['unshielded', 'shielded', 'dust']) {
  const check = checkAddress(first.networkId, overview.addresses[kind]);
  log(`checkAddress(${kind}, ${overview.addresses[kind].length} chars)`, json(check));
  if (!check.valid || check.kind !== kind) throw new Error(`checkAddress failed for ${kind}`);
}
if (!args.seed && (overview.night.available !== '0' || overview.dust.balance !== '0')) throw new Error('a fresh wallet should hold nothing');
log('history (latest 3)', json((await historyItems(first, s1)).slice(0, 3)));

const snapshot = await first.serialize();
log('snapshot sizes', json(Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, String(v).length]))));
await first.stop();
log('stopped; resuming from the snapshot');

const resumed = await openWallet({ net, endpoints, seed, snapshot, birthday });
const resumeStarted = Date.now();
const s2 = await synced(resumed, 'resume');
log(`resumed and synced in ${((Date.now() - resumeStarted) / 1000).toFixed(1)}s`, json(resumed.started));
if (Object.values(resumed.started).some(how => how !== 'snapshot')) throw new Error('a wallet part did not resume from the snapshot');
const again = overviewOf(s2, resumed.networkId);
if (json(again.addresses) !== json(overview.addresses)) throw new Error('addresses changed across the resume');
log('balances after resume', json({ night: again.night, unshielded: again.unshielded, shielded: again.shielded, dust: again.dust }));

if (args.seed) {
  // Funded flows: send NIGHT (unshielded) and a shielded token to a fresh
  // second wallet, which then registers its NIGHT for DUST generation and
  // deregisters it again.
  const other = await openWallet({ net, endpoints, seed: await seedFromMnemonic(generateMnemonic()) });
  const o1 = await synced(other, 'second wallet');
  const to = overviewOf(o1, other.networkId).addresses;
  const shieldedToken = again.shielded.find(t => t.type !== again.unshielded[0]?.type)?.type ?? again.shielded[0].type;
  const built = await buildTransfer(resumed, [
    { type: NIGHT, amount: '100000000000', recipient: to.unshielded },
    { type: shieldedToken, amount: '1000', recipient: to.shielded },
  ]);
  log('transfer preview', json({ outputs: built.outputs, fee: built.fee, ttl: built.ttl }));
  const txId = await completeRecipe(resumed, built.recipe, { onStage: stage => log('stage', stage) });
  log('submitted', txId);
  const received = await firstValueFrom(other.facade.state().pipe(
    filter(s => s.isSynced && (s.unshielded.balances[NIGHT] ?? 0n) > 0n && Object.keys(s.shielded.balances).length > 0),
    timeout(10 * 60 * 1000)));
  log('second wallet received', json(overviewOf(received, other.networkId)));
  log('sender history (latest)', json((await historyItems(resumed, await resumed.facade.waitForSyncedState())).slice(0, 1)));
  log('receiver history', json(await historyItems(other, received)));

  let dust = await buildDustAction(other, 'register');
  log('dust register preview', json({ ...dust, recipe: undefined }));
  if (!dust.canPay) {
    const utxos = received.unshielded.availableCoins.filter(c => c.utxo.type === NIGHT);
    log(`waiting for the NIGHT to generate the ${dust.fee} SPECK fee (${dust.waitSeconds ?? '?'} s)`);
    await other.facade.waitForGeneratedDust(utxos, BigInt(dust.fee), { timeoutMs: ((dust.waitSeconds ?? 600) + 120) * 1000 });
    dust = await buildDustAction(other, 'register');
    log('dust register preview, again', json({ ...dust, recipe: undefined }));
  }
  log('dust registration submitted', await completeRecipe(other, dust.recipe, { sign: false, onStage: stage => log('stage', stage) }));
  const registered = await firstValueFrom(other.facade.state().pipe(
    filter(s => s.isSynced && s.unshielded.availableCoins.some(c => c.meta.registeredForDustGeneration)), timeout(10 * 60 * 1000)));
  log('after registration', json(overviewOf(registered, other.networkId).dust));
  const withDust = await firstValueFrom(other.facade.state().pipe(filter(s => s.isSynced && s.dust.balance(new Date()) > 0n), timeout(10 * 60 * 1000)));
  log('DUST generated', withDust.dust.balance(new Date()).toString());
  // Let a few blocks pass so the DUST paying for the deregistration is settled.
  await new Promise(r => setTimeout(r, 60000));
  const off = await buildDustAction(other, 'deregister');
  log('dust deregister preview', json({ ...off, recipe: undefined }));
  log('deregistration submitted', await completeRecipe(other, off.recipe, { sign: false, onStage: stage => log('stage', stage) }));
  const deregistered = await firstValueFrom(other.facade.state().pipe(
    filter(s => s.isSynced && s.unshielded.availableCoins.length > 0 && !s.unshielded.availableCoins.some(c => c.meta.registeredForDustGeneration)),
    timeout(10 * 60 * 1000)));
  log('after deregistration', json(overviewOf(deregistered, other.networkId).dust));
  log('receiver history', json(await historyItems(other, deregistered)));
  await other.stop();
}
await resumed.stop();
log('done', json(addressesOf(s2, resumed.networkId)));
process.exit(0);
