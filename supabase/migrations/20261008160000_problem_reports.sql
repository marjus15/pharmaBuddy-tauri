-- Problem reports from the pharmaBuddy widget («Αναφορά προβλήματος»).
-- Run this in the Supabase SQL editor after 20261008120000_pharmacy_login.sql.
-- The widget does not insert directly. The submit-problem-report edge function
-- uses the service role, checks the user JWT, and writes the pharmacy_id itself.
-- Do not commit service-role keys.

create table if not exists public.problem_reports (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null,
  pharmacy_id uuid not null references public.pharmacies (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  message text,
  app_version text not null,
  profile text not null,
  os_info text not null,
  logs text not null,
  created_at timestamptz not null default now(),
  constraint problem_reports_reference_code_key unique (reference_code),
  constraint problem_reports_reference_code_format
    check (reference_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'),
  constraint problem_reports_message_len
    check (message is null or char_length(message) <= 4000),
  constraint problem_reports_logs_len
    check (char_length(logs) <= 60000)
);

create index if not exists problem_reports_pharmacy_created_idx
  on public.problem_reports (pharmacy_id, created_at desc);

comment on table public.problem_reports is
  'Widget problem reports. reference_code is what the pharmacist reads over the phone.';

alter table public.problem_reports enable row level security;

revoke all on public.problem_reports from anon, public;
grant select on public.problem_reports to authenticated;

drop policy if exists "members read own pharmacy reports" on public.problem_reports;
create policy "members read own pharmacy reports"
  on public.problem_reports
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.pharmacy_members m
      where m.pharmacy_id = problem_reports.pharmacy_id
        and m.user_id = auth.uid()
    )
  );

-- No insert/update/delete policies. The edge function uses the service role,
-- which bypasses RLS. anon has no grant.
