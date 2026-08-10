// Minimal typing for the build-time constants Vite substitutes.
//
// Declared here rather than via `/// <reference types="vite/client" />` so the
// extension's `types/` overrides and the chrome typings stay in charge of
// everything else — we only need `DEV`, which src/ui/tokens.ts uses to fold the
// contrast audit out of production builds.

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
