-- Home Meds: production hardening for shared photos, live family sync and
-- correctly classified shopping activity.
-- Run after 20260914_cabinet_pro.sql and 20260914_manual_shopping.sql.

-- View-only family members may read private package photos, but only owners
-- and editors may upload, replace or delete them.
drop policy if exists "Users manage own package photos" on storage.objects;
drop policy if exists "Home Meds members manage package photos" on storage.objects;
drop policy if exists "Home Meds members manage owner package photos" on storage.objects;
drop policy if exists "Home Meds editors manage owner package photos" on storage.objects;
drop policy if exists "Home Meds household reads package photos" on storage.objects;
drop policy if exists "Home Meds editors insert package photos" on storage.objects;
drop policy if exists "Home Meds editors update package photos" on storage.objects;
drop policy if exists "Home Meds editors delete package photos" on storage.objects;

create policy "Home Meds household reads package photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_access_owner_photo_path(name)
  );

create policy "Home Meds editors insert package photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  );

create policy "Home Meds editors update package photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  )
  with check (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  );

create policy "Home Meds editors delete package photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'home-meds-photos'
    and public.home_meds_can_edit_owner_photo_path(name)
  );

-- Supabase Realtime powers automatic refresh on every connected family
-- device. The RLS policies above still decide which rows each user receives.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['home_meds_items', 'home_meds_trips', 'home_meds_members']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

-- Older installations logged manual shopping rows as medicines. Keep the
-- migration safe when the optional activity table has not been installed.
do $$
begin
  if to_regclass('public.home_meds_activity_log') is not null then
    alter table public.home_meds_activity_log
      drop constraint if exists home_meds_activity_log_entity_type_check;
    alter table public.home_meds_activity_log
      add constraint home_meds_activity_log_entity_type_check
      check (entity_type in ('medicine', 'trip', 'trip_item', 'family_member', 'shopping'));
  end if;
end;
$$;

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
    v_type := case v_row->>'kind'
      when 'travel' then 'trip_item'
      when 'shopping' then 'shopping'
      else 'medicine'
    end;
    v_label := coalesce(nullif(btrim(v_payload->>'name'), ''), nullif(btrim(v_payload->>'title'), ''), 'Без назви');
  elsif TG_TABLE_NAME = 'home_meds_trips' then
    v_type := 'trip';
    v_label := coalesce(nullif(btrim(v_row->>'title'), ''), 'Подорож без назви');
  else
    v_type := 'family_member';
    v_label := coalesce(nullif(btrim(v_row->>'name'), ''), 'Профіль родини');
  end if;

  if to_regclass('public.home_meds_activity_log') is not null then
    insert into public.home_meds_activity_log
      (owner_user_id, actor_user_id, entity_type, entity_id, action, label)
    values
      (v_owner, auth.uid(), v_type, (v_row->>'id')::uuid, v_action, v_label);
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.home_meds_record_activity() from public, anon, authenticated;
