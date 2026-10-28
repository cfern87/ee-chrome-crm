// Settings → Data → Incoming webhooks (EXPERIMENTAL).
//
// The switch, the tokens outside systems use, which automations they may run,
// and enough live status to test the whole loop from here. See ../inbound.ts.
// Everything that talks to the server goes through the background worker, so
// only one place ever refreshes the sign-in token.

import React, { useCallback, useEffect, useState } from 'react';
import type { Store, SaveResult } from '../storage';
import { readAutomations, describeRun, type AutomationRun } from '../automations';
import { readInboundSettings, writeInboundSettings, type InboundSettings, type InboundStatus } from '../inbound';
import { TOKEN_HISTORY_LIMIT, type InboundCommandDetail, type InboundCommandSummary, type InboundToken } from '../inboundClient';
import { Banner, Button, Card, Input, Stack, Text, Toggle, Field as FormField, color, radius, space } from '../ui/primitives';
import { sendBg, formatRelativeTime, CopyButton } from './shared';
import { helpUrl } from '../helpLinks';
import { WORKER_NOT_LOADED } from '../product';

type Fail = { ok: false; error: string };

/**
 * Everything a caller needs to paste into Zapier / a script. With no ticked
 * automation the example is a ping, so it works the moment it's pasted.
 */
export function inboundSetup(endpoint: string, token: string, automationName?: string) {
  const body = automationName
    ? { command: 'automation.run', payload: { automation: automationName, dryRun: true } }
    : { command: 'ping' };
  const bodyJson = JSON.stringify(body);
  const header = `Bearer ${token}`;
  const curl = `curl -X POST '${endpoint}' \\
  -H 'Authorization: ${header}' \\
  -H 'Content-Type: application/json' \\
  -d '${bodyJson.replace(/'/g, "'\\''")}'`;
  return { url: endpoint, header, body: bodyJson, curl };
}

function SetupRow({ label, value, copyTitle }: { label: string; value: string; copyTitle: string }) {
  return (
    <Stack direction="row" gap="sm" align="center" style={{ marginTop: space.xs }}>
      <Text size="micro" tone="muted" style={{ width: 120, flexShrink: 0 }}>{label}</Text>
      <code style={{ fontSize: 12, flex: 1, wordBreak: 'break-all' }}>{value}</code>
      <CopyButton text={value} title={copyTitle} />
    </Stack>
  );
}

function describeStatus(s: InboundStatus | null): string {
  if (!s) return 'Not checked yet on this machine.';
  const when = formatRelativeTime(s.at);
  if (s.skipped === 'disabled') return `Off (checked ${when}).`;
  if (s.skipped === 'signed-out') return `Signed out — not checking (${when}).`;
  if (s.skipped === 'not-sender') return `Another machine is the sending machine, so it runs incoming webhooks (${when}).`;
  if (!s.ok) return `Last check failed ${when}: ${s.error}`;
  const last = s.last ? ` Last command: ${s.last.command} → ${s.last.status}${s.last.error ? ` (${s.last.error})` : ''}.` : '';
  return `Checked ${when}: ${s.claimed} new.${last}`;
}

/** One line for what a request asked: the command, and the automation it named. */
function describeRequest(c: InboundCommandDetail): string {
  const p = c.payload && typeof c.payload === 'object' ? (c.payload as Record<string, unknown>) : {};
  const name = typeof c.result?.automationName === 'string' ? c.result.automationName
    : typeof p.automation === 'string' ? p.automation
    : typeof p.automationId === 'string' ? p.automationId : '';
  const contacts = Array.isArray(p.contacts) ? ` · ${p.contacts.length} contact${p.contacts.length === 1 ? '' : 's'} named` : '';
  const dry = p.dryRun === true ? ' · dry run' : '';
  return c.command === 'automation.run' ? `Run “${name}”${contacts}${dry}` : c.command;
}

/** What came of it, in the same words as the Automations section. */
function describeOutcome(c: InboundCommandDetail): string {
  if (c.status === 'pending') return 'Waiting for the sending machine to pick it up';
  if (c.status === 'claimed') return 'Running…';
  if (c.status === 'expired') return 'Expired — no sending machine picked it up in time';
  const r = c.result;
  if (r && typeof r.automationId === 'string') {
    const text = describeRun({ ...(r as unknown as AutomationRun), running: false, error: undefined });
    const missing = Array.isArray(r.notFound) && r.notFound.length ? ` · ${r.notFound.length} not in CRM` : '';
    return `${c.status === 'failed' ? `Failed: ${c.error || 'unknown error'} — ` : ''}${text}${missing}`;
  }
  if (r && r.pong) return 'Pong';
  return c.status === 'failed' ? `Failed: ${c.error || 'unknown error'}` : 'Done';
}

/** The last TOKEN_HISTORY_LIMIT requests that came in with one token. Loaded when opened. */
function TokenHistory({ tokenId }: { tokenId: string }) {
  const [items, setItems] = useState<InboundCommandDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await sendBg<{ ok: true; commands: InboundCommandDetail[] } | Fail>({ type: 'INBOUND_TOKEN_HISTORY', payload: { id: tokenId } });
    if (!r) { setError(WORKER_NOT_LOADED); return; }
    if ('error' in r) { setError(r.error); return; }
    setError(null);
    setItems(r.commands);
  }, [tokenId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div data-testid={`token-history-${tokenId}`} style={{ margin: `${space.xs}px 0 ${space.sm}px ${space.md}px`, paddingLeft: space.sm, borderLeft: `2px solid ${color.border.subtle}` }}>
      <Stack direction="row" gap="sm" align="center">
        <Text size="micro" weight="semibold" style={{ flex: 1 }}>Last {TOKEN_HISTORY_LIMIT} requests</Text>
        <Button size="sm" variant="ghost" onClick={() => void load()}>Refresh</Button>
      </Stack>
      {error && <Text as="div" size="micro" tone="danger">{error}</Text>}
      {!error && items === null && <Text as="div" size="micro" tone="muted">Loading…</Text>}
      {items?.length === 0 && <Text as="div" size="micro" tone="muted">No requests with this token yet.</Text>}
      {items?.map((c) => (
        <div key={c.id} style={{ marginTop: 4 }}>
          <button
            onClick={() => setOpen(open === c.id ? null : c.id)}
            aria-expanded={open === c.id}
            style={{ all: 'unset', cursor: 'pointer', display: 'block', fontSize: 12, color: c.status === 'failed' ? color.danger.base : color.text.secondary }}
          >
            {open === c.id ? '▾' : '▸'} {formatRelativeTime(Date.parse(c.created_at))} · {describeRequest(c)} · {c.status}
          </button>
          {open === c.id && (
            <div style={{ margin: '4px 0 6px 14px' }}>
              <Text as="div" size="micro" tone={c.status === 'failed' ? 'danger' : 'muted'}>{describeOutcome(c)}</Text>
              <Text as="div" size="micro" tone="muted" style={{ marginTop: 2 }}>
                Received {new Date(c.created_at).toLocaleString()}
                {c.finished_at ? ` · finished ${new Date(c.finished_at).toLocaleString()}` : ''}
              </Text>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0', padding: 6, borderRadius: radius.sm, background: color.surface.raised }}>
                {JSON.stringify(c.payload ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const box: React.CSSProperties = {
  border: `1px solid ${color.border.subtle}`, borderRadius: radius.sm, background: color.surface.sunken, padding: space.md,
};

export function InboundWebhookSettings({ store, updateStore }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
}) {
  const settings = readInboundSettings(store);
  const automations = readAutomations(store);
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState<InboundStatus | null>(null);
  const [tokens, setTokens] = useState<InboundToken[]>([]);
  const [recent, setRecent] = useState<InboundCommandSummary[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const persist = (next: InboundSettings) => updateStore({ ...store, settings: writeInboundSettings(store.settings, next) });

  const refresh = useCallback(async () => {
    const info = await sendBg<{ endpointUrl: string; status: InboundStatus | null }>({ type: 'INBOUND_INFO' });
    if (info) { setEndpoint(info.endpointUrl); setStatus(info.status); }
    if (!settings.enabled) return;
    const t = await sendBg<{ ok: true; tokens: InboundToken[] } | Fail>({ type: 'INBOUND_TOKENS' });
    const r = await sendBg<{ ok: true; commands: InboundCommandSummary[] } | Fail>({ type: 'INBOUND_RECENT' });
    if (t && 'error' in t) setError(t.error);
    else if (r && 'error' in r) setError(r.error);
    else setError(null);
    if (t && 'tokens' in t) setTokens(t.tokens);
    if (r && 'commands' in r) setRecent(r.commands);
  }, [settings.enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const checkNow = async () => {
    setBusy(true);
    const s = await sendBg<InboundStatus>({ type: 'INBOUND_POLL_NOW' }, 120_000);
    setBusy(false);
    if (s) setStatus(s);
    await refresh();
  };

  const createToken = async () => {
    setBusy(true);
    const res = await sendBg<{ ok: true; token: { token: string } } | Fail>({ type: 'INBOUND_TOKEN_CREATE', payload: { label: label.trim() || 'Untitled' } });
    setBusy(false);
    if (!res) { setError(WORKER_NOT_LOADED); return; }
    if ('error' in res) { setError(res.error); return; }
    setNewToken(res.token.token);
    setLabel('');
    await refresh();
  };

  const revoke = async (id: string) => {
    const res = await sendBg<{ ok: true } | Fail>({ type: 'INBOUND_TOKEN_REVOKE', payload: { id } });
    if (res && 'error' in res) setError(res.error);
    await refresh();
  };

  const toggleAutomation = (id: string) => persist({
    ...settings,
    automationIds: settings.automationIds.includes(id)
      ? settings.automationIds.filter((x) => x !== id)
      : [...settings.automationIds, id],
  });

  const allowed = automations.filter((a) => settings.automationIds.includes(a.id));
  const example = inboundSetup(endpoint || '<endpoint>', '<your token>', allowed[0]?.name).curl;
  const setup = newToken ? inboundSetup(endpoint, newToken, allowed[0]?.name) : null;

  return (
    <Card style={{ marginBottom: space.md }}>
      <Stack direction="row" gap="sm" align="center" wrap>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: 0, flex: 1 }}>Incoming webhooks (experimental)</Text>
        <Toggle label="On" labelFirst={false} checked={settings.enabled} onChange={(e) => persist({ ...settings, enabled: e.target.checked })} />
      </Stack>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.md}px` }}>
        Let another system (Zapier, your website, a script) run automations by POSTing to a URL. Requests wait
        on the server until the browser running your sending machine picks them up — checked about once a minute.
        Only automations you tick below can be run.{' '}
        <a href={helpUrl('incoming-webhooks')} target="_blank" rel="noreferrer">Open the incoming webhook guide</a>.
      </Text>

      {!settings.enabled ? (
        <Text size="small" tone="muted">Off. Nothing is checked and nothing can be triggered.</Text>
      ) : (
        <Stack gap="md">
          <div style={box}>
            <Text as="div" size="small" weight="semibold">Endpoint</Text>
            <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{endpoint}</code>
            <Stack direction="row" gap="sm" align="center" wrap style={{ marginTop: space.sm }}>
              <Text size="micro" tone="muted" style={{ flex: 1 }}>{describeStatus(status)}</Text>
              <Button size="sm" variant="secondary" onClick={checkNow} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</Button>
            </Stack>
          </div>

          <div style={box}>
            <Text as="div" size="small" weight="semibold" style={{ marginBottom: space.xs }}>Tokens</Text>
            {tokens.filter((t) => !t.revoked_at).length === 0 && <Text size="small" tone="muted">No active tokens.</Text>}
            {tokens.map((t) => (
              <React.Fragment key={t.id}>
                <Stack direction="row" gap="sm" align="center" style={{ opacity: t.revoked_at ? 0.5 : 1 }}>
                  <code style={{ fontSize: 12 }}>{t.token_prefix}…</code>
                  <Text size="small" style={{ flex: 1 }}>{t.label || ''}</Text>
                  <Text size="micro" tone="muted">
                    {t.revoked_at ? 'revoked' : t.last_used_at ? `used ${formatRelativeTime(Date.parse(t.last_used_at))}` : 'never used'}
                  </Text>
                  <Button
                    size="sm" variant="ghost" aria-expanded={historyFor === t.id}
                    onClick={() => setHistoryFor(historyFor === t.id ? null : t.id)}
                  >
                    {historyFor === t.id ? 'Hide history' : 'History'}
                  </Button>
                  {!t.revoked_at && <Button size="sm" variant="danger" onClick={() => revoke(t.id)}>Revoke</Button>}
                </Stack>
                {historyFor === t.id && <TokenHistory tokenId={t.id} />}
              </React.Fragment>
            ))}
            {newToken && setup && (
              <div
                data-testid="inbound-setup"
                style={{ marginTop: space.sm, padding: space.md, borderRadius: radius.sm, border: `1px solid ${color.success.base}`, background: color.success.subtle }}
              >
                <Text as="div" size="small" weight="semibold">Your new token — copy it now, it won’t be shown again</Text>
                <SetupRow label="Token" value={newToken} copyTitle="Copy token" />
                <Text as="div" size="micro" tone="muted" style={{ marginTop: space.sm }}>
                  To set up Zapier (“Webhooks by Zapier” → POST), Make, or your own code, paste these:
                </Text>
                <SetupRow label="URL" value={setup.url} copyTitle="Copy URL" />
                <SetupRow label="Header: Authorization" value={setup.header} copyTitle="Copy header value" />
                <SetupRow label="Body (JSON)" value={setup.body} copyTitle="Copy body" />
                <Stack direction="row" gap="sm" align="center" style={{ marginTop: space.sm }}>
                  <Text size="micro" tone="muted" style={{ flex: 1 }}>Or test it from a terminal right away.</Text>
                  <CopyButton text={setup.curl} label="Copy curl" title="Copy curl command" />
                  <Button size="sm" variant="secondary" onClick={() => setNewToken(null)}>Done, I’ve saved it</Button>
                </Stack>
              </div>
            )}
            <Stack direction="row" gap="sm" align="flex-end" wrap style={{ marginTop: space.sm }}>
              <FormField label="Label" hint="Which system uses it.">
                {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Zapier" style={{ width: 200 }} />}
              </FormField>
              <Button size="sm" variant="secondary" onClick={createToken} disabled={busy}>Create token</Button>
            </Stack>
          </div>

          <div style={box}>
            <Text as="div" size="small" weight="semibold" style={{ marginBottom: space.xs }}>Automations a webhook may run</Text>
            {automations.length === 0 && <Text size="small" tone="muted">No automations yet.</Text>}
            {automations.map((a) => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: space.xs, cursor: 'pointer', fontSize: 12 }}>
                <input type="checkbox" checked={settings.automationIds.includes(a.id)} onChange={() => toggleAutomation(a.id)} />
                <span style={{ color: color.text.secondary }}>{a.name}</span>
                <code style={{ fontSize: 10, color: color.text.muted }}>{a.id}</code>
              </label>
            ))}
          </div>

          <div style={box}>
            <Stack direction="row" gap="sm" align="center">
              <Text as="div" size="small" weight="semibold" style={{ flex: 1 }}>Recent requests</Text>
              <Button size="sm" variant="ghost" onClick={() => void refresh()}>Refresh</Button>
            </Stack>
            {recent.length === 0 && <Text size="small" tone="muted">None yet.</Text>}
            {recent.map((c) => (
              <Text key={c.id} as="div" size="micro" tone={c.status === 'failed' ? 'danger' : 'muted'}>
                {formatRelativeTime(Date.parse(c.created_at))} · {c.command} · {c.status}{c.error ? ` — ${c.error}` : ''}
              </Text>
            ))}
          </div>

          <div style={box}>
            <Text as="div" size="small" weight="semibold" style={{ marginBottom: space.xs }}>Example</Text>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{example}</pre>
          </div>

          {error && <Banner tone="danger" live>{error}</Banner>}
        </Stack>
      )}
    </Card>
  );
}
