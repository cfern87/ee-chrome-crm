// Identity of the build that is actually loaded in the browser.
//
// WHY: `dist/` is gitignored, so `git pull` updates the source but leaves the
// loaded extension running whatever was built last. Reloading at
// chrome://extensions re-reads that same stale dist, which looks exactly like
// "the feature didn't transfer". These constants are stamped in at build time
// (see build.mjs) and shown in Settings → About, so the loaded build can be
// compared against the checked-out source: if the commit here isn't what
// `git log -1 --format=%h` reports, the extension needs a rebuild.
//
// The values are injected by Vite's `define`, so they are literals in the
// bundle — no runtime lookup, and they work identically in the content script,
// the service worker and the dashboard.

declare const __BUILD_INFO__: string | undefined;

export interface BuildInfo {
  version: string;     // extension version, bumped by the pre-commit hook
  commit: string;      // short SHA of HEAD when the bundle was built
  commitDate: string;  // ISO timestamp of that commit ('' if unknown)
  dirty: boolean;      // uncommitted changes were present at build time
  builtAt: number;     // epoch ms of the build (0 if unknown)
}

// Used when the bundle wasn't produced by build.mjs (e.g. `vite dev`).
const UNKNOWN_BUILD: BuildInfo = {
  version: '0.0.0',
  commit: 'unknown',
  commitDate: '',
  dirty: false,
  builtAt: 0,
};

export const BUILD_INFO: BuildInfo = (() => {
  try {
    // `typeof` on an unreplaced identifier is safe — it can't throw.
    if (typeof __BUILD_INFO__ === 'string') {
      return { ...UNKNOWN_BUILD, ...(JSON.parse(__BUILD_INFO__) as Partial<BuildInfo>) };
    }
  } catch { /* fall through to the unknown build */ }
  return UNKNOWN_BUILD;
})();

/** One-line build identity, e.g. `v1.0.11 · 16b41d4 · built Aug 4, 2:31 PM`. */
export function describeBuild(info: BuildInfo = BUILD_INFO): string {
  const parts = [`v${info.version}`, info.commit + (info.dirty ? '+local' : '')];
  if (info.builtAt) parts.push(`built ${new Date(info.builtAt).toLocaleString()}`);
  return parts.join(' · ');
}
