// Settings → Data → Incoming webhooks (EXPERIMENTAL).
//
// The switch, the tokens outside systems use, which automations they may run,
// and enough live status to test the whole loop from here. See ../inbound.ts.
// Everything that talks to the server goes through the background worker, so
// only one place ever refreshes the sign-in token.

import React, { useCallback, useEffect, useState } from 'react';
import type { Store, SaveResult } from '../storage';
import { readAutomations } from '../automations';
import { readInboundSettings, writeInboundSettings, type InboundSettings, type InboundStatus } from '../inbound';
import type { InboundCommandSummary, InboundToken } from '../inboundClient';
import { Banner, Button, Card, Input, Stack, Text, Toggle, Field as FormField, color, radius, space } from '../ui/primitives';
import { sendBg, formatRelativeTime } from './shared';

type Fail = { ok: false; error: string };

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
    if (!res) { setError("The extension's background service didn't respond."); return; }
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
  const example = `curl -X POST '${endpoint || '<endpoint>'}' \\
  -H 'Authorization: Bearer <your token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"command":"automation.run","payload":{"automation":"${allowed[0]?.name || 'My automation'}","dryRun":true}}'`;

  return (
    <Card style={{ marginBottom: space.md }}>
      <Stack direction="row" gap="sm" align="center" wrap>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: 0, flex: 1 }}>Incoming webhooks (experimental)</Text>
        <Toggle label="On" labelFirst={false} checked={settings.enabled} onChange={(e) => persist({ ...settings, enabled: e.target.checked })} />
      </Stack>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.md}px` }}>
        Let another system (Zapier, your website, a script) run automations by POSTing to a URL. Requests wait
        on the server until the browser running your sending machine picks them up — checked about once a minute.
        Only automations you tick below can be run. See <code>docs/INBOUND_WEBHOOKS.md</code>.
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
              <Stack key={t.id} direction="row" gap="sm" align="center" style={{ opacity: t.revoked_at ? 0.5 : 1 }}>
                <code style={{ fontSize: 12 }}>{t.token_prefix}…</code>
                <Text size="small" style={{ flex: 1 }}>{t.label || ''}</Text>
                <Text size="micro" tone="muted">
                  {t.revoked_at ? 'revoked' : t.last_used_at ? `used ${formatRelativeTime(Date.parse(t.last_used_at))}` : 'never used'}
                </Text>
                {!t.revoked_at && <Button size="sm" variant="danger" onClick={() => revoke(t.id)}>Revoke</Button>}
              </Stack>
            ))}
            {newToken && (
              <Banner tone="success" live>
                New token — copy it now, it won’t be shown again: <code style={{ wordBreak: 'break-all' }}>{newToken}</code>
              </Banner>
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
