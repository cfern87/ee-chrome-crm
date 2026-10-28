// The extension's side of the incoming-webhook mailbox: talks to the Supabase
// tables and RPCs described in docs/INBOUND_WEBHOOKS_LOVABLE.md, as the
// signed-in user (RLS scopes everything to their own rows).
//
// Never throws: every call resolves to { ok: false, error } on failure, so a
// missing server piece shows up as a readable status rather than a crash.

import type { ClaimResult, CompleteOutcome, InboundCommandRow } from './inbound';

/**
 * Where outside systems POST. It lives on the website (Lovable hosts server
 * code there, not in Supabase edge functions); the website writes into the
 * same Supabase tables this client reads.
 */
export const INBOUND_ENDPOINT_PATH = '/api/public/crm-inbox';

export function inboundEndpointUrl(platformUrl: string): string {
  return `${platformUrl.replace(/\/+$/, '')}${INBOUND_ENDPOINT_PATH}`;
}
export const CLAIM_LIMIT = 5;

export const SETUP_PENDING_MESSAGE =
  'The server side of incoming webhooks is not set up yet (the Supabase tables/functions are missing).';

export interface InboundToken {
  id: string;
  token_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface InboundCommandSummary {
  id: string;
  command: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired';
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  expires_at: string;
}

/** One request in a token's history: the summary plus what was asked and what came back. */
export interface InboundCommandDetail extends InboundCommandSummary {
  payload: unknown;
  result: Record<string, unknown> | null;
}

/** Requests shown per token. The server keeps more; this is just what the history lists. */
export const TOKEN_HISTORY_LIMIT = 10;

type Fail = { ok: false; error: string; status?: number };

export interface InboundClientDeps {
  /** Supabase project URL — for the extension's own table reads and RPCs. */
  baseUrl: string;
  anonKey: string;
  /** The public endpoint shown to users (see inboundEndpointUrl). */
  endpointUrl: string;
  getToken(): Promise<string | null>;
  fetch: typeof fetch;
}

export function makeInboundClient(deps: InboundClientDeps) {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: unknown } | Fail> {
    const token = await deps.getToken();
    if (!token) return { ok: false, error: 'Not signed in.' };
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}${path}`, {
        method,
        headers: { apikey: deps.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const j = (json || {}) as { code?: string; message?: string; error?: string };
      // PGRST202 = RPC not found, 42P01 = table not found, PGRST205 = table not in schema cache.
      if (j.code === 'PGRST202' || j.code === '42P01' || j.code === 'PGRST205' || (res.status === 404 && !j.message)) {
        return { ok: false, error: SETUP_PENDING_MESSAGE, status: res.status };
      }
      return { ok: false, error: j.message || j.error || `Server replied ${res.status}.`, status: res.status };
    }
    return { ok: true, data: json };
  }

  const rpc = (name: string, args: Record<string, unknown>) => call('POST', `/rest/v1/rpc/${name}`, args);
  // The project compiles without strictNullChecks, where `ok: true | false`
  // doesn't narrow â€” so failures are recognised by their `error` field.
  const failed = (r: { ok: true; data: unknown } | Fail): r is Fail => 'error' in r;

  return {
    endpointUrl: deps.endpointUrl,

    async claim(deviceId: string): Promise<ClaimResult> {
      const r = await rpc('claim_inbound_commands', { p_device: deviceId, p_limit: CLAIM_LIMIT });
      if (failed(r)) return r;
      return { ok: true, rows: Array.isArray(r.data) ? (r.data as InboundCommandRow[]) : [] };
    },

    async complete(id: string, o: CompleteOutcome): Promise<{ ok: true } | Fail> {
      const r = await rpc('complete_inbound_command', {
        p_id: id, p_status: o.status, p_result: o.result ?? null, p_error: o.error ?? null,
      });
      return failed(r) ? r : { ok: true };
    },

    async createToken(label: string): Promise<{ ok: true; token: { id: string; token: string; token_prefix: string } } | Fail> {
      const r = await rpc('create_inbound_token', { p_label: label });
      if (failed(r)) return r;
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!row || typeof row !== 'object' || typeof (row as { token?: unknown }).token !== 'string') {
        return { ok: false, error: 'The server did not return a token.' };
      }
      return { ok: true, token: row as { id: string; token: string; token_prefix: string } };
    },

    async revokeToken(id: string): Promise<{ ok: true } | Fail> {
      const r = await rpc('revoke_inbound_token', { p_id: id });
      return failed(r) ? r : { ok: true };
    },

    async listTokens(): Promise<{ ok: true; tokens: InboundToken[] } | Fail> {
      const r = await call('GET', '/rest/v1/inbound_tokens?select=id,token_prefix,label,created_at,last_used_at,revoked_at&order=created_at.desc');
      return failed(r) ? r : { ok: true, tokens: Array.isArray(r.data) ? (r.data as InboundToken[]) : [] };
    },

    async listRecent(limit = 20): Promise<{ ok: true; commands: InboundCommandSummary[] } | Fail> {
      const r = await call('GET', `/rest/v1/inbound_commands?select=id,command,status,error,created_at,claimed_at,finished_at,expires_at&order=created_at.desc&limit=${limit}`);
      return failed(r) ? r : { ok: true, commands: Array.isArray(r.data) ? (r.data as InboundCommandSummary[]) : [] };
    },

    /** The last requests that came in with one token, newest first. */
    async listForToken(tokenId: string, limit = TOKEN_HISTORY_LIMIT): Promise<{ ok: true; commands: InboundCommandDetail[] } | Fail> {
      const n = Math.max(1, Math.min(50, Math.floor(limit) || TOKEN_HISTORY_LIMIT));
      const r = await call('GET', `/rest/v1/inbound_commands?select=id,command,status,error,payload,result,created_at,claimed_at,finished_at,expires_at&token_id=eq.${encodeURIComponent(tokenId)}&order=created_at.desc&limit=${n}`);
      return failed(r) ? r : { ok: true, commands: Array.isArray(r.data) ? (r.data as InboundCommandDetail[]) : [] };
    },
  };
}

export type InboundClient = ReturnType<typeof makeInboundClient>;
