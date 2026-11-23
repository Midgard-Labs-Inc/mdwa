#!/usr/bin/env node
// Runs the built extension in a real browser under automation and checks the
// engine end to end: it boots, its WASM loads under the extension's CSP, the
// background answers ui('state'), a fresh wallet on Preview syncs, lock and
// unlock work, and the SDK's WASM prover proves a transaction in a worker.
//
//   npm run build:extension && node scripts/browser-check.mjs [--browser /path/to/Chromium] [--only-prove | --only-devnet]
//
// With --devnet-seed <hex> --devnet-node ws://host:port --devnet-indexer
// http://host:port it also funds a fresh extension wallet on that local
// chain (Undeployed) from the given master seed, under Node, then has the
// extension register its NIGHT for DUST, send NIGHT back and list history:
// the funded flows, with proofs made by the engine's WASM prover.
//
// It loads a copy of build/extension with a test page added
// (build/extension-check), in a throwaway profile (.browser-test-profile/),
// and closes the browser when done. Console errors of every extension
// context are printed at the end.
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasmPlugin, forbidPlugin } from './esbuild-plugins.mjs';
import { buildTransfer, completeRecipe, openWallet, overviewOf, NIGHT } from '../extension/src/midnight.js';
import { endpointsOf, network } from '../wallet/networks.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const executablePath = args.browser ?? '/Applications/Helium.app/Contents/MacOS/Helium';
const built = path.join(root, 'build/extension');
const out = path.join(root, 'build/extension-check');
const profile = path.join(root, '.browser-test-profile');
if (!existsSync(path.join(built, 'manifest.json'))) throw new Error('Build the extension first: npm run build:extension');

rmSync(out, { recursive: true, force: true });
cpSync(built, out, { recursive: true });
copyFileSync(path.join(root, 'scripts/browser-check/check.html'), path.join(out, 'check.html'));
await build({
  entryPoints: { check: path.join(root, 'scripts/browser-check/check.js'), 'check-worker': path.join(root, 'scripts/browser-check/check-worker.js') },
  outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'chrome116', keepNames: true, logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  inject: [path.join(root, 'extension/src/buffer-shim.js'), path.join(root, 'extension/src/process-shim.js')],
  plugins: [wasmPlugin({ sync: true, out }), forbidPlugin()],
});

const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const consoleLines = [];
const record = (context, type, text) => {
  consoleLines.push({ context, type, text });
  if (type === 'error' || /Content Security Policy|CompileError|LinkError/i.test(text)) log(`console ${type} [${context}]`, text.slice(0, 400));
};

rmSync(profile, { recursive: true, force: true });
const browser = await puppeteer.launch({
  executablePath, headless: false, enableExtensions: true, pipe: true, userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check'], defaultViewport: null,
  // Proving in the engine can take minutes; page.evaluate waits for it.
  protocolTimeout: 20 * 60 * 1000,
});
const watched = new Set();
let extensionId = null;
async function watch(target) {
  if (watched.has(target)) return;
  watched.add(target);
  const url = target.url();
  // Other extensions (the browser's own) are named with their id, so their
  // messages can be told apart from this one's.
  const name = (extensionId && url.startsWith(`chrome-extension://${extensionId}/`)
    ? url.slice(`chrome-extension://${extensionId}/`.length) : url.replace(/^chrome-extension:\/\//, 'other extension ')) || target.type();
  try {
    if (['service_worker', 'worker', 'shared_worker'].includes(target.type()) || /\.js$/.test(url)) {
      const worker = await target.worker();
      worker?.on('console', m => record(name, m.type(), m.text()));
      return;
    }
    if (!url.startsWith('chrome-extension://')) return;
    const page = await target.asPage();
    page.on('console', m => record(name, m.type(), m.text()));
    page.on('pageerror', e => record(name, 'error', `pageerror: ${e.message}`));
    page.on('error', e => record(name, 'error', `crashed: ${e.message}`));
    page.on('workercreated', w => {
      const wname = `${name} > ${w.url().replace(/^chrome-extension:\/\/[a-z]+\//, '')}`;
      log('worker started', wname);
      w.on('console', m => record(wname, m.type(), m.text()));
    });
    for (const w of page.workers()) w.on('console', m => record(`${name} > ${w.url()}`, m.type(), m.text()));
  } catch (error) { log('could not watch', name, error.message); }
}
browser.on('targetcreated', watch);
browser.on('targetdestroyed', t => { if (t.url().startsWith('chrome-extension://')) log('target gone', t.type(), t.url().replace(/^chrome-extension:\/\/[a-z]+\//, '')); });

let exitCode = 0;
try {
  const id = await browser.installExtension(out);
  extensionId = id;
  log('extension installed', id);
  for (const t of browser.targets()) await watch(t);
  const page = await browser.newPage();
  page.on('workercreated', w => w.on('console', m => record(`check.html > ${w.url().split('/').pop()}`, m.type(), m.text())));
  page.on('console', m => record('check.html', m.type(), m.text()));
  await page.goto(`chrome-extension://${id}/check.html`);
  const ui = (method, params = {}) => page.evaluate((m, p) => window.ui(m, p).then(
    result => ({ result }), error => ({ error: { message: error.message, locked: !!error.locked } })), method, params);
  const must = async (method, params) => {
    const r = await ui(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const short = s => ({ network: s.network, hasWallet: s.hasWallet, locked: s.locked, sync: { status: s.sync.status, percent: s.sync.percent, error: s.sync.error, tip: s.sync.tip }, busy: s.busy, prover: s.prover });
  async function untilSynced(label, limitMs) {
    const until = Date.now() + limitMs;
    let last = 0;
    for (;;) {
      const s = await must('state');
      if (s.sync.status === 'synced') return s;
      if (Date.now() - last > 15000) { log(label, JSON.stringify(short(s))); last = Date.now(); }
      if (Date.now() > until) throw new Error(`${label}: not synced after ${limitMs / 1000}s (${JSON.stringify(short(s))})`);
      await wait(2000);
    }
  }

  if (!args['only-prove'] && !args['only-devnet']) {
    const first = await must('state');
    log('state', JSON.stringify(first));
    const targets = browser.targets().map(t => `${t.type()} ${t.url()}`).filter(t => t.includes(id));
    log('extension targets', JSON.stringify(targets));
    await must('selectNetwork', { network: 'preview' });
    const { words } = await must('generateMnemonic');
    log('generateMnemonic', `${words.length} words`);
    const tooShort = await ui('createWallet', { mnemonic: words.join(' '), password: 'short' });
    log('createWallet with a 5-character password ->', JSON.stringify(tooShort.error));
    const password = 'correct horse battery';
    const created = await must('createWallet', { mnemonic: words.join(' '), password, restore: false });
    log('createWallet', JSON.stringify(short(created)), JSON.stringify(created.addresses));
    const synced = await untilSynced('first sync', 10 * 60 * 1000);
    log('synced', JSON.stringify(short(synced)));
    log('overview', JSON.stringify(await must('overview')));
    log('checkAddress(own shielded)', JSON.stringify(await must('checkAddress', { address: synced.addresses.shielded })));
    log('history', JSON.stringify(await must('history', { offset: 0, limit: 10 })));
    log('previewSend with no funds ->', JSON.stringify((await ui('previewSend', { outputs: [{ type: '0'.repeat(64), amount: '1000000', recipient: synced.addresses.unshielded }] })).error));
    log('dustPreview with no NIGHT ->', JSON.stringify((await ui('dustPreview', { action: 'register' })).error));
    log('settings', JSON.stringify(await must('settings')));
    log('sites', JSON.stringify(await must('sites')));

    const locked = await must('lock');
    log('lock', JSON.stringify(short(locked)), 'addresses while locked:', !!locked.addresses);
    log('overview while locked ->', JSON.stringify((await ui('overview')).error));
    log('unlock with a wrong password ->', JSON.stringify((await ui('unlock', { password: 'wrong password' })).error));
    const unlockedAt = Date.now();
    const unlocked = await must('unlock', { password });
    log('unlock', JSON.stringify(short(unlocked)));
    await untilSynced('resume', 5 * 60 * 1000);
    log(`synced again ${((Date.now() - unlockedAt) / 1000).toFixed(1)}s after unlock (resumed from the encrypted snapshot)`);

    log('prover settings: switch Preview to a proof server and back');
    const settings = await must('settings');
    const server = await must('saveSettings', { network: 'preview', endpoints: { ...settings.endpoints.preview, prover: { kind: 'server', url: 'http://localhost:6300' } } });
    log('prover after saveSettings', JSON.stringify(server.prover));
    const back = await must('saveSettings', { network: 'preview', endpoints: settings.endpoints.preview });
    log('prover restored', JSON.stringify(back.prover));
    await untilSynced('after settings', 5 * 60 * 1000);

    log('Blockfrost network without a project id: a second wallet on Preprod');
    await must('selectNetwork', { network: 'preprod' });
    await must('createWallet', { mnemonic: (await must('generateMnemonic')).words.join(' '), password, restore: false });
    await wait(1000);
    log('preprod state', JSON.stringify(short(await must('state'))));
    log('resetWallet with a wrong password ->', JSON.stringify((await ui('resetWallet', { password: 'wrong password' })).error));
    const reset = await must('resetWallet', { password });
    log('resetWallet', JSON.stringify(short(reset)), JSON.stringify(reset.networks));
    await must('selectNetwork', { network: 'preview' });
    await untilSynced('back on preview', 5 * 60 * 1000);
  }

  if (args['devnet-seed']) {
    const indexer = args['devnet-indexer'];
    const devnet = { node: args['devnet-node'], indexerHttp: `${indexer}/api/v4/graphql`, indexerWs: `${indexer.replace(/^http/, 'ws')}/api/v4/graphql/ws` };
    const settings = await must('settings');
    const prover = args['devnet-proof-server'] ? { prover: { kind: 'server', url: args['devnet-proof-server'] } } : {};
    await must('saveSettings', { network: 'undeployed', endpoints: { ...settings.endpoints.undeployed, ...devnet, ...prover } });
    await must('selectNetwork', { network: 'undeployed' });
    const { words } = await must('generateMnemonic');
    const created = await must('createWallet', { mnemonic: words.join(' '), password: 'devnet wallet password', restore: false });
    await untilSynced('devnet wallet', 10 * 60 * 1000);
    log('devnet wallet', JSON.stringify(created.addresses));

    log('funding it from the devnet seed, under Node');
    const funder = await openWallet({ net: network('undeployed'), endpoints: endpointsOf(network('undeployed'), devnet), seed: Uint8Array.from(args['devnet-seed'].match(/../g), b => parseInt(b, 16)) });
    const fs = await funder.facade.waitForSyncedState();
    const funderAddress = overviewOf(fs, funder.networkId).addresses.unshielded;
    const shieldedType = Object.keys(fs.shielded.balances).find(t => fs.shielded.balances[t] > 1000n);
    const funding = await buildTransfer(funder, [
      { type: NIGHT, amount: '100000000000', recipient: created.addresses.unshielded },
      { type: shieldedType, amount: '1000', recipient: created.addresses.shielded },
    ]);
    log('funding submitted', await completeRecipe(funder, funding.recipe));
    await funder.stop();

    let overview;
    for (const until = Date.now() + 5 * 60 * 1000; ;) {
      overview = await must('overview');
      if (overview.night.available !== '0' && overview.shielded.length) break;
      if (Date.now() > until) throw new Error('the funding did not arrive');
      await wait(3000);
    }
    log('funded overview', JSON.stringify(overview));

    const dust = await must('dustPreview', { action: 'register' });
    log('dustPreview(register)', JSON.stringify(dust));
    const watchBusy = setInterval(async () => { const s = await must('state').catch(() => null); if (s?.busy) log('busy', JSON.stringify(s.busy)); }, 5000);
    try {
      log('dustApply', JSON.stringify(await must('dustApply', { id: dust.id })));
      for (const until = Date.now() + 5 * 60 * 1000; ;) {
        overview = await must('overview');
        if (overview.dust.registered > 0 && overview.dust.balance !== '0') break;
        if (Date.now() > until) throw new Error('the registration did not show');
        await wait(3000);
      }
      log('registered overview', JSON.stringify(overview.dust));

      const preview = await must('previewSend', { outputs: [
        { type: NIGHT, amount: '1000000', recipient: funderAddress },
        { type: shieldedType, amount: '10', recipient: created.addresses.shielded },
      ] });
      log('previewSend', JSON.stringify(preview));
      const sendStarted = Date.now();
      const sent = await must('send', { id: preview.id });
      log(`send (${((Date.now() - sendStarted) / 1000).toFixed(1)}s)`, JSON.stringify(sent));
    } finally { clearInterval(watchBusy); }
    await wait(20000);
    const history = await must('history', { offset: 0, limit: 10 });
    log('history', JSON.stringify(history));
    if (history.items[0]) log('txDetail', JSON.stringify(await must('txDetail', { hash: history.items[0].hash })).slice(0, 3000));
    log('overview after send', JSON.stringify(await must('overview')));
  }

  if (!args['only-devnet']) {
    log('proving a shielded output with the WASM prover in a worker (downloads key material)...');
    const proof = await page.evaluate(() => window.prove());
    log('prove', JSON.stringify(proof));
    if (!proof.ok) exitCode = 1;
  }
  log('state pushes received by the page:', await page.evaluate(() => window.states.length));
} catch (error) {
  exitCode = 1;
  log('FAILED', error.stack ?? error.message);
} finally {
  const errors = consoleLines.filter(l => l.type === 'error');
  const csp = consoleLines.filter(l => /Content Security Policy/i.test(l.text));
  log(`console: ${consoleLines.length} lines, ${errors.length} errors, ${csp.length} CSP violations`);
  for (const l of errors) console.log(`  [${l.context}] ${l.text.slice(0, 300)}`);
  await browser.close().catch(() => {});
  log('browser closed');
}
process.exit(exitCode);
