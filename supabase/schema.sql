-- Family Allowance Tracker v2
-- Run this entire file in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  role text not null default 'pending' check (role in ('parent','child','pending')),
  created_at timestamptz not null default now()
);

create table if not exists public.children (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.allowance_periods (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete restrict,
  effective_from date not null,
  monthly_allowance numeric(10,2) not null check (monthly_allowance >= 0),
  created_at timestamptz not null default now(),
  unique(child_id, effective_from)
);

create table if not exists public.monthly_allowances (
  child_id uuid not null references public.children(id) on delete restrict,
  month_start date not null,
  starting_allowance numeric(10,2) not null check (starting_allowance >= 0),
  created_at timestamptz not null default now(),
  primary key(child_id, month_start)
);

create table if not exists public.settings (
  id boolean primary key default true,
  max_daily_dings numeric(10,2) not null default 5.00 check (max_daily_dings >= 0),
  max_weekly_dings numeric(10,2) not null default 10.00 check (max_weekly_dings >= 0),
  prevent_negative_balance boolean not null default true,
  backdate_days integer not null default 7 check (backdate_days between 0 and 31),
  prevent_duplicate_rule_same_day boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.allowance_rules (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  type text not null check (type in ('ding','earn')),
  name text not null,
  amount numeric(10,2) not null check (amount > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(child_id, type, name)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete restrict,
  rule_id uuid references public.allowance_rules(id) on delete restrict,
  type text not null check (type in ('ding','earn')),
  amount numeric(10,2) not null check (amount > 0),
  reason text not null,
  note text,
  event_date date not null default current_date,
  requested_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  decided_by uuid references auth.users(id) on delete set null,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  reversal_of uuid references public.transactions(id) on delete restrict
);

create index if not exists transactions_child_date_idx on public.transactions(child_id, event_date desc, created_at desc);
create index if not exists transactions_status_idx on public.transactions(status, created_at desc);
create index if not exists allowance_periods_child_date_idx on public.allowance_periods(child_id, effective_from desc);

insert into public.settings (id) values (true) on conflict (id) do nothing;

insert into public.children (name) values ('Nathan'), ('Matthew') on conflict (name) do nothing;

-- Initial allowance rates. Change effective_from if you are setting this up for a different month.
insert into public.allowance_periods(child_id, effective_from, monthly_allowance)
select id, date '2026-09-01', case when name='Nathan' then 40.00 else 30.00 end
from public.children
where name in ('Nathan','Matthew')
on conflict (child_id, effective_from) do nothing;

-- Sheet rules.
insert into public.allowance_rules(child_id, type, name, amount, sort_order)
select c.id, r.type, r.name, case when c.name='Nathan' then 1.00 else 0.50 end, r.sort_order
from public.children c
cross join (values
  ('ding','Bedroom not reasonably picked up by Sunday night before bedtime',10),
  ('ding','Does not complete an assigned chore',20),
  ('ding','Leaves dishes, wrappers, or food mess behind',30),
  ('ding','Does not put things away after moving/using them',40),
  ('ding','Disrespectful, rude, or sarcastic response to an adult',50),
  ('ding','Fighting, teasing, or intentionally being unkind to brother',60),
  ('ding','Breaks an agreed-upon screen-time rule',70),
  ('ding','Uses a device after the agreed-upon bedtime/device time',80),
  ('ding','Does not return shared areas/items to the way they were',90),
  ('ding','Shoes, clothes, backpack, etc. left out in common areas',100),
  ('earn','Complete an extra household chore',10),
  ('earn','Help Mom, Joe, or brother with a task',20),
  ('earn','Clean a shared area without being reminded',30),
  ('earn','Take initiative and notice something that needs to be done',40),
  ('earn','Complete responsibilities without reminders for 5 days in a row',50),
  ('earn','Use good table manners throughout a meal',60),
  ('earn','Walk dog an extra 30 minutes',70)
) r(type,name,sort_order)
where c.name in ('Nathan','Matthew')
on conflict (child_id, type, name) do nothing;

-- Profile trigger. New accounts start as pending and MUST be promoted to parent manually.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email,''), '@', 1)), new.email, 'pending')
  on conflict (id) do update set email=excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.is_parent(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id=uid and role='parent');
$$;

create or replace function public.month_start(p_date date)
returns date language sql immutable as $$ select date_trunc('month', p_date)::date; $$;

create or replace function public.starting_allowance(p_child uuid, p_month date)
returns numeric language sql stable security definer set search_path = public as $$
  select ap.monthly_allowance
  from public.allowance_periods ap
  where ap.child_id=p_child and ap.effective_from <= public.month_start(p_month)
  order by ap.effective_from desc limit 1;
$$;

create or replace function public.ensure_month_snapshot(p_month date)
returns void language plpgsql security definer set search_path = public as $$
declare c record; ms date := public.month_start(p_month); a numeric;
begin
  if not public.is_parent(auth.uid()) then raise exception 'Parent access required.'; end if;
  for c in select id from public.children where active loop
    if not exists(select 1 from public.monthly_allowances where child_id=c.id and month_start=ms) then
      a := public.starting_allowance(c.id, ms);
      if a is null then raise exception 'No allowance rate exists for %.', ms; end if;
      insert into public.monthly_allowances(child_id, month_start, starting_allowance) values(c.id, ms, a) on conflict do nothing;
    end if;
  end loop;
end;
$$;

create or replace function public.month_balance(p_child uuid, p_date date default current_date)
returns numeric language sql stable security definer set search_path = public as $$
  select round(ma.starting_allowance + coalesce(sum(case when t.type='earn' then t.amount else -t.amount end),0),2)
  from public.monthly_allowances ma
  left join public.transactions t on t.child_id=ma.child_id
    and t.status='approved'
    and t.event_date >= ma.month_start
    and t.event_date < ma.month_start + interval '1 month'
  where ma.child_id=p_child and ma.month_start=public.month_start(p_date)
  group by ma.starting_allowance;
$$;

-- Transaction inserts are limited to pending requests created by the current parent.
drop policy if exists transactions_update on public.transactions;
drop policy if exists transactions_delete on public.transactions;

create or replace function public.submit_transaction(
  p_child uuid,
  p_rule uuid,
  p_event_date date,
  p_note text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.allowance_rules%rowtype; s public.settings%rowtype; id uuid;
begin
  if not public.is_parent(auth.uid()) then raise exception 'Parent access required.'; end if;
  select * into s from public.settings where id=true;
  if p_event_date < current_date - s.backdate_days then raise exception 'Entries can only be backdated % days.', s.backdate_days; end if;
  if p_event_date > current_date then raise exception 'Future entries are not allowed.'; end if;
  select * into r from public.allowance_rules where id=p_rule and child_id=p_child and active=true;
  if not found then raise exception 'Invalid or inactive allowance rule.'; end if;
  if s.prevent_duplicate_rule_same_day and exists(
    select 1 from public.transactions where child_id=p_child and rule_id=p_rule and event_date=p_event_date and status in ('pending','approved')
  ) then raise exception 'That rule has already been entered for this child on this date.'; end if;
  insert into public.transactions(child_id,rule_id,type,amount,reason,note,event_date,requested_by,status)
  values(p_child,p_rule,r.type,r.amount,r.name,p_note,p_event_date,auth.uid(),'pending') returning transactions.id into id;
  return id;
end;
$$;

-- Atomically approve/decline. Approved records are immutable afterwards.
create or replace function public.decide_transaction(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; s public.settings%rowtype; ma numeric; daily numeric; weekly numeric; startm date; wk date;
begin
  if not public.is_parent(auth.uid()) then raise exception 'Parent access required.'; end if;
  select * into t from public.transactions where id=p_id for update;
  if not found then raise exception 'Transaction not found.'; end if;
  if t.status <> 'pending' then raise exception 'This transaction has already been decided.'; end if;
  if t.requested_by=auth.uid() then raise exception 'A different parent must approve or decline this item.'; end if;

  if not p_approve then
    update public.transactions set status='declined', decided_by=auth.uid(), decision_note=nullif(trim(p_note),'') , decided_at=now() where id=p_id;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('allowance:'||t.child_id::text||':'||public.month_start(t.event_date)::text, 0));
  select * into s from public.settings where id=true;
  perform public.ensure_month_snapshot(t.event_date);
  startm := public.month_start(t.event_date);
  wk := date_trunc('week', t.event_date)::date;

  if t.type='ding' then
    select coalesce(sum(amount),0) into daily from public.transactions where child_id=t.child_id and type='ding' and status='approved' and event_date=t.event_date;
    if daily+t.amount > s.max_daily_dings then raise exception 'Daily Ding limit of $% would be exceeded.', s.max_daily_dings; end if;
    select coalesce(sum(amount),0) into weekly from public.transactions where child_id=t.child_id and type='ding' and status='approved' and event_date>=wk and event_date<wk+7;
    if weekly+t.amount > s.max_weekly_dings then raise exception 'Weekly Ding limit of $% would be exceeded.', s.max_weekly_dings; end if;
    if s.prevent_negative_balance and coalesce(public.month_balance(t.child_id,t.event_date),0)-t.amount < 0 then raise exception 'This Ding would make the monthly allowance negative.'; end if;
  else
    ma := public.month_balance(t.child_id,t.event_date);
    select starting_allowance into ma from public.monthly_allowances where child_id=t.child_id and month_start=startm;
    if coalesce(public.month_balance(t.child_id,t.event_date),0)+t.amount > ma then raise exception 'Earn-back would exceed the child''s monthly starting allowance.'; end if;
  end if;

  update public.transactions set status='approved', decided_by=auth.uid(), decision_note=nullif(trim(p_note),''), decided_at=now() where id=p_id;
end;
$$;

-- Reversal/correction is itself a new transaction and requires the normal approval process.
create or replace function public.submit_reversal(p_original uuid, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; id uuid;
begin
  if not public.is_parent(auth.uid()) then raise exception 'Parent access required.'; end if;
  select * into t from public.transactions where id=p_original and status='approved';
  if not found then raise exception 'Only an approved transaction can be corrected.'; end if;
  if exists(select 1 from public.transactions where reversal_of=p_original and status in ('pending','approved')) then raise exception 'A correction already exists for this transaction.'; end if;
  insert into public.transactions(child_id,rule_id,type,amount,reason,note,event_date,requested_by,status,reversal_of)
  values(t.child_id,t.rule_id,case when t.type='ding' then 'earn' else 'ding' end,t.amount,'Correction: reverse prior entry',coalesce(p_note,'Correction'),t.event_date,auth.uid(),'pending',p_original)
  returning transactions.id into id;
  return id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.children enable row level security;
alter table public.allowance_periods enable row level security;
alter table public.monthly_allowances enable row level security;
alter table public.settings enable row level security;
alter table public.allowance_rules enable row level security;
alter table public.transactions enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (public.is_parent(auth.uid()) or id=auth.uid());

drop policy if exists children_select on public.children;
create policy children_select on public.children for select to authenticated using (public.is_parent(auth.uid()));

drop policy if exists allowance_periods_select on public.allowance_periods;
create policy allowance_periods_select on public.allowance_periods for select to authenticated using (public.is_parent(auth.uid()));

drop policy if exists monthly_allowances_select on public.monthly_allowances;
create policy monthly_allowances_select on public.monthly_allowances for select to authenticated using (public.is_parent(auth.uid()));

drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated using (public.is_parent(auth.uid()));
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated using (public.is_parent(auth.uid())) with check (public.is_parent(auth.uid()));

drop policy if exists allowance_rules_select on public.allowance_rules;
create policy allowance_rules_select on public.allowance_rules for select to authenticated using (public.is_parent(auth.uid()));
drop policy if exists allowance_rules_update on public.allowance_rules;
create policy allowance_rules_update on public.allowance_rules for update to authenticated using (public.is_parent(auth.uid())) with check (public.is_parent(auth.uid()));

-- Transactions can be read/inserted, but approval/decline is ONLY through decide_transaction().
drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions for select to authenticated using (public.is_parent(auth.uid()));
drop policy if exists transactions_insert on public.transactions;
create policy transactions_insert on public.transactions for insert to authenticated with check (false);

-- Never allow direct UPDATE or DELETE from the client.
create policy transactions_update_none on public.transactions for update to authenticated using (false) with check (false);
create policy transactions_delete_none on public.transactions for delete to authenticated using (false);

-- IMPORTANT SETUP STEP:
-- After creating Joe and Delanda's Auth users, promote ONLY those two profiles:
-- update public.profiles set role='parent' where email in ('JOE_EMAIL_HERE','DELANDA_EMAIL_HERE');
-- Do not expose that SQL to the browser and never use a service-role key in the app.


-- v4 behavior overrides (web-only app):
-- Family Allowance Tracker v4 migration
-- Run this in Supabase SQL Editor for an EXISTING v3 database.

-- Allow the same rule to be used more than once on the same day.
update public.settings
set prevent_duplicate_rule_same_day = false
where id = true;

-- Remove the old four-argument version before creating the new version.
drop function if exists public.submit_transaction(uuid, uuid, date, text);

-- Replace transaction submission logic.
-- Dings are pending until approved by the other parent.
-- Earn-backs are approved immediately and affect the allowance right away.
-- p_rule may be NULL for an "Other ding"; p_custom_reason is then required.
create or replace function public.submit_transaction(
  p_child uuid,
  p_rule uuid,
  p_event_date date,
  p_note text default null,
  p_custom_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule public.allowance_rules%rowtype;
  v_settings public.settings%rowtype;
  v_transaction_id uuid;
  v_amount numeric(10,2);
  v_type text;
  v_reason text;
  v_starting_allowance numeric(10,2);
  v_current_balance numeric(10,2);
begin
  if not public.is_parent(auth.uid()) then
    raise exception 'Parent access required.';
  end if;

  select s.* into v_settings
  from public.settings s
  where s.id = true;

  if p_event_date < current_date - v_settings.backdate_days then
    raise exception 'Entries can only be backdated % days.', v_settings.backdate_days;
  end if;

  if p_event_date > current_date then
    raise exception 'Future entries are not allowed.';
  end if;

  if p_rule is null then
    -- "Other" is intentionally supported only for dings.
    if nullif(trim(coalesce(p_custom_reason, '')), '') is null then
      raise exception 'Please enter what the Ding was for.';
    end if;

    select ar.amount into v_amount
    from public.allowance_rules ar
    where ar.child_id = p_child
      and ar.type = 'ding'
      and ar.active = true
    order by ar.sort_order
    limit 1;

    if v_amount is null then
      raise exception 'No active Ding amount is configured for this child.';
    end if;

    v_type := 'ding';
    v_reason := trim(p_custom_reason);
  else
    select ar.* into v_rule
    from public.allowance_rules ar
    where ar.id = p_rule
      and ar.child_id = p_child
      and ar.active = true;

    if not found then
      raise exception 'Invalid or inactive allowance rule.';
    end if;

    v_type := v_rule.type;
    v_amount := v_rule.amount;
    v_reason := v_rule.name;
  end if;

  -- Earn-backs are immediate, but cannot take the child above the monthly starting allowance.
  if v_type = 'earn' then
    perform public.ensure_month_snapshot(p_event_date);

    select ma.starting_allowance into v_starting_allowance
    from public.monthly_allowances ma
    where ma.child_id = p_child
      and ma.month_start = public.month_start(p_event_date);

    v_current_balance := coalesce(public.month_balance(p_child, p_event_date), 0);

    if v_current_balance + v_amount > v_starting_allowance then
      raise exception 'Earn-back would exceed the child''s monthly starting allowance.';
    end if;

    insert into public.transactions(
      child_id, rule_id, type, amount, reason, note, event_date,
      requested_by, status, decided_by, decided_at
    ) values (
      p_child, p_rule, v_type, v_amount, v_reason, nullif(trim(p_note), ''), p_event_date,
      auth.uid(), 'approved', auth.uid(), now()
    )
    returning public.transactions.id into v_transaction_id;
  else
    -- Dings require approval by the other parent.
    insert into public.transactions(
      child_id, rule_id, type, amount, reason, note, event_date,
      requested_by, status
    ) values (
      p_child, p_rule, v_type, v_amount, v_reason, nullif(trim(p_note), ''), p_event_date,
      auth.uid(), 'pending'
    )
    returning public.transactions.id into v_transaction_id;
  end if;

  return v_transaction_id;
end;
$$;

-- Replace approval/decline logic with fully qualified references to avoid ambiguous-column errors.
create or replace function public.decide_transaction(
  p_id uuid,
  p_approve boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction public.transactions%rowtype;
  v_settings public.settings%rowtype;
  v_daily numeric(10,2);
  v_weekly numeric(10,2);
  v_week_start date;
begin
  if not public.is_parent(auth.uid()) then
    raise exception 'Parent access required.';
  end if;

  select tx.* into v_transaction
  from public.transactions tx
  where tx.id = p_id
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

  if v_transaction.status <> 'pending' then
    raise exception 'This transaction has already been decided.';
  end if;

  if v_transaction.type <> 'ding' then
    raise exception 'Earn-backs are approved immediately and do not require approval.';
  end if;

  if v_transaction.requested_by = auth.uid() then
    raise exception 'A different parent must approve or decline this Ding.';
  end if;

  if not p_approve then
    update public.transactions tx
    set status = 'declined',
        decided_by = auth.uid(),
        decision_note = nullif(trim(p_note), ''),
        decided_at = now()
    where tx.id = p_id;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'allowance:' || v_transaction.child_id::text || ':' || public.month_start(v_transaction.event_date)::text,
      0
    )
  );

  select s.* into v_settings
  from public.settings s
  where s.id = true;

  perform public.ensure_month_snapshot(v_transaction.event_date);

  v_week_start := date_trunc('week', v_transaction.event_date)::date;

  select coalesce(sum(tx.amount), 0) into v_daily
  from public.transactions tx
  where tx.child_id = v_transaction.child_id
    and tx.type = 'ding'
    and tx.status = 'approved'
    and tx.event_date = v_transaction.event_date;

  if v_daily + v_transaction.amount > v_settings.max_daily_dings then
    raise exception 'Daily Ding limit of $% would be exceeded.', v_settings.max_daily_dings;
  end if;

  select coalesce(sum(tx.amount), 0) into v_weekly
  from public.transactions tx
  where tx.child_id = v_transaction.child_id
    and tx.type = 'ding'
    and tx.status = 'approved'
    and tx.event_date >= v_week_start
    and tx.event_date < v_week_start + 7;

  if v_weekly + v_transaction.amount > v_settings.max_weekly_dings then
    raise exception 'Weekly Ding limit of $% would be exceeded.', v_settings.max_weekly_dings;
  end if;

  if v_settings.prevent_negative_balance
     and coalesce(public.month_balance(v_transaction.child_id, v_transaction.event_date), 0) - v_transaction.amount < 0 then
    raise exception 'This Ding would make the monthly allowance negative.';
  end if;

  update public.transactions tx
  set status = 'approved',
      decided_by = auth.uid(),
      decision_note = nullif(trim(p_note), ''),
      decided_at = now()
  where tx.id = p_id;
end;
$$;

-- Corrections follow the new approval rule too:
-- reversing a Ding creates an Earn-back and is immediate;
-- reversing an Earn-back creates a Ding and requires the other parent's approval.
create or replace function public.submit_reversal(
  p_original uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.transactions%rowtype;
  v_transaction_id uuid;
  v_reverse_type text;
begin
  if not public.is_parent(auth.uid()) then
    raise exception 'Parent access required.';
  end if;

  select tx.* into v_original
  from public.transactions tx
  where tx.id = p_original
    and tx.status = 'approved';

  if not found then
    raise exception 'Only an approved transaction can be corrected.';
  end if;

  if exists (
    select 1
    from public.transactions tx
    where tx.reversal_of = p_original
      and tx.status in ('pending', 'approved')
  ) then
    raise exception 'A correction already exists for this transaction.';
  end if;

  v_reverse_type := case when v_original.type = 'ding' then 'earn' else 'ding' end;

  insert into public.transactions(
    child_id, rule_id, type, amount, reason, note, event_date,
    requested_by, status, decided_by, decided_at, reversal_of
  ) values (
    v_original.child_id,
    v_original.rule_id,
    v_reverse_type,
    v_original.amount,
    'Correction: reverse prior entry',
    coalesce(nullif(trim(p_note), ''), 'Correction'),
    v_original.event_date,
    auth.uid(),
    case when v_reverse_type = 'earn' then 'approved' else 'pending' end,
    case when v_reverse_type = 'earn' then auth.uid() else null end,
    case when v_reverse_type = 'earn' then now() else null end,
    p_original
  )
  returning public.transactions.id into v_transaction_id;

  return v_transaction_id;
end;
$$;
