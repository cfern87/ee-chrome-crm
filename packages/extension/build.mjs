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

const __dirname = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(__dirname, p);

async function run() {
  // 1. Dashboard — ES module. This pass clears dist and copies public/ assets.
  await build({
    configFile: false,
    plugins: [react()],
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
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
