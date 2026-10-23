# Incoming webhooks — instructions for Lovable

> **As built (2026-10-23)** — Lovable implemented this with three deviations:
> 1. The public endpoint is a **website route**,
>    `https://notanothersocialcrm.com/api/public/crm-inbox`, not a Supabase edge
>    function (Lovable keeps server code in the website). Same behaviour.
> 2. `user_id` is a plain uuid with **no foreign key** to `auth.users`, so
>    deleting an account does not cascade-delete its tokens/commands.
> 3. **No cleanup job** (`pg_cron` not available) — finished commands are kept.
>
> The tables and functions are in the same Supabase project the extension
> signs into, named exactly as below. The rollback in §6 still applies, minus
> the cron line; remove the website route instead of an edge function.

Paste everything below the line into Lovable. It is self-contained.

It only **adds** things (two tables, five database functions, one edge
function). Nothing existing is changed. §6 removes all of it again.

---

## Prompt for Lovable

We are adding **incoming webhooks** to Not Another Social CRM. Outside systems
(Zapier, scripts) POST a command to a public edge function. The edge function
stores it in a table. The user's Chrome extension (signed in as that user via
Supabase Auth) polls the table, runs the command, and writes the result back.
The caller can then GET the result.

Please implement **exactly** the names, columns and signatures below. The
extension is already built against them, so any rename breaks it.
Do not change any existing tables, functions or auth settings.

### 1. Migration: tables

```sql
create extension if not exists pgcrypto with schema extensions;

create table public.inbound_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  token_hash    text not null unique,          -- sha256 hex of the full token
  token_prefix  text not null,                 -- first 12 chars, for display
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index inbound_tokens_user_idx on public.inbound_tokens (user_id);

create table public.inbound_commands (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  token_id         uuid references public.inbound_tokens(id) on delete set null,
  command          text not null,
  payload          jsonb not null default '{}'::jsonb,
  idempotency_key  text,
  status           text not null default 'pending'
                   check (status in ('pending','claimed','done','failed','expired')),
  result           jsonb,
  error            text,
  claimed_by       text,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours'
);
create index inbound_commands_pending_idx on public.inbound_commands (user_id, status, created_at);
create unique index inbound_commands_idem_idx
  on public.inbound_commands (user_id, idempotency_key) where idempotency_key is not null;

alter table public.inbound_tokens   enable row level security;
alter table public.inbound_commands enable row level security;

-- Signed-in users may READ their own rows. No insert/update/delete policies:
-- all writes go through the functions below or the edge function (service role).
create policy "own tokens readable"   on public.inbound_tokens   for select to authenticated using (user_id = auth.uid());
create policy "own commands readable" on public.inbound_commands for select to authenticated using (user_id = auth.uid());

-- Never expose the hash, even to its owner: replace the default table-wide
-- grants with a column list that leaves token_hash out.
revoke all on public.inbound_tokens   from anon, authenticated;
revoke all on public.inbound_commands from anon, authenticated;
grant select (id, user_id, token_prefix, label, created_at, last_used_at, revoked_at)
  on public.inbound_tokens to authenticated;
grant select on public.inbound_commands to authenticated;
```

The extension only ever selects `id,token_prefix,label,created_at,last_used_at,revoked_at`
from `inbound_tokens`.

### 2. Migration: database functions (called by the extension as the signed-in user)

All are `security definer`, scoped to `auth.uid()`, executable by
`authenticated` only.

```sql
-- Create a token. Returns the plaintext ONCE; only the hash is stored.
create or replace function public.create_inbound_token(p_label text)
returns table (id uuid, token text, token_prefix text)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if (select count(*) from inbound_tokens t where t.user_id = v_uid and t.revoked_at is null) >= 5 then
    raise exception 'You already have 5 active tokens. Revoke one first.';
  end if;
  v_token := 'crm_in_' || encode(gen_random_bytes(24), 'hex');
  insert into inbound_tokens (user_id, token_hash, token_prefix, label)
  values (v_uid, encode(digest(v_token, 'sha256'), 'hex'), left(v_token, 12), nullif(left(coalesce(p_label, ''), 60), ''))
  returning inbound_tokens.id into v_id;
  return query select v_id, v_token, left(v_token, 12);
end $$;

create or replace function public.revoke_inbound_token(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update inbound_tokens set revoked_at = now()
  where id = p_id and user_id = auth.uid() and revoked_at is null;
$$;

-- Atomically claim up to p_limit pending commands for this user.
-- Two machines calling at once never get the same row (skip locked).
create or replace function public.claim_inbound_commands(p_device text, p_limit int default 5)
returns setof public.inbound_commands
language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  update inbound_commands set status = 'expired', finished_at = now()
  where user_id = v_uid and status = 'pending' and expires_at < now();

  return query
  update inbound_commands c
     set status = 'claimed', claimed_by = left(p_device, 100), claimed_at = now()
   where c.id in (
     select id from inbound_commands
      where user_id = v_uid and status = 'pending'
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 5), 20))
      for update skip locked
   )
  returning c.*;
end $$;

-- Report the outcome of a claimed command.
create or replace function public.complete_inbound_command(p_id uuid, p_status text, p_result jsonb, p_error text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('done', 'failed') then raise exception 'bad status'; end if;
  update inbound_commands
     set status = p_status, result = p_result, error = left(p_error, 1000), finished_at = now()
   where id = p_id and user_id = auth.uid() and status = 'claimed';
end $$;

revoke all on function public.create_inbound_token(text)               from public, anon;
revoke all on function public.revoke_inbound_token(uuid)               from public, anon;
revoke all on function public.claim_inbound_commands(text, int)        from public, anon;
revoke all on function public.complete_inbound_command(uuid, text, jsonb, text) from public, anon;
grant execute on function public.create_inbound_token(text)               to authenticated;
grant execute on function public.revoke_inbound_token(uuid)               to authenticated;
grant execute on function public.claim_inbound_commands(text, int)        to authenticated;
grant execute on function public.complete_inbound_command(uuid, text, jsonb, text) to authenticated;
```

### 3. Edge function `crm-inbox`

Create a Supabase Edge Function named **`crm-inbox`**. It must be callable
**without a Supabase JWT** — callers authenticate with our own token — so set
in `supabase/config.toml`:

```toml
[functions.crm-inbox]
verify_jwt = false
```

It uses the service role key (`SUPABASE_SERVICE_ROLE_KEY`, already available
to edge functions) to read/write the tables above.

**Authentication (every request):**
- Token from `Authorization: Bearer <token>`, or from header
  `X-CRM-Inbound-Token`.
- Hash it: SHA-256 of the UTF-8 token, lowercase hex (must equal
  `encode(digest(token,'sha256'),'hex')` in Postgres). Use `crypto.subtle`.
- Look up `inbound_tokens` by `token_hash` with `revoked_at is null`.
  Not found → **401** `{"error":"invalid token"}`.
- On success set `last_used_at = now()` on that token.

**CORS:** respond to `OPTIONS` with 204 and
`Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: authorization, content-type, x-crm-inbound-token`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`. Include
`Access-Control-Allow-Origin: *` on every response. All responses are JSON.

**`POST /crm-inbox`** — queue a command

Request body (max 16 KB → otherwise **413** `{"error":"body too large"}`):

```json
{
  "command": "automation.run",
  "payload": { "automation": "Follow up", "dryRun": true },
  "idempotencyKey": "optional-string-max-100",
  "expiresInMinutes": 60
}
```

Validation (→ **400** `{"error":"<message>"}`):
- body is a JSON object
- `command` is a string matching `^[a-z][a-z0-9_.]{1,63}$`
  (do NOT hardcode a list of commands — the extension validates them)
- `payload`, if present, is a JSON object (default `{}`)
- `idempotencyKey`, if present, string ≤ 100 chars
- `expiresInMinutes`, if present, integer 1–1440 (default 1440)

Limits: if the user already has **100 or more** rows with
`status = 'pending'` → **429** `{"error":"too many pending commands"}`.

Insert into `inbound_commands` (`user_id` and `token_id` from the token,
`expires_at = now() + expiresInMinutes`).
- If `idempotencyKey` conflicts with an existing row for this user, do not
  insert; return that row with **200** and `"duplicate": true`.
- Otherwise **202**:

```json
{ "id": "<uuid>", "status": "pending", "createdAt": "...", "expiresAt": "...", "duplicate": false }
```

**`GET /crm-inbox?id=<uuid>`** — read one command's state

Only rows belonging to the token's user. Missing/other user's → **404**
`{"error":"not found"}`. Bad uuid → 400. Response 200:

```json
{
  "id": "...", "command": "ping", "status": "done",
  "result": { "pong": true }, "error": null,
  "createdAt": "...", "claimedAt": "...", "finishedAt": "...", "expiresAt": "..."
}
```

Any other method → **405**.

### 4. Optional: cleanup job

If `pg_cron` is available, delete finished rows after 7 days:

```sql
select cron.schedule('inbound-commands-cleanup', '17 3 * * *',
  $$delete from public.inbound_commands where created_at < now() - interval '7 days'$$);
```

### 5. Acceptance checks (please run these before telling me it's done)

Using the SQL editor as a test user (or by calling the RPCs with a signed-in
user's JWT):

1. `select * from create_inbound_token('test')` returns one row whose `token`
   starts with `crm_in_` and is 55 characters long; `inbound_tokens` holds only
   the hash.
2. `curl -i -X POST <functions-url>/crm-inbox -d '{"command":"ping"}'` with **no**
   token → 401.
3. Same with `-H "Authorization: Bearer <token>"` → 202 with an `id`.
4. `GET ...crm-inbox?id=<that id>` with the token → 200, `"status":"pending"`.
5. `select * from claim_inbound_commands('test-device', 5)` as that user
   returns the row with `status = 'claimed'`; calling again returns nothing.
6. `select complete_inbound_command('<id>', 'done', '{"pong":true}', null)`;
   the GET from step 4 now shows `"status":"done"` and the result.
7. Posting the same `idempotencyKey` twice returns the same `id` the second
   time with `"duplicate": true`.
8. `revoke_inbound_token('<token id>')` → the token now gets 401.
9. A second user cannot see the first user's rows (RLS) and cannot claim them.

Reply with the function URL.

---

## 6. Rollback (removes everything above)

```sql
select cron.unschedule('inbound-commands-cleanup');  -- only if step 4 was done
drop function if exists public.complete_inbound_command(uuid, text, jsonb, text);
drop function if exists public.claim_inbound_commands(text, int);
drop function if exists public.revoke_inbound_token(uuid);
drop function if exists public.create_inbound_token(text);
drop table if exists public.inbound_commands;
drop table if exists public.inbound_tokens;
```

…and delete the `crm-inbox` edge function and its `config.toml` entry.

With the server side gone, the extension's Incoming webhooks screen shows
"the server side is not set up yet" and does nothing else.
