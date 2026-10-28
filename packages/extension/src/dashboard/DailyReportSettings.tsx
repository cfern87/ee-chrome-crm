// Settings → Data → Daily report.
//
// The Dashboard's numbers, sent once a day by webhook. See
// ../dailyReport.ts for scheduling and what is sent. Sits right after Webhooks:
// it is another outbound delivery, and the URL/token fields work the same way.

import React, { useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  readReportConfig, writeReportConfig, readReportLog, reportChannels,
  REPORT_LOG_LIMIT, type DailyReportConfig, type ReportDelivery,
} from '../dailyReport';
import { isValidWebhookUrl } from '../webhooks';
import { Banner, Button, Card, Input, Stack, Text, Toggle, Field as FormField, color, radius, space } from '../ui/primitives';
import { sendBg, formatRelativeTime, DraftInput } from './shared';
import { ensureHostPermission, TEST_PERMISSION_NOTE } from './WebhookSettings';
import { WORKER_NOT_LOADED } from '../product';

/** The card's element id — what the Dashboard's "Set up a daily report" link scrolls to. */
export const DAILY_REPORT_SECTION_ID = 'daily-report';

function describeDelivery(d: ReportDelivery): string {
  const what = 'Webhook';
  const outcome = d.ok
    ? d.status ? `HTTP ${d.status}` : 'sent'
    : d.error || (d.status ? `HTTP ${d.status}` : 'failed');
  return `${what}${d.trigger === 'test' ? ' (test)' : ''} · ${outcome}`;
}

function DeliveryLog({ entries }: { entries: ReportDelivery[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div style={{ marginTop: space.md }}>
      <Text as="div" size="small" weight="semibold">Last {REPORT_LOG_LIMIT} deliveries</Text>
      {entries.length === 0 && <Text as="div" size="micro" tone="muted">Nothing sent yet.</Text>}
      {entries.map((d, i) => (
        <div key={`${d.at}-${d.channel}-${i}`} style={{ marginTop: 4 }}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
            style={{ all: 'unset', cursor: 'pointer', display: 'block', fontSize: 12, color: d.ok ? color.text.secondary : color.danger.base }}
          >
            {open === i ? '▾' : '▸'} {formatRelativeTime(d.at)} · {describeDelivery(d)}
          </button>
          {open === i && (
            <div style={{ margin: '4px 0 6px 14px' }}>
              <Text as="div" size="micro" tone="muted">
                {new Date(d.at).toLocaleString()} · to {d.target}
              </Text>
              {d.error && <Text as="div" size="micro" tone="danger" style={{ marginTop: 2 }}>{d.error}</Text>}
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0', padding: 6, borderRadius: radius.sm, background: color.surface.sunken, maxHeight: 260, overflow: 'auto' }}>
                {JSON.stringify(d.payload ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function DailyReportSettings({ store, updateStore }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
}) {
  const cfg = readReportConfig(store.settings);
  const log = readReportLog(store.settings);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger' | 'info'; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const persist = (patch: Partial<DailyReportConfig>) => {
    const { at: _at, ...rest } = { ...cfg, ...patch };
    return updateStore({ ...store, settings: writeReportConfig(store.settings, rest) });
  };

  const commitUrl = async (raw: string) => {
    const url = raw.trim();
    if (url) {
      const invalid = isValidWebhookUrl(url);
      if (invalid) { setUrlError(invalid); return; }
      // Saving the URL is a click-free blur, which Chrome won't accept as the
      // gesture for a permission prompt — "Send test now" asks instead.
    }
    setUrlError(null);
    await persist({ webhookUrl: url });
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    if (cfg.webhookUrl) await ensureHostPermission(cfg.webhookUrl);
    const res = await sendBg<{ ok: boolean; error?: string; deliveries: ReportDelivery[] }>({ type: 'TEST_DAILY_REPORT' }, 40000);
    setTesting(false);
    if (!res) { setStatus({ tone: 'danger', msg: `${WORKER_NOT_LOADED} Refresh this page and try again.` }); return; }
    if (res.error) { setStatus({ tone: 'danger', msg: res.error }); return; }
    setStatus(res.ok
      ? { tone: 'success', msg: `Test sent: ${res.deliveries.map(describeDelivery).join('; ')}.` }
      : { tone: 'danger', msg: `Test failed: ${res.deliveries.filter((d) => !d.ok).map(describeDelivery).join('; ')}.` });
  };

  const channels = reportChannels(cfg);

  return (
    <Card id={DAILY_REPORT_SECTION_ID} style={{ marginBottom: space.md, scrollMarginTop: 16 }}>
      <Stack direction="row" gap="sm" align="center" wrap>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: 0, flex: 1 }} tabIndex={-1} data-section-heading>
          Daily report
        </Text>
        <Toggle label="On" labelFirst={false} checked={cfg.enabled} onChange={(e) => void persist({ enabled: e.target.checked })} />
      </Stack>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.md}px` }}>
        Once a day, POST the numbers on your Dashboard (every tile, as they stand at send time) to a
        webhook: your own endpoint, or Zapier/Make to forward them on.
      </Text>

      <Stack gap="md">
        <FormField
          label="Send at"
          hint="Your local time. It only goes out while Chrome is open on your sending machine. If Chrome is closed then, it goes out when Chrome next starts that day."
        >
          {(p) => (
            <Input
              {...p}
              type="time"
              value={cfg.time}
              onChange={(e) => { if (e.target.value) void persist({ time: e.target.value }); }}
              style={{ width: 130 }}
            />
          )}
        </FormField>

        <Stack direction="row" gap="sm" wrap align="flex-start">
          <FormField label="Webhook URL" hint="POSTs a report.daily event. https only (http is allowed for localhost)." error={urlError || undefined}>
            {(p) => (
              <DraftInput {...p} value={cfg.webhookUrl} onCommit={(v) => void commitUrl(v)} placeholder="https://example.com/hooks/daily" style={{ width: 300 }} />
            )}
          </FormField>
          <FormField label="Token (optional)" hint="Sent as X-CRM-Token. Identification, not authentication.">
            {(p) => (
              <DraftInput {...p} value={cfg.webhookSecret} onCommit={(v) => void persist({ webhookSecret: v })} placeholder="shared token" style={{ width: 160 }} />
            )}
          </FormField>
        </Stack>

        <Stack direction="row" gap="sm" align="center" wrap>
          <Button variant="secondary" onClick={() => void test()} disabled={testing || channels.length === 0}>
            {testing ? 'Sending…' : 'Send test now'}
          </Button>
          <Text size="micro" tone="muted" style={{ flex: 1 }}>
            {channels.length === 0
              ? 'Add a webhook URL to send to.'
              : !cfg.enabled
                ? 'Off. Turn it on to send every day; you can still send a test.'
                : log.lastSentDay
                  ? `Last daily send: ${log.lastSentDay}.`
                  : 'Not sent yet.'}
          </Text>
        </Stack>
        {status && <Banner tone={status.tone} live>{status.msg}</Banner>}
        {cfg.webhookUrl && <Text size="micro" tone="muted" leading="relaxed">{TEST_PERMISSION_NOTE}</Text>}
      </Stack>

      <DeliveryLog entries={log.entries} />
    </Card>
  );
}
