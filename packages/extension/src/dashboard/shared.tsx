// Cross-cutting helpers for the dashboard.
//
// These are the things more than one panel needs: the background message
// channel, the date and size formatters, the tag-group bucketing that the
// contact detail, the tag picker and the tag filter all share, and the small
// components (SubNav, ProfileUrlEditor, CopyButton) that appear in several
// places. Extracted when DashboardApp.tsx passed 5,500 lines and every one of
// these was defined next to code that had nothing to do with it.

import React, { useState } from 'react';
import type { Store, Tag, TagGroup, SyncUsage } from '../storage';
import { DRIVE_SYNC_ALARM } from '../storage';
import { isSignedIn } from '../license';
import { DEFAULTS } from '../campaigns';
import type { DeviceOverview } from '../devices';
import type { SyncStatusView, SendHoldReason } from '../syncHealth';
import { PRODUCT_NAME } from '../product';
import { Button, Input, Stack, Text, color, fontSize, fontWeight, radius, space } from '../ui/primitives';
import { elevation } from '../ui/tokens';

export interface MachineView extends DeviceOverview {
  lastSyncAt: number | null;
  syncEnabled: boolean;   // false when Drive sync is off — then there's one machine and no lease
  // Drive health and whether the queue is held because of it. Optional because a
  // worker from before this field existed may still be the one answering during
  // an update, and the queue card must not blow up on that.
  sync?: SyncStatusView;
}

// Why the queue is held, in the user's terms. The distinction that matters is
// that this is NOT a pause they asked for and NOT something they can override —
export function describeHold(reason: SendHoldReason): string {
  switch (reason) {
    case 'announce-failed':
      return "Sending is on hold: this machine couldn't tell the others who it was about to message.";
    case 'lease-unverifiable':
      return "Sending is on hold: this machine can't confirm it's still the one that should be sending.";
    default:
      return 'Sending is on hold: this machine lost contact with Google Drive.';
  }
}

export function downloadText(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Guard for import/export. The dashboard as a whole is already behind the
 * sign-in gate, but that is render state: a session can expire while this tab
 * sits open, and moving data in or out of the CRM is exactly where an
 * out-of-date screen must not be trusted. So these paths re-check at click time
 * against the stored session, not against React state.
 *
 * Import is additionally refused by the background (SET_STORE checks the same
 * thing before writing); export has no write to be refused, which is why the
 * check here is what actually stops it.
 */
export async function ensureSignedIn(action: string): Promise<string | null> {
  if (await isSignedIn()) return null;
  return `Sign in to your ${PRODUCT_NAME} account to ${action}.`;
}

/**
 * What `hideInSidebar` means to the user, in one phrase. Hiding applies to the
 * compact chip rows that preview a contact in a list — Messenger's conversation
 * sidebar and the contact list here — and nowhere else.
 */
export const HIDDEN_TAG_TITLE = 'Hidden from conversation previews — still available for sorting, filtering and search';

/**
 * The tags to draw as chips in a *preview* row (the contact list, the recipient
 * picker). Tags marked "hide in previews" are dropped.
 *
 * Display only. Nothing that decides which contacts appear — the tag filter,
 * sorting, and the advanced query — goes through here; those all read
 * `conv.tags` and `store.tags` directly, so a hidden tag still filters, sorts
 * and searches exactly like any other.
 */
export function previewTags(tagIds: string[], tags: Record<string, Tag>): Tag[] {
  return tagIds.map((id) => tags[id]).filter((t): t is Tag => !!t && !t.hideInSidebar);
}

/** A tag group and the subset of tags that fell into it. */
export interface TagBucket {
  key: string;
  label: string;
  color?: string;
  tags: Tag[];
}

const UNGROUPED_KEY = '__ungrouped__';

/**
 * Bucket `tags` by their tag group, in the same order the Tags tab uses
 * (`order`, then `createdAt`), with ungrouped tags last. Input order is
 * preserved inside each bucket.
 *
 * Empty buckets are dropped, so a profile shows headings only for groups the
 * contact actually has tags in. A `groupId` pointing at a deleted group counts
 * as ungrouped — the same reading as the Tags tab, so a tag can never vanish
 * from a list just because its group went away.
 */
export function bucketTagsByGroup(tags: Tag[], groups: Record<string, TagGroup>): TagBucket[] {
  const ordered = Object.values(groups).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const byGroup = new Map<string, Tag[]>();
  const ungrouped: Tag[] = [];

  for (const t of tags) {
    if (t.groupId && groups[t.groupId]) {
      const list = byGroup.get(t.groupId);
      if (list) list.push(t);
      else byGroup.set(t.groupId, [t]);
    } else {
      ungrouped.push(t);
    }
  }

  const out: TagBucket[] = [];
  for (const g of ordered) {
    const list = byGroup.get(g.id);
    if (list?.length) out.push({ key: g.id, label: g.name, color: g.color, tags: list });
  }
  if (ungrouped.length) out.push({ key: UNGROUPED_KEY, label: 'Ungrouped', tags: ungrouped });
  return out;
}

/**
 * Whether to draw group headings at all. A single bucket of ungrouped tags is
 * just a flat list, and labelling it "Ungrouped" would be noise.
 */
export function showsGroupLabels(buckets: TagBucket[]): boolean {
  return buckets.some((b) => b.key !== UNGROUPED_KEY);
}
export function tsStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

// Promise wrapper around the background message channel (campaign control).
// Always settles: a timeout guards against a service worker that failed to
// register its handler (e.g. before a full extension reload), so the UI can
// never hang waiting for a response that will never come.
export function sendBg<T = any>(message: unknown, timeoutMs = 15000): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: T | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) { clearTimeout(timer); done(null); return; }
      chrome.runtime.sendMessage(message, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { done(null); return; }
        done(res as T);
      });
    } catch { clearTimeout(timer); done(null); }
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function minutes(ms: number): string {
  return `${Math.round(ms / 60000)}m`;
}

// "in 3m 12s" style countdown for the next scheduled Drive sync.
export function formatCountdown(ms: number): string {
  if (ms <= 1000) return 'any moment';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// The background worker owns the periodic Drive sync; read its alarm so the
// settings panel can show when the next pass is due. Resolves null when alarms
// aren't available or the worker hasn't scheduled it yet.
export function getNextDriveSyncAt(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.alarms?.get) { resolve(null); return; }
      chrome.alarms.get(DRIVE_SYNC_ALARM, (alarm) => {
        void chrome.runtime.lastError;
        resolve(alarm?.scheduledTime ?? null);
      });
    } catch { resolve(null); }
  });
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// --- Sending pace ---------------------------------------------------------
//
// The pace lived only inside the composer, so it was re-entered from the
// shipped defaults for every campaign and there was nowhere to say "this is
// how I always want to send". It is a standing preference, so it belongs in
// Settings; the composer still overrides it per campaign.
//
// Stored in the CRM store (not localStorage) because unlike a pane width this
// genuinely should follow you between machines — Facebook rate-limits the
// account, not the browser.

/** Pace in the units the UI uses: minutes, and a message count. */
export interface SendingPace {
  minDelay: number;
  maxDelay: number;
  batchSize: number;
  pauseMin: number;
  pauseMax: number;
}

export const SENDING_PACE_KEY = 'sendingPace';

export const DEFAULT_PACE: SendingPace = {
  minDelay: DEFAULTS.minDelayMs / 60000,
  maxDelay: DEFAULTS.maxDelayMs / 60000,
  batchSize: DEFAULTS.batchSize,
  pauseMin: DEFAULTS.pauseMinMs / 60000,
  pauseMax: DEFAULTS.pauseMaxMs / 60000,
};

/** The saved pace, falling back per-field so a partial or older value from
 *  another machine can't produce a NaN in a number input. */
export function readPace(store: Store): SendingPace {
  const raw = (store.settings as Record<string, unknown>)?.[SENDING_PACE_KEY] as Partial<SendingPace> | undefined;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    minDelay: num(raw?.minDelay, DEFAULT_PACE.minDelay),
    maxDelay: num(raw?.maxDelay, DEFAULT_PACE.maxDelay),
    batchSize: num(raw?.batchSize, DEFAULT_PACE.batchSize),
    pauseMin: num(raw?.pauseMin, DEFAULT_PACE.pauseMin),
    pauseMax: num(raw?.pauseMax, DEFAULT_PACE.pauseMax),
  };
}

/** One-line summary of a pace, used in both the composer and Settings. */
export function describePace(p: SendingPace): string {
  return `${p.minDelay}–${p.maxDelay} min between messages · pause ~${p.batchSize} messages for ${p.pauseMin}–${p.pauseMax} min`;
}

// --- Sub-navigation -------------------------------------------------------

export interface SubNavItem<Id extends string> { id: Id; label: string; count?: number }

/**
 * Segmented control for sub-views within a destination. Deliberately different
 * from the rail: these are views of one thing, not separate places, so they
 * read as a control rather than as navigation.
 */
export function SubNav<Id extends string>({
  items, current, onChange, label,
}: {
  items: SubNavItem<Id>[];
  current: Id;
  onChange: (id: Id) => void;
  /** Names the group for assistive tech, e.g. "Campaign views". */
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: 'inline-flex', gap: space.xxs, padding: space.xxs,
        background: color.surface.sunken, border: `1px solid ${color.border.subtle}`,
        borderRadius: radius.sm, alignSelf: 'flex-start',
      }}
    >
      {items.map((item) => {
        const active = item.id === current;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: space.xs,
              minHeight: 30, padding: `0 ${space.md}px`,
              border: 'none', borderRadius: radius.sm,
              background: active ? color.surface.raised : 'transparent',
              boxShadow: active ? elevation.sm : 'none',
              color: active ? color.text.primary : color.text.secondary,
              font: 'inherit', fontSize: fontSize.small,
              fontWeight: active ? fontWeight.semibold : fontWeight.medium,
              cursor: 'pointer',
            }}
          >
            {item.label}
            {item.count !== undefined && (
              <Text size="micro" weight="semibold" tone={active ? 'accent' : 'muted'}>{item.count}</Text>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Inline editor for a contact's Facebook profile URL. Shows the URL as a link
// with an edit pencil; clicking swaps to an input with Save/Cancel. onSave
// returns an error string to display inline, or null on success. Reused in the
// contact detail pane and in the messaging queue so a wrong/changed URL can be
// fixed right where a send failed, then requeued.
/**
 * Inline editor for a contact's Facebook profile URL. Shows the URL as a link
 * with an edit pencil; clicking swaps to an input with Save/Cancel. `onSave`
 * returns an error string to display inline, or null on success.
 *
 * Used in the contact detail pane and in the messaging queue, so a wrong or
 * changed URL can be fixed right where a send failed, then requeued.
 */
export function ProfileUrlEditor({ value, onSave, compact }: { value?: string; onSave: (raw: string) => Promise<string | null>; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fs = compact ? 12 : 13;

  const start = () => { setDraft(value || ''); setError(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); };
  const commit = async () => {
    if (saving) return;
    setSaving(true);
    const err = await onSave(draft);
    setSaving(false);
    if (err) { setError(err); return; }
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
            placeholder="https://facebook.com/username"
            style={{ flex: 1, minWidth: 0, fontSize: fs, padding: '5px 8px', border: `1px solid ${color.accent.subtle}`, borderRadius: 6, outline: 'none' }}
          />
          <button onClick={commit} disabled={saving} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 10px', borderRadius: 6, fontWeight: 600, fontSize: fs - 1, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>Save</button>
          <button onClick={cancel} style={{ background: color.surface.sunken, color: color.text.secondary, border: `1px solid ${color.border.subtle}`, padding: '6px 10px', borderRadius: 6, fontWeight: 600, fontSize: fs - 1, cursor: 'pointer' }}>Cancel</button>
        </div>
        {error && <span style={{ fontSize: 11, color: color.danger.base }}>{error}</span>}
      </div>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
      {value ? (
        <a href={value} target="_blank" rel="noreferrer" style={{ color: color.accent.base, wordBreak: 'break-all', fontSize: fs }}>{value}</a>
      ) : (
        <span style={{ color: color.text.muted, fontStyle: 'italic', fontSize: fs }}>No profile URL</span>
      )}
      <button onClick={start} title="Edit profile URL" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: fs, color: color.text.muted, padding: 2, lineHeight: 1, flexShrink: 0 }}>✎</button>
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={copy}
      title="Copy template"
      style={{
        background: copied ? color.success.subtle : color.surface.raised,
        color: copied ? color.success.base : color.text.secondary,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}
