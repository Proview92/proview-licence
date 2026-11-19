-- WiFi go-live (owner, 19 Nov 2026): the licence portal talks to Proview WiFi's Supabase project instead of the Node
-- server. Run in the SQL editor of the LICENCE project (bpssjfrinjlrnkzhytfr) AFTER migration 015 is applied on the WiFi
-- project and AFTER the WiFi final copy has finished (https://wifi.proviewcrm.co.uk/health shows final_copy).
-- Undo: 2026-11-19_wifi_switch_to_supabase_ROLLBACK.sql.
--
-- 1) Remaps the WiFi account / unit ids from the Node server's ('c-<business name slug>', '<SQLite site id>') to the
--    Supabase ones (wf_orgs.id, wf_sites.id), so the next Sync matches them instead of marking them gone. The mapping
--    below is the live data of 19 Nov 2026 (1 business, 1 location). If a WiFi business was added since, the script
--    stops; regenerate the mapping with this READ-ONLY query on the WiFi project (twpmmxnmyyxtjgodldeq):
--      select 'account', 'c-' || trim(both '-' from regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')), id::text from wf_orgs where legacy_id is not null
--      union all select 'unit', legacy_id::text, id::text from wf_sites where legacy_id is not null;
-- 2) Points the WiFi app row (hub_private.apps) at https://twpmmxnmyyxtjgodldeq.supabase.co with that project's
--    publishable key (public: it is in the /app page too), and app_url at /app/. The hub token stays the same (the
--    WiFi project keeps the sha256 of the same HUB_TOKEN). The old row is kept in hub_private.apps_wifi_before_switch.
-- Then in the portal: press Sync, then Prices -> Save (pushes the WiFi prices to the WiFi project).
begin;
create table if not exists hub_private.apps_wifi_before_switch as select now() as saved_at, a.* from hub_private.apps a where false;
create table if not exists hub_private.wifi_id_map(kind text not null, old_id text not null, new_id text not null, primary key (kind, old_id));
do $$
declare map_a jsonb := '{"c-proview-tech-demo": "8356a97d-54f5-42ca-a6aa-094f248309d7"}';
        map_u jsonb := '{"1": "a92c94c0-4cc1-4a82-a08f-020153aed8c9"}';
        new_key text := 'sb_publishable_2aIoW0WfuEoFiCG8txmVrA_SpGUQiic';   -- WiFi project's publishable key (public)
        x record; n int;
begin
  if new_key like '<%' then raise exception 'Fill in the WiFi project''s publishable (anon) key first. Nothing was changed.'; end if;
  if (select url from hub_private.apps where product = 'wifi') like '%supabase.co%' then
    raise notice 'WiFi already points at Supabase: nothing to do'; return; end if;
  -- every live WiFi account / unit must be in the mapping, or stop
  for x in select ext_id from lic_accounts where product = 'wifi' and not gone and not (map_a ? ext_id) loop
    raise exception 'WiFi account % is not in the mapping (added since 19 Nov?). Regenerate the mapping. Nothing was changed.', x.ext_id; end loop;
  for x in select ext_id from lic_units where product = 'wifi' and not gone and not (map_u ? ext_id) loop
    raise exception 'WiFi unit % is not in the mapping. Regenerate the mapping. Nothing was changed.', x.ext_id; end loop;
  insert into hub_private.apps_wifi_before_switch select now(), a.* from hub_private.apps a where a.product = 'wifi';
  insert into hub_private.wifi_id_map select 'account', key, value #>> '{}' from jsonb_each(map_a) on conflict do nothing;
  insert into hub_private.wifi_id_map select 'unit', key, value #>> '{}' from jsonb_each(map_u) on conflict do nothing;
  update lic_units u set account_ext_id = map_a ->> u.account_ext_id where product = 'wifi' and map_a ? u.account_ext_id;
  update lic_units u set ext_id = map_u ->> u.ext_id where product = 'wifi' and map_u ? u.ext_id;
  update lic_accounts a set ext_id = map_a ->> a.ext_id where product = 'wifi' and map_a ? a.ext_id;
  update lic_subscriptions s set unit_ext_id = map_u ->> s.unit_ext_id where product = 'wifi' and map_u ? s.unit_ext_id;
  update hub_private.apps set url = 'https://twpmmxnmyyxtjgodldeq.supabase.co', apikey = new_key,
         app_url = 'https://wifi.proviewcrm.co.uk/app/' where product = 'wifi';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'No WiFi app row in hub_private.apps. Nothing was changed.'; end if;
  insert into lic_audit(admin_email, product, action, after) values ('Proview (go-live script)', 'wifi', 'switched WiFi to its Supabase back office',
    jsonb_build_object('accounts', map_a, 'units', map_u, 'url', 'https://twpmmxnmyyxtjgodldeq.supabase.co'));
  raise notice 'WiFi now points at Supabase. Press Sync in the licence portal, then Prices -> Save.';
end $$;
commit;
-- Check: select product, url, app_url from lic_app_config() where product = 'wifi';
--        select ext_id, account_ext_id, name, license_type from lic_units where product = 'wifi';
