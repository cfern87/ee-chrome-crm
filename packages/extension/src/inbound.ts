// Incoming webhooks: run CRM actions when an outside system asks.
//
// An extension can't listen for HTTP, so a request never reaches it directly.
// Instead it lands on a Supabase Edge Function (`crm-inbox`, built on the
// Lovable side — see docs/INBOUND_WEBHOOKS_LOVABLE.md), which stores it as a
// row in `inbound_commands`. The machine holding the sender lease polls that
// table, claims pending rows, runs them, and writes each result back. The
// caller gets 202 + an id straight away and can GET the result later.
//
// EXPERIMENTAL and OFF by default (`inboundWebhooks.enabled` in settings).
// While off, nothing here touches the network.
//
// Guard rails, because anything that can be triggered from the internet will
// eventually be triggered by mistake:
//   * Only automations explicitly ticked in Settings can be run.
//   * The request can narrow WHO an automation acts on and fill {{vars.x}} in
//     its message — it can never change WHAT the automation does.
//   * `dryRun: true` can make a run safer; nothing in a request can make a
//     dry-run automation send for real.
//   * The automation's own message limits (once per contact, max per run)
//     still apply.
//
// Pure apart from the injected deps, so the whole flow is testable without
// chrome or the network.

import type { Store } from './storage';
import { readAutomations, whyNotRunnable, type Automation, type AutomationRun } from './automations';
import { buildThreadIndex } from './contacts';
import { extractThreadFromProfileUrl, profileKey } from './csv';
import type { SettingsBag } from './settingsMerge';

// ---------------------------------------------------------------------------
// Settings (a plain scalar key in store.settings — syncs last-write-wins)
// ---------------------------------------------------------------------------

export const INBOUND_SETTINGS_KEY = 'inboundWebhooks';

export interface InboundSettings {
  /** Master switch. Off = no polling, no network. */
  enabled: boolean;
  /** Automations a webhook may run. Empty = none. */
  automationIds: string[];
}

export function readInboundSettings(store: Pick<Store, 'settings'>): InboundSettings {
  const raw = (store.settings as SettingsBag | undefined)?.[INBOUND_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return { enabled: false, automationIds: [] };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    automationIds: Array.isArray(o.automationIds)
      ? Array.from(new Set(o.automationIds.filter((x): x is string => typeof x === 'string')))
      : [],
  };
}

export function writeInboundSettings(settings: SettingsBag | undefined, next: InboundSettings): SettingsBag {
  return {
    ...(settings || {}),
    [INBOUND_SETTINGS_KEY]: { enabled: !!next.enabled, automationIds: Array.from(new Set(next.automationIds)) },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** A row as the claim RPC returns it. Only the fields used here are typed. */
export interface InboundCommandRow {
  id: string;
  command: string;
  payload: unknown;
  created_at: string;
  expires_at?: string;
  /** The token the request came in with (null once that token is deleted). */
  token_id?: string | null;
}

export interface ContactRef {
  id?: string;
  profileUrl?: string;
  chatUrl?: string;
}

export const INBOUND_COMMANDS = ['ping', 'automation.run'] as const;
export const MAX_INBOUND_CONTACTS = 250;
export const MAX_VARS = 20;
export const MAX_VAR_LENGTH = 500;
const VAR_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;

export type ParsedCommand =
  | { ok: true; command: 'ping' }
  | {
      ok: true;
      command: 'automation.run';
      /** Automation id or name. */
      automation: string;
      /** Absent = use the automation's own source. */
      contacts?: ContactRef[];
      vars: Record<string, string>;
      dryRun: boolean;
    }
  | { ok: false; error: string };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseInboundCommand(row: InboundCommandRow): ParsedCommand {
  if (row.command === 'ping') return { ok: true, command: 'ping' };
  if (row.command !== 'automation.run') {
    return { ok: false, error: `Unknown command "${row.command}". Supported: ${INBOUND_COMMANDS.join(', ')}.` };
  }

  const p = row.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'payload must be a JSON object.' };
  const o = p as Record<string, unknown>;

  const automation = str(o.automation) ?? str(o.automationId);
  if (!automation) return { ok: false, error: 'payload.automation (id or name) is required.' };

  let contacts: ContactRef[] | undefined;
  if (o.contacts !== undefined) {
    if (!Array.isArray(o.contacts)) return { ok: false, error: 'payload.contacts must be a list.' };
    if (o.contacts.length === 0) return { ok: false, error: 'payload.contacts is empty. Leave it out to use the automation’s own source.' };
    if (o.contacts.length > MAX_INBOUND_CONTACTS) {
      return { ok: false, error: `payload.contacts has ${o.contacts.length} entries; the most is ${MAX_INBOUND_CONTACTS}.` };
    }
    contacts = [];
    for (const [i, c] of o.contacts.entries()) {
      const e = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
      const ref: ContactRef = {};
      const id = str(e.id); const profileUrl = str(e.profileUrl); const chatUrl = str(e.chatUrl);
      if (id) ref.id = id;
      if (profileUrl) ref.profileUrl = profileUrl;
      if (chatUrl) ref.chatUrl = chatUrl;
      if (!id && !profileUrl && !chatUrl) {
        return { ok: false, error: `payload.contacts[${i}] needs an id, profileUrl or chatUrl.` };
      }
      contacts.push(ref);
    }
  }

  const vars: Record<string, string> = {};
  if (o.vars !== undefined) {
    if (!o.vars || typeof o.vars !== 'object' || Array.isArray(o.vars)) return { ok: false, error: 'payload.vars must be an object.' };
    const entries = Object.entries(o.vars as Record<string, unknown>);
    if (entries.length > MAX_VARS) return { ok: false, error: `payload.vars has more than ${MAX_VARS} keys.` };
    for (const [k, v] of entries) {
      if (!VAR_KEY_RE.test(k)) return { ok: false, error: `payload.vars key "${k}" may only use letters, digits and _.` };
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return { ok: false, error: `payload.vars.${k} must be text, a number or true/false.` };
      }
      const s = String(v);
      if (s.length > MAX_VAR_LENGTH) return { ok: false, error: `payload.vars.${k} is longer than ${MAX_VAR_LENGTH} characters.` };
      vars[k] = s;
    }
  }

  return {
    ok: true, command: 'automation.run', automation,
    ...(contacts ? { contacts } : {}),
    vars,
    dryRun: o.dryRun === true,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function findInboundAutomation(store: Store, ref: string): { automation: Automation } | { error: string } {
  const all = readAutomations(store);
  const byId = all.find((a) => a.id === ref);
  let hit = byId;
  if (!hit) {
    const key = ref.trim().toLowerCase();
    const named = all.filter((a) => a.name.trim().toLowerCase() === key);
    if (named.length > 1) return { error: `More than one automation is called "${ref}". Use its id instead.` };
    hit = named[0];
  }
  if (!hit) return { error: `No automation called "${ref}".` };

  const settings = readInboundSettings(store);
  if (!settings.automationIds.includes(hit.id)) {
    return { error: `Automation "${hit.name}" is not allowed to run from webhooks. Tick it in Settings → Incoming webhooks.` };
  }
  const why = whyNotRunnable(hit, store);
  if (why) return { error: `Automation "${hit.name}" can't run: ${why}` };
  return { automation: hit };
}

function chatUrlThread(url: string | undefined): string | null {
  const m = (url || '').match(/\/t\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** Map request refs onto contact store keys. Deduped, request order kept. */
export function resolveContactRefs(store: Store, refs: ContactRef[]): { ids: string[]; notFound: ContactRef[] } {
  const index = buildThreadIndex(store);
  const byProfile = new Map<string, string>();
  for (const c of Object.values(store.conversations)) {
    const k = profileKey(c.profileUrl);
    if (k && !byProfile.has(k)) byProfile.set(k, c.id);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const notFound: ContactRef[] = [];
  for (const ref of refs) {
    let hit: string | undefined;
    if (ref.id) hit = store.conversations[ref.id]?.id ?? index.get(ref.id.toLowerCase())?.id;
    if (!hit && ref.profileUrl) {
      const k = profileKey(ref.profileUrl);
      hit = (k && byProfile.get(k)) || undefined;
      const t = extractThreadFromProfileUrl(ref.profileUrl)?.threadId;
      if (!hit && t) hit = index.get(t.toLowerCase())?.id;
    }
    if (!hit && ref.chatUrl) {
      const t = chatUrlThread(ref.chatUrl);
      if (t) hit = index.get(t)?.id;
    }
    if (!hit) { notFound.push(ref); continue; }
    if (seen.has(hit)) continue;
    seen.add(hit);
    ids.push(hit);
  }
  return { ids, notFound };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Fill {{vars.key}}. Unknown keys stay visible. Braces are stripped from
 * values so a value can't inject {{name}} or another var.
 */
export function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key].replace(/[{}]/g, '') : whole);
}

/** A copy of the automation with the request's vars and dryRun applied. */
export function withInboundOverrides(a: Automation, o: { vars: Record<string, string>; dryRun: boolean }): Automation {
  if (!a.message) return a;
  return {
    ...a,
    message: {
      ...a.message,
      template: applyVars(a.message.template, o.vars),
      dryRun: a.message.dryRun || o.dryRun,
    },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type CompleteOutcome = { status: 'done' | 'failed'; result?: Record<string, unknown>; error?: string };
export type ClaimResult = { ok: true; rows: InboundCommandRow[] } | { ok: false; error: string; status?: number };

export interface InboundStatus {
  at: number;
  ok: boolean;
  error?: string;
  claimed: number;
  skipped?: 'disabled' | 'signed-out' | 'not-sender';
  last?: { id: string; command: string; status: 'done' | 'failed'; error?: string; at: number };
}

export interface InboundDeps {
  loadStore(): Promise<Store>;
  getSettings(): Promise<InboundSettings>;
  isSignedIn(): Promise<boolean>;
  isSender(): Promise<boolean>;
  deviceId(): Promise<string>;
  version: string;
  claim(deviceId: string): Promise<ClaimResult>;
  complete(id: string, outcome: CompleteOutcome): Promise<{ ok: boolean; error?: string }>;
  /**
   * Run the automation (already overridden) and resolve with its finished run
   * record. `ids` undefined = its own source. `source` names the webhook for
   * the contacts' history. May throw.
   */
  runAutomation(automation: Automation, ids: string[] | undefined, source?: string): Promise<AutomationRun>;
  /** The label of the token a request came in with, for contact history. Optional; never throws. */
  tokenLabel?(tokenId: string): Promise<string | undefined>;
  saveStatus(s: InboundStatus): Promise<void>;
  now(): number;
}

export async function executeInboundCommand(row: InboundCommandRow, deps: InboundDeps): Promise<CompleteOutcome> {
  try {
    const parsed = parseInboundCommand(row);
    if ('error' in parsed) return { status: 'failed', error: parsed.error };
    if (parsed.command === 'ping') {
      return { status: 'done', result: { pong: true, device: await deps.deviceId(), version: deps.version, at: deps.now() } };
    }

    const store = await deps.loadStore();
    const found = findInboundAutomation(store, parsed.automation);
    if ('error' in found) return { status: 'failed', error: found.error };

    let ids: string[] | undefined;
    let notFound: ContactRef[] = [];
    if (parsed.contacts) {
      const r = resolveContactRefs(store, parsed.contacts);
      if (!r.ids.length) return { status: 'failed', error: 'None of the contacts in the request are in the CRM.', result: { notFound: r.notFound } };
      ids = r.ids;
      notFound = r.notFound;
    }

    let label: string | undefined;
    if (row.token_id && deps.tokenLabel) {
      try { label = await deps.tokenLabel(row.token_id); } catch { /* cosmetic */ }
    }
    const run = await deps.runAutomation(withInboundOverrides(found.automation, parsed), ids, label || 'Incoming webhook');
    const { running: _r, phase: _p, ...summary } = run;
    const result: Record<string, unknown> = { ...summary, automationName: found.automation.name, dryRun: parsed.dryRun };
    if (parsed.contacts) result.notFound = notFound;
    if (run.error) return { status: 'failed', error: run.error, result };
    return { status: 'done', result };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** One poll: claim what's waiting, run each, report each. Never throws. */
export async function pollInbound(deps: InboundDeps): Promise<InboundStatus> {
  const at = deps.now();
  const finish = async (s: InboundStatus) => { try { await deps.saveStatus(s); } catch { /* status is cosmetic */ } return s; };
  try {
    if (!(await deps.getSettings()).enabled) return { at, ok: true, claimed: 0, skipped: 'disabled' };
    if (!(await deps.isSignedIn())) return finish({ at, ok: true, claimed: 0, skipped: 'signed-out' });
    if (!(await deps.isSender())) return finish({ at, ok: true, claimed: 0, skipped: 'not-sender' });

    const claim = await deps.claim(await deps.deviceId());
    if ('error' in claim) return finish({ at, ok: false, error: claim.error, claimed: 0 });

    let last: InboundStatus['last'];
    for (const row of claim.rows) {
      const outcome = await executeInboundCommand(row, deps);
      const reported = await deps.complete(row.id, outcome);
      if (!reported.ok) console.warn('[CRM] inbound: could not report result for', row.id, reported.error);
      last = { id: row.id, command: row.command, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), at: deps.now() };
    }
    return finish({ at, ok: true, claimed: claim.rows.length, ...(last ? { last } : {}) });
  } catch (e) {
    return finish({ at, ok: false, error: e instanceof Error ? e.message : String(e), claimed: 0 });
  }
}
