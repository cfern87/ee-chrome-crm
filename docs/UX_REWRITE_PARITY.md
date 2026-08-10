# UX rewrite — feature parity checklist

The contract for the UX rewrite. Every item below exists in the app **today**. The rewrite changes how these look and where they live; it must not remove what they do.

How to use it: after each phase, walk the affected sections in the rebuilt extension and tick them. An item is only ticked when the affordance was actually exercised, not merely spotted on screen.

Legend — **`M`** moved to a new location by the rewrite (verify it still works *and* that it is findable). **`R`** deliberately removed; see the note.

---

## 1. Dashboard — global

- [ ] Sign-in gate replaces the entire dashboard when signed out; no contact data or settings visible
- [ ] Gate's "Sign in or create an account" opens the platform auth page in a new tab
- [ ] Gate's re-check button picks up a session signed in from another tab
- [ ] Session expiring while the tab sits open drops back to the gate (15s poll + storage event)
- [ ] Loading state until store + sign-in check resolve
- [ ] Header contact/tag counts `M` → top bar
- [ ] Failed-send notice appears on open for failures that happened while closed `M` → notifications drawer
- [ ] Failed-send notice: "Review in History", per-row clear (✕), "Clear all" dismiss, "Show N more" expand
- [ ] Failed-send notice calls out `unavailable` recipients separately (retry won't help)
- [ ] Store changes from another surface (panel, other machine) refresh the view live
- [ ] Optimistic write, then confirmation through the background worker; direct save fallback when the worker is unreachable

## 2. Contacts (was "Conversations")

### Filtering and search
- [ ] Quick search box matches participant name and last message
- [ ] Archive scope: Active only / Archived only / Active + archived
- [ ] Date filter: Any time / Last 24h / Last 7 days / Last 30 days
- [ ] Tag filter chips, including "All Tags"; click again to clear
- [ ] Advanced boolean query builder `M` → popover
- [ ] Advanced query composes with quick search + tag chip + date + archive scope
- [ ] Query summary line when the builder is collapsed
- [ ] "Clear" resets the query and detaches the active preset
- [ ] Pinned saved-search chips row; apply and clear
- [ ] Save new preset, update active preset when dirty, rename, pin/unpin, delete, reorder up/down
- [ ] Applying a preset restores query **and** sortBy, sortDir, archiveScope
- [ ] Match count vs total shown in the builder

### Sorting and paging
- [ ] Sort by: Recent activity, Last contacted, Last opened, Date added, Last tagged, Number of tags, Name
- [ ] Sort direction toggle; shows A→Z / Z→A for name, ↑/↓ otherwise
- [ ] Page size 25 / 50 / 100 / 250 / All
- [ ] Pager with first/last + window around current, elision, Prev/Next
- [ ] Any filter or sort change resets to page 1
- [ ] Page clamps when the list shrinks under it (e.g. after bulk delete)
- [ ] Range readout: "1–50 of 320" / "N contacts"

### Selection and bulk actions
- [ ] Per-row checkbox, independent of opening the detail pane
- [ ] "Select this page" header checkbox with indeterminate state
- [ ] "Select all N" across every page matching the filters
- [ ] Selection count plus "N on other pages" callout
- [ ] Clear selection
- [ ] Open All (opens each selected chat URL in a new tab, stamps lastOpenedAt)
- [ ] Message (N) — hands the selection to the composer as preselected recipients `M` → Campaigns
- [ ] Assign Tag — picker of every tag, applies to the whole selection
- [ ] Remove Tag — same, removes
- [ ] Merge (N) when ≥2 selected — unions tags, keeps best identity/thread id, selects the survivor
- [ ] Delete with inline confirm naming the count
- [ ] Export CSV of the current filtered view (re-importable, includes custom field columns)
- [ ] Export re-checks sign-in at click time

### Contact list rows
- [ ] Name, relative last-activity time, last message preview
- [ ] Tag chips, with `hideInSidebar` tags omitted from the preview row
- [ ] Selected row highlighted distinctly from bulk-checked row
- [ ] Empty states differ: no contacts at all vs no results for this filter

### Contact detail pane
- [ ] Rename contact inline (✎), Enter saves, Escape cancels; "custom" badge once `nameManual`
- [ ] Last activity / last contacted / last opened line
- [ ] Close (×)
- [ ] Open Chat ↗ (stamps lastOpenedAt), Open Profile ↗
- [ ] Archive / Unarchive
- [ ] Delete with **two-step** confirm ("Delete X?" → "Are you absolutely sure?")
- [ ] Last message block
- [ ] Tags grouped by tag group, in the Tags tab's group order; group headings hidden when everything is ungrouped
- [ ] Hidden tags **do** appear here, striped
- [ ] Remove tag (×) per chip
- [ ] "+ Add tag" picker, grouped identically, excludes already-applied tags
- [ ] Custom fields — text / number / date / dropdown, each committing on change
- [ ] Email mailto link
- [ ] Profile URL always editable inline; invalid URL reports inline; saving re-derives `chatUrl` and sets `resolvedThreadId` when the thread changes
- [ ] Clearing the profile URL leaves the existing chat URL intact
- [ ] FB user id, FB username, contact id, "Source: CSV import", chat URL, added date

## 3. Campaigns (Messaging + History merged) `M`

### Compose
- [ ] Template textarea with `{{name}}` / `{{firstName}}` substitution
- [ ] Live preview rendered against the first selected recipient, named
- [ ] Sending pace: min/max delay between messages, pause every N messages, pause length min/max `M` → defaults in Settings, per-campaign override stays here
- [ ] Pace summary line when collapsed
- [ ] Recipient picker: search, tag filter chips, "Toggle all shown"
- [ ] Recipients with no chat URL are disabled and marked "no URL"
- [ ] Recipients already queued elsewhere marked "queued", with a warning naming up to 3
- [ ] Up to 2 preview tag chips per recipient row, hidden tags excluded
- [ ] Preselected recipients arrive from the Contacts bulk bar and are consumed once
- [ ] "N recipients ready · M skipped (no chat URL)" readout
- [ ] Dry run checkbox — types into the composer without sending; button and styling change to match
- [ ] Start button label adapts: Start campaign / Add to queue / Queue dry run, with recipient count
- [ ] "Joins the existing queue" notice when campaigns are already in flight
- [ ] Inline error surface for a refused start

### Active queue
- [ ] Queue card: depth, next-up campaign, countdown to next send
- [ ] Queue mode: `interleave` vs `sequential`
- [ ] Pause all / Resume sending
- [ ] Per-campaign Pause / Resume / Cancel
- [ ] "Sending from" — which machine holds the lease, expand to switch to another
- [ ] Offline machines are still selectable, with a warning that the queue waits then moves on
- [ ] Sync-hold banner with the three reasons (announce-failed, lease-unverifiable, drive-unreachable); not user-overridable
- [ ] Queue reconciles every 15s while a queue-facing view is open

### Past sends
- [ ] Campaign cards newest first, expandable
- [ ] Status badge + dry-run chip
- [ ] Summary counts (sent / failed / pending)
- [ ] Copy template
- [ ] Pause / Resume / Cancel on a still-active campaign from here too
- [ ] Recipient rows: status, error text, expandable log
- [ ] Per-recipient: view profile (jumps to the contact in Contacts), edit profile URL inline, open Messenger chat, requeue, remove from queue with confirm
- [ ] Empty state when no campaigns exist

## 4. Tags & Fields `M`

### Tags
- [ ] Create tag: name, group, color, Add (Enter submits)
- [ ] Create tag group: name, color, Add (Enter submits)
- [ ] Tag row: recolor, rename on blur/Enter (Escape reverts), usage count
- [ ] "Hide in previews" toggle per tag, with striped row treatment
- [ ] Move tag between groups via select
- [ ] Delete tag — removes it from every contact
- [ ] Rename group inline; group tag count
- [ ] Delete group — its tags survive, ungrouped, and the change is stamped so it survives a sync merge
- [ ] Ungrouped section, labelled only when groups exist
- [ ] Empty state

### Fields
- [ ] Create field: name, type (Text / Number / Date / Dropdown), Add
- [ ] Dropdown options textarea, one per line or comma-separated; Dropdown with no options is refused
- [ ] "Show in the CRM panel on Messenger" at creation and as a per-field toggle
- [ ] Field row: type badge, "In panel" badge, options list, "set on N contacts"
- [ ] Delete field — also clears its value from every contact
- [ ] Empty state

## 5. Settings `M` (regrouped)

### Account & plan
- [ ] Signed-out: explanation + sign-in link
- [ ] Signed-in: email, plan (Pro / Pro trial / Free N of M used), stale/offline note
- [ ] Free-plan-full warning: existing data stays, new contacts won't save
- [ ] Upgrade — $20/mo / Manage subscription
- [ ] Refresh plan (forces an entitlement re-fetch)

### Sync & devices
- [ ] Google Drive sync: connect, disconnect, Pull from Drive, Push to Drive with confirm
- [ ] CANONICAL badge when Drive is the source of truth
- [ ] Pro gate with trial CTA when the plan doesn't include Drive sync
- [ ] "Setup needed" guidance when no OAuth client id is configured, incl. the redirect URI to register
- [ ] Auth mode explainer: silent renewal vs hourly re-authorisation, broker-capable vs not; account email
- [ ] Connected/not-connected state, last backup time
- [ ] "Sync is on but this machine isn't authorised" warning incl. last error
- [ ] Next-sync countdown and pending-write indicator
- [ ] Machines roster: online dot, this-machine and sending markers, pinned marker, last seen, platform, version
- [ ] Send from here / Forget (offline, non-self only) / Rename this machine
- [ ] "Queue last synced" stamp
- [ ] Off-state copy when Drive sync is disabled
- [ ] Chrome Sync (legacy, collapsed): Pull from Sync, Push to Sync with confirm, status message, quota meter

### Data
- [ ] CSV import: pick file, download sample, choose a different file
- [ ] Header→field mapping with auto-detection and "— Not mapped —"
- [ ] Row issue summary, expandable to the full list
- [ ] Apply tags to all imported contacts: existing tag chips, free-text add, remove
- [ ] "Use the tags column from the file" toggle, disabled when the file has no tags column
- [ ] Confirm import / Cancel
- [ ] Import history entries
- [ ] JSON backup: Export Data / Import Data (full store)
- [ ] Import/export re-check sign-in at click time
- [ ] Contacts maintenance: Clean up names, Scan for duplicates, per-group Merge

### Behavior
- [ ] Auto-capture conversations you open (default off)
- [ ] Auto-tagging (default off)
- [ ] Notifications (default on)
- [ ] Auto-capture explainer text
- [ ] Sending-pace defaults `M` from the campaign composer

### About
- [ ] Version, commit, build time, "built Nh ago" ticking live
- [ ] Copy build info
- [ ] Stale-build warning when the loaded build is behind source

## 6. In-page Messenger panel

- [ ] Floating launcher button, bottom-right
- [ ] Panel opens docked bottom-right, or **anchored** beside a sidebar row when opened from that row's "+"
- [ ] Anchored position clamps to the viewport
- [ ] Close (✕)
- [ ] Signed-out panel: explanation + sign-in button; re-renders into the real panel when the session lands
- [ ] Profile page, not in CRM: name guess + "Add to CRM", with "⏳ Reading name…" while the name resolves
- [ ] No thread detected: "Select from sidebar" pick mode
- [ ] Auto-capture off / previously removed: "Save this contact" / "Add back to CRM"
- [ ] Contact unreachable: explicit error rather than an empty panel
- [ ] Loaded contact: name + inline edit, last-contacted line
- [ ] "Select different conversation" pick mode (hidden on profile pages)
- [ ] Pick mode banner with Cancel
- [ ] Custom fields marked "show in panel", in dashboard order, with draft/focus preserved across re-renders
- [ ] Tags on this conversation, with remove (✕)
- [ ] Add existing tag chips
- [ ] Create new tag: name + color + Add; focus and caret preserved across re-render
- [ ] Hidden tags render striped, with an explanatory title
- [ ] Remove from CRM with a confirm that names the consequence
- [ ] Sidebar tag chips injected onto Messenger conversation rows, hidden tags excluded
- [ ] Per-row "+" add-tag button

## 7. Popup

- [ ] Sign-in gate: Continue with Google, email + password, create-account link, error surface, "data stays on this machine" reassurance
- [ ] Open Full Dashboard
- [ ] Account: email, plan, Upgrade to Pro, Sign Out
- [ ] Sync / queue / failure status summary *(new — replaces the duplicated panels below)*
- [ ] Quick contact search that jumps to a chat
- [ ] `R` Conversations list with tag filters — **removed**; lives in the dashboard
- [ ] `R` Tags create/list/delete — **removed**; lives in Tags & Fields
- [ ] `R` Auto-tagging / Notifications toggles — **removed**; live in Settings → Behavior
- [ ] `R` Export / Import Data — **removed**; live in Settings → Data

> The four `R` items are the only intentional reductions in the rewrite, approved up front. Each capability still exists in the dashboard — this deletes a second, weaker copy, not a feature.

---

## Cross-cutting behavior that must survive

- [ ] Writes serialize through the background worker (never straight from the dashboard) so content scripts can't be clobbered
- [ ] `updatedAt` stamping on tags, groups and field defs — this is what carries edits between machines
- [ ] Hidden tags filter, sort and search exactly like any other tag; only *preview* rows omit them
- [ ] Free-plan and signed-out refusals surface a reason rather than failing silently
- [ ] Campaign sending holds rather than risking duplicates when Drive is unreachable
