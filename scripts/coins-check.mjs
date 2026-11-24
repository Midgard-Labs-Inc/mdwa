#!/usr/bin/env node
// Checks which unshielded outputs the wallet spends (wallet/coins.mjs) under
// Node. It needs no network and no browser.
//
//   node scripts/coins-check.mjs
//
// Covered: the smallest output that covers what is missing; the largest when
// none does; outputs of other tokens ignored; nothing without an output of the
// token; and the SDK's own balancer, set up as the unshielded wallet sets it
// up, spending one output where a single one covers the amount.
import assert from 'node:assert/strict';
import { Imbalances, getBalanceRecipe } from '@midnightntwrk/wallet-sdk/capabilities';
import { fewestInputs } from '../wallet/coins.mjs';

let checks = 0;
const ok = (label, fn) => { fn(); checks++; console.log(`ok  ${label}`); };

const NIGHT = '0'.repeat(64);
const OTHER = '1'.repeat(64);
let n = 0;
const output = (value, type = NIGHT) => ({ type, value, intentHash: 'ab'.repeat(32), outputNo: n++ });
const [two, nine, big] = [output(2n), output(9n), output(280n)];
const coins = [big, two, output(500n, OTHER), nine];

ok('the smallest output that covers the amount', () => {
  assert.equal(fewestInputs(coins, NIGHT, -5n), nine);
  assert.equal(fewestInputs(coins, NIGHT, -9n), nine);
  assert.equal(fewestInputs(coins, NIGHT, -10n), big);
  assert.equal(fewestInputs(coins, NIGHT, -2n), two);
});
ok('the largest output when none covers the amount', () => assert.equal(fewestInputs(coins, NIGHT, -281n), big));
ok('outputs of other tokens are ignored', () => {
  assert.equal(fewestInputs(coins, NIGHT, -400n), big);
  assert.equal(fewestInputs(coins, OTHER, -5n).type, OTHER);
});
ok('nothing without an output of the token', () => {
  assert.equal(fewestInputs(coins, '2'.repeat(64), -1n), undefined);
  assert.equal(fewestInputs([], NIGHT, -1n), undefined);
});
ok('the SDK\'s balancer spends one output of {2, 280} for 5', () => {
  const recipe = getBalanceRecipe({
    coins: [two, big],
    initialImbalances: Imbalances.fromEntries([[NIGHT, -5n]]),
    feeTokenType: '',
    transactionCostModel: { inputFeeOverhead: 0n, outputFeeOverhead: 0n },
    coinSelection: fewestInputs,
    createOutput: coin => coin,
    isCoinEqual: (a, b) => a.intentHash === b.intentHash && a.outputNo === b.outputNo,
  });
  assert.deepEqual(recipe.inputs, [big]);
  assert.deepEqual(recipe.outputs, [{ type: NIGHT, value: 275n }]);
});

console.log(`\n${checks} checks passed`);
