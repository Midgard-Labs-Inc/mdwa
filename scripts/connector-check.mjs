#!/usr/bin/env node
// Checks the dApp connector end to end: the built extension in a real
// browser (Helium, under automation, with its own throwaway profile in
// .connector-test-profiles/), the test dApp (dapp/, served on localhost) and a
// local chain. It creates a wallet on Undeployed, funds it from a dev seed
// under Node, registers its NIGHT for DUST, then drives the dApp through
// most of the standard connector API, answering the approval windows as a
// user would, and prints what it saw. The browser runs headless (--headed to watch).
//
//   npm run build:extension && node scripts/connector-check.mjs \
//     --devnet-seed <hex> --devnet-node ws://localhost:9954 \
//     --devnet-indexer http://localhost:8098 --devnet-proof-server http://localhost:6310
//
// With --no-funds it skips the funding and every step that needs funds.
// The Node-side funding proves with the proof server; the extension proves
// with the prover the wallet is set to (WASM unless --prover server). Each
// funded step runs once. The browser and the dApp server are closed at the
// end, whatever happened.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTransfer, completeRecipe, openWallet, overviewOf, NIGHT } from '../extension/src/midnight.js';
import { endpointsOf, network } from '../wallet/networks.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')]); return acc;
}, []));
const executablePath = args.browser ?? '/Applications/Helium.app/Contents/MacOS/Helium';
const extension = path.join(root, 'build/extension');
// A new profile per run, under .connector-test-profiles/ (or the directory
// --profile-root names), never removed by this script (inspect or delete
// them by hand).
const profile = path.join(args['profile-root'] ? path.resolve(args['profile-root']) : path.join(root, '.connector-test-profiles'),
  new Date().toISOString().replace(/[:.]/g, '-'));
const port = Number(args.port ?? 5190);
const dappUrl = `http://localhost:${port}/`;
const otherOrigin = `http://127.0.0.1:${port}/`;
const PASSWORD = 'connector check password';

const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const wait = ms => new Promise(r => setTimeout(r, ms));
const short = (value, n = 1500) => { const t = typeof value === 'string' ? value : JSON.stringify(value); return t.length > n ? `${t.slice(0, n)}…` : t; };
const consoleErrors = [];
const noteError = line => { consoleErrors.push(line); log('console error', line.slice(0, 400)); };

// Whatever ends this script, the dApp server goes with it.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.kill(); process.exit(130); });
const server = spawn(process.execPath, [path.join(root, 'dapp/serve.mjs'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', d => { if (/Test dApp: http/.test(String(d))) resolve(); });
  server.on('exit', code => reject(new Error(`dapp server exited (${code})`)));
});
log('dApp server up', dappUrl);

// Headless unless --headed: an automated window on screen invites clicks
// meant for the user's own browser.
const browser = await puppeteer.launch({
  executablePath, headless: !args.headed, enableExtensions: true, pipe: true, userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check'], defaultViewport: null, protocolTimeout: 30 * 60 * 1000,
});
let exitCode = 0;
const results = {};
try {
  const id = await browser.installExtension(extension);
  log('extension installed', id);
  browser.on('targetcreated', async target => {
    if (!['page', 'service_worker'].includes(target.type())) return;
    try {
      if (target.type() === 'service_worker') {
        const w = await target.worker();
        w?.on('console', m => { if (m.type() === 'error') noteError(`[background] ${m.text()}`); });
        return;
      }
      const p = await target.asPage();
      const name = target.url().replace(/^chrome-extension:\/\/[a-z]+\//, '');
      p.on('console', m => { if (m.type() === 'error') noteError(`[${name}] ${m.text()}`); });
      p.on('pageerror', e => noteError(`[${name}] pageerror ${e.message}`));
    } catch { /* a closed target */ }
  });

  // An extension page to call the wallet's UI methods from, as the popup does.
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${id}/popup.html`);
  const ui = (method, params = {}) => ext.evaluate((m, p) => chrome.runtime.sendMessage({ type: 'ui', method: m, params: p }), method, params);
  const must = async (method, params) => {
    const r = await ui(method, params);
    if (r?.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  async function untilSynced(label, limitMs = 10 * 60 * 1000) {
    for (const until = Date.now() + limitMs; ;) {
      const s = await must('state');
      if (s.sync.status === 'synced') return s;
      if (Date.now() > until) throw new Error(`${label}: not synced (${JSON.stringify(s.sync)})`);
      await wait(2000);
    }
  }

  // ---------------------------------------------------- wallet and funds ---
  const indexer = args['devnet-indexer'];
  const devnet = { node: args['devnet-node'], indexerHttp: `${indexer}/api/v4/graphql`, indexerWs: `${indexer.replace(/^http/, 'ws')}/api/v4/graphql/ws` };
  const settings = await must('settings');
  const prover = args.prover === 'server' ? { kind: 'server', url: args['devnet-proof-server'] } : { kind: 'wasm', url: settings.endpoints.undeployed.prover.url };
  await must('saveSettings', { network: 'undeployed', endpoints: { ...settings.endpoints.undeployed, ...devnet, prover } });
  await must('selectNetwork', { network: 'undeployed' });
  const { words } = await must('generateMnemonic');
  const created = await must('createWallet', { mnemonic: words.join(' '), password: PASSWORD, restore: false });
  await untilSynced('new wallet');
  log('wallet', JSON.stringify(created.addresses), 'prover', JSON.stringify(prover));

  const funded = !args['no-funds'];
  if (funded) {
    const funder = await openWallet({
      net: network('undeployed'), seed: Uint8Array.from(args['devnet-seed'].match(/../g), b => parseInt(b, 16)),
      endpoints: endpointsOf(network('undeployed'), { ...devnet, prover: { kind: 'server', url: args['devnet-proof-server'] } }),
    });
    const fs = await funder.facade.waitForSyncedState();
    const shieldedType = Object.keys(fs.shielded.balances).find(t => fs.shielded.balances[t] > 1000n);
    const funding = await buildTransfer(funder, [
      { type: NIGHT, amount: '100000000000', recipient: created.addresses.unshielded },
      ...(shieldedType ? [{ type: shieldedType, amount: '1000', recipient: created.addresses.shielded }] : []),
    ]);
    log('funding submitted', await completeRecipe(funder, funding.recipe), 'funder', overviewOf(fs, funder.networkId).addresses.unshielded);
    await funder.stop();
    let overview;
    for (const until = Date.now() + 5 * 60 * 1000; ;) {
      overview = await must('overview');
      if (overview.night.available !== '0' && (!shieldedType || overview.shielded.length)) break;
      if (Date.now() > until) throw new Error('the funding did not arrive');
      await wait(3000);
    }
    const dust = await must('dustPreview', { action: 'register' });
    log('dustApply', JSON.stringify(await must('dustApply', { id: dust.id })));
    for (const until = Date.now() + 5 * 60 * 1000; ;) {
      overview = await must('overview');
      if (overview.dust.registered > 0 && overview.dust.balance !== '0') break;
      if (Date.now() > until) throw new Error('the DUST registration did not show');
      await wait(3000);
    }
    log('funded', JSON.stringify(overview.night), JSON.stringify(overview.shielded), JSON.stringify(overview.dust));
  }

  // ---------------------------------------------------- approval windows ---
  const seen = new Set();
  async function nextApproval(timeoutMs = 120000) {
    for (const until = Date.now() + timeoutMs; Date.now() < until; await wait(250)) {
      const target = browser.targets().find(t => t.url().includes('/approve.html?id=') && !seen.has(t.url()));
      if (target) {
        seen.add(target.url());
        const page = await target.asPage();
        await page.waitForSelector('button', { timeout: 30000 });
        return page;
      }
    }
    return null;
  }
  const textOf = page => page.evaluate(() => document.body.innerText.replace(/\s+\n/g, '\n'));
  async function click(page, label, timeoutMs = 10 * 60 * 1000) {
    for (const until = Date.now() + timeoutMs; Date.now() < until; await wait(300)) {
      const clicked = await page.evaluate(l => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === l && !x.disabled);
        if (b) b.click();
        return !!b;
      }, label).catch(() => 'closed');
      // A click that closes the window ends the evaluation with an error.
      if (clicked) return;
    }
    throw new Error(`No enabled "${label}" button: ${short(await textOf(page))}`);
  }
  /** Answers the next approval window: `label` is the button to press. */
  async function answer(label, { expect, unlock = false } = {}) {
    const page = await nextApproval();
    if (!page) throw new Error(`No approval window appeared (wanted ${label})`);
    await page.setViewport({ width: 440, height: 680 }).catch(() => {});
    if (unlock) {
      await page.waitForSelector('input[type=password]');
      log('approval (locked):', short(await textOf(page), 400));
      await page.type('input[type=password]', PASSWORD);
      await click(page, 'Unlock');
    }
    if (label !== 'Unlock') {
      // Wait until the request is ready (a transaction is built after the window opens).
      let lastReport = Date.now();
      for (const until = Date.now() + 10 * 60 * 1000; Date.now() < until; await wait(500)) {
        if (Date.now() - lastReport > 30000) {
          lastReport = Date.now();
          const s = await must('state').catch(e => ({ error: e.message }));
          log(`still waiting for "${label}":`, short(await textOf(page).catch(() => '(closed)'), 300), 'busy', JSON.stringify(s.busy), 'sync', s.sync?.status);
        }
        const ready = await page.evaluate(l => [...document.querySelectorAll('button')].some(x => x.textContent.trim() === l && !x.disabled), label === 'Reject' ? 'Reject' : label).catch(() => true);
        const preparing = await page.evaluate(() => /Preparing|Balancing/.test(document.body.innerText)).catch(() => false);
        if (ready && !preparing) break;
        // The wallet could not build it: the window says why and can only be closed.
        if (await page.evaluate(() => /The wallet cannot do this/.test(document.body.innerText)).catch(() => false)) {
          const text = await textOf(page);
          log(`approval shows an error (closing it): ${short(text, 800)}`);
          await click(page, 'Close');
          return text;
        }
      }
      const text = await textOf(page).catch(() => '');
      log(`approval -> ${label}:`, short(text, 1200));
      if (expect && !expect.test(text)) throw new Error(`The approval window did not show ${expect}: ${short(text)}`);
      await click(page, label);
      return text;
    }
    return textOf(page).catch(() => '');
  }
  // Waits until the wallet's NIGHT is spendable again after a transaction.
  async function settled() {
    for (const until = Date.now() + 5 * 60 * 1000; ;) {
      const night = (await must('overview')).night;
      if (night.available !== '0' && night.pending === '0') { log('NIGHT settled', JSON.stringify(night)); return; }
      if (Date.now() > until) { log('NIGHT did not settle in 5 minutes', JSON.stringify(night)); return; }
      await wait(3000);
    }
  }
  async function noApprovalWithin(ms) {
    const page = await nextApproval(ms);
    if (page) throw new Error(`An approval window appeared unexpectedly: ${short(await textOf(page))}`);
  }

  // -------------------------------------------------------------- dApp ---
  const dapp = await browser.newPage();
  dapp.on('console', m => { if (m.type() === 'error') noteError(`[dapp] ${m.text()}`); });
  await dapp.goto(dappUrl);
  await dapp.waitForFunction(() => !!window.dapp);
  const act = (name, ...a) => dapp.evaluate((n, x) => window.dapp[n](...x), name, a);
  const step = async (name, promise) => {
    const r = await Promise.race([promise, wait(15 * 60 * 1000).then(() => { throw new Error(`${name}: no answer in 15 minutes`); })]);
    results[name] = r;
    log(name, short(r));
    return r;
  };

  await step('inspect', act('inspect'));
  await step('connect unknown network', act('connectWrongNetwork'));
  // Rejected, then approved, then already approved (no window).
  let pending = act('connect');
  await answer('Reject', { expect: /Connect to this site\?/ });
  await step('connect rejected', pending);
  pending = act('connect');
  await answer('Connect', { expect: /Undeployed/ });
  await step('connect approved', pending);
  pending = act('connect');
  await noApprovalWithin(3000);
  await step('connect again (already approved)', pending);
  for (const m of ['getConnectionStatus', 'getConfiguration', 'getShieldedAddresses', 'getUnshieldedAddress', 'getDustAddress', 'getUnshieldedBalances']) {
    await step(m, act(m));
  }

  // hintUsage refused: the gated methods stay refused for this page.
  pending = act('hintUsage');
  await answer('Reject', { expect: /getShieldedBalances/ });
  await step('hintUsage rejected', pending);
  pending = act('getShieldedBalances');
  await noApprovalWithin(3000);
  await step('getShieldedBalances after refusal (sticky)', pending);
  pending = act('connect');
  await noApprovalWithin(3000);
  await pending;
  await step('getDustBalance after reconnect (still refused)', act('getDustBalance'));

  // A new page (document) may ask again: granted this time.
  await dapp.reload();
  await dapp.waitForFunction(() => !!window.dapp);
  await step('connect after reload', act('connect'));
  pending = act('hintUsage');
  await answer('Allow', { expect: /getTxHistory/ });
  await step('hintUsage granted', pending);
  for (const m of ['getShieldedBalances', 'getDustBalance', 'getTxHistory']) await step(m, act(m));
  await step('sites after grant', must('sites'));

  pending = act('signData');
  await answer('Sign', { expect: /Hello from the mdwa test dApp/ });
  await step('signData', pending);

  if (funded) {
    // A transfer rejected: its coins are booked while the window is open and
    // free again after the rejection.
    const before = (await must('overview')).night;
    pending = act('makeTransfer');
    const page = await nextApproval();
    if (!page) throw new Error(`makeTransfer opened no approval window: ${short(await pending)}`);
    for (const until = Date.now() + 120000; Date.now() < until && /Preparing|Balancing/.test(await textOf(page)); ) await wait(500);
    const during = (await must('overview')).night;
    log('approval (transfer to reject):', short(await textOf(page), 800));
    await click(page, /The wallet cannot do this/.test(await textOf(page)) ? 'Close' : 'Reject');
    await step('makeTransfer rejected', pending);
    await wait(1500);
    const after = (await must('overview')).night;
    results['coins booked and released'] = { before, during, after };
    log('NIGHT before / while the window was open / after rejecting', JSON.stringify(results['coins booked and released']));

    pending = act('makeTransfer');
    await answer('Send', { expect: /This wallet will send/ });
    await step('makeTransfer approved', pending);
    await step('submitTransaction', act('submitTransaction'));
    await settled();
    // A transfer without its fee (payFees: false), then balanced by the
    // wallet as a sealed transaction (it adds the fee in an intent of its
    // own), then submitted.
    pending = act('makeTransferWithoutFee');
    await answer('Send', { expect: /Not paid by this wallet/ });
    await step('makeTransfer payFees false', pending);
    pending = act('balanceSealedTransaction');
    await answer('Approve', { expect: /Effect on this wallet/ });
    await step('balanceSealedTransaction', pending);
    await step('submitTransaction (balanced)', act('submitTransaction'));
    await settled();

    pending = act('makeIntent');
    await answer('Create offer', { expect: /You give/ });
    await step('makeIntent', pending);
  }
  pending = act('makeIntentBadSegment');
  await noApprovalWithin(3000);
  await step('makeIntent segment 5 (no window)', pending);

  // The contract round trip: Midnight.js proves through getProvingProvider
  // and balances through balanceUnsealedTransaction.
  if (funded) {
    pending = act('deploy');
    await answer('Approve', { expect: /Deploys a contract/ });
    await step('deploy', pending);
    pending = act('increment');
    await answer('Approve', { expect: /increment/ });
    await step('increment', pending);
    await step('read counter', act('readRound'));
  }

  // The key transport, measured with the proof server as the prover. With
  // a real preimage and a key of zeros, the WASM prover's check passes and
  // its prove fails, and the SDK answers such a prove only at its 10-minute
  // deadline (see dappProver in extension/src/midnight.js).
  {
    const current = await must('settings');
    const proverWas = current.endpoints.undeployed.prover;
    await must('saveSettings', { network: 'undeployed', endpoints: { ...current.endpoints.undeployed, prover: { kind: 'server', url: args['devnet-proof-server'] } } });
    await untilSynced('proof server prover');
    await step(`key transport (${args['big-key-mb'] ?? 80} MB)`, act('bigKey', Number(args['big-key-mb'] ?? 80)));
    await must('saveSettings', { network: 'undeployed', endpoints: { ...current.endpoints.undeployed, prover: proverWas } });
    await untilSynced('prover restored');
  }

  // Locked: a read asks for the password in a window first.
  await must('lock');
  pending = act('getShieldedBalances');
  await answer('Unlock', { unlock: true });
  await step('getShieldedBalances while locked', pending);

  // Locked, a new site: the connect window unlocks first.
  await must('lock');
  const other = await browser.newPage();
  await other.goto(otherOrigin);
  await other.waitForFunction(() => !!window.dapp);
  pending = other.evaluate(() => window.dapp.connect());
  await answer('Connect', { unlock: true, expect: /Connect to this site/ });
  results['connect while locked (other origin)'] = await pending;
  log('connect while locked (other origin)', short(results['connect while locked (other origin)']));
  await other.close();
  await untilSynced('after unlock');

  // A network switch ends the connection.
  await must('selectNetwork', { network: 'preview' });
  await step('status after network switch', act('getConnectionStatus'));
  await step('call after network switch', act('getUnshieldedAddress'));
  await must('selectNetwork', { network: 'undeployed' });

  await wait(15000);
  const history = await must('history', { offset: 0, limit: 20 });
  results.history = history.items.map(i => ({ hash: i.hash.slice(0, 16), status: i.status, kind: i.kind, origin: i.origin, deltas: i.deltas }));
  log('history', short(results.history, 4000));
  await step('getTxHistory at the end', act('getTxHistory'));
  await step('sites at the end', must('sites'));
} catch (error) {
  exitCode = 1;
  log('FAILED', error.stack ?? error.message);
} finally {
  log(`console errors: ${consoleErrors.length}`);
  for (const line of consoleErrors.slice(0, 40)) console.log(' ', line.slice(0, 400));
  await browser.close().catch(() => {});
  server.kill();
  log('browser and dApp server closed');
}
process.exit(exitCode);
