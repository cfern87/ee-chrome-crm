# Team workspaces — design note

Status: built in the extension (branch `team-members`). The server half is the
Supabase migration in [TEAM_WORKSPACES_LOVABLE.md](TEAM_WORKSPACES_LOVABLE.md);
until it is applied, the Team card in Settings says the server side isn't set
up yet and nothing else changes.

## What it does

- One **root account** (the Pro subscriber) creates a team workspace and
  invites people by email. Billing stays on the root: members need a free
  platform account, not a subscription.
- Every invited user gets a **workspace switcher** in the dashboard top bar
  (and in the popup): *Personal* — their own contacts, exactly as today — or
  any team they belong to.
- Everyone in a team reads and writes the **same contacts**, tags, groups,
  custom fields, saved searches, notes and contact history.
- Non-Pro users without a team see an upgrade card instead of the team tools.

## Where the shared data lives — options considered

| Option | Verdict |
| --- | --- |
| Drive `appDataFolder` (today's personal store) | **Impossible.** It is private to one Google account; it cannot be shared. |
| Regular Drive file shared with members (`drive.file` scope) | **Rejected.** With `drive.file` a member's copy of the extension can only open files *it* created or that the member picked through the Google Picker, which needs remote script an MV3 extension can't load. The full `drive` scope is a restricted scope (security assessment). Drive also has no compare-and-swap, so concurrent team writes would clobber each other, and members would need a Google account even though the product's identity is the platform account. |
| **Supabase (the platform's existing backend)** | **Chosen.** The extension already signs every user into it (license.ts) and already uses tables + RPCs there for incoming webhooks, with the same "server not set up yet" fallback. It gives real identity (invite by the platform email), server-side membership checks, a server-side Pro check on the *owner* (billing stays on root) and — the key thing for smooth sync — an atomic **versioned write** (compare-and-swap), which Drive cannot do. |

## Data model (server)

- `crm_teams` — one per root account (v1), with a seat limit.
- `crm_team_members` — `(team, email)` rows, `invited` → `active` when the
  invited person signs in with that email and accepts.
- `crm_team_stores` — the team's store as one JSON document plus a `version`.

All access goes through `security definer` RPCs; RLS is on with no direct
table policies. Writes check (a) the caller is an active member and (b) the
team owner is on Pro (`crm_team_owner_is_pro`, implemented against the
platform's billing table). A lapsed owner makes the workspace read-only for
everyone; nothing is deleted.

## Sync (extension)

The personal workspace is untouched: same Drive / chrome.storage.sync paths,
same keys. A team workspace gets its **own local cache key** and its own sync
loop, so personal and team data never mix on disk.

1. **Saves are local and instant.** `saveStore` in a team workspace writes the
   team's local cache, marks it dirty and bumps the store revision — the same
   contract every caller already relies on. Content scripts never talk to the
   server.
2. **The background worker syncs** (a debounced push after each save, and a
   pull every minute): read the server document (`get` with the last known
   version returns nothing when unchanged, so polling is cheap), merge, and
   write back with `put(expected_version)`. If another member wrote first the
   put is refused; the worker re-reads, re-merges and retries.
3. **Three-way merge** (`teamMerge.ts`). The worker keeps the last document it
   agreed with the server on (the *base*). For a contact both sides changed it
   merges **field by field** against that base: tags are merged as
   additions/removals (A tags someone "Hot" while B tags them "Called" → both
   tags), tasks merge per task, and any field only one side touched keeps that
   side's value. Only when two people change the *same field* of the same
   contact does the later sync win. Settings use the existing
   `mergeSettingsWithBase`; tags/groups/fields/searches use their revisions;
   deletes travel as tombstones; history is a union. Without a base (first
   sync) it falls back to the existing `mergeStores`.
4. **Edits during a sync are not lost.** After the server round-trip the worker
   re-reads the local cache; if something was saved meanwhile it merges that
   in too and leaves the workspace dirty for the next push.

## Switching

The active workspace is one key in `chrome.storage.local`. Switching bumps the
store revision, so every open dashboard, popup and Messenger panel reloads from
the new workspace. A store loaded in one workspace carries a stamp, and
`saveStore` refuses to write it into another — so a Messenger tab that loaded
Personal can't save its copy into the team just because you switched in the
dashboard meanwhile.

## What stays per person (deliberately)

- **Campaigns, the send queue and the sender lease.** Messages go out from
  each member's own Facebook account, which Facebook rate-limits per account;
  sharing a queue between people would be wrong, not just hard.
- **Drive sync** stays a personal-workspace feature (Settings shows a note in
  a team workspace).
- **Scheduled automations** stored in a team run on ONE member's sending
  machine, so five members don't run the same automation five times. Each
  automation has a "Runs on" choice (`Automation.runOn`, an email): the owner's
  computer by default, or a member's. A member's new automation defaults to
  their own computer. That member's Messenger is what an unread scan reads and
  their Facebook account is what any message goes out from. "Run now" always
  runs on the computer where it was clicked. The daily report stays owner-only.
- **Outgoing webhooks** stored in a team are shared like the contacts. They
  fire from the machine that made the change, as today; pulling a teammate's
  edits does not re-fire them, so each change is reported once.

## Moving data between workspaces (`workspaceTransfer.ts`)

- **Creating a team** offers three starts:
  - *Move my whole Personal workspace*: contacts, tags, fields, saved
    searches, notes, history, automations and webhooks become the team's.
    Personal is emptied (contacts tombstoned, automations/webhooks given
    collection tombstones so another machine can't revive and run them), but
    only after the server confirms the team's copy. If the upload fails,
    Personal is left untouched and the user is told.
  - *Copy my contacts, tags and fields*: as before; the settings bag stays
    personal.
  - *Start empty*.
- **Deleting a team** offers to merge it into Personal or another team the
  owner can write to (or discard it). The team is synced first, merged into the
  target, and deleted only once the merge is saved, so any failure leaves both
  intact. The merge (`foldWorkspaceInto`) is additive: the source's deletions
  are ignored, a contact the target once deleted comes back, the newer copy of
  a shared contact wins, automations and webhooks are unioned.
- **Backups** can be merged into the open workspace (same additive merge) or
  replace it. In a team, replacing deletes teammates' data, so it needs a
  second click.

## Stale whole-store saves

The dashboard and popup save whole stores. A copy loaded *before* a
teammate's edit was pulled would otherwise look like a deliberate local change
(and a teammate's new contact, missing from the old copy, like a delete). The
sync records when each contact last arrived from the server (this machine's
clock only), `loadStore` stamps when a copy was read, and a team save keeps
the pulled version of anything the caller's copy predates unless the caller
edited that contact after it arrived (`guardStaleWrite`).

## Limits / follow-ups

- One document per team: fine to several thousand contacts (each push uploads
  the whole store, as Drive does today). A per-contact table would scale
  further and is the natural next step if teams grow large.
- Roles are owner / member (members can edit everything). Read-only seats would
  be a small server + UI addition.
- No realtime push; teammates' edits appear within about a minute.
- A campaign keeps sending while you switch workspaces; its "last contacted"
  stamps land on the matching contact in whichever workspace is open.
- Scheduled automations only run for the workspace that is open in the
  switcher on that computer. A member whose team automation "runs on" them
  must have the team open for it to fire; the same goes for Personal
  automations while a team is open.
- Not verified against a live Supabase yet: the server half has to be applied
  first (see the Lovable doc's acceptance checks).
- The invite email itself is not sent by the extension — the invitee sees the
  invite in Settings → Account & plan once they sign in with that address.
  The platform can add an email notification later.
