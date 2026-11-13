-- Add Proview Reservations (product "reservations") to the licence hub. Licensed per location, like Bookings.
-- The hub token is generated here; only its sha256 is copied into the Proview Reservations project
-- (hub_private.config.token_sha256 on stcfubsdrgmnriqxjgrj). Safe to run more than once.
alter table hub_private.apps drop constraint if exists apps_product_check, add constraint apps_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team','reservations']));
alter table public.lic_accounts drop constraint if exists lic_accounts_product_check, add constraint lic_accounts_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team','reservations']));
alter table public.lic_units drop constraint if exists lic_units_product_check, add constraint lic_units_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team','reservations']));
alter table public.lic_plans drop constraint if exists lic_plans_product_check, add constraint lic_plans_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team','reservations']));
insert into hub_private.apps(product, label, url, apikey, token, app_url)
values ('reservations', 'Proview Reservations', 'https://stcfubsdrgmnriqxjgrj.supabase.co', 'sb_publishable_8oitLRLNmSZdTYv1UZV3mQ_70AeCSvS',
        encode(extensions.gen_random_bytes(32), 'hex'), 'https://reservations.proviewcrm.co.uk')
on conflict (product) do nothing;
