#!/usr/bin/env node
// Package the MV3 extension into build/extension (load it unpacked in Chrome).
// Bundles every entry point with esbuild. The Midnight SDK ships its ledger
// and proving runtimes as wasm-bindgen "bundler" packages, which import their
// .wasm file as an ES module; esbuild has no loader for that, so a plugin
// (esbuild-plugins.mjs) emits each .wasm into wasm/ and generates the module
// that instantiates it.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS } from '../wallet/networks.mjs';
import { wasmPlugin, forbidPlugin } from './esbuild-plugins.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'build/extension');
const src = path.join(root, 'extension/src');
const modules = path.join(root, 'node_modules');
const proverClient = path.join(modules, '@midnightntwrk/wallet-sdk-prover-client/dist');

// Every build has its own id: pages compare it with the running background
// (see extension/src/ui/fresh.js) and reload the extension after a rebuild.
const buildId = new Date().toISOString();
// The release package (scripts/release.mjs) ships without source maps.
const sourcemap = process.env.MDWA_NO_SOURCEMAP ? false : 'linked';
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'wasm'), { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  jsx: 'automatic',
  minify: true,
  // The SDK reports errors by class and tag; keeping names keeps its messages
  // and any constructor-name checks in its dependencies intact.
  keepNames: true,
  sourcemap,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"', __BUILD_ID__: JSON.stringify(buildId), global: 'globalThis' },
  // The SDK (address codecs, polkadot) uses Node's Buffer and process.
  inject: [path.join(src, 'buffer-shim.js'), path.join(src, 'process-shim.js')],
  logLevel: 'warning',
  metafile: true,
};

// Workers: the engine and the SDK's two proof workers. WasmProver.js starts a
// proof worker with new URL('../../dist/proof-worker.js', import.meta.url);
// esbuild leaves that expression alone, so from the engine at the extension
// root it resolves to /dist/proof-worker.js, which is where they are emitted.
const workers = await build({
  ...common,
  entryPoints: {
    'engine-worker': path.join(src, 'engine-worker.js'),
    'dist/proof-worker': path.join(proverClient, 'proof-worker.js'),
    'dist/proof-worker-zkir-v3': path.join(proverClient, 'proof-worker-zkir-v3.js'),
  },
  outdir: out,
  plugins: [wasmPlugin({ sync: true, out }), forbidPlugin()],
});
const engineCode = readFileSync(path.join(out, 'engine-worker.js'), 'utf8');
for (const worker of ['../../dist/proof-worker.js', '../../dist/proof-worker-zkir-v3.js']) {
  if (!engineCode.includes(worker)) throw new Error(`The engine no longer starts ${worker}: check how the prover client finds its workers`);
}

// Pages and the service worker. None of them may load a wasm package: the
// background cannot use top-level await, and the popup gets everything from
// the engine.
const pages = await build({
  ...common,
  entryPoints: {
    background: path.join(src, 'background.js'),
    offscreen: path.join(src, 'offscreen.js'),
    popup: path.join(src, 'ui/popup.jsx'),
    approve: path.join(src, 'ui/approve.jsx'),
  },
  outdir: out,
  plugins: [wasmPlugin({ sync: false, out }), forbidPlugin()],
});
for (const [file, output] of Object.entries(pages.metafile.outputs)) {
  if (Object.keys(output.inputs).some(i => i.startsWith('wasm-esm:'))) throw new Error(`${file} bundles a wasm package; only workers may`);
}

// Content scripts are classic scripts, run in every web page: IIFEs with no
// shims and nothing of the wallet in them.
const contentScripts = await build({
  entryPoints: { content: path.join(src, 'content.js'), inject: path.join(src, 'inject.js') },
  outdir: out, bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', minify: true,
  sourcemap, legalComments: 'linked', logLevel: 'warning', metafile: true,
});
for (const [file, output] of Object.entries(contentScripts.metafile.outputs)) {
  if (Object.keys(output.inputs).some(i => i.includes('node_modules'))) throw new Error(`${file} bundles a package; content scripts must stay small`);
}

// The bundles must not contain test-only code or a second copy of a ledger.
for (const [file, output] of Object.entries(workers.metafile.outputs)) {
  // Virtual wasm modules are named by absolute path; the rest relative to root.
  const inputs = Object.keys(output.inputs).map(i => i.startsWith('wasm-esm:') ? path.relative(root, i.slice(9)) : i);
  const copies = {};
  for (const i of inputs) {
    const m = /node_modules\/(@midnightntwrk\/(?:ledger-v\d+|zkir-v\d+))\//.exec(i);
    if (m) (copies[m[1]] ??= new Set()).add(i.slice(0, i.indexOf(m[1])));
  }
  for (const [pkg, places] of Object.entries(copies)) {
    if (places.size > 1) throw new Error(`${file} bundles ${pkg} from ${places.size} places`);
  }
  const testCode = inputs.filter(i => /\/(test|testing)\//.test(i) && i.includes('@midnightntwrk'));
  if (testCode.length) throw new Error(`${file} bundles SDK test code: ${testCode.slice(0, 3).join(', ')}`);
}

// Kumo (Cloudflare's design system) + Tailwind CSS v4 -> one stylesheet.
const tailwind = spawnSync(process.execPath, [path.join(modules, '@tailwindcss/cli/dist/index.mjs'),
  '-i', path.join(src, 'ui/styles.css'), '-o', path.join(out, 'style.css'), '--minify'], { cwd: root, encoding: 'utf8' });
if (tailwind.status !== 0) throw new Error(`Tailwind failed: ${tailwind.stderr}`);
for (const file of ['popup.html', 'approve.html', 'offscreen.html', 'icon.png']) copyFileSync(path.join(root, 'extension', file), path.join(out, file));

// The default endpoints' hosts are named in connect-src explicitly; https:
// and wss: stay in it because every endpoint is editable in Settings.
const manifest = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const origins = new Set();
for (const n of Object.values(NETWORKS)) {
  for (const url of [n.node, n.indexerHttp, n.indexerWs].filter(Boolean)) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') origins.add(`${u.protocol}//${u.host}`);
  }
}
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
  .replace(/connect-src ([^;]*)/, (_, sources) => `connect-src ${sources} ${[...origins].join(' ')}`);
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
console.log(`Extension ready: ${path.relative(root, out)} (chrome://extensions → Load unpacked)`);
