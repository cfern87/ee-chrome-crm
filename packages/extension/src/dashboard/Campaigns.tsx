// Campaigns: composing a bulk message, the shared send queue, and what
// happened to everything already sent.
//
// These were two separate dashboard tabs — Messaging and History — that each
// linked to the other to get their work done. They are one job, so they are
// one module and one destination with three sub-views.
//
// The notification pieces live here too: a failed send and a held queue are
// both campaign state, and both surface in the shell's drawer.

import React, { useEffect, useMemo, useState } from 'react';
import type { Store, Tag, Conversation } from '../storage';
import {
  Campaign, CampaignRecipient, RecipientStatus, summarize, renderTemplate, DEFAULTS,
  FailedSend, failureKey,
  QueueState, QueueMode, activeCampaigns, queueDepth,
  pendingRecipientIndex, runnableCampaigns,
} from '../campaigns';
import { isOnline as isDeviceOnline, LEASE_TTL_MS, type DeviceInfo } from '../devices';
import { isDisconnected } from '../syncHealth';
import {
  Banner, Button, Card, EmptyState, Input, Stack, Text,
  color, fontSize, fontWeight, radius, space,
} from '../ui/primitives';
import {
  MachineView, describeHold, sendBg, previewTags, formatRelativeTime, formatDateTime,
  minutes, describePace, readPace, ProfileUrlEditor, CopyButton, type SendingPace,
} from './shared';

export function statusColor(s: RecipientStatus): string {
  switch (s) {
    case 'sent': return color.success.base;
    case 'error': return color.danger.base;
    case 'sending': return color.warning.base;
    default: return color.text.muted;
  }
}

export function statusLabel(s: RecipientStatus): string {
  switch (s) {
    case 'sent': return 'Sent';
    case 'error': return 'Error';
    case 'sending': return 'Sending…';
    default: return 'Pending';
  }
}

export function StatusBadge({ status }: { status: Campaign['status'] }) {
  const map: Record<Campaign['status'], { bg: string; fg: string; label: string }> = {
    running: { bg: '#e8f5ee', fg: color.success.base, label: '● Running' },
    paused: { bg: color.warning.subtle, fg: color.warning.base, label: '❚❚ Paused' },
    completed: { bg: '#eef2f7', fg: color.text.secondary, label: '✓ Completed' },
    cancelled: { bg: '#fdecec', fg: color.danger.base, label: '✕ Cancelled' },
  };
  const s = map[status];
  return (
    <span style={{ background: s.bg, color: s.fg, padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
      {s.label}
    </span>
  );
}

export function DryRunChip() {
  return (
    <span style={{ background: color.warning.subtle, color: color.warning.base, padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700, border: `1px solid ${color.warning.base}` }}>
      🧪 Dry run
    </span>
  );
}

export interface MessagingPanelProps {
  conversations: Conversation[];
  tags: Tag[];
  store: Store;
  campaigns: Campaign[];
  queue: QueueState;
  machines: MachineView | null;
  preselected: string[];
  onConsumePreselected: () => void;
  onChanged: () => void;
  onViewHistory: () => void;
  /** Draw the queue and in-flight campaign cards above the composer. False
   *  now that Campaigns has an Active sub-view that owns them. */
  showQueue?: boolean;
}

export function MessagingPanel({ conversations, tags, store, campaigns, queue, machines, preselected, onConsumePreselected, onChanged, onViewHistory, showQueue = true }: MessagingPanelProps) {
  const [template, setTemplate] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Seeded from the saved pace in Settings, then editable for this campaign
  // only. Read once on mount: re-syncing it mid-compose would overwrite an
  // override the user had already typed.
  const [pace] = useState(() => readPace(store));
  const [minDelay, setMinDelay] = useState(pace.minDelay);
  const [maxDelay, setMaxDelay] = useState(pace.maxDelay);
  const [batchSize, setBatchSize] = useState(pace.batchSize);
  const [pauseMin, setPauseMin] = useState(pace.pauseMin);
  const [pauseMax, setPauseMax] = useState(pace.pauseMax);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);

  // Adopt contacts pre-selected from the Conversations tab "Message" button.
  useEffect(() => {
    if (preselected.length > 0) {
      setSelected(new Set(preselected));
      onConsumePreselected();
    }
  }, [preselected, onConsumePreselected]);

  // Everything currently in the queue — several campaigns can be live at once.
  const active = activeCampaigns(campaigns);
  const nextUp = runnableCampaigns(campaigns)[0] || null;

  // Contacts already waiting on a message from another live campaign. Queuing
  // overlapping groups is legitimate (a follow-up to a subset, say) but it's
  // also the easy way to message somebody twice by accident, so say so.
  const alreadyQueued = useMemo(() => pendingRecipientIndex(campaigns), [campaigns]);

  const sendable = conversations.filter((c) => !c.archived);
  const filtered = sendable.filter((c) => {
    const matchesSearch = !search || (c.participantName || '').toLowerCase().includes(search.toLowerCase());
    const matchesTag = !filterTag || c.tags.includes(filterTag);
    return matchesSearch && matchesTag;
  });

  const selectedConvs = conversations.filter((c) => selected.has(c.id));
  const selectedWithUrl = selectedConvs.filter((c) => c.chatUrl);
  const selectedWithoutUrl = selectedConvs.filter((c) => !c.chatUrl);
  const selectedAlreadyQueued = selectedWithUrl.filter((c) => alreadyQueued.has(c.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAllFiltered = () => {
    const ids = filtered.filter((c) => c.chatUrl).map((c) => c.id);
    const allSelected = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    setSelected(next);
  };

  const previewName = selectedConvs[0]?.participantName || 'Jane Doe';
  const preview = template ? renderTemplate(template, previewName) : '';

  const start = async () => {
    setError(null);
    if (!template.trim()) { setError('Please type a message template.'); return; }
    if (selectedWithUrl.length === 0) { setError('Select at least one recipient with a saved chat URL.'); return; }
    if (minDelay > maxDelay) { setError('Min delay cannot be greater than max delay.'); return; }
    if (pauseMin > pauseMax) { setError('Min pause cannot be greater than max pause.'); return; }

    setStarting(true);
    const recipients = selectedWithUrl.map((c) => ({ threadId: c.id, participantName: c.participantName, chatUrl: c.chatUrl }));
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'START_CAMPAIGN',
      payload: {
        template,
        recipients,
        dryRun,
        config: {
          minDelayMs: Math.round(minDelay * 60000),
          maxDelayMs: Math.round(maxDelay * 60000),
          batchSize: Math.round(batchSize),
          pauseMinMs: Math.round(pauseMin * 60000),
          pauseMaxMs: Math.round(pauseMax * 60000),
        },
      },
    });
    setStarting(false);
    if (res?.success) {
      setSelected(new Set());
      setTemplate('');
      onChanged();
      // Deliberately stay on the composer rather than jumping to History: the
      // whole point of the queue is that you can line up the next group
      // straight away, and the queue card above shows what's in flight.
    } else if (res === null) {
      setError('No response from the extension background. Fully reload the extension at chrome://extensions (Developer mode → ⟳ on this extension), then refresh this page — the messaging feature needs the new "alarms" permission.');
    } else {
      setError(res.error || 'Failed to start campaign.');
    }
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, boxSizing: 'border-box', outline: 'none' };
  const numStyle: React.CSSProperties = { width: 64, padding: '6px 8px', border: `1px solid ${color.border.control}`, borderRadius: 6, fontSize: 13 };

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Left: composer + config */}
      <div style={{ flex: '1 1 420px', minWidth: 360 }}>
        {/* The queue used to live above the composer on this same screen. It
            now has its own sub-view, so Compose is only about composing —
            except that a running queue is still worth a one-line mention here,
            since it changes what the Start button does. */}
        {showQueue && active.length > 0 && (
          <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <QueueCard campaigns={campaigns} queue={queue} machines={machines} onChanged={onChanged} onViewHistory={onViewHistory} />
            {active.map((c) => (
              <ActiveCampaignCard
                key={c.id}
                campaign={c}
                queue={queue}
                isNext={nextUp?.id === c.id}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}

        <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>Compose template</h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: color.text.muted }}>
            Use <code style={{ background: color.surface.sunken, padding: '1px 5px', borderRadius: 4 }}>{'{{name}}'}</code> or{' '}
            <code style={{ background: color.surface.sunken, padding: '1px 5px', borderRadius: 4 }}>{'{{firstName}}'}</code> to personalize each message.
          </p>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="Hi {{firstName}}, just wanted to reach out…"
            rows={6}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
          />
          {preview && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                Preview ({previewName})
              </div>
              <div style={{ background: color.surface.sunken, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: color.text.secondary, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {preview}
              </div>
            </div>
          )}
        </div>

        {/* Pacing config */}
        <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: color.text.primary, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {showAdvanced ? '▾' : '▸'} Sending pace
          </button>
          <div style={{ fontSize: 12, color: color.text.muted, marginTop: 6 }}>
            {describePace({ minDelay, maxDelay, batchSize, pauseMin, pauseMax })}
          </div>
          {!showAdvanced && describePace({ minDelay, maxDelay, batchSize, pauseMin, pauseMax }) !== describePace(pace) && (
            <Text as="div" size="micro" tone="warning" style={{ marginTop: space.xs }}>
              Overridden for this campaign — your saved pace is unchanged.
            </Text>
          )}
          {showAdvanced && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: color.text.secondary }}>Delay between (min):</span>
                <input type="number" min={0} step={0.5} value={minDelay} onChange={(e) => setMinDelay(Number(e.target.value))} style={numStyle} />
                <span>to</span>
                <input type="number" min={0} step={0.5} value={maxDelay} onChange={(e) => setMaxDelay(Number(e.target.value))} style={numStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: color.text.secondary }}>Pause every (msgs):</span>
                <input type="number" min={1} step={1} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} style={numStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: color.text.secondary }}>Pause length (min):</span>
                <input type="number" min={0} step={1} value={pauseMin} onChange={(e) => setPauseMin(Number(e.target.value))} style={numStyle} />
                <span>to</span>
                <input type="number" min={0} step={1} value={pauseMax} onChange={(e) => setPauseMax(Number(e.target.value))} style={numStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Start */}
        <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
          <div style={{ fontSize: 13, color: color.text.secondary, marginBottom: 10 }}>
            <strong>{selectedWithUrl.length}</strong> recipient{selectedWithUrl.length !== 1 ? 's' : ''} ready
            {selectedWithoutUrl.length > 0 && (
              <span style={{ color: color.warning.base }}> · {selectedWithoutUrl.length} skipped (no chat URL)</span>
            )}
          </div>
          {error && (
            <div style={{ background: '#fdecec', color: color.danger.base, borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>
              {error}
            </div>
          )}
          {selectedAlreadyQueued.length > 0 && (
            <div style={{ background: color.warning.subtle, color: color.warning.base, borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
              <strong>{selectedAlreadyQueued.length}</strong> selected contact{selectedAlreadyQueued.length !== 1 ? 's are' : ' is'} already
              waiting on a message from another campaign
              {' '}({selectedAlreadyQueued.slice(0, 3).map((c) => c.participantName).join(', ')}
              {selectedAlreadyQueued.length > 3 ? `, +${selectedAlreadyQueued.length - 3} more` : ''}).
              They'll receive both.
            </div>
          )}
          {active.length > 0 && (
            <div style={{ background: '#eef4ff', color: color.accent.hover, borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
              This joins the existing queue ({active.length} campaign{active.length !== 1 ? 's' : ''} in flight).
              Messages still go out one at a time on the shared pace — nothing sends faster, it just takes turns.
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: dryRun ? color.warning.subtle : color.surface.sunken, borderRadius: 7, marginBottom: 10, cursor: 'pointer', border: dryRun ? `1px solid ${color.warning.base}` : '1px solid transparent' }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ marginTop: 2, cursor: 'pointer' }} />
            <span style={{ fontSize: 12, color: color.text.secondary, lineHeight: 1.4 }}>
              <strong>Dry run</strong> — type the message into each chat but <strong>don't send it</strong>. Great for testing on one contact first. Marked "sent" once the text is confirmed in the composer.
            </span>
          </label>
          <button
            onClick={start}
            disabled={starting}
            style={{
              width: '100%', background: starting ? '#9ec7b3' : dryRun ? color.warning.base : color.success.base, color: color.surface.raised, border: 'none',
              padding: '12px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14,
              cursor: starting ? 'not-allowed' : 'pointer',
            }}
          >
            {starting
              ? 'Queuing…'
              : `${dryRun ? 'Queue dry run' : active.length > 0 ? 'Add to queue' : 'Start campaign'} → ${selectedWithUrl.length} recipient${selectedWithUrl.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>

      {/* Right: recipient picker */}
      <div style={{ flex: '1 1 320px', minWidth: 300 }}>
        <div style={{ background: color.surface.raised, borderRadius: 10, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Recipients</h3>
            <button onClick={selectAllFiltered} style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
              Toggle all shown
            </button>
          </div>
          <input
            type="text"
            placeholder="Search contacts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          {tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <button onClick={() => setFilterTag(null)} style={{ padding: '3px 9px', borderRadius: 12, border: `1px solid ${color.border.control}`, background: filterTag === null ? color.accent.base : color.surface.raised, color: filterTag === null ? color.surface.raised : color.text.secondary, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                All
              </button>
              {tags.map((t) => (
                <button key={t.id} onClick={() => setFilterTag(filterTag === t.id ? null : t.id)} style={{ padding: '3px 9px', borderRadius: 12, border: 'none', background: filterTag === t.id ? t.color : t.color + '33', color: filterTag === t.id ? color.surface.raised : t.color, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px 12px', color: color.text.muted, fontSize: 12 }}>No contacts match.</div>
            )}
            {filtered.map((c) => {
              const noUrl = !c.chatUrl;
              const queuedIn = alreadyQueued.get(c.id);
              return (
                <label
                  key={c.id}
                  title={noUrl
                    ? 'No saved chat URL — open this chat once in Messenger to capture it'
                    : queuedIn ? `Already queued in: ${queuedIn.join(', ')}` : ''}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 6, background: selected.has(c.id) ? '#e8f5ee' : color.surface.sunken, cursor: noUrl ? 'not-allowed' : 'pointer', opacity: noUrl ? 0.55 : 1 }}
                >
                  <input type="checkbox" disabled={noUrl} checked={selected.has(c.id)} onChange={() => toggle(c.id)} style={{ cursor: noUrl ? 'not-allowed' : 'pointer' }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.participantName || 'Unknown'}
                  </span>
                  {noUrl && <span style={{ fontSize: 10, color: color.warning.base }}>no URL</span>}
                  {queuedIn && !noUrl && <span style={{ fontSize: 9, color: color.accent.hover, background: '#eef4ff', padding: '1px 5px', borderRadius: 7, fontWeight: 600 }}>queued</span>}
                  {/* Also a preview, and only two chips fit — so a tag marked
                      "hide in previews" must not be one of them. Filtered
                      before the slice, or it would crowd out a useful tag. */}
                  {previewTags(c.tags, store.tags).slice(0, 2).map((tag) => (
                    <span key={tag.id} style={{ background: tag.color, color: color.surface.raised, fontSize: 9, padding: '1px 5px', borderRadius: 7 }}>{tag.name}</span>
                  ))}
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Countdown({ to }: { to?: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (!to) return null;
  const ms = to - Date.now();
  if (ms <= 0) return <span>any moment…</span>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return <span>{m > 0 ? `${m}m ` : ''}{s}s</span>;
}

export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? 'Online' : 'Not running'}
      style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: 4, flexShrink: 0,
        background: online ? color.success.base : '#c4c8cc',
      }}
    />
  );
}

export function machineLabel(d: DeviceInfo, selfId: string): string {
  return d.id === selfId ? `${d.name} (this machine)` : d.name;
}

export function SendingFrom({ machines, onChanged }: { machines: MachineView | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // With Drive sync off there is exactly one machine and nothing to coordinate,
  // so the whole concept would be noise. Say nothing.
  if (!machines?.syncEnabled) return null;
  // Likewise before the first heartbeat has landed.
  if (machines.devices.length === 0) return null;

  const sender = machines.devices.find((d) => d.id === machines.senderId) || null;
  const isSelf = !!sender && sender.id === machines.selfId;
  const stalled = !!sender && !machines.senderOnline;
  // This machine holds the queue but can't reach Drive to say so. It keeps
  // sending for a few more minutes and then stands down, so another machine can
  // take over without the two of them overlapping — worth saying out loud,
  // because from here it just looks like sending stopped for no reason.
  const unreachable = isSelf && machines.publishedAgeMs > LEASE_TTL_MS / 2;

  const switchTo = async (deviceId: string) => {
    setBusy(deviceId);
    setError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({ type: 'SET_SENDING_DEVICE', payload: { deviceId } }, 30_000);
    setBusy(null);
    if (!res?.success) { setError(res?.error || 'Could not hand the queue over — check your connection.'); return; }
    setOpen(false);
    onChanged();
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eef1f5', fontSize: 12, color: color.text.secondary }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>Sending from</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: color.text.primary }}>
          <OnlineDot online={machines.senderOnline} />
          {sender ? machineLabel(sender, machines.selfId) : 'no machine yet'}
        </span>
        {machines.pinnedDeviceId === machines.senderId && sender && (
          <span title="You chose this machine — it takes the queue back whenever it's running." style={{ fontSize: 11 }}>📌</span>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
        >
          {open ? 'Close' : 'Switch'}
        </button>
      </div>

      {!isSelf && sender && !stalled && (
        <div style={{ marginTop: 4, fontSize: 11 }}>
          This machine is showing the queue; <strong>{sender.name}</strong> is the one sending.
        </div>
      )}
      {stalled && (
        <div style={{ marginTop: 4, fontSize: 11, color: color.warning.base }}>
          ⚠ {sender?.name} hasn&apos;t checked in since {formatRelativeTime(sender!.lastSeenAt)}. Another running machine
          takes over automatically within a few minutes — or switch now.
        </div>
      )}
      {unreachable && (
        <div style={{ marginTop: 4, fontSize: 11, color: color.warning.base }}>
          ⚠ Can&apos;t reach Google Drive from this machine, so the other machines can&apos;t see that it&apos;s still here.
          Sending continues for a few more minutes, then hands over rather than risk two machines sending at once.
        </div>
      )}
      {machines.senderReason === 'takeover' && machines.previousSenderName && !stalled && (
        <div style={{ marginTop: 4, fontSize: 11 }}>
          Took over automatically because <strong>{machines.previousSenderName}</strong> stopped running.
        </div>
      )}
      {error && <div style={{ marginTop: 4, fontSize: 11, color: color.danger.base }}>{error}</div>}

      {open && (
        <div style={{ marginTop: 8, border: '1px solid #e3e8ef', borderRadius: 8, overflow: 'hidden' }}>
          {machines.devices.map((d) => {
            const online = isDeviceOnline(d);
            const current = d.id === machines.senderId;
            return (
              <div
                key={d.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderTop: '1px solid #f0f3f7', background: current ? '#f5f9ff' : color.surface.raised,
                }}
              >
                <OnlineDot online={online} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: color.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {machineLabel(d, machines.selfId)}
                  </div>
                  <div style={{ fontSize: 11 }}>
                    {online ? 'Running now' : `Last seen ${formatRelativeTime(d.lastSeenAt)}`}
                    {d.platform ? ` · ${d.platform}` : ''}
                  </div>
                </div>
                {current
                  ? <span style={{ fontSize: 11, fontWeight: 700, color: color.success.base }}>Sending</span>
                  : (
                    <button
                      disabled={busy === d.id}
                      title={online ? undefined : 'This machine isn’t running — the queue will wait for it, then move on automatically.'}
                      onClick={() => switchTo(d.id)}
                      style={{
                        background: color.surface.raised, color: online ? color.accent.base : color.warning.base,
                        border: '1px solid ' + (online ? color.accent.subtle : color.warning.base),
                        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                        cursor: busy === d.id ? 'default' : 'pointer', opacity: busy === d.id ? 0.6 : 1,
                      }}
                    >
                      {busy === d.id ? 'Switching…' : 'Send from here'}
                    </button>
                  )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The Active sub-view of Campaigns: the shared queue, and every campaign
 * currently in flight. These used to sit above the composer, which meant the
 * screen you went to in order to *write* a message was mostly taken up by the
 * status of messages already going out.
 */
export function ActiveCampaignsView({
  campaigns, queue, machines, onChanged, onViewHistory, onCompose,
}: {
  campaigns: Campaign[];
  queue: QueueState;
  machines: MachineView | null;
  onChanged: () => void;
  onViewHistory: () => void;
  onCompose: () => void;
}) {
  const active = activeCampaigns(campaigns);
  const nextUp = runnableCampaigns(campaigns)[0] || null;

  if (active.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing in the queue"
          hint="Campaigns you start appear here while they send, with pacing, per-campaign controls and which machine is doing the sending."
          action={<Button variant="primary" onClick={onCompose}>Compose a message</Button>}
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, maxWidth: 720 }}>
      <QueueCard campaigns={campaigns} queue={queue} machines={machines} onChanged={onChanged} onViewHistory={onViewHistory} />
      {active.map((c) => (
        <ActiveCampaignCard key={c.id} campaign={c} queue={queue} isNext={nextUp?.id === c.id} onChanged={onChanged} />
      ))}
    </div>
  );
}

/**
 * Everything in the notifications drawer.
 *
 * The failed-send notice used to be injected into the content flow of every
 * destination, pushing the actual work down the page, and the sync hold was
 * buried inside the queue card where you only saw it if you were already
 * looking at the queue. Both are "something needs your attention" — so both
 * live behind the bell, and the bell carries the count.
 */
export function NotificationsDrawer({
  failures, machines, queue, campaigns, onDismissFailures, onClearFailure, onReview, onViewQueue,
}: {
  failures: FailedSend[];
  machines: MachineView | null;
  queue: QueueState;
  campaigns: Campaign[];
  onDismissFailures: () => void;
  onClearFailure: (f: FailedSend) => void;
  onReview: () => void;
  onViewQueue: () => void;
}) {
  const { pending } = queueDepth(campaigns);
  const held = holdOf(machines);
  const nothing = failures.length === 0 && !held && pending === 0;

  if (nothing) {
    return (
      <EmptyState
        title="Nothing needs your attention"
        hint="Failed sends, a paused queue, and problems reaching Google Drive all show up here."
      />
    );
  }

  return (
    <Stack gap="md">
      {held && <SyncHoldBanner machines={machines} />}

      {failures.length > 0 && (
        <FailedSendsNotice
          failures={failures}
          onDismiss={onDismissFailures}
          onClear={onClearFailure}
          onReview={onReview}
        />
      )}

      {pending > 0 && (
        <Card padding="lg">
          <Stack gap="sm">
            <Text weight="semibold">
              {pending} message{pending !== 1 ? 's' : ''} waiting to send
            </Text>
            <Text size="small" tone="muted" leading="relaxed">
              {queue.paused
                ? 'Sending is paused. Nothing goes out until you resume it.'
                : 'Going out on the shared pace, one at a time.'}
            </Text>
            <Button size="sm" variant="secondary" onClick={onViewQueue} style={{ alignSelf: 'flex-start' }}>
              View the queue
            </Button>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

/**
 * Whether sending is currently held, or heading that way. Shared by the bell
 * count and the drawer so the badge can never disagree with the contents.
 */
export function holdOf(machines: MachineView | null): boolean {
  if (!machines?.syncEnabled) return false;
  if (machines.sync?.hold) return true;
  const health = machines.sync?.health;
  return !!health && isDisconnected(health);
}

export function SyncHoldBanner({ machines }: { machines: MachineView | null }) {
  // With sync off there is one machine, nothing to lose contact with, and any
  // hold left over from when it was on is meaningless.
  if (!machines?.syncEnabled) return null;

  const hold = machines.sync?.hold;
  const health = machines.sync?.health;
  if (!hold) {
    // Not held yet, but the connection is already gone: say so now rather than
    // waiting for the hold, because at a 2-4 minute gap the hold may be several
    // minutes away and the queue looks fine in the meantime.
    if (!health || !isDisconnected(health)) return null;
    return (
      <div style={{ marginTop: 10, background: color.warning.subtle, border: `1px solid ${color.warning.base}`, borderRadius: 8, padding: '10px 12px', fontSize: 12, color: color.warning.base }}>
        <strong>Google Drive is unreachable.</strong> Sending will pause automatically rather than risk
        messaging anybody twice. Retrying every minute.
      </div>
    );
  }

  const heldMinutes = Math.max(1, Math.round((Date.now() - hold.since) / 60_000));
  const authProblem = health?.kind === 'auth';

  return (
    <div style={{ marginTop: 10, background: color.danger.subtle, border: '1px solid #f2c4c4', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#8a2b2b' }}>
      <div style={{ fontWeight: 700 }}>❚❚ {describeHold(hold.reason)}</div>
      <div style={{ marginTop: 4 }}>
        Held for {heldMinutes} min. Nothing is lost — the queue picks up where it left off as soon as
        sync is working, and it re-checks every minute.
      </div>
      {authProblem && (
        <div style={{ marginTop: 6, fontWeight: 600 }}>
          This one needs you: reconnect Google Drive in Settings → Google Drive sync.
        </div>
      )}
      {!!hold.detail && (
        <div style={{ marginTop: 6, color: color.text.secondary, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-word' }}>
          {hold.detail}
        </div>
      )}
    </div>
  );
}

// The queue header: one processor, one clock, however many campaigns are
// feeding it. This is where the global controls live, because pausing "the
// sending" and pausing "this campaign" are genuinely different actions and
// conflating them is how you accidentally stop the wrong thing.
export function QueueCard({ campaigns, queue, machines, onChanged, onViewHistory }: { campaigns: Campaign[]; queue: QueueState; machines: MachineView | null; onChanged: () => void; onViewHistory: () => void }) {
  const depth = queueDepth(campaigns);
  const pausing = !!(queue.pausedForBatchUntil && queue.pausedForBatchUntil > Date.now());
  const inFlight = queue.inFlight
    ? campaigns.find((c) => c.id === queue.inFlight!.campaignId)
        ?.recipients.find((r) => r.threadId === queue.inFlight!.threadId)
    : undefined;

  const control = async (type: string, payload?: unknown) => {
    await sendBg({ type, payload });
    onChanged();
  };

  const modeBtn = (mode: QueueMode, label: string, hint: string): React.ReactElement => (
    <button
      key={mode}
      title={hint}
      onClick={() => control('SET_QUEUE_MODE', { mode })}
      style={{
        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
        border: '1px solid ' + (queue.mode === mode ? color.accent.hover : '#dfe3e8'),
        background: queue.mode === mode ? color.accent.hover : color.surface.raised,
        color: queue.mode === mode ? color.surface.raised : color.text.secondary,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ background: color.surface.raised, borderRadius: 10, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', border: `1px solid ${color.accent.subtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Send queue</div>
          <div style={{ marginTop: 4, fontSize: 12, color: color.text.secondary }}>
            {depth.pending} message{depth.pending !== 1 ? 's' : ''} waiting across {depth.campaigns} campaign{depth.campaigns !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {modeBtn('interleave', 'Interleave', 'Round-robin: every campaign makes progress, one message each per turn.')}
          {modeBtn('sequential', 'One at a time', 'Finish the oldest campaign first, then move to the next.')}
          {queue.paused
            ? <button onClick={() => control('RESUME_QUEUE')} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Resume sending</button>
            : <button onClick={() => control('PAUSE_QUEUE')} style={{ background: color.surface.raised, color: color.warning.base, border: `1px solid ${color.warning.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Pause all</button>}
        </div>
      </div>

      <SyncHoldBanner machines={machines} />

      <div style={{ marginTop: 10, fontSize: 12, color: color.text.secondary, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          {queue.paused
            ? <span style={{ color: color.warning.base, fontWeight: 600 }}>❚❚ Sending paused — no campaign will send until you resume.</span>
            : inFlight
              ? <>Sending now → <strong>{inFlight.participantName}</strong></>
              : pausing
                ? <>Batch pause · sending resumes in <Countdown to={queue.pausedForBatchUntil} /></>
                : queue.nextSendAt
                  ? <>Next message in <Countdown to={queue.nextSendAt} /></>
                  : 'Idle.'}
        </span>
        <button onClick={onViewHistory} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: color.accent.base, fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
          History &amp; logs →
        </button>
      </div>

      <SendingFrom machines={machines} onChanged={onChanged} />
    </div>
  );
}

export function ActiveCampaignCard({ campaign, queue, isNext, onChanged }: { campaign: Campaign; queue: QueueState; isNext: boolean; onChanged: () => void }) {
  const sum = summarize(campaign);
  const pausing = !!(queue.pausedForBatchUntil && queue.pausedForBatchUntil > Date.now());

  const control = async (type: string) => {
    await sendBg({ type, payload: { campaignId: campaign.id } });
    onChanged();
  };

  // The countdown belongs to the queue, so only the campaign that's actually
  // next says "next send" — the others are waiting their turn behind it.
  const timing = (): React.ReactNode => {
    if (campaign.status !== 'running') return null;
    if (queue.paused) return 'Sending paused';
    if (pausing) return <>Batch pause · resumes in <Countdown to={queue.pausedForBatchUntil} /></>;
    if (queue.inFlight?.campaignId === campaign.id) return 'Sending now…';
    if (isNext) return <>Next send in <Countdown to={queue.nextSendAt} /></>;
    return 'Waiting its turn';
  };

  return (
    <div style={{ background: color.surface.raised, borderRadius: 10, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', border: '1px solid #d7eadf' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campaign.name}</div>
          <div style={{ marginTop: 4, display: 'flex', gap: 6 }}><StatusBadge status={campaign.status} />{campaign.dryRun && <DryRunChip />}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {campaign.status === 'running' && (
            <button onClick={() => control('PAUSE_CAMPAIGN')} style={{ background: color.surface.raised, color: color.warning.base, border: `1px solid ${color.warning.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Pause</button>
          )}
          {campaign.status === 'paused' && (
            <button onClick={() => control('RESUME_CAMPAIGN')} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Resume</button>
          )}
          <button onClick={() => control('CANCEL_CAMPAIGN')} style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: 12, height: 8, background: color.border.subtle, borderRadius: 5, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${(sum.sent / sum.total) * 100}%`, background: color.success.base }} />
        <div style={{ width: `${(sum.errors / sum.total) * 100}%`, background: color.danger.base }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: color.text.secondary, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>✅ {sum.sent} sent</span>
        <span>❌ {sum.errors} errors</span>
        <span>⏳ {sum.pending} pending</span>
        <span style={{ marginLeft: 'auto' }}>{timing()}</span>
      </div>
    </div>
  );
}

export function HistoryPanel({ campaigns, onChanged, store, onViewProfile, onEditProfileUrl, onCompose }: { campaigns: Campaign[]; onChanged: () => void; store: Store; onViewProfile: (threadId: string) => void; onEditProfileUrl: (threadId: string, raw: string) => Promise<string | null>; onCompose: () => void }) {
  const sorted = campaigns.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No bulk messages yet"
          hint="Every campaign you send lands here — who received it, who failed, and the message that went out."
          action={<Button variant="primary" onClick={onCompose}>Compose a message</Button>}
        />
      </Card>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sorted.map((c) => <CampaignHistoryCard key={c.id} campaign={c} onChanged={onChanged} store={store} onViewProfile={onViewProfile} onEditProfileUrl={onEditProfileUrl} />)}
    </div>
  );
}

// Banner for messages that failed while nobody was watching. Blocked/
// unavailable recipients are called out separately: those never succeed on a
// retry, so requeueing them is wasted effort.
export function FailedSendsNotice({ failures, onDismiss, onClear, onReview }: { failures: FailedSend[]; onDismiss: () => void; onClear: (f: FailedSend) => void; onReview: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const unavailable = failures.filter((f) => f.errorKind === 'unavailable');
  const shown = expanded ? failures : failures.slice(0, 5);

  return (
    <div style={{ background: '#fff6f6', border: `1px solid ${color.danger.base}`, borderRadius: 10, padding: '14px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: color.danger.base }}>
            {failures.length} message{failures.length !== 1 ? 's' : ''} failed to send
          </div>
          {unavailable.length > 0 && (
            <div style={{ fontSize: 12, color: '#8a3a2f', marginTop: 2 }}>
              {unavailable.length} because the recipient isn't available on Messenger (blocked, deactivated, or restricted) — retrying won't help.
            </div>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={onReview}>Review in past sends</Button>
        {/* "Clear all" read as though it deleted the failures. It only stops
            them being reported again — the sends stay in the campaign. */}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          title="Stop reporting these. The failed sends stay on the campaign."
        >
          Dismiss
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10 }}>
        {shown.map((f) => (
          <div key={failureKey(f)} style={{ fontSize: 12, color: '#7a3b33', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{f.participantName || f.threadId}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.error || 'Unknown error'}</span>
            <span style={{ color: color.text.secondary, flexShrink: 0 }}>{formatRelativeTime(f.failedAt)}</span>
            <button
              onClick={() => onClear(f)}
              title={`Clear ${f.participantName || 'this failure'} from this notice`}
              style={{ background: 'none', border: 'none', color: color.text.secondary, fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        ))}
        {failures.length > shown.length && (
          <button
            onClick={() => setExpanded(true)}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: color.danger.base, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '2px 0' }}
          >
            Show {failures.length - shown.length} more
          </button>
        )}
      </div>
    </div>
  );
}

export function CampaignHistoryCard({ campaign, onChanged, store, onViewProfile, onEditProfileUrl }: { campaign: Campaign; onChanged: () => void; store: Store; onViewProfile: (threadId: string) => void; onEditProfileUrl: (threadId: string, raw: string) => Promise<string | null> }) {
  const [expanded, setExpanded] = useState(false);
  // A refused queue change is shown on the campaign it belongs to, rather than
  // in a browser alert that gives no clue which card it came from.
  const [actionError, setActionError] = useState<string | null>(null);
  const sum = summarize(campaign);

  const control = async (type: string) => {
    await sendBg({ type, payload: { campaignId: campaign.id } });
    onChanged();
  };

  const removeRecipient = async (threadId: string) => {
    setActionError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'REMOVE_CAMPAIGN_RECIPIENT',
      payload: { campaignId: campaign.id, threadId },
    });
    if (res && !res.success && res.error) setActionError(res.error);
    onChanged();
  };

  const requeueRecipient = async (threadId: string) => {
    setActionError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'REQUEUE_CAMPAIGN_RECIPIENT',
      payload: { campaignId: campaign.id, threadId },
    });
    if (res && !res.success && res.error) setActionError(res.error);
    onChanged();
  };

  const canRemove = campaign.status === 'running' || campaign.status === 'paused';

  return (
    <div style={{ background: color.surface.raised, borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <span style={{ color: color.text.muted, fontSize: 13 }}>{expanded ? '▾' : '▸'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campaign.name}</div>
          <div style={{ fontSize: 12, color: color.text.muted, marginTop: 2 }}>
            Started {formatDateTime(campaign.startedAt || campaign.createdAt)}
            {campaign.completedAt ? ` · finished ${formatDateTime(campaign.completedAt)}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: color.text.secondary }}>
          <span style={{ color: color.success.base, fontWeight: 600 }}>{sum.sent}✓</span>
          <span style={{ color: color.danger.base, fontWeight: 600 }}>{sum.errors}✕</span>
          <span style={{ color: color.text.muted }}>{sum.pending}⏳</span>
          <span>/ {sum.total}</span>
          {campaign.dryRun && <DryRunChip />}
          <StatusBadge status={campaign.status} />
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${color.border.subtle}`, padding: '14px 18px' }}>
          {actionError && (
            <div style={{ marginBottom: space.md }}>
              <Banner tone="danger" live>{actionError}</Banner>
            </div>
          )}
          {/* Controls for an in-flight campaign */}
          {(campaign.status === 'running' || campaign.status === 'paused') && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {campaign.status === 'running' && <button onClick={() => control('PAUSE_CAMPAIGN')} style={{ background: color.surface.raised, color: color.warning.base, border: `1px solid ${color.warning.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Pause</button>}
              {campaign.status === 'paused' && <button onClick={() => control('RESUME_CAMPAIGN')} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Resume</button>}
              <button onClick={() => control('CANCEL_CAMPAIGN')} style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            </div>
          )}

          {/* Template */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Template</div>
            <CopyButton text={campaign.template} />
          </div>
          <div style={{ background: color.surface.sunken, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: color.text.secondary, whiteSpace: 'pre-wrap', marginBottom: 14, lineHeight: 1.5 }}>{campaign.template}</div>

          {/* Config summary */}
          <div style={{ fontSize: 12, color: color.text.muted, marginBottom: 14 }}>
            Pace: {minutes(campaign.config.minDelayMs)}–{minutes(campaign.config.maxDelayMs)} between messages · pause ~{campaign.config.batchSize} for {minutes(campaign.config.pauseMinMs)}–{minutes(campaign.config.pauseMaxMs)}
          </div>

          {/* Batches */}
          {campaign.batches.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Batches</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
                {campaign.batches.map((b) => (
                  <div key={b.index} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: color.text.secondary, background: color.surface.sunken, padding: '6px 10px', borderRadius: 6 }}>
                    <span>Batch {b.index + 1} · {b.count} message{b.count !== 1 ? 's' : ''}</span>
                    <span>{formatDateTime(b.startedAt)}{b.endedAt ? ` → ${new Date(b.endedAt).toLocaleTimeString()}` : ' → …'}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Recipients */}
          <div style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Recipients</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {campaign.recipients.map((r, i) => (
              <RecipientRow
                key={r.threadId + i}
                r={r}
                conv={store.conversations[r.threadId]}
                onViewProfile={() => onViewProfile(r.threadId)}
                onEditProfileUrl={store.conversations[r.threadId] ? (raw) => onEditProfileUrl(r.threadId, raw) : undefined}
                onRemove={canRemove && r.status !== 'sending' ? () => removeRecipient(r.threadId) : undefined}
                onRequeue={r.status === 'error' ? () => requeueRecipient(r.threadId) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RecipientRow({ r, conv, onViewProfile, onEditProfileUrl, onRemove, onRequeue }: { r: CampaignRecipient; conv?: Conversation; onViewProfile: () => void; onEditProfileUrl?: (raw: string) => Promise<string | null>; onRemove?: () => void; onRequeue?: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Reveal the profile-URL editor by default for a failed send — a wrong or
  // changed URL is the thing you most often need to fix before requeuing.
  const [editingUrl, setEditingUrl] = useState(r.status === 'error');
  const hasLog = !!(r.log && r.log.length);
  // Prefer the contact's current chat URL; the recipient snapshot can be stale.
  const chatUrl = conv?.chatUrl || r.chatUrl;

  return (
    <div style={{ background: color.surface.sunken, borderRadius: 6, padding: '8px 10px' }}>
      <div
        onClick={() => hasLog && setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasLog ? 'pointer' : 'default' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(r.status), flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.participantName || r.threadId}</span>
        <span style={{ fontSize: 11, color: statusColor(r.status), fontWeight: 600 }}>{statusLabel(r.status)}</span>
        {r.sentAt && <span style={{ fontSize: 11, color: color.text.muted }}>{new Date(r.sentAt).toLocaleTimeString()}</span>}
        {hasLog && <span style={{ fontSize: 11, color: color.accent.base }}>{open ? 'hide log' : 'log'}</span>}

        <button
          onClick={(e) => { e.stopPropagation(); onViewProfile(); }}
          title="View contact profile"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: 2, lineHeight: 1 }}
        >
          👤
        </button>
        {onEditProfileUrl && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditingUrl((v) => !v); }}
            title="Edit profile URL used for sending"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: 2, lineHeight: 1, color: editingUrl ? color.accent.base : undefined }}
          >
            🔗
          </button>
        )}
        {chatUrl && (
          <a
            href={chatUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open Messenger chat"
            style={{ fontSize: 13, textDecoration: 'none', lineHeight: 1 }}
          >
            💬
          </a>
        )}
        {onRequeue && (
          <button
            onClick={(e) => { e.stopPropagation(); onRequeue(); }}
            title="Requeue — try sending this again"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: color.accent.base, padding: 2, lineHeight: 1 }}
          >
            ↻
          </button>
        )}
        {onRemove && (
          confirmRemove ? (
            <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: color.danger.base }}>Remove?</span>
              <button
                onClick={onRemove}
                style={{ background: color.danger.base, color: color.surface.raised, border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                style={{ background: color.surface.sunken, color: color.text.secondary, border: `1px solid ${color.border.subtle}`, padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
              >
                No
              </button>
            </span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmRemove(true); }}
              title="Remove from queue"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: color.danger.base, padding: 2, lineHeight: 1 }}
            >
              ✕
            </button>
          )
        )}
      </div>
      {r.error && (
        <div style={{ marginTop: 6, marginLeft: 18, fontSize: 12, color: color.danger.base }}>⚠️ {r.error}</div>
      )}
      {onEditProfileUrl && editingUrl && (
        <div style={{ marginTop: 8, marginLeft: 18, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, flexShrink: 0, paddingTop: 5 }}>Profile URL</span>
          <ProfileUrlEditor value={conv?.profileUrl} onSave={onEditProfileUrl} compact />
        </div>
      )}
      {open && hasLog && (
        <pre style={{ marginTop: 8, marginLeft: 18, background: '#1e1e1e', color: color.text.muted, padding: '10px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {r.log!.join('\n')}
        </pre>
      )}
    </div>
  );
}
