-- Personal profile and editable trips for Home Meds.
-- Run after supabase/schema.sql in the Supabase SQL Editor.

create table if not exists public.home_meds_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  household_name text not null default 'Моя аптечка',
  updated_at timestamptz not null default now()
);

create table if not exists public.home_meds_trips (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  destination text not null default '',
  starts_on date,
  ends_on date,
  travellers text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_meds_trip_dates_check check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index if not exists home_meds_trips_user_idx on public.home_meds_trips(user_id, starts_on);

alter table public.home_meds_profiles enable row level security;
alter table public.home_meds_trips enable row level security;
revoke all on public.home_meds_profiles, public.home_meds_trips from anon;
grant select, insert, update, delete on public.home_meds_profiles, public.home_meds_trips to authenticated;

create policy "Read own Home Meds profile" on public.home_meds_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Home Meds profile" on public.home_meds_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own Home Meds profile" on public.home_meds_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own Home Meds profile" on public.home_meds_profiles for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Read own Home Meds trips" on public.home_meds_trips for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Home Meds trips" on public.home_meds_trips for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own Home Meds trips" on public.home_meds_trips for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own Home Meds trips" on public.home_meds_trips for delete to authenticated using ((select auth.uid()) = user_id);

drop trigger if exists set_home_meds_profiles_updated_at on public.home_meds_profiles;
create trigger set_home_meds_profiles_updated_at before update on public.home_meds_profiles for each row execute function public.set_updated_at();
drop trigger if exists set_home_meds_trips_updated_at on public.home_meds_trips;
create trigger set_home_meds_trips_updated_at before update on public.home_meds_trips for each row execute function public.set_updated_at();
