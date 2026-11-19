-- Undo 2026-11-19_wifi_switch_to_supabase.sql (licence project bpssjfrinjlrnkzhytfr): the portal talks to the Node
-- server again with the old ids. Use together with the WiFi rollback (config/live.json app_live false). Units / accounts
-- added in Supabase after the switch have no Node id: they stay as they are (the next Sync marks them gone).
begin;
do $$
declare n int;
begin
  if not exists(select 1 from hub_private.apps_wifi_before_switch) then raise exception 'No saved WiFi row: the switch never ran. Nothing was changed.'; end if;
  update hub_private.apps a set url = b.url, apikey = b.apikey, token = b.token, app_url = b.app_url, label = b.label
    from (select * from hub_private.apps_wifi_before_switch order by saved_at limit 1) b where a.product = 'wifi';
  get diagnostics n = row_count; if n <> 1 then raise exception 'No WiFi app row. Nothing was changed.'; end if;
  update lic_units u set ext_id = m.old_id from hub_private.wifi_id_map m where u.product = 'wifi' and m.kind = 'unit' and u.ext_id = m.new_id;
  update lic_units u set account_ext_id = m.old_id from hub_private.wifi_id_map m where u.product = 'wifi' and m.kind = 'account' and u.account_ext_id = m.new_id;
  update lic_accounts a set ext_id = m.old_id from hub_private.wifi_id_map m where a.product = 'wifi' and m.kind = 'account' and a.ext_id = m.new_id;
  update lic_subscriptions s set unit_ext_id = m.old_id from hub_private.wifi_id_map m where s.product = 'wifi' and m.kind = 'unit' and s.unit_ext_id = m.new_id;
  insert into lic_audit(admin_email, product, action) values ('Proview (go-live rollback)', 'wifi', 'switched WiFi back to the Node server');
  raise notice 'WiFi points at the Node server again. Press Sync.';
end $$;
commit;
