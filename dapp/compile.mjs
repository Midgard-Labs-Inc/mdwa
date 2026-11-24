#!/usr/bin/env node
// Compiles the test dApp's contract (dapp/contract/counter.compact) with
// Compact compiler 0.36.1 into dapp/contract/managed (contract module, ZKIR,
// keys; about 200 kB, so the output is kept in the repository and the dApp
// needs no compiler to run). The machine's default compiler is left alone:
// the version is named on the command line (`compact compile +0.36.1`).
//
//   npm run dapp:contract
//
// Public parameters come from ~/.cache/midnight/zk-params (MIDNIGHT_PP), as
// the compiler's own download would put them; set MIDNIGHT_ZK_PARAMS to use
// another directory.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPACT_VERSION = '0.36.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const compact = process.env.COMPACT ?? path.join(homedir(), '.local/bin/compact');
const params = process.env.MIDNIGHT_ZK_PARAMS ?? path.join(homedir(), '.cache/midnight/zk-params');
const out = path.join(here, 'contract/managed');

rmSync(out, { recursive: true, force: true });
const result = spawnSync(compact, ['compile', `+${COMPACT_VERSION}`, path.join(here, 'contract/counter.compact'), out], {
  stdio: 'inherit', env: { ...process.env, MIDNIGHT_PP: params },
});
if (result.status !== 0) throw new Error(`compact compile +${COMPACT_VERSION} failed (${result.status ?? result.error})`);
console.log(`Compiled with compactc ${COMPACT_VERSION}: ${path.relative(path.dirname(here), out)}`);
