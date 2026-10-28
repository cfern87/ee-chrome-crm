// "Send as": the personal profile or a Page, chosen per campaign (and per
// automation / quick-action step that queues one). Exactly one is always
// selected. The send path checks it before typing anything — see
// senderIdentity.ts and Campaign.sendAs.

import React, { useState } from 'react';
import type { SendAsMode } from '../campaigns';
import type { SenderIdentity } from '../senderIdentity';
import { Banner, Button, Input, Stack, Text, color, fontSize, radius, space } from '../ui/primitives';

export interface SendAsValue { sendAs: SendAsMode; sendAsPageId?: string }

// Ask an open Facebook tab who it is acting as. Read-only; opens nothing.
async function readOpenTabIdentity(): Promise<SenderIdentity | string> {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.facebook.com/*'] });
    for (const t of tabs) {
      if (t.id == null) continue;
      try {
        const res = await chrome.tabs.sendMessage(t.id, { type: 'CRM_GET_SENDER_IDENTITY' });
        if (res && typeof res === 'object' && 'kind' in res) return res as SenderIdentity;
      } catch { /* no content script in that tab; try the next */ }
    }
    return 'Open facebook.com in a tab first (reload it if it was open before the extension updated).';
  } catch (e) {
    return String((e as Error)?.message || e);
  }
}

let radioGroupSeq = 0;

export function SendAsPicker({ value, onChange, disabled }: {
  value: SendAsValue;
  onChange: (v: SendAsValue) => void;
  disabled?: boolean;
}) {
  const [name] = useState(() => `crm-send-as-${++radioGroupSeq}`);
  const [seen, setSeen] = useState<SenderIdentity | string | null>(null);
  const pageId = value.sendAsPageId || '';
  const badPageId = pageId.trim() !== '' && !/^\d+$/.test(pageId.trim());

  const check = async () => { setSeen('Checking…'); setSeen(await readOpenTabIdentity()); };

  return (
    <div style={{ padding: `${space.sm}px ${space.md}px`, background: color.surface.sunken, borderRadius: radius.sm }}>
      <Stack gap="xs">
        <Text size="small" weight="semibold">Send as</Text>
        <div role="radiogroup" aria-label="Send as" style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          {([
            ['profile', 'Personal profile'],
            ['page', 'A Page'],
          ] as const).map(([mode, label]) => (
            <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: space.xs, cursor: disabled ? 'default' : 'pointer', fontSize: fontSize.small }}>
              <input
                type="radio"
                name={name}
                disabled={disabled}
                checked={value.sendAs === mode}
                onChange={() => onChange(mode === 'page' ? { sendAs: 'page', sendAsPageId: value.sendAsPageId } : { sendAs: 'profile' })}
              />
              {label}
            </label>
          ))}
        </div>
        {value.sendAs === 'page' && (
          <Stack direction="row" gap="sm" align="center" wrap>
            <Input
              aria-label="Only this Page id (optional)"
              value={pageId}
              disabled={disabled}
              placeholder="Page id (optional — any Page)"
              onChange={(e) => onChange({ sendAs: 'page', sendAsPageId: e.target.value })}
              style={{ width: 230 }}
            />
          </Stack>
        )}
        <Text size="micro" tone="muted" leading="relaxed">
          Every message is checked before it’s typed. If Facebook is acting as the other identity, nothing is sent and
          all running campaigns pause. {value.sendAs === 'page' ? 'A Page can only message people who messaged it in the last 24 hours.' : ''}
        </Text>
        <div><Button variant="ghost" size="sm" onClick={check}>Check who Facebook is acting as</Button></div>
        {badPageId && <Banner tone="danger" live>A Page id is digits only. Use “Check who Facebook is acting as” while switched into the Page to see it.</Banner>}
        {typeof seen === 'string' && <Text size="small" tone="muted">{seen}</Text>}
        {seen && typeof seen === 'object' && (
          <Banner tone={seen.kind === 'page' ? 'success' : seen.kind === 'personal' ? 'info' : 'warning'} live>
            {seen.kind === 'page' ? 'Acting as a Page' : seen.kind === 'personal' ? 'Acting as your personal profile' : 'Could not tell'}
            {seen.name ? `: ${seen.name}` : ''}{seen.actorId ? ` (id ${seen.actorId})` : ''}. {seen.reason}
          </Banner>
        )}
      </Stack>
    </div>
  );
}

/** A Page id that is set but not digits — the caller should block saving. */
export function sendAsInvalid(v: SendAsValue): boolean {
  const id = (v.sendAsPageId || '').trim();
  return v.sendAs === 'page' && id !== '' && !/^\d+$/.test(id);
}
