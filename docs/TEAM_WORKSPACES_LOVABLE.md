# Team workspaces — instructions for Lovable

Design and reasoning: [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md).

Paste everything below the line into Lovable. It is self-contained.

It only **adds** things (three tables, ten database functions). Nothing
existing is changed. §5 removes all of it again.

---

## Prompt for Lovable

We are adding **team workspaces** to Not Another Social CRM. A Pro subscriber
(the team *owner*) invites other people by email. Each invited person signs in
to the Chrome extension with their own platform account (free is fine) and can
then read and write one shared CRM document. Billing stays on the owner: the
team works only while the **owner** is on Pro.

The extension calls the functions below as the signed-in user (Supabase Auth
JWT, `/rest/v1/rpc/<name>`). Please implement **exactly** these names, columns
and signatures — the extension is already built against them. Do not change
any existing tables, functions or auth settings.

### 1. Migration: tables

```sql
create table public.crm_teams (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null unique,               -- one team per owner (v1)
  name        text not null,
  seat_limit  int  not null default 10,           -- members incl. owner and pending invites
  created_at  timestamptz not null default now()
);

create table public.crm_team_members (
  team_id     uuid not null references public.crm_teams(id) on delete cascade,
  email       text not null,                      -- always lower-case
  user_id     uuid,                               -- null until the invite is accepted
  role        text not null default 'member' check (role in ('owner','member')),
  status      text not null default 'invited' check (status in ('invited','active')),
  invited_at  timestamptz not null default now(),
  joined_at   timestamptz,
  primary key (team_id, email)
);
create index crm_team_members_user_idx  on public.crm_team_members (user_id);
create index crm_team_members_email_idx on public.crm_team_members (email);

-- The team's CRM data: one JSON document with a version for compare-and-swap.
create table public.crm_team_stores (
  team_id     uuid primary key references public.crm_teams(id) on delete cascade,
  version     bigint not null,
  data        jsonb  not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

alter table public.crm_teams        enable row level security;
alter table public.crm_team_members enable row level security;
alter table public.crm_team_stores  enable row level security;
-- No policies on purpose: every read and write goes through the functions below.
revoke all on public.crm_teams, public.crm_team_members, public.crm_team_stores from anon, authenticated;
```

### 2. Migration: functions

**`crm_team_owner_is_pro` is the one function you must adapt**: make it return
true exactly when `/api/public/entitlement` would return `is_pro: true` for that
user (same subscription table and statuses, trialing included). The body below
is a placeholder that shows the shape.

```sql
-- ADAPT THIS to the platform's billing table (same rule as the entitlement endpoint).
create or replace function public.crm_team_owner_is_pro(p_owner uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions s           -- <- your table
     where s.user_id = p_owner
       and s.status in ('active', 'trialing')      -- <- your rule
  );
$$;

create or replace function public.crm_jwt_email()
returns text language sql stable
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.crm_is_member(p_team uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from crm_team_members m
                  where m.team_id = p_team and m.user_id = auth.uid() and m.status = 'active');
$$;

-- Every team the caller belongs to, plus invites waiting for their email.
create or replace function public.crm_my_workspaces()
returns table (team_id uuid, name text, role text, status text, owner_email text,
               member_count int, seat_limit int, active boolean)
language sql stable security definer set search_path = public, auth
as $$
  select t.id, t.name, m.role, m.status,
         (select u.email from auth.users u where u.id = t.owner_id)::text,
         (select count(*)::int from crm_team_members x where x.team_id = t.id),
         t.seat_limit,
         crm_team_owner_is_pro(t.owner_id)
    from crm_team_members m
    join crm_teams t on t.id = m.team_id
   where (m.status = 'active'  and m.user_id = auth.uid())
      or (m.status = 'invited' and m.email = crm_jwt_email() and crm_jwt_email() <> '')
   order by t.created_at;
$$;

-- Create the caller's team (idempotent: returns the existing one). Owner must be Pro.
create or replace function public.crm_create_team(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select id into v_id from crm_teams where owner_id = v_uid;
  if v_id is not null then return v_id; end if;
  if not crm_team_owner_is_pro(v_uid) then raise exception 'Team workspaces need an active Pro plan.'; end if;
  insert into crm_teams (owner_id, name)
  values (v_uid, coalesce(nullif(left(trim(p_name), 60), ''), 'Team'))
  returning id into v_id;
  insert into crm_team_members (team_id, email, user_id, role, status, joined_at)
  values (v_id, crm_jwt_email(), v_uid, 'owner', 'active', now());
  return v_id;
end $$;

-- Owner invites someone by email.
create or replace function public.crm_invite_member(p_team uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_email text := lower(trim(p_email)); v_team crm_teams;
begin
  select * into v_team from crm_teams where id = p_team;
  if v_team.id is null or v_team.owner_id <> auth.uid() then raise exception 'Only the team owner can invite.'; end if;
  if not crm_team_owner_is_pro(v_team.owner_id) then raise exception 'Team workspaces need an active Pro plan.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That does not look like an email address.'; end if;
  if exists (select 1 from crm_team_members where team_id = p_team and email = v_email) then return; end if;
  if (select count(*) from crm_team_members where team_id = p_team) >= v_team.seat_limit then
    raise exception 'This team is full (% seats).', v_team.seat_limit;
  end if;
  insert into crm_team_members (team_id, email) values (p_team, v_email);
end $$;

-- Owner removes anyone but themselves; anyone may remove themselves (leave / decline).
create or replace function public.crm_remove_member(p_team uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_email text := lower(trim(p_email)); v_owner uuid;
begin
  select owner_id into v_owner from crm_teams where id = p_team;
  if v_owner is null then raise exception 'No such team.'; end if;
  if v_owner = auth.uid() then
    delete from crm_team_members where team_id = p_team and email = v_email and role <> 'owner';
  elsif v_email = crm_jwt_email() then
    delete from crm_team_members where team_id = p_team and email = v_email and role <> 'owner';
  else
    raise exception 'Only the team owner can remove members.';
  end if;
end $$;

-- The invited person accepts (must be signed in with the invited email).
create or replace function public.crm_accept_invite(p_team uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update crm_team_members
     set user_id = auth.uid(), status = 'active', joined_at = now()
   where team_id = p_team and email = crm_jwt_email() and status = 'invited';
  if not found then raise exception 'No pending invite for this account.'; end if;
end $$;

create or replace function public.crm_team_members_list(p_team uuid)
returns table (email text, role text, status text, invited_at timestamptz, joined_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not crm_is_member(p_team) then raise exception 'not a member of this team'; end if;
  return query select m.email, m.role, m.status, m.invited_at, m.joined_at
                 from crm_team_members m where m.team_id = p_team
                order by (m.role = 'owner') desc, m.invited_at;
end $$;

-- Owner deletes the whole team (members and data).
create or replace function public.crm_delete_team(p_team uuid)
returns void
language sql security definer set search_path = public
as $$ delete from crm_teams where id = p_team and owner_id = auth.uid(); $$;

-- Read the team document. Returns data = null when p_known_version is current
-- (cheap polling) and version = 0 when nothing has been written yet.
-- Reading is allowed even while the owner's plan has lapsed (active = false).
create or replace function public.crm_team_store_get(p_team uuid, p_known_version bigint)
returns table (version bigint, data jsonb, active boolean)
language plpgsql stable security definer set search_path = public
as $$
declare v_owner uuid;
begin
  if not crm_is_member(p_team) then raise exception 'not a member of this team'; end if;
  select owner_id into v_owner from crm_teams where id = p_team;
  return query
    select coalesce(s.version, 0),
           case when s.version is null or s.version = p_known_version then null else s.data end,
           crm_team_owner_is_pro(v_owner)
      from (select 1) one
      left join crm_team_stores s on s.team_id = p_team;
end $$;

-- Compare-and-swap write. ok = false (with the current version) when someone
-- else wrote first; the extension then re-reads, merges and retries.
create or replace function public.crm_team_store_put(p_team uuid, p_expected_version bigint, p_data jsonb)
returns table (ok boolean, version bigint)
language plpgsql security definer set search_path = public
as $$
declare v_owner uuid; v_new bigint;
begin
  if not crm_is_member(p_team) then raise exception 'not a member of this team'; end if;
  select owner_id into v_owner from crm_teams where id = p_team;
  if not crm_team_owner_is_pro(v_owner) then
    raise exception 'The team owner''s Pro plan is not active, so this workspace is read-only.';
  end if;
  if octet_length(p_data::text) > 25 * 1024 * 1024 then raise exception 'Team data is too large (25 MB max).'; end if;

  if p_expected_version = 0 then
    insert into crm_team_stores (team_id, version, data, updated_by)
    values (p_team, 1, p_data, auth.uid())
    on conflict (team_id) do nothing;
    if found then return query select true, 1::bigint; return; end if;
  else
    update crm_team_stores s
       set data = p_data, version = s.version + 1, updated_at = now(), updated_by = auth.uid()
     where s.team_id = p_team and s.version = p_expected_version
    returning s.version into v_new;
    if v_new is not null then return query select true, v_new; return; end if;
  end if;
  return query select false, coalesce((select s.version from crm_team_stores s where s.team_id = p_team), 0);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_team_owner_is_pro(uuid)', 'crm_jwt_email()', 'crm_is_member(uuid)',
    'crm_my_workspaces()', 'crm_create_team(text)', 'crm_invite_member(uuid, text)',
    'crm_remove_member(uuid, text)', 'crm_accept_invite(uuid)', 'crm_team_members_list(uuid)',
    'crm_delete_team(uuid)', 'crm_team_store_get(uuid, bigint)', 'crm_team_store_put(uuid, bigint, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
```

PostgREST's default request body limit may need raising to ~25 MB for large
teams (`crm_team_store_put` carries the whole document).

### 3. Optional: invite email

When a row is inserted into `crm_team_members` with `status = 'invited'`, the
website may email that address: "*owner* invited you to *team* in Not Another
Social CRM — sign in to the extension with this email and accept the invite
under Settings → Account & plan." The extension works without it.

### 4. Acceptance checks (please run these before telling me it's done)

With two test users, **A** (on Pro) and **B** (free), calling as each user:

1. A: `select crm_create_team('Acme')` returns a uuid; calling it again returns
   the same uuid. B (free): `crm_create_team('x')` fails with the Pro message.
2. A: `crm_invite_member(<team>, 'B@Example.com')`; `crm_team_members_list(<team>)`
   shows `b@example.com` as `invited`.
3. B: `crm_my_workspaces()` shows the team with `status = 'invited'`;
   `crm_team_store_get(<team>, 0)` fails ("not a member").
4. B: `crm_accept_invite(<team>)`; `crm_my_workspaces()` now shows `active`.
5. A: `crm_team_store_put(<team>, 0, '{"conversations":{}}')` → `(true, 1)`.
   B: `crm_team_store_put(<team>, 0, '{}')` → `(false, 1)` (stale version).
   B: `crm_team_store_get(<team>, 0)` → version 1 with data;
   `crm_team_store_get(<team>, 1)` → version 1, data null.
6. B: `crm_team_store_put(<team>, 1, '{"x":1}')` → `(true, 2)`.
7. With A's subscription inactive: `crm_my_workspaces()` shows `active = false`,
   `crm_team_store_get` still works, `crm_team_store_put` fails (read-only).
8. B: `crm_remove_member(<team>, '<A's email>')` fails; A: `crm_remove_member(<team>, 'b@example.com')`
   → B's `crm_team_store_get` fails again.
9. A third user C sees nothing in `crm_my_workspaces()` and cannot read or
   write the team.

---

## 5. Rollback (removes everything above)

```sql
drop function if exists public.crm_team_store_put(uuid, bigint, jsonb);
drop function if exists public.crm_team_store_get(uuid, bigint);
drop function if exists public.crm_delete_team(uuid);
drop function if exists public.crm_team_members_list(uuid);
drop function if exists public.crm_accept_invite(uuid);
drop function if exists public.crm_remove_member(uuid, text);
drop function if exists public.crm_invite_member(uuid, text);
drop function if exists public.crm_create_team(text);
drop function if exists public.crm_my_workspaces();
drop function if exists public.crm_is_member(uuid);
drop function if exists public.crm_jwt_email();
drop function if exists public.crm_team_owner_is_pro(uuid);
drop table if exists public.crm_team_stores;
drop table if exists public.crm_team_members;
drop table if exists public.crm_teams;
```

With the server side gone, the extension's Team card shows "the server side is
not set up yet"; anyone who was in a team workspace is moved back to Personal.
