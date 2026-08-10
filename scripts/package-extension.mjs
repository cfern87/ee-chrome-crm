#!/usr/bin/env node
// Release step: build the extension, then produce the Chrome Web Store upload
// zip at <repo>/dist/<name>-<version>.zip.
//
// Run it deliberately before a submission — NOT from a git hook. The pre-commit
// hook bumps the patch version on every commit to main, so a zip built before
// committing is stale the instant you commit. Building here, on demand, means
// the filename always reflects the manifest that actually went into the archive.
//
// Two things this script exists to get right, both of which are easy to botch
// by hand and invisible until the Web Store rejects the upload:
//
//   1. manifest.json must sit at the ARCHIVE ROOT. Zipping the dist folder
//      itself nests everything one level down and CWS reports the manifest as
//      missing or unreadable.
//   2. The `key` field must not ship. See PROD_EXTENSION_ID below.

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { createZip } from './zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'packages', 'extension');
const distDir = join(extDir, 'dist');
const outDir = join(root, 'dist');

// The Web Store item this package is destined for. Recorded for humans: the
// archive itself carries no identity, because `key` is stripped below.
const PROD_EXTENSION_ID = 'hdknnokfjebdmklpadidgafodjlmelba';

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Collect every asset path the manifest points at, wherever it is nested. */
function referencedPaths(node, found = new Set()) {
  if (typeof node === 'string') {
    if (/\.(js|css|html|png|json)$/.test(node)) found.add(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) referencedPaths(value, found);
  }
  return found;
}

function fail(message) {
  console.error(`\n  x ${message}\n`);
  process.exit(1);
}

// 1. Build. build.mjs pins its own root, so the cwd here doesn't matter.
console.log('  Building extension ...\n');
execFileSync(process.execPath, [join(extDir, 'build.mjs')], { stdio: 'inherit' });

if (!existsSync(join(distDir, 'manifest.json'))) {
  fail(`Build produced no manifest at ${relative(root, join(distDir, 'manifest.json'))}`);
}

// 2. Read the built manifest and strip `key` for the packaged copy only.
//
// WHY: `key` pins the extension ID for locally loaded unpacked builds, which is
// what keeps the dev ID stable across reloads. The Web Store assigns identity
// from the registered item instead, and rejects an upload whose key doesn't
// match that item — the key in public/manifest.json belongs to a different,
// development item. Stripping it here leaves packages/extension/dist untouched,
// so loading dist unpacked still gets its pinned dev ID.
const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!version) fail('Built manifest has no version field.');

const hadKey = 'key' in manifest;
delete manifest.key;
const packagedManifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 3. Gather entries, substituting the stripped manifest.
const names = walk(distDir);
const files = names.map((name) => ({
  name,
  data: name === 'manifest.json' ? packagedManifest : readFileSync(join(distDir, name)),
}));

// 4. Refuse to ship a broken package. Each of these has a matching failure mode
//    that only shows up after upload, or worse, after install.
if (!names.includes('manifest.json')) fail('manifest.json is not at the archive root.');

const missing = [...referencedPaths(manifest)].filter((p) => !names.includes(p));
if (missing.length) {
  fail(`Manifest references files that are not in the build:\n    ${missing.join('\n    ')}`);
}

const roundTripped = JSON.parse(packagedManifest.toString('utf8'));
if ('key' in roundTripped) fail('`key` survived into the packaged manifest.');

// 5. Write the archive.
mkdirSync(outDir, { recursive: true });
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const outFile = join(outDir, `${pkgName}-${version}.zip`);
const replaced = existsSync(outFile);
writeFileSync(outFile, createZip(files));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`\n  Packaged ${files.length} files -> ${relative(root, outFile).replace(/\\/g, '/')}` +
            `  (${kb(statSync(outFile).size)})${replaced ? '  [replaced]' : ''}`);
console.log(`  v${version}` + (hadKey ? '  ·  `key` stripped for upload' : ''));
console.log(`\n  Upload to Web Store item ${PROD_EXTENSION_ID}`);
console.log('  Local dev is unaffected — load packages/extension/dist unpacked as before.\n');
