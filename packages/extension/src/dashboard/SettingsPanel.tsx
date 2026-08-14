// Settings, in five groups.
//
// The old panel was one scroll of nine cards in this order: build info,
// preferences, contacts maintenance, Chrome Sync (legacy), account, Drive
// sync, machines, JSON backup, CSV import. Identity, storage, behaviour and
// build info were interleaved, and the two sync mechanisms sat either side of
// the account card. The components are unchanged; they are re-parented into
// Account & plan / Sync & devices / Data / Behavior / About.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Store, Conversation, Tag, SaveResult, SyncUsage,
  forcePullFromSync, forcePushToSync, isDriveEnabled, setDriveEnabled,
  getDriveSyncInfo, DriveSyncInfo, DRIVE_SYNC_ALARM, DRIVE_SYNC_PERIOD_MINUTES,
  DIAG_TTL_MS,
} from '../storage';
import { BUILD_INFO } from '../buildInfo';
import { getEntitlement, PLATFORM_URL, FREE_CONTACT_LIMIT, type Entitlement } from '../license';
import {
  isDriveConfigured, getDriveStatus, getDriveAuthState, connectDrive, disconnectDrive,
  getAuthRedirectUri, readStore as driveReadStore, writeStore as driveWriteStore,
  DriveStatus, DriveAuthState,
} from '../drive';
import {
  parseContactsCsv, applyContacts, sampleCsv, resolveThread, csvHeaders, detectMapping,
  MAPPABLE_FIELDS, Mapping, Field, loadImportHistory, recordImport, ImportHistoryEntry,
} from '../csv';
import { mergeConversations, findDuplicateGroups, cleanStoredNames, pickPrimary, duplicateGroupKey, DuplicateGroup } from '../contacts';
import { IS_UNPACKED } from '../devMode';
import { isOnline as isDeviceOnline, LEASE_TTL_MS, type DeviceInfo } from '../devices';
import {
  Banner, Button, Card, Input, Select, Stack, Text, Toggle,
  Field as FormField, color, fontSize, fontWeight, radius, space,
} from '../ui/primitives';
import { useLocalPref } from '../ui/prefs';
import { PRODUCT_SLUG } from '../product';
import {
  MachineView, sendBg, ensureSignedIn, downloadText, tsStamp, formatBytes, formatDateTime,
  formatRelativeTime, formatCountdown, minutes, getNextDriveSyncAt,
  readPace, describePace, SENDING_PACE_KEY, DEFAULT_PACE, type SendingPace,
  SubNav, CopyButton,
} from './shared';
import { OnlineDot } from './Campaigns';
import { PresetActionsSettings } from './PresetActionsSettings';
import { WebhookSettings } from './WebhookSettings';

/** Sections of Settings. */
export type SettingsView = 'account' | 'sync' | 'data' | 'behavior' | 'about';


// --- Settings sub-component ---
export interface SettingsPanelProps {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
  conversations: Conversation[];
  tags: Tag[];
  syncUsage: SyncUsage | null;
  onStoreReplaced: (s: Store) => Promise<void>;
}

export function SettingsPanel({ store, updateStore, conversations, tags, syncUsage, onStoreReplaced }: SettingsPanelProps) {
  const settings = store.settings as Record<string, unknown>;
  const [view, setView] = useLocalPref<SettingsView>('settingsView', 'account');
  // Backup import/export result. Shown in place rather than through alert(),
  // which is browser chrome: it can't be styled, isn't announced in context,
  // and blocks the page.
  const [dataStatus, setDataStatus] = useState<{ tone: 'success' | 'warning' | 'danger'; msg: string } | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [pushConfirm, setPushConfirm] = useState(false);
  // Chrome Sync is legacy once Drive is canonical, so it starts collapsed.
  const [syncOpen, setSyncOpen] = useState(false);

  const handlePull = async () => {
    setSyncStatus({ type: 'info', msg: 'Pulling from Chrome sync…' });
    try {
      const pulled = await forcePullFromSync();
      if (!pulled) {
        setSyncStatus({ type: 'error', msg: 'Nothing found in Chrome sync. Make sure you are signed into Chrome with the same account on both machines and that the extension has been active long enough to sync (development-mode extensions may not sync).' });
        return;
      }
      await onStoreReplaced(pulled);
      const convCount = Object.keys(pulled.conversations).length;
      const tagCount = Object.keys(pulled.tags).length;
      setSyncStatus({ type: 'success', msg: `Pulled ${convCount} contacts and ${tagCount} tags from Chrome sync.` });
    } catch (e) {
      setSyncStatus({ type: 'error', msg: `Pull failed: ${String(e)}` });
    }
  };

  const handlePush = async () => {
    setPushConfirm(false);
    setSyncStatus({ type: 'info', msg: 'Pushing to Chrome sync…' });
    try {
      await forcePushToSync(store);
      setSyncStatus({ type: 'success', msg: 'Local data pushed to Chrome sync successfully.' });
    } catch (e) {
      setSyncStatus({ type: 'error', msg: `Push failed: ${String(e)}` });
    }
  };

  const toggleSetting = async (key: string, val: boolean) => {
    await updateStore({ ...store, settings: { ...settings, [key]: val } });
  };

  const exportData = async () => {
    const blocked = await ensureSignedIn('export your data');
    if (blocked) { setDataStatus({ tone: 'danger', msg: blocked }); return; }
    setDataStatus(null);
    const data = JSON.stringify(store, null, 2);
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(data);
    a.download = `${PRODUCT_SLUG}-backup-${tsStamp()}.json`;
    a.click();
  };

  const importData = async () => {
    const blocked = await ensureSignedIn('import a backup');
    if (blocked) { setDataStatus({ tone: 'danger', msg: blocked }); return; }
    setDataStatus(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          const save = await updateStore(data);
          // Report what actually happened. The background refuses the write when
          // there's no account, and claiming success there would be a lie that
          // costs the user their backup.
          if (save.signedOut) {
            setDataStatus({ tone: 'danger', msg: save.reason || 'Sign in to import a backup.' });
          } else if (save.ok) {
            setDataStatus({ tone: 'success', msg: 'Backup restored.' });
          } else {
            setDataStatus({
              tone: 'warning',
              msg: `Restored on this machine, but ${save.pending} record${save.pending === 1 ? '' : 's'} could not sync: ${save.reason || 'the write was rejected'}.`,
            });
          }
        } catch {
          setDataStatus({ tone: 'danger', msg: "That file isn't a Not Another Social CRM backup — it should be the .json this page exports." });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <Stack gap="lg">
      <SubNav<SettingsView>
        label="Settings sections"
        current={view}
        onChange={setView}
        items={[
          { id: 'account', label: 'Account & plan' },
          { id: 'sync', label: 'Sync & devices' },
          { id: 'data', label: 'Data' },
          { id: 'behavior', label: 'Behavior' },
          { id: 'about', label: 'About' },
        ]}
      />

      <div style={{ maxWidth: 620 }}>

      {view === 'account' && <AccountPanel contactCount={conversations.length} />}

      {view === 'behavior' && (
      <>
      <Card style={{ marginBottom: space.md }}>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: `0 0 ${space.lg}px` }}>Capture &amp; notifications</Text>
        <Stack gap="xs">
          {[
            { key: 'autoCapture', label: 'Auto-capture conversations you open', default: false },
            { key: 'autoTagging', label: 'Auto-tagging', default: false },
            { key: 'notificationEnabled', label: 'Notifications', default: true },
          ].map(({ key, label, default: def }) => (
            <div key={key} style={{ padding: `${space.sm}px ${space.md}px`, background: color.surface.sunken, borderRadius: radius.sm }}>
              <Toggle
                label={label}
                checked={(settings[key] as boolean) ?? def}
                onChange={(e) => toggleSetting(key, e.target.checked)}
              />
            </div>
          ))}
        </Stack>
        <Text as="p" size="micro" tone="muted" leading="relaxed" style={{ margin: `${space.md}px 0 0` }}>
          <strong>Auto-capture</strong> saves every conversation you open while the CRM panel is visible in Messenger. Turn it off to
          only add contacts you explicitly save (a "Save contact" button appears instead). It never adds anyone just from replying.
        </Text>
      </Card>

      <PresetActionsSettings store={store} updateStore={updateStore} />

      <SendingPaceSettings store={store} updateStore={updateStore} />
      </>
      )}

      {view === 'sync' && (
      <>
      {/* Drive first: it is the supported path, and Chrome Sync is what it
          replaced. The old order put a legacy mechanism above the current one
          and separated the two with the Account card. */}
      <DriveBackupPanel store={store} updateStore={updateStore} />

      <MachinesPanel />

      <div style={{ background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <button
          onClick={() => setSyncOpen((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
          aria-expanded={syncOpen}
        >
          <span style={{ fontSize: 11, color: color.text.muted, transform: syncOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Chrome Sync</h3>
          <span style={{ fontSize: 10, fontWeight: 700, color: color.text.muted, background: color.surface.sunken, borderRadius: 4, padding: '2px 6px' }}>LEGACY</span>
        </button>
        {syncOpen && (
        <div style={{ marginTop: 12 }}>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
          Pull loads data from Chrome's sync storage into this machine. Push uploads this machine's data to Chrome sync so other machines pick it up.
          {' '}<strong>Note:</strong> Chrome may not sync data for extensions installed in developer mode — if contacts are missing after pulling, try the JSON backup under <strong>Data</strong> as a fallback.
          {' '}Superseded by Google Drive sync above, which has no ~500-contact limit.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: syncStatus ? 10 : 0 }}>
          <button
            onClick={handlePull}
            style={{ flex: 1, background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.border.control}`, padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Pull from Sync
          </button>
          {!pushConfirm ? (
            <button
              onClick={() => setPushConfirm(true)}
              style={{ flex: 1, background: color.warning.base, color: color.warning.onBase, border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Push to Sync
            </button>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: color.danger.base, fontWeight: 600 }}>This overwrites Chrome sync with local data. Other machines will pick up these changes on their next load.</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handlePush} style={{ flex: 1, background: color.danger.base, color: color.surface.raised, border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Confirm Push</button>
                <button onClick={() => setPushConfirm(false)} style={{ flex: 1, background: color.border.subtle, color: color.text.primary, border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {syncStatus && (
          <div style={{
            fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
            background: syncStatus.type === 'success' ? color.success.subtle : syncStatus.type === 'error' ? color.danger.subtle : color.accent.subtle,
            color: syncStatus.type === 'success' ? color.success.base : syncStatus.type === 'error' ? color.danger.base : color.accent.base,
          }}>
            {syncStatus.msg}
          </div>
        )}
        <SyncMeter usage={syncUsage} convCount={conversations.length} tagCount={tags.length} />
        </div>
        )}
      </div>
      </>
      )}

      {view === 'data' && (
      <>
      {/* CSV first: importing a list is the common errand. The JSON backup is
          a safety net you reach for rarely, and maintenance rarer still. */}
      <CsvImportPanel store={store} updateStore={updateStore} />

      <Card style={{ marginBottom: space.md }}>
        <Text as="h3" size="strong" weight="semibold" style={{ margin: `0 0 ${space.lg}px` }}>Full backup</Text>
        <Stack direction="row" gap="sm">
          <Button variant="primary" onClick={exportData} block>Export backup</Button>
          <Button variant="secondary" onClick={importData} block>Import backup</Button>
        </Stack>
        {dataStatus && (
          <div style={{ marginTop: space.md }}>
            <Banner tone={dataStatus.tone} live>{dataStatus.msg}</Banner>
          </div>
        )}
        <Text as="p" size="micro" tone="muted" leading="relaxed" style={{ margin: `${space.md}px 0 0` }}>
          A complete JSON copy of everything — contacts, tags, fields, saved searches and settings.
          For contacts as <strong>CSV</strong>, use the import above, or the <strong>CSV</strong> button on
          the Contacts list to export whatever the current filters are showing.
        </Text>
      </Card>

      <CaptureDiagnostics store={store} />

      <WebhookSettings store={store} updateStore={updateStore} />

      <ContactsMaintenance store={store} updateStore={updateStore} />
      </>
      )}

      {view === 'about' && <AboutPanel />}

      </div>
    </Stack>
  );
}

/**
 * The standing sending pace.
 *
 * This used to exist only inside the campaign composer, which meant there was
 * no way to say "this is how I always send" — every campaign started from the
 * shipped defaults and had to be re-typed. The composer still overrides it per
 * campaign; this is what it starts from.
 */
export function SendingPaceSettings({ store, updateStore }: { store: Store; updateStore: (s: Store) => Promise<SaveResult> }) {
  const saved = readPace(store);
  const [draft, setDraft] = useState<SendingPace>(saved);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = describePace(draft) !== describePace(saved);
  const invalid =
    draft.minDelay > draft.maxDelay ? 'Minimum delay cannot be greater than the maximum.'
    : draft.pauseMin > draft.pauseMax ? 'Minimum pause cannot be greater than the maximum.'
    : draft.batchSize < 1 ? 'Pause every must be at least 1 message.'
    : null;

  const save = async () => {
    if (invalid) return;
    await updateStore({
      ...store,
      settings: { ...(store.settings as Record<string, unknown>), [SENDING_PACE_KEY]: draft },
    });
    setStatus('Saved. New campaigns start from this pace.');
    window.setTimeout(() => setStatus(null), 3000);
  };

  const reset = () => { setDraft(DEFAULT_PACE); setStatus(null); };

  const num = (label: string, key: keyof SendingPace, step: number, min: number) => (
    <FormField label={label}>
      {(p) => (
        <Input
          {...p}
          type="number"
          min={min}
          step={step}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
          style={{ width: 96 }}
        />
      )}
    </FormField>
  );

  return (
    <Card style={{ marginBottom: space.md }}>
      <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Sending pace</Text>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.lg}px` }}>
        How quickly bulk messages go out. Facebook rate-limits the account rather than the browser,
        so this is deliberately slow and irregular. {describePace(saved)}.
      </Text>

      <Stack gap="md">
        <Stack direction="row" gap="sm" align="flex-end" wrap>
          {num('Delay from (min)', 'minDelay', 0.5, 0)}
          {num('to (min)', 'maxDelay', 0.5, 0)}
          {num('Pause every (msgs)', 'batchSize', 1, 1)}
        </Stack>
        <Stack direction="row" gap="sm" align="flex-end" wrap>
          {num('Pause from (min)', 'pauseMin', 1, 0)}
          {num('to (min)', 'pauseMax', 1, 0)}
        </Stack>

        {invalid && <Banner tone="danger" live>{invalid}</Banner>}
        {status && <Banner tone="success" live>{status}</Banner>}

        <Stack direction="row" gap="sm" align="center">
          <Button variant="primary" onClick={save} disabled={!dirty || !!invalid}>Save pace</Button>
          <Button variant="ghost" onClick={reset} disabled={describePace(draft) === describePace(DEFAULT_PACE)}>
            Reset to defaults
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

// --- About / build identity ---
//
// dist/ is gitignored, so changing source does NOT update the loaded extension —
// it keeps running the last build until something rebuilds it. That failure mode
// is invisible (the feature simply "isn't there"), so the exact build is
// surfaced here: version, the commit it was built from, and when.
//
// The .githooks post-commit and post-merge hooks now rebuild automatically, so
// these values stay current on their own. The banner below covers the remaining
// cases — hooks not installed, or a build that failed.
//
// All of that is a developer's problem, and none of it is actionable for
// someone who installed this from the Web Store: the rebuild advice, the hook
// instructions and the staleness banner are all gated on IS_UNPACKED. The
// identity rows themselves stay — "which build am I on" is the first question
// of any support conversation.
export function AboutPanel() {
  const [copied, setCopied] = useState(false);

  // "Built 3h ago" would otherwise freeze at whatever it read when the panel
  // mounted; this is the only row whose value moves on its own.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // The manifest is the version Chrome itself reports; BUILD_INFO.version is
  // what the bundle was stamped with. scripts/bump-version.js writes the new
  // version into dist/manifest.json as soon as it bumps source, so these two
  // diverge exactly when the rebuild that should have followed didn't happen
  // (or failed) — see the staleness banner below.
  let manifestVersion = '';
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* not in an extension context */ }

  const stale = !!manifestVersion && BUILD_INFO.version !== '0.0.0' && manifestVersion !== BUILD_INFO.version;
  const unknown = BUILD_INFO.commit === 'unknown';
  const summary = `v${manifestVersion || BUILD_INFO.version} · ${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+local' : ''}${BUILD_INFO.builtAt ? ` · built ${new Date(BUILD_INFO.builtAt).toLocaleString()}` : ''}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the text is on screen anyway */ }
  };

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0' }}>
      <span style={{ color: color.text.muted }}>{label}</span>
      <span style={{ fontWeight: 600, color: color.text.primary, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>About this build</h3>
        <button
          onClick={copy}
          style={{ background: 'none', border: `1px solid ${color.border.subtle}`, borderRadius: 6, padding: '4px 9px', fontSize: 11, fontWeight: 600, color: color.text.secondary, cursor: 'pointer' }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
        {row('Version', manifestVersion || BUILD_INFO.version)}
        {row('Source commit', unknown ? 'unknown' : (
          <>
            {BUILD_INFO.commit}
            {BUILD_INFO.dirty && <span style={{ color: color.warning.base }}> +uncommitted</span>}
          </>
        ))}
        {row('Commit date', BUILD_INFO.commitDate ? new Date(BUILD_INFO.commitDate).toLocaleString() : '—')}
        {row('Built', BUILD_INFO.builtAt ? `${new Date(BUILD_INFO.builtAt).toLocaleString()} (${formatRelativeTime(BUILD_INFO.builtAt)})` : '—')}
      </div>

      {stale && IS_UNPACKED && (
        <div style={{ marginTop: 10, fontSize: 12, padding: '8px 10px', borderRadius: 6, background: color.danger.subtle, color: color.danger.base, lineHeight: 1.5 }}>
          The loaded manifest says <strong>v{manifestVersion}</strong> but the bundle was built from <strong>v{BUILD_INFO.version}</strong>.
          The automatic rebuild didn't run or didn't finish — run <code>npm run build</code> and reload the extension.
        </div>
      )}

      {IS_UNPACKED ? (
        <p style={{ margin: '10px 0 0', fontSize: 11, color: color.text.muted, lineHeight: 1.6 }}>
          The version bumps on every commit to <code>main</code>, and the <code>post-commit</code> and <code>post-merge</code> hooks rebuild
          {' '}<code>packages/extension/dist/</code> for you — so these values keep themselves current. You still have to reload at
          {' '}<code>chrome://extensions</code> for a new build to take effect. While actively editing, <code>npm run watch</code> rebuilds
          on every save. If the commit above doesn't match <code>git log -1 --format=%h</code> and no banner is showing, the hooks aren't
          installed: run <code>npm install</code>.
        </p>
      ) : (
        <p style={{ margin: '10px 0 0', fontSize: 11, color: color.text.muted, lineHeight: 1.6 }}>
          Include these details if you get in touch about a problem — they identify exactly which build you're running.
        </p>
      )}
    </div>
  );
}

// --- Account / plan ---
//
// Sign-in lives in the popup (it's the quick surface); this panel is the status
// view: which account is in use, which plan it's on, and how much of the free
// contact allowance is gone. It never blocks anything on its own — the gates
// live in storage.ts — it just makes the state legible.
export function AccountPanel({ contactCount }: { contactCount: number }) {
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    setBusy(true);
    try { setEnt(await getEntitlement(force)); } catch { /* keep last */ }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cardStyle: React.CSSProperties = { background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };
  const link: React.CSSProperties = { display: 'inline-block', background: color.special.base, color: color.surface.raised, textDecoration: 'none', padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13 };

  const limit = ent?.contactsLimit ?? FREE_CONTACT_LIMIT;
  const overFree = !ent?.isPro && contactCount >= limit;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Account</h3>

      {!ent?.signedIn ? (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
            You're not signed in, so saving is turned off. Sign in with Google or email — free accounts store up to {FREE_CONTACT_LIMIT} contacts.
          </p>
          <a href={`${PLATFORM_URL}/extension-auth`} target="_blank" rel="noopener noreferrer" style={link}>Sign in / create account</a>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: color.text.secondary, lineHeight: 1.6 }}>
            <strong style={{ color: color.text.primary }}>{ent.email || 'Signed in'}</strong>
            <br />
            {ent.isPro
              ? (ent.status === 'trialing' ? 'Pro — free trial. Unlimited contacts and Drive sync.' : 'Pro — unlimited contacts and Drive sync.')
              : `Free — ${contactCount} of ${limit} contacts used.`}
            {ent.stale && <span style={{ color: color.warning.base }}>{' '}(offline — showing your last known plan)</span>}
          </p>

          {overFree && (
            <div style={{ fontSize: 12, padding: '10px 12px', borderRadius: 6, background: color.warning.subtle, color: color.warning.base, lineHeight: 1.6, marginBottom: 12 }}>
              You've filled the free plan. Everything already saved stays put — new contacts just won't be stored until you upgrade.
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <a href={`${PLATFORM_URL}/account/billing`} target="_blank" rel="noopener noreferrer" style={link}>
              {ent.isPro ? 'Manage subscription' : 'Upgrade — $20/mo'}
            </a>
            <button
              onClick={() => void load(true)}
              disabled={busy}
              style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 12, cursor: busy ? 'default' : 'pointer', padding: 0 }}
            >
              {busy ? 'Checking…' : 'Refresh plan'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Machines ---
//
// The roster behind the "Sending from" row in the queue card. Lives in Settings
// because that's where you go to name a machine or clear out one you've retired
// — the queue card only needs to answer "who's sending, and can I change it?".
export function MachinesPanel() {
  const [machines, setMachines] = useState<MachineView | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await sendBg<MachineView>({ type: 'GET_DEVICES' });
    if (res) setMachines(res);
  }, []);

  useEffect(() => { void refresh(); const i = setInterval(refresh, 10_000); return () => clearInterval(i); }, [refresh]);

  const cardStyle: React.CSSProperties = { background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };
  const self = machines?.devices.find((d) => d.id === machines.selfId);

  const saveName = async () => {
    setBusy(true);
    await sendBg({ type: 'RENAME_DEVICE', payload: { name } }, 30_000);
    setBusy(false);
    setRenaming(false);
    await refresh();
  };

  const forget = async (deviceId: string) => {
    setBusy(true);
    await sendBg({ type: 'FORGET_DEVICE', payload: { deviceId } }, 30_000);
    setBusy(false);
    await refresh();
  };

  const switchTo = async (deviceId: string) => {
    setBusy(true);
    await sendBg({ type: 'SET_SENDING_DEVICE', payload: { deviceId } }, 30_000);
    setBusy(false);
    await refresh();
  };

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Machines</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
        With Drive sync on, your send queue and message history follow you between machines. The sending itself
        doesn&apos;t: one machine drains the queue at a time, because Facebook rate-limits the account rather than the
        browser. If that machine stops running, another takes over automatically after about {Math.round(LEASE_TTL_MS / 60000)} minutes.
      </p>

      {!machines?.syncEnabled ? (
        <div style={{ fontSize: 12, color: color.text.muted, background: '#fafbfc', border: '1px solid #eef1f5', borderRadius: 8, padding: '12px 14px' }}>
          Google Drive sync is off, so this machine works on its own — its queue and history stay here.
        </div>
      ) : (
        <>
          <div style={{ border: '1px solid #e3e8ef', borderRadius: 8, overflow: 'hidden' }}>
            {machines.devices.map((d) => {
              const online = isDeviceOnline(d);
              const isSelf = d.id === machines.selfId;
              const sending = d.id === machines.senderId;
              return (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid #f0f3f7', background: sending ? '#f5f9ff' : color.surface.raised }}>
                  <OnlineDot online={online} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: color.text.primary }}>
                      {d.name}
                      {isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: color.accent.base }}>this machine</span>}
                      {sending && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: color.success.base }}>· sending</span>}
                      {machines.pinnedDeviceId === d.id && <span title="Preferred sending machine" style={{ marginLeft: 6, fontSize: 11 }}>📌</span>}
                    </div>
                    <div style={{ fontSize: 11, color: color.text.muted, marginTop: 2 }}>
                      {online ? 'Running now' : `Last seen ${formatRelativeTime(d.lastSeenAt)}`}
                      {d.platform ? ` · ${d.platform}` : ''}
                      {d.version ? ` · v${d.version}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {!sending && (
                      <button disabled={busy} onClick={() => switchTo(d.id)} style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.subtle}`, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
                        Send from here
                      </button>
                    )}
                    {!isSelf && !online && (
                      <button disabled={busy} onClick={() => forget(d.id)} title="Remove this machine from the list. It reappears if you use the extension there again." style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
                        Forget
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {machines.devices.length === 0 && (
              <div style={{ padding: '12px 14px', fontSize: 12, color: color.text.muted }}>No machines have checked in yet.</div>
            )}
          </div>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {renaming ? (
              <>
                <input
                  value={name}
                  autoFocus
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveName(); if (e.key === 'Escape') setRenaming(false); }}
                  style={{ padding: '6px 10px', border: '1px solid #dfe3e8', borderRadius: 6, fontSize: 12, minWidth: 180 }}
                />
                <button disabled={busy} onClick={saveName} style={{ background: color.accent.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                <button onClick={() => setRenaming(false)} style={{ background: 'none', border: 'none', color: color.text.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              </>
            ) : (
              <button
                onClick={() => { setName(self?.name || ''); setRenaming(true); }}
                style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.subtle}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Rename this machine
              </button>
            )}
            <span style={{ fontSize: 11, color: color.text.muted }}>
              Queue last synced {machines.lastSyncAt ? formatRelativeTime(machines.lastSyncAt) : 'never'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// --- Google Drive sync ---
//
// Connecting makes Drive this machine's canonical store (setDriveEnabled(true)),
// after seeding it with the current data. loadStore/saveStore then read/write
// Drive, with chrome.storage.local + IDB as the offline cache. Manual Push/Pull
// remain for explicit control and cross-machine seeding. Disconnect reverts the
// machine to Chrome sync (the Drive file is left intact).
export function DriveBackupPanel({ store, updateStore }: { store: Store; updateStore: (s: Store) => Promise<SaveResult> }) {
  const [driveStatus, setDriveStatus] = useState<DriveStatus | null>(null);
  const [authState, setAuthState] = useState<DriveAuthState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pro, setPro] = useState(true); // assume allowed until we know, to avoid a flash
  const [signedIn, setSignedIn] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushConfirm, setPushConfirm] = useState(false);
  // Sync cycle: when Drive last answered, whether anything is still queued, and
  // when the background worker's next reconcile is due.
  const [syncInfo, setSyncInfo] = useState<DriveSyncInfo | null>(null);
  const [nextSyncAt, setNextSyncAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const refreshSchedule = useCallback(async () => {
    try { setSyncInfo(await getDriveSyncInfo()); } catch { setSyncInfo(null); }
    try { setNextSyncAt(await getNextDriveSyncAt()); } catch { setNextSyncAt(null); }
  }, []);

  const refresh = useCallback(async () => {
    try { setDriveStatus(await getDriveStatus()); } catch { setDriveStatus(null); }
    try { setAuthState(await getDriveAuthState()); } catch { setAuthState(null); }
    try { setEnabled(await isDriveEnabled()); } catch { setEnabled(false); }
    try {
      const ent = await getEntitlement();
      setPro(ent.driveSync);
      setSignedIn(ent.signedIn);
    } catch { setPro(false); }
    await refreshSchedule();
  }, [refreshSchedule]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Tick the countdown every second, and re-read the alarm periodically so the
  // panel picks up the next window after a sync fires.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void refreshSchedule(); }, 10_000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [refreshSchedule]);

  const configured = driveStatus?.configured ?? isDriveConfigured();
  const connected = !!driveStatus?.connected;

  const handleConnect = async () => {
    setBusy(true);
    setStatus({ type: 'info', msg: 'Opening Google sign-in…' });
    try {
      const res = await connectDrive();
      if (!res.ok) { setStatus({ type: 'error', msg: res.error || 'Sign-in was cancelled or denied.' }); return; }
      // Seed the canonical Drive copy with this machine's data, then switch this
      // machine into Drive mode so loadStore/saveStore treat Drive as canonical.
      await driveWriteStore(store, true);
      await setDriveEnabled(true);
      await refresh();
      setStatus({ type: 'success', msg: 'Connected. Google Drive is now your canonical store — Chrome sync is no longer used on this machine.' });
    } catch (e) {
      setStatus({ type: 'error', msg: `Connect failed: ${String(e)}` });
    } finally { setBusy(false); }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await setDriveEnabled(false);
      await disconnectDrive();
      await refresh();
      setStatus({ type: 'info', msg: 'Disconnected. This machine is back on Chrome sync; your Drive data was left untouched.' });
    } finally { setBusy(false); }
  };

  const handlePush = async () => {
    setPushConfirm(false);
    setBusy(true);
    setStatus({ type: 'info', msg: 'Pushing to Google Drive…' });
    try {
      const meta = await driveWriteStore(store, true);
      await refresh();
      const when = meta.modifiedTime ? new Date(meta.modifiedTime).toLocaleString() : 'now';
      setStatus({ type: 'success', msg: `Pushed ${Object.keys(store.conversations).length} contacts to Drive (${when}).` });
    } catch (e) {
      setStatus({ type: 'error', msg: `Push failed: ${String(e)}` });
    } finally { setBusy(false); }
  };

  const handlePull = async () => {
    setBusy(true);
    setStatus({ type: 'info', msg: 'Pulling from Google Drive…' });
    try {
      const result = await driveReadStore(true);
      if (!result) { setStatus({ type: 'error', msg: 'No CRM data found in Drive yet — push from another machine first.' }); return; }
      await updateStore(result.store);
      await refresh();
      const convCount = Object.keys(result.store.conversations).length;
      const tagCount = Object.keys(result.store.tags).length;
      setStatus({ type: 'success', msg: `Pulled ${convCount} contacts and ${tagCount} tags from Drive.` });
    } catch (e) {
      setStatus({ type: 'error', msg: `Pull failed: ${String(e)}` });
    } finally { setBusy(false); }
  };

  const cardStyle: React.CSSProperties = { background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };
  const btn = (bg: string): React.CSSProperties => ({ flex: 1, background: bg, color: color.surface.raised, border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 });

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
        Google Drive Sync {enabled && <span style={{ fontSize: 10, fontWeight: 700, color: color.success.base, background: color.success.subtle, borderRadius: 4, padding: '2px 6px', verticalAlign: 'middle' }}>CANONICAL</span>}
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
        Sync your CRM through your own Google Drive (a hidden app-data folder) to get past Chrome sync's ~500-contact limit.
        {enabled
          ? ' This machine now reads and writes Drive as the source of truth; the local copy is an offline cache.'
          : ' Connecting makes Drive this machine\'s canonical store in place of Chrome sync.'}
      </p>

      {!pro ? (
        // Drive sync is the paid half of the product. Anything already in Drive
        // stays there — this just stops the machine from using it until the plan
        // is active again.
        <div style={{ fontSize: 12, padding: '12px 14px', borderRadius: 8, background: color.special.subtle, color: '#4a3f8f', lineHeight: 1.6 }}>
          <strong>Part of the paid plan ($20/mo, 7-day free trial).</strong>
          <div style={{ margin: '6px 0 10px' }}>
            Drive sync and unlimited contacts come with Pro. Everything you've already saved stays exactly where it is.
          </div>
          <a
            href={`${PLATFORM_URL}/account/billing`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', background: color.special.base, color: color.surface.raised, textDecoration: 'none', padding: '8px 14px', borderRadius: 6, fontWeight: 600 }}
          >
            {signedIn ? 'Start free trial' : 'Sign in or start free trial'}
          </a>
        </div>
      ) : !configured ? (
        // Two different audiences for the same state. A developer needs the
        // Cloud Console recipe; a customer needs to know it isn't their fault
        // and that nothing they can do in this panel will fix it.
        IS_UNPACKED ? (
          <div style={{ fontSize: 12, padding: '10px 12px', borderRadius: 6, background: color.warning.subtle, color: color.warning.base, lineHeight: 1.6 }}>
            <strong>Setup needed.</strong> A Google OAuth client id hasn't been added to the extension yet. In the Google Cloud Console:
            create a project → enable the <strong>Google Drive API</strong> → create an <strong>OAuth client ID</strong> of type
            <strong>“Web application”</strong> → add the redirect URI below to its Authorized redirect URIs → paste the client id
            into <code>manifest.json</code> under <code>oauth2.client_id</code>, then rebuild.
          </div>
        ) : (
          <div style={{ fontSize: 12, padding: '10px 12px', borderRadius: 6, background: color.warning.subtle, color: color.warning.base, lineHeight: 1.6 }}>
            <strong>Drive sync isn't available in this build.</strong> Your data is safe and still syncing through Chrome.
            Updating the extension should restore it — get in touch if it doesn't.
          </div>
        )
      ) : (
        <>
          {/* Which OAuth client this browser ends up on is a Cloud Console
              detail: it only means something to whoever can edit that project,
              and the redirect URI it prints is deployment plumbing. */}
          {IS_UNPACKED && (
            <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 12, lineHeight: 1.6, background: color.surface.sunken, borderRadius: 6, padding: '8px 10px' }}>
              Two OAuth clients are used, from the same Cloud project. Chrome uses the <strong>“Chrome Extension”</strong>
              client in <code>manifest.json</code> (its Item ID must be this extension's id). Edge falls back to a
              <strong> “Web application”</strong> client, which must list this exact URI — trailing slash included — under
              its <strong>Authorized redirect URIs</strong>:
              <br />
              <code style={{ wordBreak: 'break-all', color: color.text.primary }}>{getAuthRedirectUri() || '(unavailable)'}</code>
            </div>
          )}

          {/* Which flow this machine ended up on. This is the difference between
              renewing silently in the background forever and needing a fresh
              Google session every hour, so it's worth showing rather than
              leaving the user to infer it from mystery disconnections. */}
          {authState && (
            <div style={{
              fontSize: 11, marginBottom: 12, lineHeight: 1.6, borderRadius: 6, padding: '8px 10px',
              background: authState.silentRenewal ? '#f2f9f4' : color.warning.subtle,
              color: authState.silentRenewal ? '#2e6b45' : color.warning.base,
            }}>
              {authState.silentRenewal ? (
                <>
                  <strong>Renews itself.</strong> Chrome holds the Google authorisation for this extension and
                  re-issues it on demand, so nothing expires and nothing opens a window — including overnight while
                  a campaign is running.
                </>
              ) : authState.brokerCapable ? (
                <>
                  <strong>Hourly re-authorisation.</strong> Chrome couldn't hand out the token itself, which almost
                  always means this browser profile isn't signed into Chrome. Access is instead renewed about once
                  an hour against your Google session in a tab. Sign into Chrome and press Reconnect to switch to
                  the version that never expires.
                </>
              ) : (
                <>
                  <strong>Hourly re-authorisation.</strong> This browser can't have Chrome broker the token
                  (Edge wires that API to Microsoft accounts), so access is renewed about once an hour against
                  your Google session. That renewal is now much more reliable — it knows which account to use and
                  gives up rather than hanging — and if it ever fails, campaign sending pauses rather than risking
                  duplicate messages.
                </>
              )}
              {!!authState.email && <div style={{ marginTop: 4, color: color.text.muted }}>Account: {authState.email}</div>}
            </div>
          )}

          <div style={{ fontSize: 12, marginBottom: connected && enabled ? 8 : 12, color: connected ? color.success.base : color.text.muted }}>
            {connected ? '● Connected to Google Drive' : '○ Not connected'}
            {connected && driveStatus?.file?.modifiedTime && (
              <span style={{ color: color.text.muted }}>{' '}· last backup {new Date(driveStatus.file.modifiedTime).toLocaleString()}</span>
            )}
          </div>

          {!connected && enabled && (
            <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: color.danger.subtle, color: color.danger.base, lineHeight: 1.6 }}>
              <strong>Sync is on but this machine isn't authorised.</strong> Campaign sending is held here until
              it is, so nobody gets messaged twice.
              {!!authState?.lastError && (
                <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-word' }}>{authState.lastError}</div>
              )}
            </div>
          )}

          {/* Sync cycle. Saves upload as they happen; this periodic pass is what
              pulls down edits made on another machine, so it's the number that
              answers "when will this machine see the other one's changes?". */}
          {connected && enabled && (
            <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 10px', background: color.surface.sunken, borderRadius: 6, lineHeight: 1.7, color: color.text.secondary }}>
              <div>
                <strong>Next sync</strong>{' '}
                {nextSyncAt ? (
                  <>
                    in {formatCountdown(nextSyncAt - now)}{' '}
                    <span style={{ color: color.text.muted }}>({new Date(nextSyncAt).toLocaleTimeString()})</span>
                  </>
                ) : (
                  <span style={{ color: color.text.muted }}>scheduling… (the background worker sets it on wake)</span>
                )}
              </div>
              <div style={{ color: color.text.muted }}>
                Last sync {syncInfo?.lastSyncAt ? `${new Date(syncInfo.lastSyncAt).toLocaleTimeString()} (${formatRelativeTime(syncInfo.lastSyncAt)})` : '—'}
                {' · '}every {DRIVE_SYNC_PERIOD_MINUTES} min
                {syncInfo?.pendingUpload && (
                  <span style={{ color: color.warning.base, fontWeight: 600 }}>{' · '}changes waiting to upload</span>
                )}
              </div>
            </div>
          )}

          {!connected ? (
            <button onClick={handleConnect} disabled={busy} style={btn(color.accent.base)}>
              {enabled ? 'Reconnect Google Drive' : 'Connect Google Drive'}
            </button>
          ) : (
            <>
              {/* Reconnecting while already connected is not a no-op: only a fresh
                  consent issues a refresh token, and it re-probes the code flow
                  against whatever OAuth client is in the manifest now. This is the
                  button you press after swapping the client id in the Console. */}
              {/* Only worth offering where reconnecting could actually change the
                  outcome — i.e. Chrome, where signing into the profile promotes
                  this machine off the hourly flow. On Edge it would just re-run
                  the same flow to the same result. */}
              {authState && !authState.silentRenewal && authState.brokerCapable && (
                <button onClick={handleConnect} disabled={busy} style={{ ...btn(color.accent.base), marginBottom: 10 }}>
                  Reconnect
                </button>
              )}
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                <button onClick={handlePull} disabled={busy} style={btn(color.accent.base)}>Pull from Drive</button>
                {!pushConfirm ? (
                  <button onClick={() => setPushConfirm(true)} disabled={busy} style={btn(color.warning.base)}>Push to Drive</button>
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 11, color: color.danger.base, fontWeight: 600 }}>Overwrites the Drive copy with this machine's data.</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={handlePush} disabled={busy} style={{ flex: 1, background: color.danger.base, color: color.surface.raised, border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Confirm Push</button>
                      <button onClick={() => setPushConfirm(false)} style={{ flex: 1, background: color.border.subtle, color: color.text.primary, border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
              <button onClick={handleDisconnect} disabled={busy} style={{ background: 'none', border: 'none', color: color.danger.base, fontSize: 12, cursor: 'pointer', padding: 0 }}>Disconnect</button>
            </>
          )}
        </>
      )}

      {status && (
        <div style={{
          marginTop: 12, fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
          background: status.type === 'success' ? color.success.subtle : status.type === 'error' ? color.danger.subtle : color.accent.subtle,
          color: status.type === 'success' ? color.success.base : status.type === 'error' ? color.danger.base : color.accent.base,
        }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

// --- CSV contact import (with preview + machine-local import history) ---
export interface CsvImportPanelProps {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
}

// --- Contacts maintenance: clean names + find/merge duplicates ---
export function ContactsMaintenance({ store, updateStore }: { store: Store; updateStore: (s: Store) => Promise<SaveResult> }) {
  const [status, setStatus] = useState<{ type: 'success' | 'info'; msg: string } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Suggestions the user has looked at and rejected. Without this, two people
  // who genuinely share a name are re-offered on every single scan, and the
  // only way to stop being asked is to merge two unrelated contacts.
  //
  // Per-machine (localStorage), like the failed-send dismissals: it records a
  // judgement about a suggestion, not a change to the data, so nothing is lost
  // if another machine hasn't heard about it.
  const [ignored, setIgnored] = useLocalPref<string[]>('ignoredDuplicates', []);
  const [showIgnored, setShowIgnored] = useState(false);
  const ignoredSet = useMemo(() => new Set(ignored), [ignored]);

  const cardStyle: React.CSSProperties = { background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };

  const cleanNames = async () => {
    setBusy(true);
    try {
      const { store: next, changed, examples } = cleanStoredNames(store);
      if (changed === 0) { setStatus({ type: 'info', msg: 'No names needed cleaning.' }); return; }
      await updateStore(next);
      const sample = examples.map((e) => `“${e.from}” → “${e.to}”`).join(', ');
      console.info(`[CRM][names] Cleaned ${changed} name(s)`);
      setStatus({ type: 'success', msg: `Cleaned ${changed} name${changed !== 1 ? 's' : ''}. ${sample}${changed > examples.length ? '…' : ''}` });
    } finally { setBusy(false); }
  };

  const scan = () => {
    const found = findDuplicateGroups(store.conversations);
    // Drop dismissals whose pair no longer exists — merged, deleted, or renamed
    // apart. A scan sees the whole store, so anything it didn't return can't
    // come back under the same key, and keeping it would let this list grow for
    // the life of the install.
    const live = new Set(found.map(duplicateGroupKey));
    setIgnored((prev) => {
      const kept = prev.filter((k) => live.has(k));
      return kept.length === prev.length ? prev : kept;
    });
    setGroups(found);
    setShowIgnored(false);
    setStatus(null);
  };

  const mergeGroup = async (g: DuplicateGroup) => {
    const { store: next, removed, mergedInto } = mergeConversations(store, g.ids);
    await updateStore(next);
    console.info(`[CRM][merge] Merged ${removed + 1} contacts into ${mergedInto}`);
    setGroups((gs) => (gs ? gs.filter((x) => x !== g) : gs));
    setStatus({ type: 'success', msg: `Merged ${removed + 1} contacts into “${next.conversations[mergedInto]?.participantName || mergedInto}”.` });
  };

  // The suggestion stays on screen under "ignored" rather than disappearing —
  // one misplaced click shouldn't silently hide a real duplicate with no way
  // back to it.
  const ignoreGroup = (g: DuplicateGroup) => {
    const key = duplicateGroupKey(g);
    setIgnored((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setStatus({ type: 'info', msg: 'Suggestion ignored. It stays hidden on this machine until you restore it.' });
  };

  const restoreGroup = (g: DuplicateGroup) => {
    const key = duplicateGroupKey(g);
    setIgnored((prev) => prev.filter((k) => k !== key));
    setStatus(null);
  };

  // Split rather than filtered, so the ignored ones stay reachable and the
  // count of what's left can't drift from what's rendered.
  const active = groups?.filter((g) => !ignoredSet.has(duplicateGroupKey(g))) ?? [];
  const hidden = groups?.filter((g) => ignoredSet.has(duplicateGroupKey(g))) ?? [];

  const identityCount = active.filter((g) => g.reason === 'identity').length;
  const nameCount = active.filter((g) => g.reason === 'name').length;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Contacts maintenance</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
        <strong>Clean up names</strong> re-tidies stored names (strips "Conversation with", trailing "· 3h", etc.).
        <strong> Find duplicates</strong> groups contacts that share an identity (profile/id/username/thread) or just a name, so you can merge them.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={cleanNames} disabled={busy} style={{ background: color.accent.base, color: color.surface.raised, border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer' }}>
          Clean up names
        </button>
        <button onClick={scan} disabled={busy} style={{ background: color.special.base, color: color.surface.raised, border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer' }}>
          Find duplicates
        </button>
      </div>

      {status && (
        <div style={{
          marginTop: 12, fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
          background: status.type === 'success' ? color.success.subtle : color.accent.subtle, color: status.type === 'success' ? color.success.base : color.accent.base,
        }}>
          {status.msg}
        </div>
      )}

      {groups && (
        <div style={{ marginTop: 14 }}>
          {active.length === 0 ? (
            <div style={{ fontSize: 13, color: color.success.base, background: color.success.subtle, padding: '10px 12px', borderRadius: 7 }}>
              ✓ No duplicates found{hidden.length > 0 ? ` (${hidden.length} ignored)` : ''}.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: color.text.secondary, marginBottom: 8 }}>
                {identityCount} identity match{identityCount !== 1 ? 'es' : ''} · {nameCount} same-name group{nameCount !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {active.map((g) => (
                  <DuplicateGroupRow
                    key={duplicateGroupKey(g)}
                    group={g}
                    store={store}
                    onMerge={() => mergeGroup(g)}
                    onIgnore={() => ignoreGroup(g)}
                  />
                ))}
              </div>
            </>
          )}

          {hidden.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => setShowIgnored((v) => !v)}
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: color.accent.base, cursor: 'pointer' }}
              >
                {showIgnored ? 'Hide' : 'Show'} {hidden.length} ignored suggestion{hidden.length !== 1 ? 's' : ''}
              </button>
              {showIgnored && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, opacity: 0.72 }}>
                  {hidden.map((g) => (
                    <DuplicateGroupRow
                      key={duplicateGroupKey(g)}
                      group={g}
                      store={store}
                      onMerge={() => mergeGroup(g)}
                      onRestore={() => restoreGroup(g)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DuplicateGroupRow({ group, store, onMerge, onIgnore, onRestore }: { group: DuplicateGroup; store: Store; onMerge: () => void; onIgnore?: () => void; onRestore?: () => void }) {
  const convs = group.ids.map((id) => store.conversations[id]).filter(Boolean) as Conversation[];
  if (convs.length < 2) return null;
  const primary = pickPrimary(convs);
  const strong = group.reason === 'identity';
  return (
    <div style={{ background: color.surface.sunken, borderRadius: 8, padding: '10px 12px', border: `1px solid ${strong ? '#e6d8f5' : color.border.subtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: strong ? '#7b3fb8' : color.warning.base }}>
            {strong ? 'Same identity' : 'Same name'}
          </span>
          <div style={{ fontSize: 13, marginTop: 2 }}>
            {convs.map((c) => (
              <span key={c.id} style={{ marginRight: 8 }}>
                {c.id === primary.id ? '★ ' : ''}{c.participantName || 'Unknown'}
                <span style={{ color: color.text.muted, fontSize: 11 }}> ({c.tags.length}🏷{c.chatUrl ? ' · ✉' : ''})</span>
              </span>
            ))}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* "Not duplicates" rather than "Ignore": the button states the
              judgement being recorded, not the effect on the list. */}
          {onIgnore && (
            <button
              onClick={onIgnore}
              title="These are different people — stop suggesting this merge"
              style={{ background: 'none', color: color.text.secondary, border: `1px solid ${color.border.subtle}`, padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Not duplicates
            </button>
          )}
          {onRestore && (
            <button
              onClick={onRestore}
              title="Start suggesting this merge again"
              style={{ background: 'none', color: color.accent.base, border: `1px solid ${color.border.subtle}`, padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Restore
            </button>
          )}
          <button onClick={onMerge} style={{ background: color.special.base, color: color.surface.raised, border: 'none', padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Merge {convs.length}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 10, color: color.text.muted, marginTop: 4 }}>★ survivor keeps the best thread id; tags are combined.</div>
    </div>
  );
}

export function CsvImportPanel({ store, updateStore }: CsvImportPanelProps) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [applyTags, setApplyTags] = useState<string[]>([]);
  const [importFileTags, setImportFileTags] = useState(true);
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllIssues, setShowAllIssues] = useState(false);

  const refreshHistory = useCallback(async () => {
    setHistory(await loadImportHistory());
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const reset = () => { setFile(null); setHeaders([]); setMapping({}); setApplyTags([]); setImportFileTags(true); setShowAllIssues(false); };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = String(ev.target?.result || '');
          const hdrs = csvHeaders(text);
          setStatus(null);
          setShowAllIssues(false);
          setHeaders(hdrs);
          setMapping(detectMapping(hdrs));   // auto-map matching headers
          setApplyTags([]);
          setImportFileTags(true);
          setFile({ name: f.name, text });
        } catch (err) {
          setStatus({ type: 'error', msg: `Could not read CSV: ${String(err)}` });
        }
      };
      reader.readAsText(f);
    };
    input.click();
  };

  // Recompute the parse + dry-run preview whenever the file, mapping or tag
  // options change. Cheap and pure, so it's fine to derive on every render.
  const preview = useMemo(() => {
    if (!file) return null;
    const parse = parseContactsCsv(file.text, { mapping, applyTags, importFileTags });
    if (parse.missingRequired.length > 0) return { parse, blocked: true as const };
    const dry = applyContacts(store, parse.contacts);
    const messageable = parse.contacts.filter((c) => resolveThread(c)).length;
    return { parse, blocked: false as const, willAdd: dry.added, willUpdate: dry.updated, newTags: dry.tagsCreated, messageable };
  }, [file, mapping, applyTags, importFileTags, store]);

  const confirmImport = async () => {
    if (!file || !preview || preview.blocked) return;
    const blocked = await ensureSignedIn('import contacts');
    if (blocked) { setStatus({ type: 'error', msg: blocked }); return; }
    setBusy(true);
    try {
      // Re-parse against the live store at confirm time.
      const parse = parseContactsCsv(file.text, { mapping, applyTags, importFileTags });
      const { contacts, errors, warnings, totalDataRows } = parse;
      const result = applyContacts(store, contacts);
      const save = await updateStore(result.store);
      // Refused outright — the session expired between the click-time check and
      // the write. Bail before recording history for an import that didn't
      // happen, and leave the mapping in place so retrying after signing in is
      // one click.
      if (save.signedOut) {
        setStatus({ type: 'error', msg: save.reason || 'Nothing was imported — sign in to your account first.' });
        return;
      }
      const entry = await recordImport({
        fileName: file.name,
        totalRows: totalDataRows,
        added: result.added,
        updated: result.updated,
        errors: errors.length,
        warnings: warnings.length,
        tagsCreated: result.tagsCreated,
        errorSamples: errors,
      });
      console.info(`[CRM][import] "${file.name}": +${result.added} added, ${result.updated} updated, ${errors.length} errors, ${result.tagsCreated.length} tags created${applyTags.length ? `, applied ${applyTags.length} tag(s) to all` : ''}${save.ok ? '' : `, ${save.pending} shard(s) not synced`}`);
      setHistory((h) => [entry, ...h].slice(0, 50));
      const applied = `${result.added} added, ${result.updated} updated${errors.length ? `, ${errors.length} skipped` : ''}`;
      if (save.ok) {
        setStatus({ type: 'success', msg: `Imported "${file.name}": ${applied}.` });
      } else if (save.itemLimitReached) {
        // The contacts/tags are safely stored on this device, but Chrome sync's
        // ~500-item ceiling stopped them syncing — this is exactly what Google
        // Drive mode fixes. Surface it instead of falsely reporting success.
        setStatus({ type: 'error', msg: `Imported "${file.name}" on this device (${applied}), but Chrome sync is full — ${save.pending} record(s) couldn't sync (the ~500-item limit). Connect Google Drive in Settings to store and sync more than ~500 contacts.` });
      } else {
        setStatus({ type: 'error', msg: `Imported "${file.name}" on this device (${applied}), but ${save.pending} record(s) couldn't sync to Chrome (${save.reason || 'write rejected'}). They'll retry on your next change.` });
      }
      reset();
    } catch (err) {
      setStatus({ type: 'error', msg: `Import failed: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const downloadSample = () => downloadText('contacts-template.csv', 'text/csv', sampleCsv());

  const cardStyle: React.CSSProperties = { background: color.surface.raised, borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };
  const p = preview?.parse;
  const issues = p ? [...p.errors.map((e) => ({ ...e, kind: 'error' as const })), ...p.warnings.map((w) => ({ ...w, kind: 'warning' as const }))] : [];
  const shownIssues = showAllIssues ? issues : issues.slice(0, 6);
  const total = preview && !preview.blocked ? preview.willAdd + preview.willUpdate : 0;

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Contacts — CSV import</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted, lineHeight: 1.5 }}>
          Required: a <strong>name</strong> (Full Name, or First + Last) and <strong>at least one</strong> of
          <strong> Facebook Profile URL</strong>, <strong>FB User ID</strong>, or <strong>FB Username</strong>. Matching headers are
          auto-mapped — adjust the mapping below if your column names differ. Each identity is resolved to a Messenger thread id so
          imports are <strong>messageable</strong>. Rows merge with existing contacts on any matching identity.
        </p>

        {!file && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={pickFile} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              Choose CSV file…
            </button>
            <button onClick={downloadSample} style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.subtle}`, padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              Download template
            </button>
          </div>
        )}

        {file && p && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <span style={{ color: color.accent.base }}>{file.name}</span>
                <span style={{ color: color.text.muted, fontWeight: 500 }}> · {p.totalDataRows} row{p.totalDataRows !== 1 ? 's' : ''}</span>
              </div>
              <button onClick={reset} disabled={busy} style={{ background: 'none', border: 'none', color: color.text.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>Choose a different file</button>
            </div>

            {/* Field mapping */}
            <FieldMapper headers={headers} mapping={mapping} onChange={setMapping} />

            {/* Tag controls */}
            <ImportTagControls
              existingTags={Object.values(store.tags)}
              applyTags={applyTags}
              onApplyTags={setApplyTags}
              hasTagsColumn={mapping.tags != null}
              importFileTags={importFileTags}
              onImportFileTags={setImportFileTags}
            />

            {/* Blocked: required fields not mapped */}
            {preview.blocked ? (
              <div style={{ background: color.danger.subtle, color: color.danger.base, borderRadius: 7, padding: '12px 14px', fontSize: 13, lineHeight: 1.5, marginTop: 12 }}>
                Map the required field{p.missingRequired.length !== 1 ? 's' : ''} above to continue:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {p.missingRequired.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </div>
            ) : (
              <div style={{ background: '#f7f9fc', border: '1px solid #e6ecf5', borderRadius: 8, padding: '12px 14px', marginTop: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, marginBottom: 10 }}>
                  <Stat label="Add" value={preview.willAdd} valueColor="#0a7c4a" />
                  <Stat label="Update" value={preview.willUpdate} valueColor="#065fd4" />
                  <Stat label="Messageable" value={preview.messageable} valueColor="#0a7c4a" />
                  <Stat label="Skipped (errors)" value={p.errors.length} valueColor={p.errors.length ? color.danger.base : color.text.muted} />
                  <Stat label="Warnings" value={p.warnings.length} valueColor={p.warnings.length ? color.warning.base : color.text.muted} />
                  <Stat label="New tags" value={preview.newTags.length} valueColor={color.special.base} />
                </div>
                {preview.messageable < total && (
                  <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 8, lineHeight: 1.5 }}>
                    {total - preview.messageable} contact(s) couldn't be resolved to a Messenger thread. Vanity-username contacts become fully messageable once you open their profile in Facebook (the numeric thread id is captured automatically).
                  </div>
                )}
                {preview.newTags.length > 0 && (
                  <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 8 }}>
                    Will create tags: {preview.newTags.map((t) => <span key={t} style={{ background: color.border.subtle, borderRadius: 8, padding: '1px 7px', marginRight: 4 }}>{t}</span>)}
                  </div>
                )}

                {issues.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: color.text.muted, marginBottom: 4 }}>Issues</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflowY: 'auto' }}>
                      {shownIssues.map((it, i) => (
                        <div key={i} style={{ fontSize: 11, color: it.kind === 'error' ? color.danger.base : color.warning.base }}>
                          {it.kind === 'error' ? '⛔' : '⚠️'} Row {it.rowNumber}: {it.reason}
                        </div>
                      ))}
                    </div>
                    {issues.length > shownIssues.length && (
                      <button onClick={() => setShowAllIssues(true)} style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '4px 0 0', textDecoration: 'underline' }}>
                        Show all {issues.length} issues
                      </button>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    onClick={confirmImport}
                    disabled={busy || total === 0}
                    style={{ background: busy || total === 0 ? '#9ec7b3' : color.success.base, color: color.surface.raised, border: 'none', padding: '9px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy || total === 0 ? 'not-allowed' : 'pointer' }}
                  >
                    {busy ? 'Importing…' : `Import ${total} contact${total !== 1 ? 's' : ''}`}
                  </button>
                  <button onClick={reset} disabled={busy} style={{ background: color.surface.raised, color: color.text.secondary, border: `1px solid ${color.border.control}`, padding: '9px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {status && (
          <div style={{
            marginTop: 12, fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
            background: status.type === 'success' ? color.success.subtle : status.type === 'error' ? color.danger.subtle : color.accent.subtle,
            color: status.type === 'success' ? color.success.base : status.type === 'error' ? color.danger.base : color.accent.base,
          }}>
            {status.msg}
          </div>
        )}
      </div>

      {/* Import history */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Import history</h3>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: color.text.muted }}>No CSV imports yet. (History is stored on this machine.)</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((h) => <ImportHistoryRow key={h.id} entry={h} />)}
          </div>
        )}
      </div>
    </>
  );
}

export function FieldMapper({ headers, mapping, onChange }: { headers: string[]; mapping: Mapping; onChange: (m: Mapping) => void }) {
  const set = (field: Field, idx: number) => {
    const next: Mapping = { ...mapping };
    if (idx < 0) delete next[field]; else next[field] = idx;
    onChange(next);
  };
  const hasName = mapping.fullName != null || mapping.firstName != null || mapping.lastName != null;
  const hasIdentity = mapping.profileUrl != null || mapping.fbUserId != null || mapping.fbUsername != null;
  const selStyle: React.CSSProperties = { padding: '6px 8px', border: `1px solid ${color.border.control}`, borderRadius: 6, fontSize: 12, background: color.surface.raised, width: '100%', boxSizing: 'border-box' };
  return (
    <div style={{ border: `1px solid ${color.border.subtle}`, borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: color.text.secondary }}>Map fields</span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: hasName ? color.success.base : color.danger.base, fontWeight: 600 }}>{hasName ? '✓' : '•'} Name</span>
          <span style={{ color: color.border.control, margin: '0 6px' }}>|</span>
          <span style={{ color: hasIdentity ? color.success.base : color.danger.base, fontWeight: 600 }}>{hasIdentity ? '✓' : '•'} Identity</span>
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {MAPPABLE_FIELDS.map(({ field, label, group }) => (
          <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, color: color.text.secondary, fontWeight: 600 }}>
              {label}{group !== 'other' && <span style={{ color: color.text.muted, fontWeight: 500 }}> · {group}</span>}
            </span>
            <select value={mapping[field] ?? -1} onChange={(e) => set(field, Number(e.target.value))} style={selStyle}>
              <option value={-1}>— Not mapped —</option>
              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ImportTagControls({ existingTags, applyTags, onApplyTags, hasTagsColumn, importFileTags, onImportFileTags }: {
  existingTags: Tag[];
  applyTags: string[];
  onApplyTags: (v: string[]) => void;
  hasTagsColumn: boolean;
  importFileTags: boolean;
  onImportFileTags: (v: boolean) => void;
}) {
  const [input, setInput] = useState('');
  const has = (name: string) => applyTags.some((v) => v.toLowerCase() === name.toLowerCase());
  const toggle = (name: string) => onApplyTags(has(name) ? applyTags.filter((v) => v.toLowerCase() !== name.toLowerCase()) : [...applyTags, name]);
  const addCustom = () => { const n = input.trim(); if (n && !has(n)) onApplyTags([...applyTags, n]); setInput(''); };
  const existingNames = new Set(existingTags.map((t) => t.name.toLowerCase()));
  const customSelected = applyTags.filter((t) => !existingNames.has(t.toLowerCase()));
  return (
    <div style={{ border: `1px solid ${color.border.subtle}`, borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: color.text.secondary }}>Tags</span>
      <div style={{ fontSize: 11, color: color.text.muted, margin: '4px 0 8px' }}>Apply tags to <strong>every</strong> imported contact (created if new):</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {existingTags.map((t) => {
          const on = has(t.name);
          return (
            <button key={t.id} onClick={() => toggle(t.name)} style={{ padding: '4px 10px', borderRadius: 12, border: on ? 'none' : `1px solid ${t.color}`, background: on ? t.color : t.color + '22', color: on ? color.surface.raised : t.color, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {on ? '✓ ' : '+ '}{t.name}
            </button>
          );
        })}
        {existingTags.length === 0 && <span style={{ fontSize: 11, color: color.text.muted }}>No tags yet — type one below.</span>}
      </div>
      {customSelected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {customSelected.map((t) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 12, background: color.special.base, color: color.surface.raised, fontSize: 12, fontWeight: 600 }}>
              {t} <span style={{ fontSize: 10, opacity: 0.85 }}>new</span>
              <span onClick={() => toggle(t)} style={{ cursor: 'pointer', marginLeft: 2 }}>×</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCustom(); } }}
          placeholder="Add a tag for all contacts…"
          style={{ flex: 1, padding: '7px 10px', border: `1px solid ${color.border.subtle}`, borderRadius: 6, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
        />
        <button onClick={addCustom} style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.subtle}`, padding: '7px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Add</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: hasTagsColumn ? color.text.secondary : color.text.muted, cursor: hasTagsColumn ? 'pointer' : 'default' }}>
        <input type="checkbox" checked={hasTagsColumn && importFileTags} disabled={!hasTagsColumn} onChange={(e) => onImportFileTags(e.target.checked)} style={{ cursor: hasTagsColumn ? 'pointer' : 'default' }} />
        Also import tags from the file's Tags column{!hasTagsColumn && ' (no Tags column mapped)'}
      </label>
    </div>
  );
}

// `valueColor` rather than `color`, which would shadow the token module inside
// this function.
export function Stat({ label, value, valueColor }: { label: string; value: number; valueColor: string }) {
  return (
    <span style={{ background: color.surface.raised, border: '1px solid #e6ecf5', borderRadius: 7, padding: '5px 10px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <strong style={{ color: valueColor, fontSize: 14 }}>{value}</strong>
      <span style={{ color: color.text.muted }}>{label}</span>
    </span>
  );
}

export function ImportHistoryRow({ entry }: { entry: ImportHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const hasErrors = entry.errorSamples.length > 0;
  return (
    <div style={{ background: color.surface.sunken, borderRadius: 8, padding: '10px 12px' }}>
      <div onClick={() => hasErrors && setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasErrors ? 'pointer' : 'default' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.fileName}</div>
          <div style={{ fontSize: 11, color: color.text.muted, marginTop: 2 }}>{formatDateTime(entry.importedAt)} · {entry.totalRows} row{entry.totalRows !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
          <span style={{ color: color.success.base, fontWeight: 600 }}>+{entry.added}</span>
          <span style={{ color: color.accent.base, fontWeight: 600 }}>↻{entry.updated}</span>
          {entry.errors > 0 && <span style={{ color: color.danger.base, fontWeight: 600 }}>⛔{entry.errors}</span>}
          {entry.tagsCreated.length > 0 && <span style={{ color: color.special.base, fontWeight: 600 }}>🏷{entry.tagsCreated.length}</span>}
          {hasErrors && <span style={{ fontSize: 11, color: color.accent.base }}>{open ? 'hide' : 'details'}</span>}
        </div>
      </div>
      {open && hasErrors && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${color.border.subtle}`, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {entry.errorSamples.map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: color.danger.base }}>Row {e.rowNumber}: {e.reason}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SyncMeter({ usage, convCount, tagCount }: { usage: SyncUsage | null; convCount: number; tagCount: number }) {
  const summary = `${convCount} conversations, ${tagCount} tags`;

  if (!usage || !usage.available) {
    return (
      <div style={{ marginTop: 16, fontSize: 12, color: color.text.muted }}>
        {summary} · chrome.storage.sync unavailable (using local backup)
      </div>
    );
  }

  const bytePct = Math.min(100, (usage.bytesInUse / usage.quotaBytes) * 100);
  const itemPct = Math.min(100, (usage.itemCount / usage.maxItems) * 100);
  const pct = Math.max(bytePct, itemPct); // whichever limit is closer
  const near = pct >= 80;
  const barColor = pct >= 90 ? '#e74c3c' : pct >= 80 ? '#f39c12' : '#2ecc71';

  return (
    <div style={{ marginTop: 16, padding: '12px 14px', background: '#f7f8fa', borderRadius: 8, border: `1px solid ${color.border.subtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary }}>☁️ Cloud sync storage</span>
        <span style={{ fontSize: 12, color: color.text.muted }}>
          {formatBytes(usage.bytesInUse)} / {formatBytes(usage.quotaBytes)} ({pct.toFixed(0)}%)
        </span>
      </div>
      <div style={{ height: 8, background: '#e6e8eb', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s, background 0.3s' }} />
      </div>
      <div style={{ marginTop: 7, fontSize: 11, color: color.text.muted, display: 'flex', justifyContent: 'space-between' }}>
        <span>{summary} · {usage.itemCount}/{usage.maxItems} items</span>
        <span>synced across your devices</span>
      </div>
      {near && (
        <div style={{ marginTop: 8, fontSize: 11, color: color.warning.base, background: color.warning.subtle, padding: '6px 8px', borderRadius: 6 }}>
          ⚠️ Approaching the chrome.storage.sync limit. New changes still save to your local backup, but may stop syncing to other devices once full. Consider exporting/archiving older contacts.
        </div>
      )}
    </div>
  );
}


/**
 * Settings → Data → Capture diagnostics.
 *
 * The bulk counterpart to the ⌗ button on a single contact: copy every
 * diagnostic currently held, for sending in as one bug report.
 *
 * Sits low in Data, under a plain heading, and says out loud that these expire.
 * A user who never has a wrong name should be able to read this once, conclude
 * it isn't for them, and never think about it again.
 */
export function CaptureDiagnostics({ store }: { store: Store }) {
  const [copied, setCopied] = useState(false);

  const withDiag = Object.values(store.conversations).filter((c) => c.nameDiag);

  const copyAll = async () => {
    const blob = withDiag
      // Newest first: the mistake someone just noticed is the one they want.
      .sort((a, b) => (b.nameDiag?.at || 0) - (a.nameDiag?.at || 0))
      .map((c) => ({
        currentName: c.participantName,
        contactId: c.id,
        source: c.source || 'messenger',
        nameManual: !!c.nameManual,
        capturedAt: new Date(c.nameDiag!.at).toISOString(),
        diag: c.nameDiag,
      }));
    try {
      await navigator.clipboard.writeText(JSON.stringify({ contacts: blob }, null, 2));
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card style={{ marginBottom: space.md }}>
      <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Capture diagnostics</Text>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.md}px` }}>
        When a contact first enters the CRM, the extension records which of its name readers produced
        the name and what the alternatives were. If someone comes in under the <strong>wrong</strong> name,
        copying this and sending it in is what makes the cause fixable rather than guessable.
        Each record is deleted automatically after {Math.round(DIAG_TTL_MS / (24 * 60 * 60 * 1000))} days,
        so there is nothing to clean up.
      </Text>

      <Stack direction="row" gap="sm" align="center" wrap>
        <Button variant="secondary" size="sm" onClick={copyAll} disabled={withDiag.length === 0}>
          {copied ? 'Copied ✓' : `Copy ${withDiag.length} diagnostic${withDiag.length === 1 ? '' : 's'}`}
        </Button>
        <Text size="micro" tone="muted">
          {withDiag.length === 0
            ? 'Nothing recorded right now — every contact captured recently has already expired, or none have been added.'
            : 'For one contact only, use the small ⌗ next to their name in the contact detail.'}
        </Text>
      </Stack>
    </Card>
  );
}
