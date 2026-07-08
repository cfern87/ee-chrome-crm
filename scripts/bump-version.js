#!/usr/bin/env node
// Bumps the patch/revision version (x.y.Z -> x.y.(Z+1)) in the extension manifest,
// which is the file Chrome reads to determine the installed version.
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'packages', 'extension', 'public', 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const [major, minor, patch] = manifest.version.split('.').map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;

manifest.version = nextVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Bumped extension manifest version to ${nextVersion}`);
