-- Family members, private package photos and reminder preferences.
create table if not exists public.home_meds_members (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  relation text not null default '',
  allergies text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);
alter table public.home_meds_members enable row level security;
revoke all on public.home_meds_members from anon;
grant select, insert, update, delete on public.home_meds_members to authenticated;
create policy "Read own Home Meds members" on public.home_meds_members for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Home Meds members" on public.home_meds_members for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own Home Meds members" on public.home_meds_members for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own Home Meds members" on public.home_meds_members for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public) values ('home-meds-photos', 'home-meds-photos', false)
on conflict (id) do nothing;
create policy "Users manage own package photos" on storage.objects for all to authenticated
using (bucket_id = 'home-meds-photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'home-meds-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
