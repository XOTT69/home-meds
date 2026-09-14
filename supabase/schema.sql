-- Run this whole file once in Supabase: SQL Editor → New query → Run.
-- Every record belongs to exactly one authenticated user.

create table if not exists public.home_meds_items (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('medicine', 'travel')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists home_meds_items_owner_kind_idx
  on public.home_meds_items (user_id, kind);

alter table public.home_meds_items enable row level security;

revoke all on table public.home_meds_items from anon;
grant select, insert, update, delete on table public.home_meds_items to authenticated;

drop policy if exists "Read own Home Meds items" on public.home_meds_items;
create policy "Read own Home Meds items"
  on public.home_meds_items for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Create own Home Meds items" on public.home_meds_items;
create policy "Create own Home Meds items"
  on public.home_meds_items for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Update own Home Meds items" on public.home_meds_items;
create policy "Update own Home Meds items"
  on public.home_meds_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Delete own Home Meds items" on public.home_meds_items;
create policy "Delete own Home Meds items"
  on public.home_meds_items for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_home_meds_items_updated_at on public.home_meds_items;
create trigger set_home_meds_items_updated_at
before update on public.home_meds_items
for each row execute function public.set_updated_at();
