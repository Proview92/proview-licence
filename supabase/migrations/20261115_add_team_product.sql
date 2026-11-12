-- Add Proview Team (product "team") to the licence hub. Licensed per location, like Bookings.
-- The hub token is generated here; only its sha256 is copied into the Proview Team project
-- (hub_private.config.token_sha256 on guiwijyxzyffnmiiwpcf). Safe to run more than once.
alter table hub_private.apps drop constraint if exists apps_product_check, add constraint apps_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team']));
alter table public.lic_accounts drop constraint if exists lic_accounts_product_check, add constraint lic_accounts_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team']));
alter table public.lic_units drop constraint if exists lic_units_product_check, add constraint lic_units_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team']));
alter table public.lic_plans drop constraint if exists lic_plans_product_check, add constraint lic_plans_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label','team']));
insert into hub_private.apps(product, label, url, apikey, token, app_url)
values ('team', 'Proview Team', 'https://guiwijyxzyffnmiiwpcf.supabase.co', 'sb_publishable_j6XpQ7z1VK6SsKDqzgbfuw_MNdGNQJz',
        encode(extensions.gen_random_bytes(32), 'hex'), 'https://team.proviewcrm.co.uk')
on conflict (product) do nothing;
