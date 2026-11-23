#!/usr/bin/env node
// Checks how the wallet's sync reacts to an indexer that drops blocks
// (extension/src/midnight.js, "rewind") under Node against an in-process stub
// of an indexer's GraphQL WebSocket. It needs no network and no browser.
//
//   node scripts/rewind-check.mjs
//
// Covered: the SDK's own unshielded sync service, wrapped as the wallet wraps
// it, over the SDK's own WebSocket client: an indexer's CHAIN_REWOUND ends
// the stream quietly and calls onRewound once; any other GraphQL error still
// fails the stream, for the SDK's retry.
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { Effect, Fiber, Stream } from 'effect';
import { Sync as UnshieldedSync } from '@midnightntwrk/wallet-sdk/unshielded/v2';
import { isChainRewound, rewindAware } from '../extension/src/midnight.js';

let checks = 0;
const ok = async (label, fn) => { await fn(); checks++; console.log(`ok  ${label}`); };

// ------------------------------------------------------------- the stub ---
// graphql-transport-ws: every subscription is answered with `stub.error`, then
// `complete`, as such an indexer answers a subscription resumed from an id it
// no longer knows.
const stub = { error: null, subscribed: 0 };
const server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: protocols => (protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false) });
server.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(String(raw));
  if (message.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
  if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
  if (message.type === 'subscribe') {
    stub.subscribed++;
    socket.send(JSON.stringify({ type: 'next', id: message.id, payload: { data: null, errors: [stub.error] } }));
    socket.send(JSON.stringify({ type: 'complete', id: message.id }));
  }
}));
await new Promise(r => server.on('listening', r));
const { port } = server.address();
const config = {
  networkId: 'undeployed',
  indexerClientConnection: { indexerHttpUrl: `http://127.0.0.1:${port}/graphql`, indexerWsUrl: `ws://127.0.0.1:${port}/graphql/ws` },
};
// What the sync service reads of an unshielded wallet's state to subscribe.
const walletState = {
  progress: { appliedId: 6617455915907672n },
  publicKey: { address: 'mn_addr_undeployed1gkasr3z3vwyscy2jpp53nzr37v7n4r3lsfgj6v5g584dakjzt0xqun4d4r' },
  protocolVersion: 0n,
};
const REWOUND = { message: 'the indexed chain changed branch; resync from a known checkpoint', extensions: { code: 'CHAIN_REWOUND', safeHeight: 13, safeHash: 'ab'.repeat(32) } };

// -------------------------------------------------------------- checks ---
await ok('CHAIN_REWOUND ends the unshielded sync quietly and calls onRewound once', async () => {
  stub.error = REWOUND;
  stub.subscribed = 0;
  let calls = 0;
  let told;
  const rewound = new Promise(r => { told = r; });
  const service = rewindAware(UnshieldedSync.makeDefaultSyncService, () => { calls++; told(); })(config);
  const fiber = Effect.runFork(Stream.runDrain(service.updates(walletState)));
  await Promise.race([rewound, new Promise((_, reject) => setTimeout(() => reject(new Error('onRewound was not called')), 10000))]);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(calls, 1);
  assert.equal(stub.subscribed, 1);
  // The stream neither failed nor ended: the SDK has nothing to retry.
  assert.equal(fiber.unsafePoll(), null);
  await Effect.runPromise(Fiber.interrupt(fiber));
});

await ok('another GraphQL error still fails the stream, and is not a rewind', async () => {
  stub.error = { message: 'the index could not be read', extensions: { code: 'INDEX_READ' } };
  let calls = 0;
  const service = rewindAware(UnshieldedSync.makeDefaultSyncService, () => { calls++; })(config);
  const failure = await Effect.runPromise(Effect.flip(Stream.runDrain(service.updates(walletState))));
  assert.equal(calls, 0);
  assert.equal(isChainRewound(failure), false);
  assert.match(String(failure.message ?? failure), /could not be read/);
});

await ok('the code is read from the error the SDK fails with, at any depth of causes', () => {
  assert.equal(isChainRewound({ cause: { cause: [REWOUND] } }), true);
  assert.equal(isChainRewound(new Error('socket closed')), false);
  assert.equal(isChainRewound(null), false);
});

server.close();
console.log(`\n${checks} checks passed`);
