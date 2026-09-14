-- Shared households for Home Meds.
--
-- Run after schema.sql, 20260914_personalize_home_meds.sql and
-- 20260914_family_inventory.sql.
--
-- This migration intentionally does NOT add household_id columns, migrate
-- existing rows, or create an implicit active-household state.  The app keeps
-- shared records under the household owner's existing `user_id`; collaborators
-- explicitly query and write with that owner id.  Therefore all legacy data
-- stays exactly where it was and stays private until its owner creates a
-- household and shares an invite.
--
-- RPC contract (each returns one JSON object, except a no-household GET which
-- returns SQL NULL):
--   home_meds_get_household()
--   home_meds_create_household()
--   home_meds_join_household(invite_code text)
--   home_meds_remove_household_member(member_user_id uuid)
--   home_meds_update_household_name(new_name text)
--
-- Returned data has `id` + `household_id`, `owner_user_id`, `role` +
-- `current_role`, and `members` + `collaborators` aliases.  The high-entropy
-- plaintext invite code is returned only to the owner.  It is kept in a column
-- that browser roles cannot select directly, and is rotated immediately after
-- an owner removes a collaborator.

create extension if not exists pgcrypto with schema extensions;

-- One owner has one shareable Home Meds household.  The table doubles as the
-- shared household profile: `name` is safe to share, while personal
-- `display_name` remains in home_meds_profiles under its original own-only RLS.
create table if not exists public.home_meds_households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'Моя аптечка',
  notes text not null default '',
  invite_code text,
  invite_code_hash text,
  invite_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_meds_household_name_not_blank check (length(btrim(name)) between 1 and 120),
  constraint home_meds_household_notes_size check (length(notes) <= 2000),
  constraint home_meds_household_invite_pair check (
    (invite_code is null and invite_code_hash is null and invite_created_at is null)
    or (invite_code is not null and invite_code_hash is not null and invite_created_at is not null)
  ),
  constraint home_meds_household_invite_shape check (
    invite_code is null or invite_code ~ '^HM-[0-9A-F]{32}$'
  )
);

-- These ALTERs make a retry safe if an earlier interrupted run created the
-- table before all private invite columns were present.
alter table public.home_meds_households add column if not exists invite_code text;
alter table public.home_meds_households add column if not exists invite_code_hash text;
alter table public.home_meds_households add column if not exists invite_created_at timestamptz;

-- A user can be a member of only one household.  That makes the owner id used
-- by the UI unambiguous and prevents users from combining permissions from
-- several households.  Members are editors; only the owner role manages access.
create table if not exists public.home_meds_household_members (
  household_id uuid not null references public.home_meds_households(id) on delete cascade,
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  constraint home_meds_household_members_household_user_key unique (household_id, user_id)
);

create unique index if not exists home_meds_household_invite_hash_idx
  on public.home_meds_households (invite_code_hash) where invite_code_hash is not null;
create index if not exists home_meds_household_members_household_idx
  on public.home_meds_household_members (household_id, joined_at);

drop trigger if exists set_home_meds_households_updated_at on public.home_meds_households;
create trigger set_home_meds_households_updated_at
before update on public.home_meds_households
for each row execute function public.set_updated_at();

-- RLS-safe predicate for every existing row whose `user_id` is the household
-- owner.  It also permits an owner to access old private rows before a
-- household exists, preserving the original application behavior.
create or replace function public.home_meds_can_access_owner(p_owner_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    p_owner_user_id = auth.uid()
    or exists (
      select 1
      from public.home_meds_households as h
      join public.home_meds_household_members as m on m.household_id = h.id
      where h.owner_user_id = p_owner_user_id
        and m.user_id = auth.uid()
    )
  );
$$;

create or replace function public.home_meds_is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.home_meds_household_members as m
    where m.household_id = p_household_id
      and m.user_id = auth.uid()
  );
$$;

-- Only a caller's actual membership is used to build a response.  This helper
-- never exposes auth.users.email, the invite hash, or another household's code.
create or replace function public.home_meds_household_payload(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  if not public.home_meds_is_household_member(p_household_id) then
    raise exception 'You are not a member of this household' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', h.id,
    'household_id', h.id,
    'name', h.name,
    'household_name', h.name,
    'notes', h.notes,
    'owner_user_id', h.owner_user_id,
    'owner_id', h.owner_user_id,
    'role', case when me.role = 'member' then 'editor' else me.role end,
    'current_role', case when me.role = 'member' then 'editor' else me.role end,
    -- The code is intentionally emitted only for the owner.  Direct table
    -- grants below do not include this column, even for authenticated users.
    'invite_code', case when h.owner_user_id = auth.uid() then h.invite_code else null end,
    'invite_created_at', case when h.owner_user_id = auth.uid() then h.invite_created_at else null end,
    'members', coalesce(member_rows.rows, '[]'::jsonb),
    'collaborators', coalesce(member_rows.rows, '[]'::jsonb)
  )
  into v_payload
  from public.home_meds_households as h
  join public.home_meds_household_members as me
    on me.household_id = h.id and me.user_id = auth.uid()
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'user_id', m.user_id,
        'role', case when m.role = 'member' then 'editor' else m.role end,
        'joined_at', m.joined_at,
        'display_name', nullif(btrim(p.display_name), '')
      )
      order by case when m.role = 'owner' then 0 else 1 end, m.joined_at
    ) as rows
    from public.home_meds_household_members as m
    left join public.home_meds_profiles as p on p.user_id = m.user_id
    where m.household_id = h.id
  ) as member_rows on true
  where h.id = p_household_id;

  if v_payload is null then
    raise exception 'Household does not exist' using errcode = 'P0002';
  end if;
  return v_payload;
end;
$$;

-- Required public RPC.  A signed-in user who has not created or joined a
-- household gets NULL; their own cabinet continues to load through user_id.
create or replace function public.home_meds_get_household()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_household_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to read household access' using errcode = '42501';
  end if;

  select household_id into v_household_id
  from public.home_meds_household_members
  where user_id = auth.uid();

  if v_household_id is null then
    return null;
  end if;
  return public.home_meds_household_payload(v_household_id);
end;
$$;

-- 122 random bits are represented as an easy-to-copy `HM-` code.  The hash is
-- used for joins; the raw value is retained only so the owner can retrieve it
-- after a refresh without weakening member or table-level access controls.
create or replace function public.home_meds_new_invite_code()
returns text
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select 'HM-' || upper(replace(gen_random_uuid()::text, '-', ''));
$$;

create or replace function public.home_meds_normalize_invite_code(p_invite_code text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select regexp_replace(upper(coalesce(btrim(p_invite_code), '')), E'\\s+', '', 'g');
$$;

-- Required public RPC.  Its first call creates the owner's household and seeds
-- the shared name from their existing private profile.  Calling it again as
-- owner safely rotates the invite.  A collaborator cannot create another
-- household while already participating in one.
create or replace function public.home_meds_create_household()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
  v_role text;
  v_name text;
  v_code text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required to create a household' using errcode = '42501';
  end if;

  select m.household_id, m.role
    into v_household_id, v_role
  from public.home_meds_household_members as m
  where m.user_id = v_user_id
  for update;

  if v_household_id is not null and v_role <> 'owner' then
    raise exception 'You already participate in another household' using errcode = '42501';
  end if;

  if v_household_id is null then
    select coalesce(nullif(btrim(p.household_name), ''), 'Моя аптечка')
      into v_name
    from public.home_meds_profiles as p
    where p.user_id = v_user_id;
    v_name := coalesce(v_name, 'Моя аптечка');

    -- A unique owner id prevents a duplicate household during concurrent calls.
    insert into public.home_meds_households (owner_user_id, name)
    values (v_user_id, v_name)
    on conflict (owner_user_id) do nothing
    returning id into v_household_id;

    if v_household_id is null then
      select id into v_household_id
      from public.home_meds_households
      where owner_user_id = v_user_id;
    end if;

    insert into public.home_meds_household_members (household_id, user_id, role)
    values (v_household_id, v_user_id, 'owner')
    on conflict (user_id) do nothing;
  end if;

  -- The unique hash index makes an extraordinarily unlikely random collision
  -- retry-safe.  Each create call replaces any old code immediately.
  loop
    v_code := public.home_meds_new_invite_code();
    begin
      update public.home_meds_households
      set invite_code = v_code,
          invite_code_hash = encode(digest(public.home_meds_normalize_invite_code(v_code), 'sha256'), 'hex'),
          invite_created_at = now()
      where id = v_household_id and owner_user_id = v_user_id;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  return public.home_meds_household_payload(v_household_id);
end;
$$;

-- Required public RPC.  A code creates a member/editor relationship only; it
-- never migrates, copies, or changes any of the joiner's existing personal rows.
-- The one-membership constraint blocks joining a second household accidentally.
create or replace function public.home_meds_join_household(invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_target_household_id uuid;
  v_current_household_id uuid;
  v_normalized_code text := public.home_meds_normalize_invite_code(invite_code);
  v_hash text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required to join a household' using errcode = '42501';
  end if;
  if length(v_normalized_code) <> 35 or v_normalized_code !~ '^HM-[0-9A-F]{32}$' then
    raise exception 'Invite code is invalid' using errcode = '22023';
  end if;

  v_hash := encode(digest(v_normalized_code, 'sha256'), 'hex');
  select h.id into v_target_household_id
  from public.home_meds_households as h
  where h.invite_code_hash = v_hash
  for update;

  if v_target_household_id is null then
    raise exception 'Invite code is invalid' using errcode = '22023';
  end if;

  select household_id into v_current_household_id
  from public.home_meds_household_members
  where user_id = v_user_id
  for update;

  if v_current_household_id = v_target_household_id then
    return public.home_meds_household_payload(v_target_household_id);
  end if;
  if v_current_household_id is not null then
    raise exception 'You already participate in another household' using errcode = '22023';
  end if;

  insert into public.home_meds_household_members (household_id, user_id, role)
  values (v_target_household_id, v_user_id, 'member');

  return public.home_meds_household_payload(v_target_household_id);
end;
$$;

-- Required public RPC.  It operates only on the caller's household, so an
-- owner cannot aim a removal at a foreign household by forging an id.  A fresh
-- code is issued atomically before the transaction completes; the removed user
-- can never rejoin using the old code.
create or replace function public.home_meds_remove_household_member(member_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
  v_owner_user_id uuid;
  v_code text;
begin
  select m.household_id, h.owner_user_id
    into v_household_id, v_owner_user_id
  from public.home_meds_household_members as m
  join public.home_meds_households as h on h.id = m.household_id
  where m.user_id = v_user_id
  for update of m, h;

  if v_household_id is null or v_owner_user_id is distinct from v_user_id then
    raise exception 'Only the household owner can remove a collaborator' using errcode = '42501';
  end if;
  if member_user_id = v_user_id then
    raise exception 'The household owner cannot be removed' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.home_meds_household_members
    where household_id = v_household_id
      and user_id = member_user_id
      and role = 'member'
  ) then
    raise exception 'This collaborator is not in the household' using errcode = 'P0002';
  end if;

  loop
    v_code := public.home_meds_new_invite_code();
    begin
      update public.home_meds_households
      set invite_code = v_code,
          invite_code_hash = encode(digest(public.home_meds_normalize_invite_code(v_code), 'sha256'), 'hex'),
          invite_created_at = now()
      where id = v_household_id;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  delete from public.home_meds_household_members
  where household_id = v_household_id
    and user_id = member_user_id
    and role = 'member';

  return public.home_meds_household_payload(v_household_id);
end;
$$;

-- Shared household name: every collaborator is deliberately an editor, but no
-- client argument can modify owner_user_id, invite code/hash, or membership.
create or replace function public.home_meds_update_household_name(new_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_household_id uuid;
  v_name text := coalesce(nullif(btrim(new_name), ''), 'Моя аптечка');
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to update a household' using errcode = '42501';
  end if;
  if length(v_name) > 120 then
    raise exception 'Household name is too long' using errcode = '22001';
  end if;

  select household_id into v_household_id
  from public.home_meds_household_members
  where user_id = auth.uid();
  if v_household_id is null then
    raise exception 'No household is selected' using errcode = '42501';
  end if;

  update public.home_meds_households set name = v_name where id = v_household_id;
  return public.home_meds_household_payload(v_household_id);
end;
$$;

-- Existing data tables keep their schemas and IDs.  The following short
-- trigger only makes their `user_id` immutable after INSERT.  It is not an
-- implicit scoping system: it blocks a collaborator from re-parenting a shared
-- medicine/trip/member into another owner's data through a crafted UPDATE.
create or replace function public.home_meds_prevent_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'The Home Meds data owner cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_home_meds_items_owner_change on public.home_meds_items;
create trigger prevent_home_meds_items_owner_change
before update on public.home_meds_items
for each row execute function public.home_meds_prevent_owner_change();

drop trigger if exists prevent_home_meds_trips_owner_change on public.home_meds_trips;
create trigger prevent_home_meds_trips_owner_change
before update on public.home_meds_trips
for each row execute function public.home_meds_prevent_owner_change();

drop trigger if exists prevent_home_meds_members_owner_change on public.home_meds_members;
create trigger prevent_home_meds_members_owner_change
before update on public.home_meds_members
for each row execute function public.home_meds_prevent_owner_change();

-- Household metadata is readable but never directly writable through PostgREST.
-- Column privileges intentionally omit invite_code / invite_code_hash.
alter table public.home_meds_households enable row level security;
alter table public.home_meds_household_members enable row level security;
revoke all on public.home_meds_households, public.home_meds_household_members from anon, authenticated;
grant select (id, owner_user_id, name, notes, created_at, updated_at)
  on public.home_meds_households to authenticated;
grant select (household_id, user_id, role, joined_at)
  on public.home_meds_household_members to authenticated;

drop policy if exists "Home Meds members read household metadata" on public.home_meds_households;
create policy "Home Meds members read household metadata"
  on public.home_meds_households for select to authenticated
  using (public.home_meds_is_household_member(id));

drop policy if exists "Home Meds members read household collaborators" on public.home_meds_household_members;
create policy "Home Meds members read household collaborators"
  on public.home_meds_household_members for select to authenticated
  using (public.home_meds_is_household_member(household_id));

-- Replace the old own-only data policies with owner-or-member policies.  The
-- caller still needs to be the owner/member of the exact user_id in the row;
-- knowing a UUID alone never creates access.
revoke all on public.home_meds_items, public.home_meds_trips, public.home_meds_members from anon;
grant select, insert, update, delete on public.home_meds_items, public.home_meds_trips, public.home_meds_members to authenticated;

drop policy if exists "Read own Home Meds items" on public.home_meds_items;
drop policy if exists "Create own Home Meds items" on public.home_meds_items;
drop policy if exists "Update own Home Meds items" on public.home_meds_items;
drop policy if exists "Delete own Home Meds items" on public.home_meds_items;
drop policy if exists "Home Meds household access items" on public.home_meds_items;
drop policy if exists "Home Meds household create items" on public.home_meds_items;
drop policy if exists "Home Meds household update items" on public.home_meds_items;
drop policy if exists "Home Meds household delete items" on public.home_meds_items;
create policy "Home Meds household access items"
  on public.home_meds_items for select to authenticated
  using (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household create items"
  on public.home_meds_items for insert to authenticated
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household update items"
  on public.home_meds_items for update to authenticated
  using (public.home_meds_can_access_owner(user_id))
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household delete items"
  on public.home_meds_items for delete to authenticated
  using (public.home_meds_can_access_owner(user_id));

drop policy if exists "Read own Home Meds trips" on public.home_meds_trips;
drop policy if exists "Create own Home Meds trips" on public.home_meds_trips;
drop policy if exists "Update own Home Meds trips" on public.home_meds_trips;
drop policy if exists "Delete own Home Meds trips" on public.home_meds_trips;
drop policy if exists "Home Meds household access trips" on public.home_meds_trips;
drop policy if exists "Home Meds household create trips" on public.home_meds_trips;
drop policy if exists "Home Meds household update trips" on public.home_meds_trips;
drop policy if exists "Home Meds household delete trips" on public.home_meds_trips;
create policy "Home Meds household access trips"
  on public.home_meds_trips for select to authenticated
  using (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household create trips"
  on public.home_meds_trips for insert to authenticated
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household update trips"
  on public.home_meds_trips for update to authenticated
  using (public.home_meds_can_access_owner(user_id))
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household delete trips"
  on public.home_meds_trips for delete to authenticated
  using (public.home_meds_can_access_owner(user_id));

drop policy if exists "Read own Home Meds members" on public.home_meds_members;
drop policy if exists "Create own Home Meds members" on public.home_meds_members;
drop policy if exists "Update own Home Meds members" on public.home_meds_members;
drop policy if exists "Delete own Home Meds members" on public.home_meds_members;
drop policy if exists "Home Meds household access members" on public.home_meds_members;
drop policy if exists "Home Meds household create members" on public.home_meds_members;
drop policy if exists "Home Meds household update members" on public.home_meds_members;
drop policy if exists "Home Meds household delete members" on public.home_meds_members;
create policy "Home Meds household access members"
  on public.home_meds_members for select to authenticated
  using (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household create members"
  on public.home_meds_members for insert to authenticated
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household update members"
  on public.home_meds_members for update to authenticated
  using (public.home_meds_can_access_owner(user_id))
  with check (public.home_meds_can_access_owner(user_id));
create policy "Home Meds household delete members"
  on public.home_meds_members for delete to authenticated
  using (public.home_meds_can_access_owner(user_id));

-- Private package photos are stored under the data owner's folder:
--   <owner_user_id>/<file-name>
-- A collaborator can use a signed URL/upload/delete only when that folder is
-- the owner of their household.  This preserves existing owner photo paths and
-- blocks access to every unrelated user folder.
create or replace function public.home_meds_can_access_owner_photo_path(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_folder_parts text[] := storage.foldername(p_object_name);
  v_owner_user_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

  begin
    v_owner_user_id := v_folder_parts[1]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return public.home_meds_can_access_owner(v_owner_user_id);
end;
$$;

drop policy if exists "Users manage own package photos" on storage.objects;
drop policy if exists "Home Meds members manage package photos" on storage.objects;
drop policy if exists "Home Meds members manage owner package photos" on storage.objects;
create policy "Home Meds members manage owner package photos"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_access_owner_photo_path(name)
  )
  with check (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_access_owner_photo_path(name)
  );

-- PostgreSQL grants EXECUTE to PUBLIC by default.  Remove that default from
-- every helper, then grant only the public RPCs and RLS predicates needed by an
-- authenticated browser session.
revoke all on function public.home_meds_can_access_owner(uuid) from public;
revoke all on function public.home_meds_is_household_member(uuid) from public;
revoke all on function public.home_meds_household_payload(uuid) from public;
revoke all on function public.home_meds_new_invite_code() from public;
revoke all on function public.home_meds_normalize_invite_code(text) from public;
revoke all on function public.home_meds_prevent_owner_change() from public;
revoke all on function public.home_meds_can_access_owner_photo_path(text) from public;
revoke all on function public.home_meds_get_household() from public;
revoke all on function public.home_meds_create_household() from public;
revoke all on function public.home_meds_join_household(text) from public;
revoke all on function public.home_meds_remove_household_member(uuid) from public;
revoke all on function public.home_meds_update_household_name(text) from public;

grant execute on function public.home_meds_can_access_owner(uuid) to authenticated;
grant execute on function public.home_meds_is_household_member(uuid) to authenticated;
grant execute on function public.home_meds_can_access_owner_photo_path(text) to authenticated;
grant execute on function public.home_meds_get_household() to authenticated;
grant execute on function public.home_meds_create_household() to authenticated;
grant execute on function public.home_meds_join_household(text) to authenticated;
grant execute on function public.home_meds_remove_household_member(uuid) to authenticated;
grant execute on function public.home_meds_update_household_name(text) to authenticated;
