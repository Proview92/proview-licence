-- Licence units get a KIND, and prices are per product AND kind (PER_LOCATION_LICENCE_SPEC + LABEL_LICENCE_SPEC, 11 Nov 2026).
-- Every app now licenses each location; Signage also each TV and Employee each extra person ("Staff add-on").
--   lic_units.kind          'location' | 'screen' (shown as TV) | 'staff' (shown as Staff add-on). Existing rows: Signage = screen,
--                           Employee = staff, every other app (Bookings, QR Menu, WiFi, Label) = location.
--   lic_plans.kind          the same; the key becomes (product, kind, plan), so e.g. Signage location m12 and Signage TV m12.
--   lic_subscriptions.kind  which kind a Stripe subscription renews (null on older rows = the product's default kind).
--   lic_payments.unit_kind  the kind a payment was for (display; null on older rows).
-- Apps that don't send a kind yet keep working: the licence hub stores their units as their old kind.
-- Run before deploying the licence-hub edge function that writes these columns. Safe to run more than once.

alter table public.lic_units add column if not exists kind text;
update public.lic_units set kind = case product when 'signage' then 'screen' when 'employee' then 'staff' else 'location' end where kind is null;
alter table public.lic_units alter column kind set default 'location', alter column kind set not null;
alter table public.lic_units drop constraint if exists lic_units_kind_check,
  add constraint lic_units_kind_check check (kind in ('location', 'screen', 'staff'));

alter table public.lic_plans add column if not exists kind text;
update public.lic_plans set kind = case product when 'signage' then 'screen' when 'employee' then 'staff' else 'location' end where kind is null;
alter table public.lic_plans alter column kind set default 'location', alter column kind set not null;
alter table public.lic_plans drop constraint if exists lic_plans_kind_check,
  add constraint lic_plans_kind_check check (kind in ('location', 'screen', 'staff'));
do $$
begin
  if (select array_agg(a.attname::text order by k.ord) from pg_constraint c
        cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conname = 'lic_plans_pkey' and c.conrelid = 'public.lic_plans'::regclass) is distinct from array['product', 'kind', 'plan'] then
    alter table public.lic_plans drop constraint if exists lic_plans_pkey;
    alter table public.lic_plans add constraint lic_plans_pkey primary key (product, kind, plan);
  end if;
end $$;

alter table public.lic_subscriptions add column if not exists kind text;
alter table public.lic_subscriptions drop constraint if exists lic_subscriptions_kind_check,
  add constraint lic_subscriptions_kind_check check (kind is null or kind in ('location', 'screen', 'staff'));
alter table public.lic_payments add column if not exists unit_kind text;
alter table public.lic_payments drop constraint if exists lic_payments_unit_kind_check,
  add constraint lic_payments_unit_kind_check check (unit_kind is null or unit_kind in ('location', 'screen', 'staff'));

comment on column public.lic_units.kind is 'location | screen (TV) | staff (Staff add-on). Set by the licence hub sync; apps that send no kind = their old kind.';
comment on column public.lic_plans.kind is 'Which kind of licence this price is for (key: product, kind, plan).';
