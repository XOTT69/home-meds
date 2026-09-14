-- Home Meds: manual home shopping list.
-- It is safe to run whether or not the optional activity-log migration has
-- already been installed.

-- Manual purchases share the same secure owner/household rules as medicines
-- and travel checklists, while staying out of the medicine grid.
alter table public.home_meds_items
  drop constraint if exists home_meds_items_kind_check;
alter table public.home_meds_items
  add constraint home_meds_items_kind_check
  check (kind in ('medicine', 'travel', 'shopping'));
