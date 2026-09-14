-- Home Meds: roles, shared audit history and safe editor/viewer permissions.
-- Run this AFTER 20260914_shared_households.sql.

-- A collaborator can either edit the shared cabinet or only view it. Older
-- households store editors as `member`, so that value stays supported.
alter table public.home_meds_household_members
  drop constraint if exists home_meds_household_members_role_check;
alter table public.home_meds_household_members
  add constraint home_meds_household_members_role_check
  check (role in ('owner', 'member', 'viewer'));

create or replace function public.home_meds_can_edit_owner(p_owner_user_id uuid)
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
      from public.home_meds_households h
      join public.home_meds_household_members m on m.household_id = h.id
      where h.owner_user_id = p_owner_user_id
        and m.user_id = auth.uid()
        and m.role = 'member'
    )
  );
$$;

-- Viewers retain read access through home_meds_can_access_owner(), while all
-- mutations are restricted to the owner and editors.
drop policy if exists "Home Meds household create items" on public.home_meds_items;
drop policy if exists "Home Meds household update items" on public.home_meds_items;
drop policy if exists "Home Meds household delete items" on public.home_meds_items;
create policy "Home Meds household create items"
  on public.home_meds_items for insert to authenticated
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household update items"
  on public.home_meds_items for update to authenticated
  using (public.home_meds_can_edit_owner(user_id))
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household delete items"
  on public.home_meds_items for delete to authenticated
  using (public.home_meds_can_edit_owner(user_id));

drop policy if exists "Home Meds household create trips" on public.home_meds_trips;
drop policy if exists "Home Meds household update trips" on public.home_meds_trips;
drop policy if exists "Home Meds household delete trips" on public.home_meds_trips;
create policy "Home Meds household create trips"
  on public.home_meds_trips for insert to authenticated
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household update trips"
  on public.home_meds_trips for update to authenticated
  using (public.home_meds_can_edit_owner(user_id))
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household delete trips"
  on public.home_meds_trips for delete to authenticated
  using (public.home_meds_can_edit_owner(user_id));

drop policy if exists "Home Meds household create members" on public.home_meds_members;
drop policy if exists "Home Meds household update members" on public.home_meds_members;
drop policy if exists "Home Meds household delete members" on public.home_meds_members;
create policy "Home Meds household create members"
  on public.home_meds_members for insert to authenticated
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household update members"
  on public.home_meds_members for update to authenticated
  using (public.home_meds_can_edit_owner(user_id))
  with check (public.home_meds_can_edit_owner(user_id));
create policy "Home Meds household delete members"
  on public.home_meds_members for delete to authenticated
  using (public.home_meds_can_edit_owner(user_id));

-- Package photos use the same edit-only permission (viewers can still read a
-- signed URL from the app but cannot upload or remove another user's file).
create or replace function public.home_meds_can_edit_owner_photo_path(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_user_id uuid;
begin
  begin
    v_owner_user_id := split_part(coalesce(p_object_name, ''), '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return public.home_meds_can_edit_owner(v_owner_user_id);
end;
$$;
drop policy if exists "Home Meds members manage owner package photos" on storage.objects;
drop policy if exists "Home Meds editors manage owner package photos" on storage.objects;
create policy "Home Meds editors manage owner package photos"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  )
  with check (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  );

-- Owners can change a collaborator between editor and view-only mode.
create or replace function public.home_meds_update_household_member_role(
  member_user_id uuid,
  new_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_household_id uuid;
  v_role text := lower(btrim(coalesce(new_role, '')));
  v_database_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if v_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer' using errcode = '22023';
  end if;
  select id into v_household_id
  from public.home_meds_households
  where owner_user_id = auth.uid()
  for update;
  if v_household_id is null then
    raise exception 'Only the household owner can change roles' using errcode = '42501';
  end if;
  if member_user_id = auth.uid() then
    raise exception 'The owner role cannot be changed here' using errcode = '22023';
  end if;
  v_database_role := case when v_role = 'editor' then 'member' else 'viewer' end;
  update public.home_meds_household_members
    set role = v_database_role
  where household_id = v_household_id
    and user_id = member_user_id
    and role <> 'owner';
  if not found then
    raise exception 'Participant not found' using errcode = 'P0002';
  end if;
  return public.home_meds_household_payload(v_household_id);
end;
$$;

-- A compact immutable audit feed. The browser can read it but cannot insert
-- fake events; trigger functions write events after successful mutations.
create table if not exists public.home_meds_activity_log (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('medicine', 'trip', 'trip_item', 'family_member')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'updated', 'deleted')),
  label text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists home_meds_activity_log_owner_created_idx
  on public.home_meds_activity_log (owner_user_id, created_at desc);
alter table public.home_meds_activity_log enable row level security;
revoke all on public.home_meds_activity_log from anon;
grant select on public.home_meds_activity_log to authenticated;
drop policy if exists "Home Meds household reads activity" on public.home_meds_activity_log;
create policy "Home Meds household reads activity"
  on public.home_meds_activity_log for select to authenticated
  using (public.home_meds_can_access_owner(owner_user_id));

create or replace function public.home_meds_record_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb := case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_owner uuid := (v_row->>'user_id')::uuid;
  v_payload jsonb := coalesce(v_row->'payload', '{}'::jsonb);
  v_type text;
  v_label text;
  v_action text := case TG_OP when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
begin
  if auth.uid() is null or v_owner is null then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;
  if TG_TABLE_NAME = 'home_meds_items' then
    v_type := case when v_row->>'kind' = 'travel' then 'trip_item' else 'medicine' end;
    v_label := coalesce(nullif(btrim(v_payload->>'name'), ''), nullif(btrim(v_payload->>'title'), ''), 'Без назви');
  elsif TG_TABLE_NAME = 'home_meds_trips' then
    v_type := 'trip'; v_label := coalesce(nullif(btrim(v_row->>'title'), ''), 'Подорож без назви');
  else
    v_type := 'family_member'; v_label := coalesce(nullif(btrim(v_row->>'name'), ''), 'Профіль родини');
  end if;
  insert into public.home_meds_activity_log (owner_user_id, actor_user_id, entity_type, entity_id, action, label)
  values (v_owner, auth.uid(), v_type, (v_row->>'id')::uuid, v_action, v_label);
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists record_home_meds_items_activity on public.home_meds_items;
create trigger record_home_meds_items_activity after insert or update or delete on public.home_meds_items
  for each row execute function public.home_meds_record_activity();
drop trigger if exists record_home_meds_trips_activity on public.home_meds_trips;
create trigger record_home_meds_trips_activity after insert or update or delete on public.home_meds_trips
  for each row execute function public.home_meds_record_activity();
drop trigger if exists record_home_meds_members_activity on public.home_meds_members;
create trigger record_home_meds_members_activity after insert or update or delete on public.home_meds_members
  for each row execute function public.home_meds_record_activity();

revoke all on function public.home_meds_can_edit_owner(uuid) from public;
grant execute on function public.home_meds_can_edit_owner(uuid) to authenticated;
grant execute on function public.home_meds_can_edit_owner_photo_path(text) to authenticated;
grant execute on function public.home_meds_update_household_member_role(uuid, text) to authenticated;
