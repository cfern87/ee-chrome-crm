# Pro gating / payment integration — source changes

This zip is the **source tree only** (no build output, no `node_modules`).
Drop these files into your working copy of `ee-chrome-crm` and commit.

## New files

- `packages/extension/src/license.ts`
  Account + entitlement layer. Signs in against the web platform's auth
  (email/password), stores the session in `chrome.storage.local`, calls
  `GET /api/public/entitlement` with the bearer token, and caches the result
  for 6 hours. Exposes `getAccount()`, `signIn()`, `signOut()`,
  `refreshEntitlement()`, `getEntitlement()`, `isPro()`, `CONTACT_LIMIT_FREE`.

## Modified files

- `packages/extension/src/storage.ts`
  - `isDriveEnabled()` / `setDriveEnabled()` now require an active Pro plan.
  - `saveStore()` enforces the 25-contact cap for free accounts: existing
    contacts always save, *new* ones beyond the cap are rejected. Nothing
    already stored is ever deleted.
- `packages/extension/src/content.ts`
  - Injects a one-time, dismissible plan-limit notice with an upgrade link
    when a new contact is blocked by the free cap.
- `packages/extension/src/background.ts`
  - Message handlers: `GET_ACCOUNT`, `ACCOUNT_SIGN_IN`, `ACCOUNT_SIGN_OUT`.
  - Hourly `chrome.alarms` job to re-check entitlement.
- `packages/extension/src/dashboard/DashboardApp.tsx`
  - `AccountPanel` (plan status, usage, sign in/out).
  - Google Drive backup settings replaced with an upgrade card when not Pro.
- `packages/extension/public/popup.html` and `public/popup.js`
  - Account section in the Settings tab: sign in/out and plan status.
- `packages/extension/public/manifest.json`
  - `host_permissions` for the platform domain and the auth/entitlement API.

## Configuration

`PLATFORM_URL` in `packages/extension/src/license.ts` points at
`https://notanothersocialcrm.com`. Change it if you test against the
preview URL — entitlement calls only succeed against a deployed origin
that is listed in the manifest's `host_permissions`.

## Build

```bash
bun install
bun run build   # from the repo root
```
