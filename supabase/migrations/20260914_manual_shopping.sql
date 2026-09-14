-- Home Meds: manual home shopping list.
-- Run after 20260914_cabinet_pro.sql.

-- Manual purchases share the same secure owner/household rules as medicines
-- and travel checklists, while staying out of the medicine grid.
alter table public.home_meds_items
  drop constraint if exists home_meds_items_kind_check;
alter table public.home_meds_items
  add constraint home_meds_items_kind_check
  check (kind in ('medicine', 'travel', 'shopping'));

-- Include a clear manual-shopping label in the shared activity log.
alter table public.home_meds_activity_log
  drop constraint if exists home_meds_activity_log_entity_type_check;
alter table public.home_meds_activity_log
  add constraint home_meds_activity_log_entity_type_check
  check (entity_type in ('medicine', 'trip', 'trip_item', 'family_member', 'shopping'));

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
    v_type := case
      when v_row->>'kind' = 'travel' then 'trip_item'
      when v_row->>'kind' = 'shopping' then 'shopping'
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

  insert into public.home_meds_activity_log (owner_user_id, actor_user_id, entity_type, entity_id, action, label)
  values (v_owner, auth.uid(), v_type, (v_row->>'id')::uuid, v_action, v_label);
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
