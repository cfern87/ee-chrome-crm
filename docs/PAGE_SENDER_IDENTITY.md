# Sending as a Facebook Page — findings and design

Status 2026-10-28: identity detection and the "Only send as a Page" guard are
implemented (`packages/extension/src/senderIdentity.ts`). The personal-profile
baseline was measured live. **Nothing has been measured while acting as a Page
yet**; see "Still to verify".

## 1. Detecting which identity is active

Measured live on www.facebook.com and /messages/t/ (Chrome "Browser 2", personal profile):

| Signal | Personal profile (measured) | Acting as a Page (expected, unverified) |
|---|---|---|
| cookie `c_user` | 56503077 (the person) | unchanged, still the person |
| cookie `i_user` | absent | the Page's profile id |
| `CurrentUserInitialData.USER_ID` | 56503077 | the Page's id |
| `CurrentUserInitialData.ACCOUNT_ID` | 56503077 | the person's id |

- `CurrentUserInitialData` is in the page's inline scripts on both the feed and
  Messenger pages (3 agreeing copies on /messages/t/).
- The account menu lists two Pages this login can switch into: *The ManKind
  Project* and *ManKind Project USA* (new Pages experience, profile switching).
- The cookie follows the latest switch in **any** tab. The page data is what
  **this** tab loaded as. A tab loaded before a switch keeps its old identity,
  so the detector returns `unknown` whenever the two disagree.
- `business.facebook.com` (Meta Business Suite inbox) and messenger.com are not
  covered: the content script doesn't run on business.facebook.com, and
  messenger.com doesn't support Pages.

Rules in `detectSenderIdentity`: no `c_user` → unknown; page data missing →
unknown; page data ≠ cookie actor → unknown ("reload first"); `i_user` ≠
`c_user` and page data agrees → page; otherwise personal.

## 2. The guard (implemented)

- Settings → Behavior → **Send as**: a required choice, "Only send as personal
  profile" (the default) or "Only send as a Page". With Page, an optional "Only
  this Page id". Plus a read-only "Check who Facebook is acting as" button.
  Stored in synced settings (`senderMode`, `requiredPageId`; the earlier
  `requirePageSender: true` still reads as Page).
- Personal-profile mode refuses a detected Page, or any cookie/page-data
  mismatch with the logged-in person. Missing page data alone is allowed when
  the cookies say personal, so a layout change can't halt existing campaigns.
- The check runs in `typeSendAndConfirm` (content.ts), shared by the thread
  and drawer send paths, **before anything is typed**. Campaigns, automations
  (they queue campaigns) and the send queue all go through it.
- A refusal is `failureKind: 'wrong-sender'`: no profile recovery, the
  recipient goes back to pending, **all running campaigns pause**, and a
  `message.failed` webhook goes out with `reason: 'wrong-sender'`, `skipped: true`.
- Every send log now has a `sender:` line, and each campaign recipient stores
  `sentAs` (kind, actor id, name) for the identity that sent it.

## 3. Can automated DMs go out from a Page? Meta's rules

- A Page **cannot start** a conversation. It can message someone only within
  **24 hours** of that person's last message to the Page (Click-to-Messenger
  ads can open up to 7 days).
- **HUMAN_AGENT** allows 7 days, but for **manual** human replies only. An
  automated send is not a human reply.
- Outside the window, the only routes are approved message tags, one-time
  notifications the person asked for, one private reply within 7 days of a
  comment, or sponsored messages.
- Consequence: contacts captured on the personal profile are person-to-person
  threads. As a Page, those thread ids are not the Page's conversations, so
  existing campaign lists won't work from a Page. A Page campaign only makes
  sense for people who messaged that Page in the last 24 hours. Treat this as
  a hard limit; a "messaged the Page within 24h" check per recipient is
  recommended before Page sends are enabled for real.

Sources: [Messenger Platform policy overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview),
[Send API reference](https://developers.facebook.com/docs/messenger-platform/reference/send-api),
[Private replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies).

## 4. Other features from a Page context (expected, unverified)

- Adding contacts / tagging: works only if the Page's inbox renders at
  facebook.com/messages like the personal one. Contacts should record which
  identity added them (follow-up: a `addedAs` field on Conversation).
- Read-state scan and unread automations: they read whichever inbox the tab is
  in. Run as the wrong identity, they tag from the wrong inbox. Follow-up: run
  the same sender check before scans.
- History and webhooks: unaffected, but entries don't yet say which identity
  acted (only campaign recipients carry `sentAs`).

## Still to verify (live, as a Page)

1. Switch into a Page; confirm `i_user` and `USER_ID` = Page id. If USER_ID
   stays the person, change `detectSenderIdentity` to rely on the cookie.
2. Whether facebook.com/messages shows the Page's inbox or redirects to
   Business Suite.
3. With the guard on and the tab on the personal profile, run a dry-run
   campaign and confirm it is refused and the queue pauses.
