#!/usr/bin/env node
// Live end-to-end test for incoming webhooks (docs/INBOUND_WEBHOOKS.md).
//
// Needs: the Lovable side deployed, the extension built from this branch and
// reloaded, Incoming webhooks switched ON, and a token from Settings.
//
//   CRM_INBOUND_TOKEN=crm_in_... node scripts/inbound-smoke.mjs
//   CRM_INBOUND_TOKEN=... CRM_INBOUND_AUTOMATION="Follow up" node scripts/inbound-smoke.mjs
//
// The token can also go in a file named .inbound-token at the repo root
// (gitignored). The automation test always sends dryRun: true.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.CRM_INBOUND_URL || 'https://notanothersocialcrm.com/api/public/crm-inbox';
const tokenFile = join(root, '.inbound-token');
const TOKEN = (process.env.CRM_INBOUND_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : '')).trim();
const AUTOMATION = process.env.CRM_INBOUND_AUTOMATION || '';
const WAIT_MS = Number(process.env.CRM_INBOUND_WAIT_MS || 180_000);

let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => { failures++; console.log(`  ✘ ${msg}`); };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(`${msg}${detail ? ` — ${detail}` : ''}`));

async function call(method, { body, query = '', token = TOKEN } = {}) {
  const res = await fetch(`${ENDPOINT}${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

async function waitFor(id) {
  const start = Date.now();
  let last;
  while (Date.now() - start < WAIT_MS) {
    last = await call('GET', { query: `?id=${id}` });
    const s = last.json?.status;
    if (s === 'done' || s === 'failed' || s === 'expired') return last.json;
    process.stdout.write(`    … ${s} (${Math.round((Date.now() - start) / 1000)}s)\r`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return last?.json ?? null;
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT}`);
  if (!TOKEN) { console.log('No token. Set CRM_INBOUND_TOKEN or create .inbound-token.'); process.exit(2); }

  console.log('\n1. Auth');
  const noTok = await call('POST', { body: { command: 'ping' }, token: '' });
  check(noTok.status === 401, 'no token → 401', `got ${noTok.status} ${JSON.stringify(noTok.json)}`);
  const wrongTok = await call('POST', { body: { command: 'ping' }, token: 'crm_in_' + '0'.repeat(48) });
  check(wrongTok.status === 401, 'wrong token → 401', `got ${wrongTok.status}`);

  console.log('\n2. Validation');
  const notJson = await call('POST', { body: 'not json' });
  check(notJson.status === 400, 'non-JSON body → 400', `got ${notJson.status}`);
  const badCmd = await call('POST', { body: { command: 'Bad Command!' } });
  check(badCmd.status === 400, 'malformed command → 400', `got ${badCmd.status}`);

  console.log('\n3. ping round trip (waits for the extension to pick it up)');
  const ping = await call('POST', { body: { command: 'ping', expiresInMinutes: 10 } });
  check(ping.status === 202 && ping.json?.id, 'ping queued → 202 + id', `got ${ping.status} ${JSON.stringify(ping.json)}`);
  if (ping.json?.id) {
    const done = await waitFor(ping.json.id);
    check(done?.status === 'done' && done?.result?.pong === true, 'extension ran ping → done, pong: true', JSON.stringify(done));
    if (done?.result) console.log(`    device ${done.result.device}, version ${done.result.version}`);
  }

  console.log('\n4. Idempotency');
  const key = `smoke-${Date.now()}`;
  const a = await call('POST', { body: { command: 'ping', idempotencyKey: key, expiresInMinutes: 10 } });
  const b = await call('POST', { body: { command: 'ping', idempotencyKey: key, expiresInMinutes: 10 } });
  check(a.json?.id && a.json.id === b.json?.id && b.json?.duplicate === true, 'same key → same id, duplicate: true',
    `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);

  console.log('\n5. Unknown command is refused by the extension');
  const unk = await call('POST', { body: { command: 'contacts.delete_all', expiresInMinutes: 10 } });
  if (unk.json?.id) {
    const done = await waitFor(unk.json.id);
    check(done?.status === 'failed' && /Unknown command/.test(done?.error || ''), 'unknown command → failed', JSON.stringify(done));
  } else bad(`could not queue: ${unk.status}`);

  console.log('\n6. Unticked / missing automation is refused');
  const nope = await call('POST', { body: { command: 'automation.run', payload: { automation: '__no_such_automation__' }, expiresInMinutes: 10 } });
  if (nope.json?.id) {
    const done = await waitFor(nope.json.id);
    check(done?.status === 'failed' && /No automation/.test(done?.error || ''), 'missing automation → failed', JSON.stringify(done));
  } else bad(`could not queue: ${nope.status}`);

  if (AUTOMATION) {
    console.log(`\n7. automation.run "${AUTOMATION}" (dryRun: true)`);
    const run = await call('POST', {
      body: { command: 'automation.run', payload: { automation: AUTOMATION, dryRun: true, vars: { smoke: 'yes' } }, expiresInMinutes: 10 },
    });
    if (run.json?.id) {
      const done = await waitFor(run.json.id);
      check(done?.status === 'done', 'automation ran → done', JSON.stringify(done));
      console.log(`    result: ${JSON.stringify(done?.result)}`);
    } else bad(`could not queue: ${run.status}`);
  } else {
    console.log('\n7. (skipped — set CRM_INBOUND_AUTOMATION to test a real automation, always as a dry run)');
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
