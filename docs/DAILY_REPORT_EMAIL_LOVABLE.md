# Daily report email — instructions for Lovable

The extension's **Daily report** (Settings → Data) can email the Dashboard's
numbers once a day. A browser extension can't send email itself, so it asks the
website to do it. Until the route below exists, the extension shows "Email
sending is not set up on the server yet" in the report's delivery log. Webhook
delivery works without it.

Paste everything below the line into Lovable. It only **adds** one route (and,
optionally, one small table). Nothing existing changes. To roll it back, remove
the route and drop the table.

---

## Prompt for Lovable

Add a website server route for Not Another Social CRM's daily report email.
The Chrome extension is already built against exactly this contract, so please
keep the path, request and response shapes as written.

### Route

`POST https://notanothersocialcrm.com/api/public/daily-report-email`

Headers:
- `Authorization: Bearer <Supabase access token>`: the signed-in user's session
  token (same Supabase project the extension signs into).
- `Content-Type: application/json`

Body (max 64 KB):

```json
{
  "to": ["owner@example.com", "partner@example.com"],
  "test": false,
  "report": {
    "day": "2026-10-28",
    "generatedAt": 1761650000000,
    "totals": { "contacts": 812, "active": 790, "archived": 22 },
    "tiles": [
      { "kind": "count", "name": "Hot leads", "description": "optional", "count": 42, "query": "Tags has any of Hot" },
      { "kind": "ratio", "name": "Replied rate", "formula": "A & B / A", "format": "percent",
        "value": 0.25, "display": "25%", "numerator": 10, "denominator": 40, "problem": "optional" }
    ]
  }
}
```

### What it must do

1. **Authenticate.** Verify the bearer token with Supabase (`auth.getUser(token)`).
   Invalid or missing → `401 { "error": "Not signed in." }`.
2. **Validate.**
   - `to`: an array of 1–5 syntactically valid email addresses, de-duplicated. Otherwise `400`.
   - `report.tiles`: at most 60 entries. Every string is truncated to 200
     characters. Numbers must be finite, or `null`. Otherwise `400`.
3. **Rate limit**: at most **5 sends per user per UTC day**, tests included.
   Over the limit → `429 { "error": "Daily email limit reached (5 per day). Try again tomorrow." }`.
   Keep a counter in a table `daily_report_email_sends (user_id uuid, sent_at timestamptz default now(), recipients int, test bool)`
   with RLS on and no client policies; only the route writes it.
4. **Render the email on the server** from the structured numbers. Never accept
   HTML from the client, and HTML-escape every string from the request (tile
   names, queries, descriptions).
   - Subject: `Daily CRM report — {day}`, prefixed with `[Test] ` when `test` is true.
   - Body: a short heading, the totals line ("812 contacts · 790 active · 22 archived"),
     then one row per tile in the order given:
     - count tiles: name + count (and the query in small grey text);
     - ratio tiles: name + `display`, plus "10 of 40" when both numerator and
       denominator are present, or the `problem` text in grey.
   - Footer: "Sent by Not Another Social CRM because {account email} set up a daily
     report. Change it in the extension: Settings → Data → Daily report."
   - Include a plain-text alternative.
5. **Send** with the email provider already used by the site (Resend, if none
   is set up yet). From: `reports@notanothersocialcrm.com` (or the site's
   existing sender). Reply-To: the account's email.
6. **Respond** `200 { "ok": true, "id": "<provider message id>" }`. If the
   provider fails → `502 { "error": "<short provider message>" }`.

Errors are always JSON `{ "error": "…" }`. The extension shows `error` to the
user as-is, so keep it short and human.

### Why the limits

The route sends mail on behalf of a signed-in user to addresses that user
typed. Server-side rendering, the 5-recipient cap and the 5-per-day cap keep it
from being usable as a relay for anything other than this one report.
