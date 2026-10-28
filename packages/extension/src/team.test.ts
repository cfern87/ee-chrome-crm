import { describe, it, expect } from 'vitest';
import { makeTeamClient, TEAM_SETUP_PENDING_MESSAGE, isNotMemberError, isTeamWorkspace, PERSONAL_WORKSPACE } from './team';

function client(reply: (url: string, body: unknown) => { status?: number; json: unknown }, token: string | null = 'jwt') {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const c = makeTeamClient({
    baseUrl: 'https://sb.example',
    anonKey: 'anon',
    getToken: async () => token,
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      const r = reply(url, body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as unknown as typeof fetch,
  });
  return { c, calls };
}

describe('team client', () => {
  it('calls the RPC as the signed-in user', async () => {
    const { c, calls } = client(() => ({ json: [] }));
    await c.myWorkspaces();
    expect(calls[0].url).toBe('https://sb.example/rest/v1/rpc/crm_my_workspaces');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt');
    expect(calls[0].headers.apikey).toBe('anon');
  });

  it('refuses without a session', async () => {
    const { c, calls } = client(() => ({ json: [] }), null);
    expect(await c.myWorkspaces()).toEqual({ ok: false, error: 'Not signed in.' });
    expect(calls).toHaveLength(0);
  });

  it('maps workspace rows', async () => {
    const { c } = client(() => ({
      json: [{ team_id: 't1', name: 'Acme', role: 'owner', status: 'active', owner_email: 'a@x', member_count: 3, seat_limit: 10, active: false }],
    }));
    const r = await c.myWorkspaces();
    expect(r).toEqual({ ok: true, list: [{ id: 't1', name: 'Acme', role: 'owner', status: 'active', ownerEmail: 'a@x', memberCount: 3, seatLimit: 10, active: false }] });
  });

  it('recognises a server without the team functions', async () => {
    const { c } = client(() => ({ status: 404, json: { code: 'PGRST202', message: 'Could not find the function' } }));
    const r = await c.myWorkspaces();
    expect(r).toMatchObject({ ok: false, error: TEAM_SETUP_PENDING_MESSAGE, setupPending: true });
  });

  it('passes server messages through', async () => {
    const { c } = client(() => ({ status: 400, json: { code: 'P0001', message: 'Only the team owner can invite.' } }));
    expect(await c.invite('t', 'b@x')).toMatchObject({ ok: false, error: 'Only the team owner can invite.' });
  });

  it('parses store get/put, including a refused compare-and-swap', async () => {
    const { c, calls } = client((url) => url.endsWith('crm_team_store_get')
      ? { json: [{ version: 7, data: null, active: true }] }
      : { json: [{ ok: false, version: 8 }] });
    expect(await c.getStore('t', 7)).toEqual({ ok: true, version: 7, data: null, active: true });
    expect(calls[0].body).toEqual({ p_team: 't', p_known_version: 7 });
    expect(await c.putStore('t', 7, { conversations: {} })).toEqual({ ok: true, written: false, version: 8 });
    expect(calls[1].body).toEqual({ p_team: 't', p_expected_version: 7, p_data: { conversations: {} } });
  });

  it('reads the created team id from a scalar RPC result', async () => {
    const { c } = client(() => ({ json: 'uuid-1' }));
    expect(await c.createTeam('Acme')).toEqual({ ok: true, id: 'uuid-1' });
  });
});

describe('helpers', () => {
  it('tells team workspaces from personal', () => {
    expect(isTeamWorkspace(PERSONAL_WORKSPACE)).toBe(false);
    expect(isTeamWorkspace('')).toBe(false);
    expect(isTeamWorkspace('abc')).toBe(true);
    expect(isNotMemberError('not a member of this team')).toBe(true);
    expect(isNotMemberError('network down')).toBe(false);
  });
});
