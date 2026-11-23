#!/usr/bin/env node
// Checks where a wallet's birthday lands (extension/src/birthday.js) under
// Node against an in-process stub indexer. It needs no network and no
// browser.
//
//   node scripts/birthday-check.mjs
//
// Covered: a new wallet at the tip; an instant (when a phrase was created, as
// the wallet's later networks use, or a restore's date) at the last block at
// or before it, the start before the first block, the tip after it; which
// instant the shared wallet's later networks use: a date stored with the seed
// (a restore's or a rescan's) over when a created phrase was made.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { birthdayBlock, birthdayInstant, sharedInstant } from '../extension/src/birthday.js';

let checks = 0;
const ok = async (label, fn) => { await fn(); checks++; console.log(`ok  ${label}`); };

// A chain of 20 blocks, one every 6 seconds from 1 January 2026 00:00:03 UTC.
const FIRST = Date.UTC(2026, 0, 1, 0, 0, 3);
const TIP = 19;
const blockOf = h => (h >= 0 && h <= TIP ? { height: h, timestamp: FIRST + h * 6000, protocolVersion: 1, zswapEndIndex: 0 } : null);
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const { variables } = JSON.parse(Buffer.concat(chunks));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { block: blockOf(variables?.h ?? TIP) } }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const indexer = `http://127.0.0.1:${server.address().port}/graphql`;
const at = h => ({ height: h, time: blockOf(h).timestamp });

await ok('a new wallet is born at the tip', async () => assert.deepEqual(await birthdayBlock(indexer), at(TIP)));
await ok('a creation time between two blocks gives the block before it', async () => {
  assert.deepEqual(await birthdayBlock(indexer, blockOf(7).timestamp + 5999), at(7));
  assert.deepEqual(await birthdayBlock(indexer, blockOf(7).timestamp), at(7));
});
await ok('a creation time before the first block is the start, one after the tip the tip', async () => {
  assert.equal(await birthdayBlock(indexer, FIRST - 1), null);
  assert.deepEqual(await birthdayBlock(indexer, blockOf(TIP).timestamp + 60000), at(TIP));
});
await ok('a restore date is placed by the same lookup, from 00:00 UTC', async () => {
  assert.equal(await birthdayBlock(indexer, birthdayInstant('2026-01-01')), null);
  assert.deepEqual(await birthdayBlock(indexer, birthdayInstant('2026-01-02')), at(TIP));
});
await ok('the shared wallet\'s later networks use its stored date, created or restored', async () => {
  const createdAt = blockOf(7).timestamp;
  assert.equal(sharedInstant({ restored: false, createdAt, date: null }), createdAt);
  assert.equal(sharedInstant({ restored: true, createdAt, date: null }), null);
  assert.equal(sharedInstant({ restored: false, createdAt, date: '2026-01-02' }), birthdayInstant('2026-01-02'));
  assert.equal(sharedInstant({ restored: true, createdAt, date: '2026-01-02' }), birthdayInstant('2026-01-02'));
});

server.close();
console.log(`\n${checks} checks passed`);
