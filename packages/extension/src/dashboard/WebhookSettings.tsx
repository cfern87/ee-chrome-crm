// Settings → Data → Webhooks.
//
// The editor for the outbound POSTs described in ../webhooks.ts. Two things
// here are worth knowing before reading the code:
//
//  1. HOST PERMISSION IS REQUESTED, NOT DECLARED. The manifest cannot list
//     "wherever the user later decides to point a webhook", so `https://*/*`
//     is an OPTIONAL permission requested at the moment a URL is saved.
//     chrome.permissions.request must be called from a user gesture on an
//     extension page, which is exactly what a click on Save is — so it lives
//     here and not in the background worker.
//  2. NOTHING IS SUBSCRIBED BY DEFAULT. A new webhook fires nothing until
//     events are ticked. See newWebhook for why.

import React, { useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  WebhookConfig, WEBHOOK_EVENTS, WEBHOOKS_KEY, MAX_WEBHOOKS,
  readWebhooks, newWebhook, isValidWebhookUrl, type WebhookEvent,
} from '../webhooks';
import {
  Banner, Button, Card, Input, Select, Stack, Text, Toggle,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { sendBg, formatRelativeTime, DraftInput } from './shared';

/**
 * Ask for permission to reach `url`'s origin.
 *
 * Returns true when the extension may now POST there. A refusal is not an
 * error to shout about — the user was asked and said no — so the caller
 * reports it as a plain explanation of what will happen (nothing).
 */
async function ensureHostPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin + '/*';
    if (typeof chrome === 'undefined' || !chrome.permissions?.request) return true;
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    // No permissions API (or an origin Chrome won't accept). Let the save go
    // ahead — the delivery itself will report the real failure.
    return true;
  }
}

export function WebhookSettings({ store, updateStore }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
}) {
  const hooks = readWebhooks(store);
  const [draftUrl, setDraftUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const persist = async (next: WebhookConfig[]) => {
    await updateStore({
      ...store,
      settings: { ...(store.settings as Record<string, unknown>), [WEBHOOKS_KEY]: next },
    });
  };

  const update = (id: string, patch: Partial<WebhookConfig>) =>
    persist(hooks.map((h) => (h.id === id ? { ...h, ...patch, updatedAt: Date.now() } : h)));

  const add = async () => {
    setStatus(null);
    const url = draftUrl.trim();
    const invalid = isValidWebhookUrl(url);
    if (invalid) { setError(invalid); return; }
    if (hooks.length >= MAX_WEBHOOKS) { setError(`That's the maximum (${MAX_WEBHOOKS}).`); return; }
    setError(null);

    const granted = await ensureHostPermission(url);
    await persist([...hooks, newWebhook(url)]);
    setDraftUrl('');
    setStatus(granted
      ? 'Added. Tick the events you want it to receive — it sends nothing until you do.'
      : "Added, but Chrome wasn't given permission to reach that host, so deliveries will fail. Remove and re-add it to be asked again.");
  };

  const toggleEvent = (h: WebhookConfig, event: WebhookEvent) => {
    const events = h.events.includes(event)
      ? h.events.filter((e) => e !== event)
      : [...h.events, event];
    return update(h.id, { events });
  };

  const test = async (h: WebhookConfig) => {
    setTesting(h.id);
    setStatus(null);
    // Re-check permission here too: a webhook added on another machine arrived
    // through Drive sync, and this machine has never been asked about it.
    await ensureHostPermission(h.url);
    const res = await sendBg<{ ok: boolean; status?: number; error?: string }>({
      type: 'TEST_WEBHOOK',
      payload: { id: h.id },
    }, 20000);
    setTesting(null);
    if (!res) { setStatus("The extension's background service didn't respond. Refresh this page and try again."); return; }
    setStatus(res.ok
      ? `Test delivered${res.status ? ` (HTTP ${res.status})` : ''}.`
      : `Test failed: ${res.error || 'no response from the endpoint'}.`);
  };

  return (
    <Card style={{ marginBottom: space.md }}>
      <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Webhooks</Text>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.lg}px` }}>
        POST a small JSON payload to a URL of yours whenever something happens in the CRM — a contact
        gets tagged, a campaign finishes, a message fails. Delivery is best-effort: one attempt per
        event, no retries, so treat it as a notification rather than a ledger. The payload format is
        documented in <code>docs/WEBHOOKS.md</code>.
      </Text>

      <Stack gap="sm">
        {hooks.length === 0 && (
          <Text size="small" tone="muted">No webhooks yet.</Text>
        )}

        {hooks.map((h) => (
          <div
            key={h.id}
            style={{
              border: `1px solid ${color.border.subtle}`,
              borderRadius: radius.sm,
              background: color.surface.sunken,
              padding: space.md,
              opacity: h.enabled ? 1 : 0.65,
            }}
          >
            <Stack direction="row" gap="sm" align="center" wrap>
              <Text
                size="small"
                weight="semibold"
                style={{ flex: 1, minWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={h.url}
              >
                {h.name || h.url}
              </Text>
              <Toggle
                label="Enabled"
                labelFirst={false}
                checked={h.enabled}
                onChange={(e) => update(h.id, { enabled: e.target.checked })}
              />
              <Button size="sm" variant="secondary" onClick={() => test(h)} disabled={testing === h.id}>
                {testing === h.id ? 'Sending…' : 'Send test'}
              </Button>
              {confirmDelete === h.id ? (
                <>
                  <Button
                    size="sm"
                    variant="danger-solid"
                    onClick={() => { setConfirmDelete(null); persist(hooks.filter((x) => x.id !== h.id)); }}
                  >
                    Remove?
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>No</Button>
                </>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(h.id)}>Remove</Button>
              )}
            </Stack>

            <Stack direction="row" gap="sm" align="flex-end" wrap style={{ marginTop: space.sm }}>
              <FormField label="Name (optional)" hint="Echoed in the payload, so one endpoint can tell several apart.">
                {(p) => (
                  <DraftInput
                    {...p}
                    value={h.name || ''}
                    onCommit={(name) => update(h.id, { name })}
                    placeholder="e.g. Lovable site"
                    style={{ width: 180 }}
                  />
                )}
              </FormField>
              <FormField label="Token (optional)" hint="Sent as X-CRM-Token. Identification, not authentication.">
                {(p) => (
                  <DraftInput
                    {...p}
                    value={h.secret || ''}
                    onCommit={(secret) => update(h.id, { secret })}
                    placeholder="shared token"
                    style={{ width: 180 }}
                  />
                )}
              </FormField>
            </Stack>

            <div style={{ marginTop: space.sm }}>
              <Text as="div" size="small" weight="medium" tone="secondary" style={{ marginBottom: space.xs }}>
                Events {h.events.length === 0 && <Text as="span" size="micro" tone="warning">— none ticked, so this sends nothing</Text>}
              </Text>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: space.xxs }}>
                {WEBHOOK_EVENTS.map((def) => (
                  <label
                    key={def.event}
                    title={def.hint}
                    style={{ display: 'flex', alignItems: 'center', gap: space.xs, cursor: 'pointer', fontSize: 12 }}
                  >
                    <input
                      type="checkbox"
                      checked={h.events.includes(def.event)}
                      onChange={() => toggleEvent(h, def.event)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ color: color.text.secondary }}>{def.label}</span>
                    <code style={{ fontSize: 10, color: color.text.muted }}>{def.event}</code>
                  </label>
                ))}
              </div>
            </div>

            {h.lastDelivery && (
              <Text as="div" size="micro" tone={h.lastDelivery.ok ? 'muted' : 'danger'} style={{ marginTop: space.sm }}>
                Last delivery {formatRelativeTime(h.lastDelivery.at)}:{' '}
                {h.lastDelivery.ok
                  ? `accepted${h.lastDelivery.status ? ` (HTTP ${h.lastDelivery.status})` : ''}`
                  : h.lastDelivery.error || 'failed'}
              </Text>
            )}
          </div>
        ))}
      </Stack>

      <Stack gap="sm" style={{ marginTop: space.md }}>
        <Stack direction="row" gap="sm" align="flex-end" wrap>
          <FormField label="Add a webhook URL" hint="https only (http is allowed for localhost while you test).">
            {(p) => (
              <Input
                {...p}
                value={draftUrl}
                onChange={(e) => { setDraftUrl(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                placeholder="https://example.com/hooks/crm"
                style={{ width: 320 }}
              />
            )}
          </FormField>
          <Button variant="secondary" onClick={add} disabled={!draftUrl.trim() || hooks.length >= MAX_WEBHOOKS}>
            Add
          </Button>
        </Stack>

        {error && <Banner tone="danger" live>{error}</Banner>}
        {status && <Banner tone="info" live>{status}</Banner>}

        <Text size="micro" tone="muted" leading="relaxed">
          Chrome will ask for permission to reach the host the first time you add a webhook for it.
          Without that permission the extension cannot POST there and every delivery fails.
        </Text>
      </Stack>
    </Card>
  );
}
