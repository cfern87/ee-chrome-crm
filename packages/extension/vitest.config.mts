import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one is the multi-entry build
// config build.mjs drives directly (content/background/dashboard as three
// distinct bundles), which has nothing to do with running tests and would
// only add noise here.
export default defineConfig({
  test: {
    // jsdom, not node: the name-extraction logic under test (names.ts) reads
    // DOM elements — img[alt], aria-label, h1/heading text — so the tests
    // build small DOM fixtures and need a document to build them in.
    environment: 'jsdom',
  },
});
