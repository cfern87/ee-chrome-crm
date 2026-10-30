// Team workspaces UI: the switcher in the top bar and the Team card in
// Settings → Account & plan. All state lives in the background worker
// (teamService.ts); these components only ask it and render the answer.

import React, { useCallback, useEffect, useState } from 'react';
import { PLATFORM_URL } from '../license';
import {
  ACTIVE_WORKSPACE_KEY, PERSONAL_WORKSPACE, WORKSPACES_CACHE_KEY, isTeamWorkspace,
  type TeamMember, type WorkspaceInfo,
} from '../team';
import type { WorkspacesView } from '../teamService';
import type { TeamSeed } from '../workspaceTransfer';
import { Banner, Button, Card, Input, Select, Stack, Text, color, space } from '../ui/primitives';
import { sendBg, formatRelativeTime } from './shared';

type Result = { ok: boolean; error?: string; warning?: string };

/** The workspace list + active workspace, kept current across tabs. */
export function useWorkspaces(): { view: WorkspacesView | null; reload: (refresh?: boolean) => Promise<void> } {
  const [view, setView] = useState<WorkspacesView | null>(null);
  const reload = useCallback(async (refresh = false) => {
    const v = await sendBg<WorkspacesView>({ type: 'TEAM_WORKSPACES', payload: { refresh } }, 20_000);
    if (v) setView(v);
  }, []);
  useEffect(() => {
    void reload();
    try {
      const handler = (changes: Record<string, unknown>, area: string) => {
        if (area === 'local' && (ACTIVE_WORKSPACE_KEY in changes || WORKSPACES_CACHE_KEY in changes)) void reload();
      };
      chrome.storage.onChanged.addListener(handler);
      return () => chrome.storage.onChanged.removeListener(handler);
    } catch { return undefined; }
  }, [reload]);
  return { view, reload };
}

const joined = (list: WorkspaceInfo[]) => list.filter((w) => w.status === 'active');

/**
 * Top-bar switcher. Only rendered once the user is in at least one team, so
 * nobody else ever sees it.
 */
export function WorkspaceSwitcher() {
  const { view } = useWorkspaces();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!view) return null;
  const teams = joined(view.list);
  if (!teams.length) return null;

  const change = async (id: string) => {
    setBusy(true);
    setError('');
    const r = await sendBg<Result>({ type: 'TEAM_SWITCH', payload: { id } }, 60_000);
    setBusy(false);
    if (!r?.ok) setError(r?.error || 'Could not switch workspace.');
  };

  const current = teams.find((w) => w.id === view.active);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
      <Select
        aria-label="Workspace"
        title={error || 'Switch between your own contacts and shared team workspaces'}
        value={isTeamWorkspace(view.active) ? view.active : PERSONAL_WORKSPACE}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        style={{ maxWidth: 220, borderColor: current ? color.accent.base : undefined }}
      >
        <option value={PERSONAL_WORKSPACE}>Personal</option>
        {teams.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}{w.active ? '' : ' (read-only)'}
          </option>
        ))}
      </Select>
      {busy && <Text size="micro" tone="muted">Switching…</Text>}
      {error && <Text size="micro" tone="danger">{error}</Text>}
    </div>
  );
}

/** Settings → Account & plan → Team. */
export function TeamPanel() {
  const { view, reload } = useWorkspaces();
  const [status, setStatus] = useState<{ tone: 'success' | 'warning' | 'danger' | 'info'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (message: unknown, success: string, timeout = 30_000) => {
    setBusy(true);
    setStatus(null);
    const r = await sendBg<Result>(message, timeout);
    setBusy(false);
    if (r?.ok && r.warning) setStatus({ tone: 'warning', msg: r.warning });
    else if (r?.ok) setStatus({ tone: 'success', msg: success });
    else setStatus({ tone: 'danger', msg: r?.error || 'No answer from the extension. Try again.' });
    await reload();
    return !!r?.ok;
  };

  if (!view) {
    return (
      <Card style={{ marginBottom: space.md }}>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Team</Text>
      </Card>
    );
  }

  const owned = view.list.find((w) => w.role === 'owner' && w.status === 'active');
  const invites = view.list.filter((w) => w.status === 'invited');
  const memberOf = view.list.filter((w) => w.role === 'member' && w.status === 'active');
  const setupPending = !!view.setupPending;

  return (
    <Card style={{ marginBottom: space.md }}>
      <Stack direction="row" align="center" justify="space-between">
        <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Team</Text>
        <Button variant="link" disabled={busy} onClick={() => void reload(true)}>Refresh</Button>
      </Stack>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.md}px` }}>
        Share one set of contacts with your team. Everyone you invite gets a workspace switcher and can read and
        edit the shared contacts; your personal workspace stays private. Billing stays on your account.
      </Text>

      {setupPending && <Banner tone="warning">{view.error}</Banner>}
      {!setupPending && view.error && <Banner tone="warning">Couldn't reach the server: {view.error}</Banner>}

      {status && <div style={{ marginBottom: space.md }}><Banner tone={status.tone} live>{status.msg}</Banner></div>}

      {invites.map((w) => (
        <div key={w.id} style={{ padding: space.md, background: color.accent.subtle, borderRadius: 8, marginBottom: space.sm }}>
          <Text as="div" size="small"><strong>{w.ownerEmail || 'Someone'}</strong> invited you to <strong>{w.name}</strong>.</Text>
          <Stack direction="row" gap="sm" style={{ marginTop: space.sm }}>
            <Button variant="primary" size="sm" disabled={busy}
              onClick={() => void run({ type: 'TEAM_ACCEPT', payload: { teamId: w.id } }, `You joined ${w.name}. Pick it in the workspace switcher at the top.`)}>
              Accept
            </Button>
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={() => void run({ type: 'TEAM_LEAVE', payload: { teamId: w.id } }, 'Invite declined.')}>
              Decline
            </Button>
          </Stack>
        </div>
      ))}

      {memberOf.map((w) => (
        <MemberOfRow key={w.id} w={w} busy={busy} active={view.active === w.id}
          onLeave={() => void run({ type: 'TEAM_LEAVE', payload: { teamId: w.id } }, `You left ${w.name}.`)} />
      ))}

      {owned ? (
        <OwnerTeam team={owned} view={view} busy={busy} run={run} />
      ) : !setupPending && (
        view.isPro ? <CreateTeam busy={busy} run={run} /> : <ProGate />
      )}
    </Card>
  );
}

function ProGate() {
  return (
    <div style={{ padding: space.md, background: color.surface.sunken, borderRadius: 8 }}>
      <Text as="p" size="small" style={{ margin: `0 0 ${space.sm}px` }}>
        <strong>Team workspaces are part of Pro.</strong> Upgrade to invite teammates to a shared set of contacts.
        Invited teammates don't need their own subscription.
      </Text>
      <a href={`${PLATFORM_URL}/account/billing`} target="_blank" rel="noopener noreferrer"
        style={{ display: 'inline-block', background: color.special.base, color: color.surface.raised, textDecoration: 'none', padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13 }}>
        Upgrade to Pro
      </a>
    </div>
  );
}

type Run = (message: unknown, success: string, timeout?: number) => Promise<boolean>;

const SEED_CHOICES: { id: TeamSeed; label: string; hint: string }[] = [
  {
    id: 'move',
    label: 'Move my whole Personal workspace into the team',
    hint: 'Contacts, tags, fields, saved searches, automations and webhooks all become the team\'s. Personal is left empty once the team has its copy.',
  },
  {
    id: 'copy',
    label: 'Copy my contacts, tags and fields',
    hint: 'Personal keeps everything; automations and webhooks stay personal.',
  },
  { id: 'empty', label: 'Start empty', hint: 'Personal is untouched.' },
];

function CreateTeam({ busy, run }: { busy: boolean; run: Run }) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState<TeamSeed>('copy');
  const [confirmMove, setConfirmMove] = useState(false);
  const create = () => {
    setConfirmMove(false);
    const done = seed === 'move'
      ? 'Team created and your Personal workspace moved into it. Invite people below.'
      : 'Team created — you are now working in it. Invite people below.';
    void run({ type: 'TEAM_CREATE', payload: { name: name.trim(), seed } }, done, 120_000);
  };
  return (
    <Stack gap="sm">
      <Input placeholder="Team name, e.g. Acme Sales" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <div role="radiogroup" aria-label="What the team starts with" style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
        {SEED_CHOICES.map((c) => (
          <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, cursor: 'pointer' }}>
            <input type="radio" name="team-seed" checked={seed === c.id} onChange={() => { setSeed(c.id); setConfirmMove(false); }} style={{ marginTop: 2 }} />
            <span>
              <strong>{c.label}</strong>
              <Text as="span" size="micro" tone="muted" style={{ display: 'block' }}>{c.hint}</Text>
            </span>
          </label>
        ))}
      </div>
      {confirmMove ? (
        <Stack direction="row" gap="sm" align="center" wrap>
          <Text size="micro" tone="warning">
            Everything in Personal moves to the team, and your teammates will see and edit it. Continue?
          </Text>
          <Button variant="primary" size="sm" disabled={busy} onClick={create}>Move and create</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmMove(false)}>Cancel</Button>
        </Stack>
      ) : (
        <div>
          <Button variant="primary" disabled={busy || !name.trim()}
            onClick={() => (seed === 'move' ? setConfirmMove(true) : create())}>
            Create team workspace
          </Button>
        </div>
      )}
    </Stack>
  );
}

function MemberOfRow({ w, busy, active, onLeave }: { w: WorkspaceInfo; busy: boolean; active: boolean; onLeave: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div style={{ padding: space.md, border: `1px solid ${color.border.subtle}`, borderRadius: 8, marginBottom: space.sm }}>
      <Text as="div" size="small">
        Member of <strong>{w.name}</strong> (owner {w.ownerEmail || 'unknown'}){active && ' · current workspace'}
      </Text>
      {!w.active && (
        <Text as="div" size="micro" tone="warning">Read-only: the owner's Pro plan isn't active.</Text>
      )}
      <div style={{ marginTop: space.sm }}>
        {confirm ? (
          <Stack direction="row" gap="sm" align="center">
            <Text size="micro" tone="danger">Leave? Your copy on this machine is removed.</Text>
            <Button variant="danger-solid" size="sm" disabled={busy} onClick={onLeave}>Leave team</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
          </Stack>
        ) : (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm(true)}>Leave…</Button>
        )}
      </div>
    </div>
  );
}

function OwnerTeam({ team, view, busy, run }: { team: WorkspaceInfo; view: WorkspacesView; busy: boolean; run: Run }) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Where the team's data goes before it's deleted ('' = nowhere).
  const [mergeInto, setMergeInto] = useState<string>(PERSONAL_WORKSPACE);
  const mergeTargets = joined(view.list).filter((w) => w.id !== team.id && w.active);

  const loadMembers = useCallback(async () => {
    const r = await sendBg<{ ok: boolean; members?: TeamMember[] }>({ type: 'TEAM_MEMBERS', payload: { teamId: team.id } });
    if (r?.ok) setMembers(r.members || []);
  }, [team.id]);
  useEffect(() => { void loadMembers(); }, [loadMembers, team.memberCount]);

  const act: Run = async (message, success, timeout) => {
    const ok = await run(message, success, timeout);
    await loadMembers();
    return ok;
  };

  const inThisTeam = view.active === team.id;
  const sync = inThisTeam ? view.sync : undefined;

  return (
    <Stack gap="sm">
      <Text as="div" size="small">
        You own <strong>{team.name}</strong> · {team.memberCount} of {team.seatLimit} seats used
        {!team.active && <Text size="small" tone="warning"> · read-only until your Pro plan is active again</Text>}
      </Text>
      {sync && (
        <Text as="div" size="micro" tone={sync.lastError ? 'warning' : 'muted'}>
          {sync.lastError
            ? `Last sync problem: ${sync.lastError}`
            : `Synced ${sync.lastSyncAt ? formatRelativeTime(sync.lastSyncAt) : 'not yet'}${sync.dirty ? ' · changes waiting to upload' : ''}`}
        </Text>
      )}

      <div style={{ border: `1px solid ${color.border.subtle}`, borderRadius: 8, overflow: 'hidden' }}>
        {(members || []).map((m) => (
          <div key={m.email} style={{ display: 'flex', alignItems: 'center', gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderTop: `1px solid ${color.border.subtle}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="small" weight="semibold">{m.email}</Text>
              <Text size="micro" tone="muted">
                {' '}{m.role === 'owner' ? 'owner' : m.status === 'invited' ? 'invited — not joined yet' : 'member'}
              </Text>
            </div>
            {m.role !== 'owner' && (
              <Button variant="ghost" size="sm" disabled={busy}
                onClick={() => void act({ type: 'TEAM_REMOVE_MEMBER', payload: { teamId: team.id, email: m.email } }, `${m.email} removed.`)}>
                {m.status === 'invited' ? 'Cancel invite' : 'Remove'}
              </Button>
            )}
          </div>
        ))}
        {members === null && <div style={{ padding: space.md }}><Text size="small" tone="muted">Loading members…</Text></div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const to = email.trim();
          if (!to) return;
          void act({ type: 'TEAM_INVITE', payload: { teamId: team.id, email: to } },
            `Invited ${to}. They'll see the invite under Settings → Account & plan after signing in to the extension with that email.`)
            .then((ok) => { if (ok) setEmail(''); });
        }}
        style={{ display: 'flex', gap: space.sm }}
      >
        <Input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
        <Button type="submit" variant="primary" disabled={busy || !email.trim() || !team.active}>Invite</Button>
      </form>

      <Stack direction="row" gap="sm" align="center">
        {!inThisTeam && (
          <Button variant="secondary" size="sm" disabled={busy}
            onClick={() => void run({ type: 'TEAM_SWITCH', payload: { id: team.id } }, `Now working in ${team.name}.`, 60_000)}>
            Open {team.name}
          </Button>
        )}
        {inThisTeam && (
          <Button variant="secondary" size="sm" disabled={busy}
            onClick={() => void run({ type: 'TEAM_SYNC_NOW' }, 'Synced.', 60_000)}>
            Sync now
          </Button>
        )}
        {confirmDelete ? null : (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete team…</Button>
        )}
      </Stack>
      {confirmDelete && (
        <div style={{ padding: space.md, border: `1px solid ${color.danger.base}`, borderRadius: 8 }}>
          <Stack gap="sm">
            <Text as="div" size="small">
              Delete <strong>{team.name}</strong> for everyone in it? Before it goes, its contacts, tags, fields,
              saved searches, automations and webhooks can be merged into another workspace.
            </Text>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              Keep its data by merging into
              <Select aria-label="Merge the team into" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} style={{ maxWidth: 220 }}>
                <option value={PERSONAL_WORKSPACE}>Personal</option>
                {mergeTargets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                <option value="">Nowhere — discard it</option>
              </Select>
            </label>
            <Stack direction="row" gap="sm" align="center">
              <Button variant="danger-solid" size="sm" disabled={busy}
                onClick={() => {
                  const target = mergeInto ? (mergeInto === PERSONAL_WORKSPACE ? 'Personal' : mergeTargets.find((w) => w.id === mergeInto)?.name || 'the other workspace') : '';
                  void run(
                    { type: 'TEAM_DELETE', payload: { teamId: team.id, mergeInto: mergeInto || undefined } },
                    target ? `Team deleted. Its data was merged into ${target}, which is open now.` : 'Team deleted. Your personal workspace is untouched.',
                    120_000,
                  ).then((ok) => { if (ok) setConfirmDelete(false); });
                }}>
                {mergeInto ? 'Merge and delete team' : 'Delete team'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </Stack>
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/** Shown in Sync & devices while a team workspace is open. */
export function TeamSyncNotice() {
  const { view } = useWorkspaces();
  if (!view || !isTeamWorkspace(view.active)) return null;
  const team = view.list.find((w) => w.id === view.active);
  return (
    <div style={{ marginBottom: space.md }}>
      <Banner tone="info">
        You're in the <strong>{team?.name || 'team'}</strong> workspace, which syncs through your team, not Google Drive.
        Drive sync and Chrome Sync below apply to your <strong>Personal</strong> workspace — switch to it to manage them.
      </Banner>
    </div>
  );
}

/** True while a team workspace is open (for hiding personal-only controls). */
export function useTeamWorkspaceActive(): boolean {
  const { view } = useWorkspaces();
  return !!view && isTeamWorkspace(view.active);
}
