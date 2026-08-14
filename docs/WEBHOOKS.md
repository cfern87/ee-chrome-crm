# Not Another Social CRM — Webhooks

This document is the contract for receiving webhooks from the Not Another Social
CRM browser extension. Hand it to whoever is building the receiving endpoint.

The extension has **no backend**. It runs entirely in the user's browser and
syncs through their own Google Drive. Webhooks are the only outbound channel it
has, and everything below follows from that.

---

## 1. Setup (what the user does)

In the extension: **Dashboard → Settings → Data → Webhooks**.

1. Paste an endpoint URL and press **Add**.
2. Chrome asks for permission to reach that host. **This must be granted** —
   without it every delivery fails silently from the endpoint's point of view,
   because the request never leaves the browser.
3. Tick the events to receive. **A new webhook is subscribed to nothing** and
   sends nothing until at least one event is ticked.
4. Press **Send test** to POST a real payload with `"test": true` in it.

URLs must be `https`. Plain `http` is rejected except for `localhost` /
`127.0.0.1`, so a receiver can be developed locally.

---

## 2. The request

```
POST <your URL>
Content-Type: application/json
X-CRM-Event: contact.tag_added
X-CRM-Delivery: evt_m1a2b3c4_x9y8z7
X-CRM-Token: <the token from Settings, if one was set>
```

| Header | Meaning |
| --- | --- |
| `X-CRM-Event` | The event name. Same value as `event` in the body. |
| `X-CRM-Delivery` | Unique per delivery attempt. Use it to dedupe. |
| `X-CRM-Token` | Only present if the user set a token. **See the security note below — this is not authentication.** |

### Envelope

Every payload has the same outer shape:

```json
{
  "id": "evt_m1a2b3c4_x9y8z7",
  "event": "contact.tag_added",
  "sentAt": 1755100800000,
  "version": 1,
  "source": "not-another-social-crm",
  "webhook": "Lovable site",
  "data": { }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique per delivery attempt. |
| `event` | string | One of the events in §3. |
| `sentAt` | number | Epoch **milliseconds**, from the user's machine — treat it as approximate and don't trust it for ordering across machines. |
| `version` | number | Currently `1`. Only bumped for a breaking envelope change. |
| `source` | string | Always `"not-another-social-crm"`. |
| `webhook` | string | The webhook's name from Settings, when set. Omitted otherwise. Lets one endpoint serve several webhooks. |
| `data` | object | Event-specific — see §3. |

### Response

Any `2xx` counts as accepted. Anything else is recorded as a failure and shown
to the user in Settings. **The body of the response is never read**, so return
an empty `200` and do the work asynchronously — see §5 on timeouts.

---

## 3. Events

### The `contact` object

Every contact event carries the same summary:

```json
{
  "id": "6123456789",
  "name": "Jane Doe",
  "chatUrl": "https://www.facebook.com/messages/t/6123456789/",
  "profileUrl": "https://www.facebook.com/jane.doe",
  "tags": ["Warm Lead", "Houston"],
  "archived": false
}
```

- `id` is the CRM's own key for the contact. Stable, and safe to use as your
  foreign key. It is usually the Messenger thread id, but treat it as opaque.
- `tags` are **names, not ids** — an id means nothing outside the user's store.
- `chatUrl` and `profileUrl` are omitted when not known.

### Contact events

| Event | Fires when | Extra `data` fields |
| --- | --- | --- |
| `contact.created` | Someone new enters the CRM (captured in Messenger, added from a profile, or CSV-imported). | — |
| `contact.deleted` | A contact is removed. `contact` is the last known state. | — |
| `contact.renamed` | The name changes. | `previousName`, `name` |
| `contact.tag_added` | A tag is applied. | `tag` (name) |
| `contact.tag_removed` | A tag is removed. | `tag` (name) |
| `contact.archived` | A contact is archived. | — |
| `contact.unarchived` | An archived contact comes back. | — |

**One event per tag.** A preset action that applies three tags fires three
`contact.tag_added` deliveries, not one with an array. Each carries the contact
state *after* the whole change, so the `tags` array on all three is identical.

```json
{
  "event": "contact.tag_added",
  "data": {
    "contact": { "id": "6123456789", "name": "Jane Doe", "tags": ["Warm Lead", "Houston"], "archived": false },
    "tag": "Warm Lead"
  }
}
```

### Campaign events

A *campaign* is one bulk send to a set of recipients.

| Event | `data` |
| --- | --- |
| `campaign.started` | `campaign: { id, name, dryRun, skipIfUnread }`, `recipientCount` |
| `campaign.completed` | `campaign: { … }`, `total`, `sent`, `failed` |

Recipients are **not** included — a campaign can have hundreds, and the
per-message events below carry them one at a time.

### Message events

| Event | `data` |
| --- | --- |
| `message.sent` | `campaign`, `contact: { id, name, chatUrl }`, `message`, `dryRun` |
| `message.failed` | `campaign`, `contact: { … }`, `error`, `reason`, `skipped` |

`message` is the fully-rendered text that was sent, after `{{name}}` /
`{{firstName}}` substitution.

`reason` on a failure is one of:

| `reason` | Meaning | Retryable |
| --- | --- | --- |
| `unavailable` | Facebook says the recipient can't be messaged (blocked, deactivated, restricted). | No |
| `no-composer` | The conversation never rendered a message box. | Unlikely |
| `not-delivered` | Facebook marked the message "Couldn't send". | Sometimes |
| `unconfirmed` | Submitted, but never confirmed as sent either way. | Sometimes |
| `unread` | **Deliberately skipped.** The campaign had "only if they've read the last message" on, and this contact hadn't read it. | Yes, later |

`skipped: true` accompanies `reason: "unread"`. It is the one `message.failed`
that does not mean something went wrong — nothing was sent *on purpose*. If you
build alerting on `message.failed`, filter this out or you will page yourself
over normal operation.

> **`dryRun: true`** means the message was typed into the conversation but never
> actually sent. Don't treat a dry-run `message.sent` as real outreach.

---

## 4. Security — read this

**`X-CRM-Token` is not authentication.** It is a plain shared string sent from a
browser extension, which means it is readable by anyone with access to the
user's browser profile. It exists for routing ("which of my machines is this")
and for cheaply rejecting noise. It is not a signature, there is no HMAC, and
there is no replay protection beyond `X-CRM-Delivery`.

Practical consequences for the receiver:

1. **Treat the payload as untrusted input.** Validate shapes and lengths.
2. **Never let a webhook alone authorize a privileged action** — creating a
   user, moving money, sending email to a third party. Use it to *notify* or to
   *trigger a reconciliation*, not to authorize.
3. **Make handlers idempotent**, keyed on `X-CRM-Delivery`. There is no retry
   today, but duplicates are still possible (two machines running the same
   extension, a user re-testing).
4. If it matters, **verify against your own state** rather than believing the
   payload.

---

## 5. Delivery guarantees (there aren't many)

Be honest with yourself about this layer:

- **One attempt per event. No retries.** If the endpoint is down, the event is
  gone. The failure is recorded and shown to the user in Settings, and that is
  the whole of the recovery story.
- **10-second timeout.** Respond fast — accept the payload, queue it, return
  `200`. Doing real work before responding will cost you deliveries.
- **No ordering guarantee.** Events are dispatched in the order they were
  detected, sequentially, but network reordering and multiple machines mean you
  must not rely on it. Use `sentAt` as a hint, not a sequence number.
- **Only fires while the browser is running** and the extension is active. A
  change made on a laptop that is then closed reaches your endpoint from that
  laptop or not at all — Drive sync moves the *data* between machines, not the
  events.
- **Multiple machines fire independently.** A user with the extension on a
  desktop and a laptop has two senders. Deduping by `X-CRM-Delivery` will not
  catch this, since each machine mints its own id for its own observation of
  the change — dedupe on the semantic content where it matters.
- **Bulk changes are capped at 50 events.** A CSV import of 2,000 contacts is a
  single internal write; it reports the first 50 and drops the rest rather than
  spending hours POSTing. Do not use webhooks to seed an initial dataset — use
  Settings → Data → Export backup for that.

If you need a reliable record, use webhooks as a *nudge* and pull the
authoritative state from the user's own export (Settings → Data → Export
backup), or have them re-send.

---

## 6. A minimal receiver

```js
// Express
app.post('/hooks/crm', express.json({ limit: '64kb' }), (req, res) => {
  // 1. Respond immediately — you have 10 seconds, use 10 milliseconds.
  res.sendStatus(200);

  const token = req.get('X-CRM-Token');
  if (token !== process.env.CRM_WEBHOOK_TOKEN) return;   // cheap noise filter, NOT auth

  const { id, event, data } = req.body || {};
  if (!id || !event) return;

  // 2. Idempotency: same delivery id twice is a no-op.
  if (alreadyHandled(id)) return;
  markHandled(id);

  // 3. Do the work off the request path.
  queue.push({ event, data });
});
```

```sql
-- Supabase / Postgres: the dedupe table
create table crm_deliveries (
  id          text primary key,          -- X-CRM-Delivery
  event       text not null,
  received_at timestamptz not null default now()
);
```

---

## 7. Payload examples

<details>
<summary><code>contact.created</code></summary>

```json
{
  "id": "evt_m1a2b3c4_x9y8z7",
  "event": "contact.created",
  "sentAt": 1755100800000,
  "version": 1,
  "source": "not-another-social-crm",
  "data": {
    "contact": {
      "id": "6123456789",
      "name": "Jane Doe",
      "chatUrl": "https://www.facebook.com/messages/t/6123456789/",
      "tags": [],
      "archived": false
    }
  }
}
```
</details>

<details>
<summary><code>contact.renamed</code></summary>

```json
{
  "id": "evt_m1a2b3c5_q4w5e6",
  "event": "contact.renamed",
  "sentAt": 1755100900000,
  "version": 1,
  "source": "not-another-social-crm",
  "data": {
    "contact": { "id": "6123456789", "name": "Jane Doe (dnc)", "tags": ["Warm Lead"], "archived": false },
    "previousName": "Jane Doe",
    "name": "Jane Doe (dnc)"
  }
}
```
</details>

<details>
<summary><code>campaign.completed</code></summary>

```json
{
  "id": "evt_m1a2b3c6_r7t8y9",
  "event": "campaign.completed",
  "sentAt": 1755110000000,
  "version": 1,
  "source": "not-another-social-crm",
  "data": {
    "campaign": { "id": "camp_m1a2b3", "name": "October follow-up", "dryRun": false, "skipIfUnread": true },
    "total": 120,
    "sent": 94,
    "failed": 26
  }
}
```
</details>

<details>
<summary><code>message.failed</code> (skipped as unread)</summary>

```json
{
  "id": "evt_m1a2b3c7_u1i2o3",
  "event": "message.failed",
  "sentAt": 1755105000000,
  "version": 1,
  "source": "not-another-social-crm",
  "data": {
    "campaign": { "id": "camp_m1a2b3", "name": "October follow-up", "dryRun": false },
    "contact": { "id": "6123456789", "name": "Jane Doe", "chatUrl": "https://www.facebook.com/messages/t/6123456789/" },
    "error": "Skipped — the last message hasn't been read (status: Delivered)",
    "reason": "unread",
    "skipped": true
  }
}
```
</details>

---

## 8. Versioning

`version` is `1`. Additive changes — a new event name, a new field inside
`data` — will **not** bump it, so parse leniently: ignore unknown events and
unknown fields rather than erroring on them. A bump only happens if the
envelope itself changes shape.
