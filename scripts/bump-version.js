#!/usr/bin/env node
// Bumps the patch/revision version (x.y.Z -> x.y.(Z+1)) in the extension manifest,
// which is the file Chrome reads to determine the installed version, and carries
// that number to every other place the version is recorded.
//
// Run by .githooks/pre-commit on every commit to main. The revision (Z) is a
// running count of commits that a minor release keeps counting; only a major
// release starts it over. Set BUMP for that one commit:
//   BUMP=minor git commit ...   x.y.z -> x.(y+1).(z+1)
//   BUMP=major git commit ...   x.y.z -> (x+1).0.0
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'packages', 'extension', 'public', 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const [major, minor, patch] = manifest.version.split('.').map(Number);
const bump = (process.env.BUMP || 'patch').toLowerCase();
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`BUMP must be patch, minor or major (got "${process.env.BUMP}")`);
  process.exit(1);
}
const nextVersion =
  bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.${patch + 1}`
  : `${major}.${minor}.${patch + 1}`;

manifest.version = nextVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

/** Rewrite one JSON file's `version` field, leaving the rest of it untouched. */
function setVersion(relPath, { required }) {
  const file = path.join(root, relPath);
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json.version === nextVersion) return;
    json.version = nextVersion;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  } catch (e) {
    if (required) throw e;
  }
}

// The built manifest is what chrome.runtime.getManifest() reports, so patching
// it here keeps Settings → About showing the same number as source. The bundle
// itself is still the old one until the post-commit hook rebuilds — and that is
// precisely the gap the About panel's staleness banner exists to announce.
// Absent on a machine that has never built; not an error.
setVersion(path.join('packages', 'extension', 'dist', 'manifest.json'), { required: false });

// Nothing reads these (build.mjs reads the manifest), but leaving them frozen
// at 1.0.0 makes "the version" ambiguous depending on which file you open.
setVersion('package.json', { required: true });
setVersion(path.join('packages', 'extension', 'package.json'), { required: true });
setVersion(path.join('packages', 'dashboard', 'package.json'), { required: true });

console.log(`Bumped extension manifest version to ${nextVersion}`);
