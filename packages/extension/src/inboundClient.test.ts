import { describe, it, expect, vi } from 'vitest';
import {
  makeInboundClient, INBOUND_FUNCTION_PATH, SETUP_PENDING_MESSAGE,
} from './inboundClient';

const BASE = 'https://example.supabase.co';
const ANON = 'anon-key';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(fetchImpl: typeof fetch, token: string | null = 'user-jwt') {
  return makeInboundClient({ baseUrl: BASE, anonKey: ANON, getToken: async () => token, fetch: fetchImpl });
}

describe('inbound client', () => {
  it('exposes the public endpoint URL callers POST to', () => {
    expect(client(vi.fn()).endpointUrl).toBe(`${BASE}${INBOUND_FUNCTION_PATH}`);
    expect(INBOUND_FUNCTION_PATH).toBe('/functions/v1/crm-inbox');
  });

  it('claims via the claim_inbound_commands RPC with the user token', async () => {
    const f = vi.fn(async () => jsonResponse(200, [{ id: 'c1', command: 'ping', payload: {}, created_at: 'x' }]));
    const r = await client(f as unknown as typeof fetch).claim('dev-1');
    expect(r).toEqual({ ok: true, rows: [{ id: 'c1', command: 'ping', payload: {}, created_at: 'x' }] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/v1/rpc/claim_inbound_commands`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ apikey: ANON, Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ p_device: 'dev-1', p_limit: 5 });
  });

  it('completes via the complete_inbound_command RPC', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const r = await client(f as unknown as typeof fetch).complete('c1', { status: 'done', result: { pong: true } });
    expect(r).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/v1/rpc/complete_inbound_command`);
    expect(JSON.parse(String(init.body))).toEqual({ p_id: 'c1', p_status: 'done', p_result: { pong: true }, p_error: null });
  });

  it('refuses to call anything when signed out', async () => {
    const f = vi.fn();
    const r = await client(f as unknown as typeof fetch, null).claim('dev-1');
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('explains a missing RPC as the server side not being set up yet', async () => {
    const f = vi.fn(async () => jsonResponse(404, { code: 'PGRST202', message: 'Could not find the function' }));
    const r = await client(f as unknown as typeof fetch).claim('dev-1');
    expect(r).toEqual({ ok: false, error: SETUP_PENDING_MESSAGE, status: 404 });
  });

  it('passes on the server message for other errors', async () => {
    const f = vi.fn(async () => jsonResponse(400, { message: 'bad status' }));
    const r = await client(f as unknown as typeof fetch).complete('c1', { status: 'done' });
    expect(r).toEqual({ ok: false, error: 'bad status', status: 400 });
  });

  it('never throws on a network failure', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const r = await client(f as unknown as typeof fetch).claim('dev-1');
    expect(r).toEqual({ ok: false, error: 'TypeError: Failed to fetch' });
  });

  it('creates a token and returns the plaintext once', async () => {
    const f = vi.fn(async () => jsonResponse(200, [{ id: 't1', token: 'crm_in_abc', token_prefix: 'crm_in_a' }]));
    const r = await client(f as unknown as typeof fetch).createToken('Zapier');
    expect(r).toEqual({ ok: true, token: { id: 't1', token: 'crm_in_abc', token_prefix: 'crm_in_a' } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/v1/rpc/create_inbound_token`);
    expect(JSON.parse(String(init.body))).toEqual({ p_label: 'Zapier' });
  });

  it('revokes a token', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await client(f as unknown as typeof fetch).revokeToken('t1')).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/v1/rpc/revoke_inbound_token`);
    expect(JSON.parse(String(init.body))).toEqual({ p_id: 't1' });
  });

  it('lists tokens and recent commands through table reads', async () => {
    const f = vi.fn(async () => jsonResponse(200, []));
    const c = client(f as unknown as typeof fetch);
    await c.listTokens();
    await c.listRecent(10);
    const urls = f.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls[0]).toBe(`${BASE}/rest/v1/inbound_tokens?select=id,token_prefix,label,created_at,last_used_at,revoked_at&order=created_at.desc`);
    expect(urls[1]).toBe(`${BASE}/rest/v1/inbound_commands?select=id,command,status,error,created_at,claimed_at,finished_at,expires_at&order=created_at.desc&limit=10`);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('GET');
  });
});
