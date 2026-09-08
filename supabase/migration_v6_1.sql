-- Family Allowance Tracker v6.1
-- SAFE migration: preserves existing allowance data and existing parent accounts.

create table if not exists public.viewer_requests (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_normalized text not null,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  approved_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);

create unique index if not exists viewer_requests_one_pending_name
  on public.viewer_requests(username_normalized)
  where status='pending';

alter table public.viewer_requests enable row level security;

drop policy if exists "parents read viewer requests" on public.viewer_requests;
drop policy if exists "parents update viewer requests" on public.viewer_requests;
create policy "parents read viewer requests" on public.viewer_requests
  for select to authenticated using (public.is_parent(auth.uid()));
create policy "parents update viewer requests" on public.viewer_requests
  for update to authenticated using (public.is_parent(auth.uid()))
  with check (public.is_parent(auth.uid()));
