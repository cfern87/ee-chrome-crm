# Team workspaces — UX review (2026-11-03)

Covers switching, screen refreshes, storage and sync, plus what was fixed in
1.3.110 and what is still open. Design background: [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md).

## The bugs reported, and their causes

| What was seen | Cause | Status |
| --- | --- | --- |
| A contact meant for the team was saved to Personal | When the team server briefly answered "team workspaces aren't set up" (it does this for a moment while its database is being updated — e.g. right after applying a Lovable migration), the extension took it as final: it **silently switched to Personal** and **deleted this computer's copy of the team**, unsynced edits included. Every Messenger save after that went to Personal. | Fixed: the answer must persist 30 minutes before teams are dropped; a forced switch now shows a notice (dashboard + Messenger panel); a team copy with unsynced edits is never deleted. |
| After switching to the team and back, the contact stayed in the contacts list | The dashboard re-applies its own recent edits on top of every fresh read for 30 s (covers slow Drive reads). Those edits weren't tied to a workspace, so they were painted into the *other* workspace after a switch — and the next whole-store save from the dashboard wrote them there for real. | Fixed: recent edits are dropped on a workspace change; the open contact, selection, bulk state and composer draft are cleared too. |
| A teammate tagged the contact, but the Personal copy didn't get the tag | Personal and each team are **separate** sets of contacts. The contact had ended up in both (see row 1), and each copy is edited on its own. This is by design, but nothing on screen said which workspace you were in. | Explained on screen: the Messenger panel now shows a workspace strip — which workspace is open (with a switcher), where new contacts go, and "Also in Personal / Team X" when the same person exists elsewhere. |
| A contact added to Personal didn't appear in the team | Same as above — separate workspaces. | As above. |
| A contact added to the team showed as "Unknown" on the Personal side | Personal didn't have that person, so the panel offered to save a new contact, and its name guess fell back to the placeholder "Unknown". | The strip now says the contact is "Also in <team>", with a one-click switch. |
| The member wasn't on a paid plan, the owner was | Not a cause on its own: a team runs on its owner's plan. A free member's *Personal* workspace still has the free contact limit; the team doesn't. | Covered: saving into a read-only team (owner's plan lapsed) now says so in the panel instead of "Couldn't load this contact". |

## Added in 1.3.110

- **Who did what.** In a team workspace every contact-history event records the
  member who made it ("· by sam@acme.com" in the details pane). History now also
  logs custom-field changes, hand renames, archive/unarchive, and follow-ups
  added/completed — previously only tags, messages and automation runs were
  logged. Everyone on the team needs 1.3.110+; an older build shows a tag event
  from a newer one as "deleted tag".
- **Where new contacts go.** Messenger panel → workspace strip → "New contacts
  to": the open workspace (default), Personal, or any team you can write to.
  Only *new* contacts are redirected; edits to someone already in the open
  workspace stay there. The panel then says "Saved to X" with "Switch to X" and
  "Also save in this workspace". Per browser.
- **Accepting an invite opens the team** straight away (useful for a new member
  whose Personal workspace is empty).
- **Banner text** no longer breaks into columns (affected every banner with bold
  words in it, most visibly the team-workspace notice).

## Edge cases checked

| Case | Behaviour now |
| --- | --- |
| Switch in the dashboard while a Messenger tab is open | The tab re-renders from the new workspace (store revision bump); drafts and armed buttons reset; the strip shows the new workspace. |
| Switch from the Messenger panel | Same switch the dashboard uses (pulls the team first). |
| A save that started before a switch lands after it | Refused ("You switched workspace since this was loaded"), never written into the wrong workspace. |
| Server mid-migration / brief outage | Teams kept; a sync error shows on the Team card; nothing switches. |
| Removed from a team | Moved to Personal with a notice naming the team; unsynced edits kept on this computer. |
| Owner's plan lapses | Team read-only for everyone; saves refused with that reason; nothing deleted. |
| Free member, Personal full | Team saves unaffected; Personal saves refused with the plan-limit notice. |
| Same person in Personal and a team | Two separate records; the strip says where else they are. |
| Two dashboard tabs | Both follow the switch via the storage listener. |
| facebook.com and messenger.com tabs | Share the extension's storage, so both see the same workspace. |

## Still open (not built)

1. **Moving a contact between workspaces** (rather than having two copies).
   A "Move to <workspace>" action in the details pane and panel would fold one
   copy into the other and delete the source. Medium-sized; uses
   `foldWorkspaceInto` per contact.
2. **Scheduled automations only run for the open workspace** on each computer
   (known limit). Fixing it means running each workspace's schedule against its
   own store in the background — doable now that `loadStoreIn`/`saveStoreIn`
   exist.
3. **Campaign stamps** ("last contacted", history) land on the matching contact
   in whichever workspace is open when the message is sent, not the one the
   campaign was started in. Campaigns now record their workspace, so this can
   be pointed at the right one.
4. **Signing in as a different account on the same browser** keeps the same
   Personal store (that's true without teams too). Worth a guard.
5. **A removed member's unsynced edits** are kept locally but can't upload. An
   "export / copy to Personal" offer in the removal notice would rescue them.

## Handing off a team (changing the owner)

**Storage does not move.** A team's data lives on the server keyed by the
team's id, not the owner's account, so a hand-off changes who *owns* (and
pays for) the team, never where its contacts are. Members keep working through
it with no re-sync.

What does change: the owner is who the server checks for Pro, who can
invite/remove/delete, and whose computer runs team automations that don't
name a "Runs on" member.

### Options

| | How it works | Upside | Downside |
| --- | --- | --- | --- |
| **A. Offer → accept (recommended)** | Owner picks an active member → "Offer ownership". The member sees it on their Team card → "Accept". The server checks the *new* owner is on Pro **at accept time**; if not, accept fails with "Upgrade to Pro to take over this team" and an Upgrade button. On accept: roles swap, old owner stays as a member (can leave). | Nobody gets a team (and its bill) without agreeing; the Pro check happens exactly when it matters. | Two steps. |
| B. Instant transfer | Owner picks a member; done. | One step. | Hands someone a team they didn't ask for, possibly unpaid → read-only for everyone immediately. |
| C. Claim when lapsed | If the owner's plan has lapsed for N days, any Pro member can claim the team. | Rescues teams whose owner left. | Needs a grace period and abuse rules; best as an addition to A, later. |

### What A needs

- **Server (Lovable)**: a `pending_owner_email` column on `crm_teams`, and
  three functions — `crm_offer_ownership(team, email)` (owner only; email must
  be an active member), `crm_accept_ownership(team)` (caller must be the
  pending email **and** `crm_team_owner_is_pro(caller)`; swaps `owner_id` and
  both members' roles in one transaction; respects the 10-teams-per-owner cap),
  and `crm_cancel_ownership_offer(team)`. `crm_my_workspaces` returns
  `pending_owner_email` so both sides can show the offer.
- **Extension**: "Offer ownership" on the owner's member rows; an offer card
  for the recipient (Accept / Decline, with the Upgrade link when they aren't
  Pro); after a hand-off, a note that automations without "Runs on" now run on
  the new owner's computer.
- About a day's work, plus applying and checking the server half.
