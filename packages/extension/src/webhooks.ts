// Outbound webhooks: a POST to a URL of the user's choosing when something
// happens in the CRM.
//
// This extension has no backend by design (see the storage notes — Drive is the
// sync layer precisely so there is no server to run). That makes it a closed
// world: everything the CRM knows stays inside the browser. Webhooks are the
// one seam out of it — the user's own automation, their own site, whatever they
// point it at — without any of it having to become our problem.
//
// Two consequences of "no backend" that shape everything below:
//
//   * DELIVERY IS BEST-EFFORT. There is no durable queue and no retry
//     schedule, because there is no server to hold one and a service worker
//     that can be killed between two awaits is not a place to build one. Each
//     delivery is one attempt with a timeout; the outcome is recorded on the
//     webhook so the user can see it in Settings. Anything that must not be
//     missed should be reconciled from the receiving end, not assumed.
//   * NO SECRETS WORTH THE NAME. A shared secret sent from a browser extension
//     is readable by anyone with the user's profile, so the `secret` below is
//     an identification convenience (tell my endpoint which of my machines
//     this is), NOT authentication. Receivers should treat the payload as
//     untrusted and verify by re-reading their own state where it matters.
//
// Pure except for `deliver`, which is the one function that touches the
// network. Everything else is data and diffing, so the background can decide
// what happened without knowing how it gets sent.

import type { Store, Conversation } from './storage';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type WebhookEvent =
  | 'contact.created'
  | 'contact.deleted'
  | 'contact.renamed'
  | 'contact.tag_added'
  | 'contact.tag_removed'
  | 'contact.archived'
  | 'contact.unarchived'
  | 'campaign.started'
  | 'campaign.completed'
  | 'message.sent'
  | 'message.failed';

export interface WebhookEventDef {
  event: WebhookEvent;
  label: string;
  hint: string;
}

/** Every event a webhook can subscribe to, in the order Settings lists them. */
export const WEBHOOK_EVENTS: WebhookEventDef[] = [
  { event: 'contact.created', label: 'Contact created', hint: 'Someone new entered the CRM — captured in Messenger, added from a profile, or imported.' },
  { event: 'contact.deleted', label: 'Contact deleted', hint: 'A contact was removed from the CRM.' },
  { event: 'contact.renamed', label: 'Contact renamed', hint: "A contact's name changed. Carries both the old and the new name." },
  { event: 'contact.tag_added', label: 'Tag added', hint: 'One event per tag added, so a preset that applies three tags fires three times.' },
  { event: 'contact.tag_removed', label: 'Tag removed', hint: 'One event per tag removed.' },
  { event: 'contact.archived', label: 'Contact archived', hint: 'A contact was archived.' },
  { event: 'contact.unarchived', label: 'Contact unarchived', hint: 'An archived contact came back.' },
  { event: 'campaign.started', label: 'Campaign started', hint: 'A bulk send was queued. Carries the recipient count, not the recipients.' },
  { event: 'campaign.completed', label: 'Campaign completed', hint: 'A bulk send finished, with its sent/failed tallies.' },
  { event: 'message.sent', label: 'Message sent', hint: 'One confirmed delivery inside a campaign.' },
  { event: 'message.failed', label: 'Message failed', hint: 'One send that failed or was skipped, with the reason.' },
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WebhookDelivery {
  at: number;
  ok: boolean;
  /** HTTP status, when there was a response at all. */
  status?: number;
  error?: string;
  event?: WebhookEvent;
}

export interface WebhookConfig {
  id: string;
  /** Where to POST. https only — see isValidWebhookUrl. */
  url: string;
  /** What to send. Empty means nothing is sent, not everything. */
  events: WebhookEvent[];
  enabled: boolean;
  /** Optional label, echoed in the payload so one endpoint can serve several. */
  name?: string;
  /**
   * Sent as the `X-CRM-Token` header. NOT a signature and NOT authentication —
   * see the module header. Useful for routing and for rejecting obvious noise.
   */
  secret?: string;
  createdAt: number;
  updatedAt?: number;
  lastDelivery?: WebhookDelivery;
}

export const WEBHOOKS_KEY = 'webhooks';
export const MAX_WEBHOOKS = 10;

/** The payload version. Bumped only for a breaking change to the envelope. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * https only, and no credentials in the URL.
 *
 * http is refused rather than merely discouraged: the payload carries contact
 * names and tags, and a plaintext POST from a browser extension puts those on
 * the wire for anyone on the network. localhost is the pragmatic exception —
 * it never leaves the machine, and testing a receiver locally is the first
 * thing anyone will want to do.
 */
export function isValidWebhookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'That is not a URL. It should start with https://';
  }
  const localhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localhost)) {
    return 'Webhook URLs must use https (http is allowed for localhost while you test).';
  }
  if (u.username || u.password) {
    return 'Put credentials in the token field rather than in the URL.';
  }
  return null;
}

export function readWebhooks(store: Pick<Store, 'settings'>): WebhookConfig[] {
  const raw = (store.settings as Record<string, unknown>)?.[WEBHOOKS_KEY];
  if (!Array.isArray(raw)) return [];
  const known = new Set(WEBHOOK_EVENTS.map((e) => e.event));
  const out: WebhookConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.url !== 'string') continue;
    out.push({
      id: o.id,
      url: o.url,
      // An event written by a newer build is dropped rather than kept as a
      // string we'd never fire — otherwise Settings shows a subscription that
      // silently does nothing.
      events: Array.isArray(o.events)
        ? (o.events.filter((e): e is WebhookEvent => typeof e === 'string' && known.has(e as WebhookEvent)))
        : [],
      enabled: o.enabled !== false,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.secret === 'string' ? { secret: o.secret } : {}),
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
      ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
      ...(o.lastDelivery && typeof o.lastDelivery === 'object'
        ? { lastDelivery: o.lastDelivery as WebhookDelivery }
        : {}),
    });
  }
  return out.slice(0, MAX_WEBHOOKS);
}

export function newWebhook(url: string): WebhookConfig {
  const now = Date.now();
  return {
    id: `wh_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    url: url.trim(),
    // Opting in explicitly beats defaulting to everything: a fresh endpoint
    // getting every tag change from a bulk import is how people conclude
    // webhooks are unusable.
    events: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** The contact shape every contact event carries. Deliberately small. */
export interface WebhookContact {
  id: string;
  name: string;
  chatUrl?: string;
  profileUrl?: string;
  tags: string[];
  archived: boolean;
}

export interface WebhookPayload {
  /** Unique per delivery attempt — use it to dedupe if you retry. */
  id: string;
  event: WebhookEvent;
  sentAt: number;
  version: number;
  source: 'not-another-social-crm';
  /** The webhook's own name, when it has one. Lets one endpoint fan out. */
  webhook?: string;
  data: Record<string, unknown>;
}

export function contactSummary(c: Conversation, store: Pick<Store, 'tags'>): WebhookContact {
  return {
    id: c.id,
    name: c.participantName || '',
    ...(c.chatUrl ? { chatUrl: c.chatUrl } : {}),
    ...(c.profileUrl ? { profileUrl: c.profileUrl } : {}),
    // Tag NAMES, not ids. An id is meaningless outside this store, and the
    // receiver would need a second channel just to resolve it.
    tags: c.tags.map((id) => store.tags[id]?.name).filter((n): n is string => !!n),
    archived: !!c.archived,
  };
}

export function buildPayload(hook: WebhookConfig, event: WebhookEvent, data: Record<string, unknown>): WebhookPayload {
  return {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    event,
    sentAt: Date.now(),
    version: WEBHOOK_PAYLOAD_VERSION,
    source: 'not-another-social-crm',
    ...(hook.name ? { webhook: hook.name } : {}),
    data,
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/** An event and its payload data, before a webhook is chosen for it. */
export interface PendingEvent {
  event: WebhookEvent;
  data: Record<string, unknown>;
}

/**
 * What changed between two snapshots of the store, as events.
 *
 * Diffing rather than firing at each mutation site is deliberate. There are a
 * dozen places a contact can be tagged — the panel, a preset, the dashboard, a
 * CSV import, a merge — and asking each of them to remember to emit an event
 * is the same standing invitation to forget that campaigns.ts's stamping
 * comment describes. One diff at the single choke point every write already
 * passes through cannot be forgotten, and cannot disagree with what was
 * actually saved.
 *
 * `next` is compared against `prev` for contacts only. Tag/field/settings
 * edits are configuration rather than CRM activity and would mostly be noise.
 */
export function diffContactEvents(prev: Store, next: Store): PendingEvent[] {
  const out: PendingEvent[] = [];

  for (const [id, after] of Object.entries(next.conversations)) {
    const before = prev.conversations[id];

    if (!before) {
      out.push({ event: 'contact.created', data: { contact: contactSummary(after, next) } });
      continue;
    }

    if ((before.participantName || '') !== (after.participantName || '')) {
      out.push({
        event: 'contact.renamed',
        data: {
          contact: contactSummary(after, next),
          previousName: before.participantName || '',
          name: after.participantName || '',
        },
      });
    }

    // One event per tag, not one per tagging action: a receiver that wants
    // "was Warm Lead applied" shouldn't have to diff two arrays itself. A
    // preset applying three tags is three events, which the Settings hint says.
    const had = new Set(before.tags);
    const has = new Set(after.tags);
    for (const tagId of after.tags) {
      if (had.has(tagId)) continue;
      out.push({
        event: 'contact.tag_added',
        data: { contact: contactSummary(after, next), tag: next.tags[tagId]?.name || tagId },
      });
    }
    for (const tagId of before.tags) {
      if (has.has(tagId)) continue;
      // Resolve the name from either snapshot: a tag deleted in this same write
      // is gone from `next` but the removal is still worth naming.
      out.push({
        event: 'contact.tag_removed',
        data: { contact: contactSummary(after, next), tag: next.tags[tagId]?.name || prev.tags[tagId]?.name || tagId },
      });
    }

    if (!!before.archived !== !!after.archived) {
      out.push({
        event: after.archived ? 'contact.archived' : 'contact.unarchived',
        data: { contact: contactSummary(after, next) },
      });
    }
  }

  for (const [id, before] of Object.entries(prev.conversations)) {
    if (next.conversations[id]) continue;
    out.push({
      event: 'contact.deleted',
      // The record is gone, so this is the last snapshot of it — read from
      // `prev` for the tag names too.
      data: { contact: contactSummary(before, prev) },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** How long one delivery attempt gets before it is abandoned. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * POST one payload. Never throws — a webhook the user pointed at a dead host
 * must not be able to break the send loop or a store write that has already
 * happened. The outcome is returned so the caller can record it.
 */
export async function deliver(hook: WebhookConfig, payload: WebhookPayload): Promise<WebhookDelivery> {
  const at = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(hook.secret ? { 'X-CRM-Token': hook.secret } : {}),
        'X-CRM-Event': payload.event,
        'X-CRM-Delivery': payload.id,
      },
      body: JSON.stringify(payload),
      // The response body is never read, so don't ask the endpoint's CORS
      // policy for permission to read it. The extension has host permission to
      // make the request; opaque is enough to learn whether it was accepted.
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      at,
      ok: res.ok,
      status: res.status,
      event: payload.event,
      ...(res.ok ? {} : { error: `Endpoint replied ${res.status}` }),
    };
  } catch (e) {
    const aborted = controller.signal.aborted;
    return {
      at,
      ok: false,
      event: payload.event,
      error: aborted ? `No response within ${WEBHOOK_TIMEOUT_MS / 1000}s` : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The webhooks subscribed to `event` and switched on. */
export function subscribersOf(hooks: WebhookConfig[], event: WebhookEvent): WebhookConfig[] {
  return hooks.filter((h) => h.enabled && h.events.includes(event));
}
