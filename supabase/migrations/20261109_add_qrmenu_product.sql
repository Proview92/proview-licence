-- Add Proview QR Menu (product "qrmenu") to the licence portal. The hub token is generated here and only its
-- sha256 is copied into the QR Menu project (hub_private.config.token_sha256 on yblafwttmqaqvfvedaoc).
alter table hub_private.apps drop constraint apps_product_check, add constraint apps_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu']));
alter table public.lic_accounts drop constraint lic_accounts_product_check, add constraint lic_accounts_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu']));
alter table public.lic_units drop constraint lic_units_product_check, add constraint lic_units_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu']));
alter table public.lic_plans drop constraint lic_plans_product_check, add constraint lic_plans_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu']));
insert into hub_private.apps(product,label,url,apikey,token,app_url)
values ('qrmenu','Proview QR Menu','https://yblafwttmqaqvfvedaoc.supabase.co','sb_publishable_mcs45XaG9XHMWbyXO_PyCw_NQaQ08MR',encode(extensions.gen_random_bytes(32),'hex'),'https://qrmenu.proviewcrm.co.uk');
