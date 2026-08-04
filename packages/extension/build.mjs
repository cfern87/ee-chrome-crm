// Multi-pass build for the Chrome extension.
//
// Chrome content scripts and service workers are NOT ES modules, so they
// cannot contain `import` statements. If Vite/Rollup code-splits a shared
// module (e.g. storage.ts is imported by both the content script and the
// dashboard), the content script ships with `import ... from "./chunk.js"`
// at the top, which throws `SyntaxError: Cannot use import statement outside
// a module` and the entire script fails to run.
//
// To avoid that, we build in separate passes:
//   1. dashboard  -> ES module (loaded via <script type="module"> in
//                    dashboard.html), code-splitting is fine here.
//   2. content    -> single-entry IIFE bundle, everything inlined, no imports.
//   3. background -> single-entry IIFE bundle, everything inlined, no imports.
//
// Each IIFE pass is a single entry point, so Rollup inlines all static
// imports (storage.ts, etc.) directly into the output — no shared chunks.

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(__dirname, p);

// Stamp the build with the source revision it came from. dist/ is gitignored,
// so a machine that pulls source without rebuilding keeps running an old
// bundle; Settings → About shows these values so that mismatch is visible
// instead of looking like a broken feature. See src/buildInfo.ts.
function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // no git available (e.g. building from a source archive)
  }
}

function buildInfo() {
  const manifest = JSON.parse(readFileSync(r('public/manifest.json'), 'utf8'));
  return {
    version: manifest.version || '0.0.0',
    commit: git('rev-parse --short HEAD') || 'unknown',
    commitDate: git('log -1 --format=%cI'),
    dirty: git('status --porcelain') !== '',
    builtAt: Date.now(),
  };
}

const BUILD_INFO = buildInfo();
// Vite splices `define` values in as raw source text, so the replacement has to
// be a JS string *literal* — hence the double stringify.
const define = { __BUILD_INFO__: JSON.stringify(JSON.stringify(BUILD_INFO)) };

async function run() {
  // 1. Dashboard — ES module. This pass clears dist and copies public/ assets.
  await build({
    configFile: false,
    plugins: [react()],
    define,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: { dashboard: r('src/dashboard/main.tsx') },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: '[name]-chunk.js',
          assetFileNames: '[name].[ext]',
        },
      },
    },
  });

  // 2 & 3. Content and background — self-contained IIFE bundles, no imports.
  for (const name of ['content', 'background']) {
    await build({
      configFile: false,
      define,
      build: {
        outDir: 'dist',
        emptyOutDir: false, // keep dashboard + public assets from pass 1
        rollupOptions: {
          input: r(`src/${name}.ts`),
          output: {
            format: 'iife',
            entryFileNames: `${name}.js`,
            assetFileNames: '[name].[ext]',
            inlineDynamicImports: true,
          },
        },
      },
    });
  }

  console.log('\n✓ Extension build complete (dashboard=ESM, content/background=IIFE)');
  console.log(
    `  v${BUILD_INFO.version} · ${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+local changes' : ''}` +
    `  →  reload the extension at chrome://extensions to pick this up`,
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
