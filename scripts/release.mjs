#!/usr/bin/env node
// Packages a release: build/release/mdwa-<version>.zip, one folder
// mdwa-<version>/ to pick in chrome://extensions → Load unpacked, and its
// SHA-256 in build/release/mdwa-<version>.zip.sha256 (shasum -a 256 -c).
//
//   npm run release [-- --allow-dirty]
//
// It refuses a working tree with uncommitted changes to tracked files (unless
// --allow-dirty, which names the package mdwa-<version>-dirty) and a
// package.json whose version differs from extension/manifest.json's. It builds
// the extension without source maps (MDWA_NO_SOURCEMAP), checks what it is
// about to zip, and zips it with the system zip, in a stable file order and
// without extra file attributes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const allowDirty = process.argv.includes('--allow-dirty');
const fail = message => { console.error(`release: ${message}`); process.exit(1); };
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...options });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
  return r.stdout?.trimEnd();
};
const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

const version = readJson('package.json').version;
const manifestVersion = readJson('extension/manifest.json').version;
if (version !== manifestVersion) fail(`package.json says ${version}, extension/manifest.json says ${manifestVersion}`);
const changed = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (changed && !allowDirty) fail(`uncommitted changes to tracked files (--allow-dirty to try it out):\n${changed}`);
const commit = run('git', ['rev-parse', 'HEAD']);
const name = `mdwa-${version}${changed ? '-dirty' : ''}`;

run(process.execPath, [path.join(root, 'scripts/build-extension.mjs')], { stdio: 'inherit', env: { ...process.env, MDWA_NO_SOURCEMAP: '1' } });

const releaseDir = path.join(root, 'build/release');
const pkg = path.join(releaseDir, name);
const zipFile = path.join(releaseDir, `${name}.zip`);
rmSync(pkg, { recursive: true, force: true });
rmSync(zipFile, { force: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(path.join(root, 'build/extension'), pkg, { recursive: true });

// What is about to ship, sorted, relative to the package folder.
const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(path.relative(pkg, full));
  }
};
walk(pkg);
files.sort();

const problems = [];
const manifest = JSON.parse(readFileSync(path.join(pkg, 'manifest.json'), 'utf8'));
if (manifest.version !== version) problems.push(`manifest.json has version ${manifest.version}`);
const referenced = new Set([
  manifest.action?.default_popup, manifest.background?.service_worker, ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap(c => [...(c.js ?? []), ...(c.css ?? [])]),
].filter(Boolean));
for (const page of files.filter(f => f.endsWith('.html'))) {
  const html = readFileSync(path.join(pkg, page), 'utf8');
  for (const [, ref] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (!/^[a-z]+:/i.test(ref)) referenced.add(path.join(path.dirname(page), ref));
  }
}
for (const ref of referenced) if (!existsSync(path.join(pkg, ref))) problems.push(`${ref} is referenced but missing`);
for (const file of files) {
  if (file.endsWith('.map')) problems.push(`${file} is a source map`);
  if (file.split('/').some(part => part.startsWith('.'))) problems.push(`${file} is a dot file`);
  if (/(^|\/)check[.-]|test|profile/i.test(file)) problems.push(`${file} looks like a test file or a profile`);
  if (!/\.(js|css)$/.test(file)) continue;
  const code = readFileSync(path.join(pkg, file), 'utf8');
  if (code.includes('sourceMappingURL')) problems.push(`${file} points at a source map`);
  // Third-party licences: each bundle names the file esbuild linked them to.
  for (const [, legal] of code.matchAll(/For license information please see (\S+?\.LEGAL\.txt)/g)) {
    if (!existsSync(path.join(pkg, path.dirname(file), legal))) problems.push(`${file} names ${legal}, which is missing`);
  }
}
if (!files.includes('LICENSE')) problems.push('LICENSE is missing');
if (!files.some(f => f.endsWith('.LEGAL.txt'))) problems.push('no third-party licence file (*.LEGAL.txt)');
if (problems.length) fail(`the package is not fit to ship:\n  ${problems.join('\n  ')}`);

// -X: no extra attributes; -D: no directory entries; the list in sorted order.
run('zip', ['-X', '-D', '-q', zipFile, '-@'], { cwd: releaseDir, input: files.map(f => `${name}/${f}`).join('\n') + '\n' });
rmSync(pkg, { recursive: true, force: true });
const sha256 = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
writeFileSync(`${zipFile}.sha256`, `${sha256}  ${name}.zip\n`);

console.log(`\n${path.relative(root, zipFile)}`);
console.log(`  size     ${statSync(zipFile).size} bytes (${files.length} files)`);
console.log(`  sha256   ${sha256}`);
console.log(`  commit   ${commit}${changed ? ' with uncommitted changes' : ''}`);
