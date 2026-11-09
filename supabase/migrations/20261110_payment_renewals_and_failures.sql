-- Online payments: monthly renewals and failed / declined payments
-- Safe to run more than once.

alter table public.lic_payments
  add column if not exists status text not null default 'paid',
  add column if not exists kind text not null default 'checkout',
  add column if not exists reason text,
  add column if not exists resolved boolean not null default false,
  add column if not exists subscription_id text;

do $$ begin
  alter table public.lic_payments add constraint lic_payments_status_chk check (status in ('paid','failed','abandoned'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.lic_payments add constraint lic_payments_kind_chk check (kind in ('checkout','renewal'));
exception when duplicate_object then null; end $$;

create index if not exists lic_payments_status_idx on public.lic_payments (status, resolved);

-- which Stripe subscription renews which licence (captured from the first checkout)
create table if not exists public.lic_subscriptions (
  subscription_id text primary key,
  product text not null,
  unit_ext_id text not null,
  plan text not null,
  email text,
  created_at timestamptz not null default now()
);
alter table public.lic_subscriptions enable row level security;
drop policy if exists subs_read on public.lic_subscriptions;
create policy subs_read on public.lic_subscriptions for select to authenticated using (public.is_lic_admin());
revoke all on public.lic_subscriptions from anon;
