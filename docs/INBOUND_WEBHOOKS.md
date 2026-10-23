# Not Another Social CRM — Incoming webhooks (experimental)

Let another system run CRM automations by POSTing to a URL. The opposite
direction to [outgoing webhooks](WEBHOOKS.md).

## How it works

The extension runs in a browser and can't receive HTTP, so requests go to a
mailbox on the server first:

1. You POST a command to `https://notanothersocialcrm.com/api/public/crm-inbox`.
2. It's stored and you get **202** with an `id` straight away.
3. Within about a minute, the user's **sending machine** (the one browser that
   sends messages, see Settings → Machines) picks it up and runs it.
4. You `GET …/crm-inbox?id=<id>` to see the result.

If no browser is running, commands wait — and expire after 24 hours (or
`expiresInMinutes`). Then their status is `expired` and nothing ran.

## Setup (in the extension)

Settings → Data → **Incoming webhooks**:

1. Switch it **On** (off by default; while off nothing is checked).
2. Tick the automations a webhook may run. Nothing is allowed by default.
3. **Create token**. The screen then shows everything to paste into Zapier
   ("Webhooks by Zapier" → POST), Make, or your own code — the URL, the
   `Authorization` header value and an example body — each with a Copy button,
   plus a ready-to-run curl command. The token is shown only this once; the
   server keeps just a hash of it. Lost it? Revoke it and create another.

## Request

```
POST /api/public/crm-inbox
Authorization: Bearer crm_in_…
Content-Type: application/json
```

```json
{
  "command": "automation.run",
  "payload": { "automation": "Follow up" },
  "idempotencyKey": "order-1234",
  "expiresInMinutes": 60
}
```

| Field | Notes |
| --- | --- |
| `command` | `ping` or `automation.run`. |
| `payload` | Depends on the command. |
| `idempotencyKey` | Optional. Same key twice → same command, not a second run. |
| `expiresInMinutes` | Optional, 1–1440 (default 1440). Don't run it if it can't run by then. |

Responses: `202` queued · `200` + `"duplicate": true` (same idempotency key) ·
`400` bad request · `401` bad/revoked token · `413` body over 16 KB ·
`429` 100+ commands already waiting.

## Commands

### `ping`

No payload. Result: `{ "pong": true, "device": "…", "version": "1.1.80", "at": 1761… }`.
Use it to check the whole loop works.

### `automation.run`

```json
{
  "automation": "Follow up",
  "contacts": [
    { "id": "6123456789" },
    { "profileUrl": "https://www.facebook.com/jane.doe" },
    { "chatUrl": "https://www.facebook.com/messages/t/6123456789/" }
  ],
  "vars": { "offer": "a free consult" },
  "dryRun": true
}
```

| Field | Notes |
| --- | --- |
| `automation` (or `automationId`) | The automation's id or exact name (not case-sensitive). Must be ticked in Settings. |
| `contacts` | Optional, up to 250. Run on exactly these contacts **instead of** the automation's own source (unread scan / saved search). Each needs `id`, `profileUrl` or `chatUrl`. Contacts not in the CRM are skipped and listed in `result.notFound`. |
| `vars` | Optional, up to 20 keys (letters, digits, `_`), values up to 500 chars. Fill `{{vars.key}}` in the automation's message. `{{firstName}}`/`{{name}}` still work per recipient. |
| `dryRun` | Optional. `true` types the message but doesn't send it. Can only make a run safer — it never makes a dry-run automation send. |

The request can't change **what** an automation does — only who it acts on and
the `{{vars}}` in its message. The automation's own limits (once per contact,
max per run) still apply.

Result (when `status` is `done`): the run record — e.g.
`{ "matched": 2, "tagged": 2, "messaged": 2, "campaignId": "…", "notFound": [] }`.
`messaged` means **queued**: messages go out at the normal sending pace
afterwards, and the regular outgoing `message.sent` webhooks report them.

## Reading the result

```
GET /api/public/crm-inbox?id=<id>
Authorization: Bearer crm_in_…
```

`status`: `pending` → `claimed` (running) → `done` / `failed` / `expired`.
`failed` carries `error` (e.g. "Automation "X" is not allowed to run from
webhooks", "Another automation is already running.").

## Known limits (proof of concept)

- Up to ~1 minute delay; only while a browser with the extension is open.
- A command that's running when the browser closes stays `claimed`.
- An unread-scan automation can't start while another scan is running — that
  command fails rather than waiting.
- The token is a real credential: anyone with it can run your ticked
  automations. Revoke it in Settings if it leaks.
