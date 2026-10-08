-- Per-pharmacy login for the pharmaBuddy widget.
-- Run this in the Supabase SQL editor or via `supabase db push`.
-- Do not commit service-role keys. This migration does not insert users.
--
-- Existing `pharmacies` rows are kept. `active` is the one-flag kill switch
-- (backfilled from legacy `status` when that column exists).
-- `global_product_catalog` is not altered.

create table if not exists public.pharmacies (
  id uuid primary key default gen_random_uuid(),
  name text,
  active boolean,
  created_at timestamptz not null default now()
);

alter table public.pharmacies add column if not exists name text;
alter table public.pharmacies add column if not exists active boolean;
alter table public.pharmacies add column if not exists created_at timestamptz default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pharmacies'
      and column_name = 'business_name'
  ) then
    execute $sql$
      update public.pharmacies
      set name = business_name
      where (name is null or btrim(name) = '')
        and business_name is not null
        and btrim(business_name) <> ''
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pharmacies'
      and column_name = 'status'
  ) then
    execute $sql$
      update public.pharmacies
      set active = (lower(status) = 'active')
      where active is null
    $sql$;
  end if;
end $$;

update public.pharmacies
set name = 'Φαρμακείο'
where name is null or btrim(name) = '';

update public.pharmacies
set active = true
where active is null;

update public.pharmacies
set created_at = now()
where created_at is null;

alter table public.pharmacies alter column name set not null;
alter table public.pharmacies alter column active set default true;
alter table public.pharmacies alter column active set not null;
alter table public.pharmacies alter column created_at set default now();
alter table public.pharmacies alter column created_at set not null;

comment on column public.pharmacies.active is
  'Kill switch. false rejects widget calls for every login mapped to this pharmacy.';

do $$
declare
  id_type text;
begin
  select c.data_type into id_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'pharmacies'
    and c.column_name = 'id';

  if id_type is distinct from 'uuid' then
    raise exception
      'pharmacy login requires public.pharmacies.id to be uuid (found %)',
      coalesce(id_type, 'missing');
  end if;
end $$;

create table if not exists public.pharmacy_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pharmacy_id uuid not null references public.pharmacies (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists pharmacy_members_pharmacy_id_idx
  on public.pharmacy_members (pharmacy_id);

alter table public.pharmacies enable row level security;
alter table public.pharmacy_members enable row level security;

revoke all on public.pharmacies from anon, public;
revoke all on public.pharmacy_members from anon, public;
grant select on public.pharmacies to authenticated;
grant select on public.pharmacy_members to authenticated;

drop policy if exists "members read own pharmacy" on public.pharmacies;
create policy "members read own pharmacy"
  on public.pharmacies
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.pharmacy_members m
      where m.pharmacy_id = pharmacies.id
        and m.user_id = auth.uid()
    )
  );

drop policy if exists "read own membership" on public.pharmacy_members;
create policy "read own membership"
  on public.pharmacy_members
  for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies: accounts are created with the service role.
-- The service role bypasses RLS. anon has no policies and no grants.
