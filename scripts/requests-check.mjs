#!/usr/bin/env node
// Checks, under Node and without network, the pure parts of what a page may
// ask beyond the connector API (docs/dapp-connector.md, "Beyond the
// standard API"):
//
//   node scripts/requests-check.mjs
//
// Covered: which networks a connect names by network id and endpoint; the
// label rules as applied to a token name a page suggests (watchToken); the
// shielded coins of this wallet a transaction spends and receives, on a
// transaction built with the ledger.
import assert from 'node:assert/strict';
import * as ledger from '@midnightntwrk/ledger-v9';
import { networksMatching, sameEndpoint } from '../wallet/networks.mjs';
import { deriveTokenType, pageLabel } from '../extension/src/tokens.js';
import { describeLedgerTransaction, ownNullifiers, shieldedEffect } from '../extension/src/midnight.js';

let checks = 0;
const ok = (label, fn) => { fn(); checks++; console.log(`ok  ${label}`); };

// ------------------------------------------------------------- networks ---
const networks = [
  { id: 'preprod', networkId: 'preprod', node: 'ws://127.0.0.1:9944' },
  { id: 'user-1', networkId: 'devnet-1', node: 'http://127.0.0.1:8188/v1/submit' },
  { id: 'user-2', networkId: 'devnet-1', node: 'http://127.0.0.1:8189/v1/submit' },
];

ok('an endpoint is its scheme, host, port and path, a trailing slash and a query aside', () => {
  assert.equal(sameEndpoint('ws://127.0.0.1:9944', 'ws://127.0.0.1:9944/'), true);
  assert.equal(sameEndpoint('http://127.0.0.1:8188/v1/submit/', 'http://127.0.0.1:8188/v1/submit?project_id=x'), true);
  assert.equal(sameEndpoint('wss://RPC.example/', 'wss://rpc.example'), true);
  assert.equal(sameEndpoint('ws://127.0.0.1:9944', 'ws://localhost:9944'), false);
  assert.equal(sameEndpoint('ws://127.0.0.1:9944', 'wss://127.0.0.1:9944'), false);
  assert.equal(sameEndpoint('http://127.0.0.1:8188/v1/submit', 'http://127.0.0.1:8188/v1'), false);
  assert.equal(sameEndpoint('not a url', 'not a url'), false);
});

ok('connect names the networks with its network id, narrowed by the endpoint', () => {
  assert.deepEqual(networksMatching(networks, 'devnet-1').map(n => n.id), ['user-1', 'user-2']);
  assert.deepEqual(networksMatching(networks, 'devnet-1', 'http://127.0.0.1:8189/v1/submit/').map(n => n.id), ['user-2']);
  assert.deepEqual(networksMatching(networks, 'preprod', 'ws://127.0.0.1:9944').map(n => n.id), ['preprod']);
  assert.deepEqual(networksMatching(networks, 'preprod', 'ws://127.0.0.1:9945'), []);
  assert.deepEqual(networksMatching(networks, 'mainnet'), []);
});

// --------------------------------------------------------------- labels ---
const tokenType = 'ab'.repeat(32);
const saved = {
  [`shielded:${'cd'.repeat(32)}`]: { type: 'cd'.repeat(32), kind: 'shielded', name: 'Gold', symbol: 'GLD', decimals: 2, source: 'user' },
  [`shielded:${tokenType}`]: { type: tokenType, kind: 'shielded', name: 'Silver', symbol: 'SLV', decimals: 6, source: 'user' },
};

ok('a page\'s label follows the label rules: reserved names, lengths, duplicates', () => {
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'tDUST', symbol: 'X' }), /reserved/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'A token', symbol: 'MIDNIGHT' }), /reserved/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'x'.repeat(33), symbol: 'X' }), /1 to 32/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'gold', symbol: 'AU' }, saved), /already named "Gold"/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'Aurum', symbol: 'gld' }, saved), /symbol GLD/);
  assert.throws(() => pageLabel({ kind: 'both', tokenType, name: 'Aurum', symbol: 'AU' }), /shielded or unshielded/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType: 'ab', name: 'Aurum', symbol: 'AU' }), /64 hex/);
  assert.throws(() => pageLabel({ kind: 'unshielded', tokenType: '0'.repeat(64), name: 'Aurum', symbol: 'AU' }), /NIGHT/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'Aurum', symbol: 'AU', decimals: 1.5 }), /whole number/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'Aurum', symbol: 'AU', decimals: 19 }), /0 to 18/);
});

ok('a symbol left out is the name, when the name fits a symbol', () => {
  assert.equal(pageLabel({ kind: 'shielded', tokenType, name: 'Aurum' }).label.symbol, 'Aurum');
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'A long token name' }), /needs a symbol/);
  assert.equal(pageLabel({ kind: 'shielded', tokenType, name: 'Aurum', symbol: 'AU' }).label.decimals, 0);
});

ok('an identical saved label exists; a different one is replaced', () => {
  const same = pageLabel({ kind: 'shielded', tokenType: tokenType.toUpperCase(), name: 'Silver', symbol: 'SLV', decimals: 6 }, saved);
  assert.deepEqual([same.exists, same.replaces], [true, null]);
  const other = pageLabel({ kind: 'shielded', tokenType, name: 'Silver', symbol: 'SLV', decimals: 3 }, saved);
  assert.deepEqual([other.exists, other.replaces], [false, { name: 'Silver', symbol: 'SLV', decimals: 6 }]);
  assert.equal(pageLabel({ kind: 'unshielded', tokenType, name: 'Silver', symbol: 'SLV', decimals: 6 }, saved).exists, false);
});

ok('a contract and domain separator must produce the token type', () => {
  const address = ledger.sampleContractAddress();
  const domain = new Uint8Array(32).fill(7);
  const minted = deriveTokenType(domain, address);
  const hexDomain = Buffer.from(domain).toString('hex');
  const proved = pageLabel({ kind: 'shielded', tokenType: minted, name: 'Aurum', symbol: 'AU', contract: address, domainSeparator: hexDomain });
  assert.deepEqual(proved.contract, { address, domainSeparator: hexDomain });
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType, name: 'Aurum', symbol: 'AU', contract: address, domainSeparator: hexDomain }), /do not produce/);
  assert.throws(() => pageLabel({ kind: 'shielded', tokenType: minted, name: 'Aurum', symbol: 'AU', contract: address }), /given together/);
  const text = 'mytoken:aurum';
  const fromText = deriveTokenType(new Uint8Array([...new TextEncoder().encode(text), ...new Uint8Array(32 - text.length)]), address);
  assert.equal(pageLabel({ kind: 'shielded', tokenType: fromText, name: 'Aurum', symbol: 'AU', contract: address, domainSeparator: text }).contract.address, address);
  const provedAgain = pageLabel({ kind: 'shielded', tokenType: minted, name: 'Aurum', symbol: 'AU', contract: address, domainSeparator: hexDomain },
    { [`shielded:${minted}`]: { type: minted, kind: 'shielded', name: 'Aurum', symbol: 'AU', decimals: 0, source: 'user' } });
  assert.equal(provedAgain.exists, false, 'a label without the contract is not the same as one proved by it');
});

// ----------------------------------------------------- shielded effects ---
// A wallet holding one coin of 100 spends it, gets 30 back and pays 70 to
// someone else; a coin of another wallet passes through untouched.
const me = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(1));
const other = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(2));
const shieldedType = 'ef'.repeat(32);
const held = ledger.createShieldedCoinInfo(shieldedType, 100n);
const mine = new ledger.ZswapLocalState().insertCoin(me, held);
const [, input] = mine.spend(me, [...mine.coins][0], 0);
const theirs = new ledger.ZswapLocalState().insertCoin(other, ledger.createShieldedCoinInfo(shieldedType, 5n));
const [, theirInput] = theirs.spend(other, [...theirs.coins][0], 0);
const output = (keys, value) => ledger.ZswapOffer.fromOutput(
  ledger.ZswapOutput.new(ledger.createShieldedCoinInfo(shieldedType, value), 0, keys.coinPublicKey, keys.encryptionPublicKey), shieldedType, value);
const offer = ledger.ZswapOffer.fromInput(input, shieldedType, 100n).merge(ledger.ZswapOffer.fromInput(theirInput, shieldedType, 5n))
  .merge(output(me, 30n)).merge(output(other, 75n));
const tx = ledger.Transaction.fromParts('undeployed', offer);
const state = {
  shielded: { availableCoins: [{ coin: { ...held, mt_index: 0n }, nullifier: input.nullifier.toUpperCase() }] },
  unshielded: { verifyingKey: null, address: { hexString: '00'.repeat(32) } },
};

ok('a spend is one of the wallet\'s nullifiers; a receipt is an output its keys decrypt', () => {
  const effect = shieldedEffect(tx, me, ownNullifiers(state));
  assert.deepEqual(effect.spent, [{ type: shieldedType, value: 100n }]);
  assert.deepEqual(effect.received, [{ type: shieldedType, value: 30n }]);
  assert.deepEqual(shieldedEffect(tx, null, ownNullifiers(state)).received, []);
  assert.deepEqual(shieldedEffect(tx, other, new Map()).received, [{ type: shieldedType, value: 75n }]);
});

ok('the description lists the net shielded change with the counts it came from', () => {
  const d = describeLedgerTransaction(tx, state, me);
  assert.deepEqual(d.deltas, [{ kind: 'shielded', type: shieldedType, amount: '-70' }]);
  assert.deepEqual([d.shielded.inputs, d.shielded.outputs, d.shielded.spent, d.shielded.received], ['2', '2', 1, 1]);
  assert.deepEqual(describeLedgerTransaction(tx, null).deltas, []);
});
me.clear();
other.clear();

console.log(`\n${checks} checks passed`);
