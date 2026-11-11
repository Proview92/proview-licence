-- Add Proview Label (product "label") to the licence hub, for "New customer" in the ticked apps (NEW_CUSTOMER_MULTIAPP_SPEC).
-- The hub token is generated here, when this runs; only its sha256 goes to the Label project (fiqoirnlmhjzicvktdwa),
-- the same way as QR Menu (20261109). Run Label's 008_hub_link.sql first, then this, then the one line this prints,
-- in Label's SQL editor. Until that line runs, Label refuses every hub call. Safe to run more than once
-- (the token is made once and kept).
alter table hub_private.apps drop constraint if exists apps_product_check, add constraint apps_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label']));
alter table public.lic_accounts drop constraint if exists lic_accounts_product_check, add constraint lic_accounts_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label']));
alter table public.lic_units drop constraint if exists lic_units_product_check, add constraint lic_units_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label']));
alter table public.lic_plans drop constraint if exists lic_plans_product_check, add constraint lic_plans_product_check check (product = any (array['signage','bookings','employee','wifi','qrmenu','label']));
insert into hub_private.apps(product, label, url, apikey, token, app_url)
values ('label', 'Proview Label', 'https://fiqoirnlmhjzicvktdwa.supabase.co', 'sb_publishable_j7p5qB-D6FMOV4B6zLiN_w_7xmfKLRM',
        encode(extensions.gen_random_bytes(32), 'hex'), 'https://label.proviewcrm.co.uk')
on conflict (product) do nothing;

-- Copy the line this returns and run it in Proview Label's SQL editor (it holds only the token's hash, not the token).
select format('update hub_private.config set token_sha256 = %L where id = 1;', encode(extensions.digest(token, 'sha256'), 'hex')) as run_this_in_proview_label
  from hub_private.apps where product = 'label';
