// The wallet birthday: where on the chain a wallet's shielded sync starts.
//
// The shielded wallet finds its coins by replaying every zswap event of the
// chain with its keys. A wallet that cannot have received anything before
// some point (a phrase generated just now, or a restore the user dates) does
// not need the events before it: the Merkle tree they built is all it needs,
// and the indexer hands that over in one piece as a collapsed update. This
// module asks the indexer where that point is. Turning the answer into a
// wallet is midnight.js's job (startShieldedAtAnchor).
//
// A birthday is stored as a block height (and that block's time, to show).
// What the shielded sync starts from is an anchor: the last zswap output
// event at or before that block, its event id and its Merkle index. Event
// ids are the indexer's database ids, so an anchor is worked out again from
// the height against the indexer in use whenever a wallet starts afresh, and
// never stored.
import * as ledger from '@midnightntwrk/ledger-v9';
import * as ledgerV8 from '@midnightntwrk/ledger-v8';

const TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A GraphQL query against the indexer's HTTP endpoint. A GraphQL error is
 *  thrown with the indexer's own message. */
export async function gql(indexerHttp, query, variables = {}) {
  const response = await fetch(indexerHttp, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`The indexer answered ${response.status}: ${text.slice(0, 200)}`); }
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
  if (!response.ok) throw new Error(`The indexer answered ${response.status}`);
  return body.data;
}

const BLOCK_FIELDS = 'height timestamp protocolVersion zswapEndIndex';

/** The block at `height`, or the tip when `height` is null; null if none. */
async function block(indexerHttp, height = null) {
  const data = height === null
    ? await gql(indexerHttp, `{ block { ${BLOCK_FIELDS} } }`)
    : await gql(indexerHttp, `query ($h: Int!) { block(offset: { height: $h }) { ${BLOCK_FIELDS} } }`, { h: height });
  return data.block ?? null;
}

/** The lowest height in [lo, hi] for which `test` holds, given that it holds
 *  at `hi` and, once it holds, holds for every greater height. */
async function lowestWhere(lo, hi, test) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await test(mid)) hi = mid; else lo = mid + 1;
  }
  return hi;
}

/**
 * Parses a 'YYYY-MM-DD' date the user picked as the instant the wallet's
 * scan starts from: 00:00 UTC of that day. Starting at the beginning of the
 * day in UTC (rather than in the browser's time zone, or at the day's end)
 * means the wallet never starts later than any reading of "that day" the
 * user could have meant, so a coin received on the chosen day is found
 * wherever the user lives. Throws on a malformed date or one in the future.
 */
export function birthdayInstant(date, now = Date.now()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!match || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error('The wallet birthday is not a date');
  // A day that has not started yet anywhere on Earth (UTC+14) is in the
  // future; the popup bounds the picker to the browser's own today.
  if (time > now + DAY_MS) throw new Error('The wallet birthday cannot be in the future');
  return time;
}

/**
 * The birthday block of a wallet, as `{ height, time }` (`time` the block's
 * timestamp in ms), or null for "from the start of the chain".
 *
 * Without `date`, the chain's tip (a wallet created now). With a date
 * (YYYY-MM-DD), the last block at or before 00:00 UTC of that day (see
 * birthdayInstant): a day before the chain's first block means the start; a
 * day after the tip means the tip.
 */
export async function birthdayBlock(indexerHttp, date = null) {
  const tip = await block(indexerHttp);
  if (!tip) return null;   // a chain without blocks: nothing to skip
  if (date === null) return { height: tip.height, time: tip.timestamp };
  const instant = birthdayInstant(date);
  if (tip.timestamp <= instant) return { height: tip.height, time: tip.timestamp };
  const first = await block(indexerHttp, 0);
  if (!first || first.timestamp > instant) return null;
  // The first block after the instant, then the one before it. Block
  // timestamps never go down along the chain.
  const after = await lowestWhere(0, tip.height, async h => (await block(indexerHttp, h)).timestamp > instant);
  const at = await block(indexerHttp, after - 1);
  return { height: at.height, time: at.timestamp };
}

/**
 * The anchor a shielded wallet born at block `height` starts from:
 * `{ height, eventId, mtIndex, protocolVersion }` for the last zswap output
 * at or before that block, or null when the chain has none by then (so there
 * is nothing to skip and the wallet starts at the beginning).
 *
 * `forkV9` is the protocol version at which the chain changes to ledger 9:
 * events from before it are read with ledger 8.
 *
 * The block's `zswapEndIndex` is the size of the zswap Merkle tree after it
 * (the first free index). The block that added the tree's last leaf is the
 * lowest one with the same end index; its last zswap output event must be
 * that leaf (Merkle index end - 1), which is checked, so an indexer that
 * answers inconsistently fails here rather than producing a wallet with a
 * wrong tree.
 */
export async function shieldedAnchor(indexerHttp, height, forkV9) {
  const at = await block(indexerHttp, height);
  if (!at) throw new Error(`The indexer has no block ${height}`);
  const end = at.zswapEndIndex;
  if (!end) return null;
  const leafHeight = await lowestWhere(0, at.height, async h => (await block(indexerHttp, h)).zswapEndIndex >= end);
  const data = await gql(indexerHttp,
    'query ($h: Int!) { block(offset: { height: $h }) { transactions { zswapLedgerEvents { id raw protocolVersion } } } }', { h: leafHeight });
  let anchor = null;
  for (const tx of data.block?.transactions ?? []) {
    for (const e of tx.zswapLedgerEvents ?? []) {
      const Ledger = BigInt(e.protocolVersion) >= forkV9 ? ledger : ledgerV8;
      const event = Ledger.Event.deserialize(hexBytes(e.raw));
      if (event.content.tag === 'zswapOutput' && (!anchor || e.id > anchor.eventId)) {
        anchor = { height: leafHeight, eventId: e.id, mtIndex: BigInt(event.content.mtIndex), protocolVersion: BigInt(e.protocolVersion) };
      }
    }
  }
  if (!anchor || anchor.mtIndex !== BigInt(end) - 1n) {
    throw new Error(`The indexer's block ${leafHeight} does not end the zswap tree at ${end - 1} (found ${anchor ? anchor.mtIndex : 'no output'})`);
  }
  return anchor;
}

/** The serialized zswap Merkle tree collapsed over [0, mtIndex], as bytes. */
export async function zswapCollapsedUpdate(indexerHttp, mtIndex) {
  const data = await gql(indexerHttp,
    'query ($s: Int!, $e: Int!) { zswapMerkleTreeCollapsedUpdate(startIndex: $s, endIndex: $e) { update protocolVersion } }',
    { s: 0, e: Number(mtIndex) });
  const update = data.zswapMerkleTreeCollapsedUpdate;
  if (!update?.update) throw new Error('The indexer returned no collapsed update');
  return { bytes: hexBytes(update.update), protocolVersion: BigInt(update.protocolVersion) };
}

// What the wallet's sync asks the indexer for, by GraphQL root type: the
// shielded and unshielded sync, and the DUST sync where there is DUST (on a
// network without it, the stand-in DUST wallet asks nothing). The
// shielded collapsed update is only needed for a birthday and is checked
// where it is used.
const REQUIRED = { Query: ['block'], Subscription: ['zswapLedgerEvents', 'unshieldedTransactions'] };
const DUST_REQUIRED = { Query: ['dustCommitmentMerkleTreeUpdate'], Subscription: ['dustGenerations', 'dustNullifierTransactions'] };

/**
 * The queries the wallet's sync needs that the indexer says it does not
 * offer, as 'Subscription.dustGenerations'-style names; [] when it offers
 * them all, null when it does not say (introspection off or failing). The
 * SDK retries a failing query forever without reporting it, so this is how a
 * third-party indexer that lacks one becomes a readable error instead of a
 * sync that never ends. Without `dust`, the DUST queries are not needed.
 */
export async function missingQueries(indexerHttp, { dust = true } = {}) {
  let data;
  try {
    data = await gql(indexerHttp, '{ q: __type(name: "Query") { fields { name } } s: __type(name: "Subscription") { fields { name } } }');
  } catch { return null; }
  const offered = { Query: data?.q?.fields?.map(f => f.name), Subscription: data?.s?.fields?.map(f => f.name) };
  if (!offered.Query || !offered.Subscription) return null;
  return Object.entries(REQUIRED).flatMap(([root, names]) => [...names, ...(dust ? DUST_REQUIRED[root] : [])]
    .filter(n => !offered[root].includes(n)).map(n => `${root}.${n}`));
}

const hexBytes = text => Uint8Array.from(String(text).match(/../g) ?? [], b => parseInt(b, 16));
