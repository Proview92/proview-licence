-- Test for 20261120_dashboard_ready.sql (lic_dashboard_accounts: a synced password counts as ready). Paste into the SQL
-- editor of bpssjfrinjlrnkzhytfr AFTER the migration and press Run. One DO block with throw-away logins (emails under
-- example.invalid); it ALWAYS ends with an exception listing every PASS / FAIL, which rolls everything back.
do $test$
declare
  out text[] := '{}';
  t   text := 'zz-dready-' || substr(md5(random()::text), 1, 8);
  adm uuid; rdy uuid := gen_random_uuid(); unc uuid := gen_random_uuid(); rnd uuid := gen_random_uuid(); sgn uuid := gen_random_uuid();
  h text := extensions.crypt('a-test-password', extensions.gen_salt('bf', 4));
  rows jsonb; n int; real_after int; real_emails text[];
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, last_sign_in_at, created_at, updated_at, is_anonymous)
  values
    (rdy, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-ready@example.invalid',   h,   now(), null, null, now(), now(), false),
    (unc, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-unconf@example.invalid',  h,   null,  now(), null, now(), now(), false),
    (rnd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-random@example.invalid',  'x', now(), null, null, now(), now(), false),
    (sgn, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-signed@example.invalid',  h,   now(), null, now(), now(), now(), false);
  -- the password sync copied a real password to -ready and -unconf
  insert into hub_private.pw_changes (email, hash, source, kind) values
    (t || '-ready@example.invalid', null, 'sync', 'set'), (t || '-unconf@example.invalid', null, 'sync', 'set');

  select array_agg(lower(email)) into real_emails from auth.users where email not like 'zz-%' and not coalesce(is_anonymous, false);
  select id into adm from auth.users where lower(email) = 'altun@proviewtech.co.uk' and email_confirmed_at is not null;
  if adm is null then raise exception 'master account not found'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', adm::text, true);
  execute 'set local role authenticated';

  select jsonb_agg(to_jsonb(x)), count(*) into rows, n from public.lic_dashboard_accounts(array[
    t || '-ready@example.invalid', t || '-unconf@example.invalid', t || '-random@example.invalid',
    t || '-signed@example.invalid', t || '-nobody@example.invalid']) x;
  out := out || ((case when n = 5 then 'PASS' else 'FAIL' end) || ' five rows');
  out := out || ((case when rows->0->>'state' = 'active' and rows->0->>'last_sign_in_at' is null then 'PASS' else 'FAIL' end) || ' synced password, confirmed, never signed in -> active (no invite) ' || coalesce(rows->>0, ''));
  out := out || ((case when rows->1->>'state' = 'invited' then 'PASS' else 'FAIL' end) || ' synced password but email not confirmed -> still invited');
  out := out || ((case when rows->2->>'state' = 'invited' then 'PASS' else 'FAIL' end) || ' random password from New business -> still invited');
  out := out || ((case when rows->3->>'state' = 'active' and rows->3->>'last_sign_in_at' is not null then 'PASS' else 'FAIL' end) || ' signed in -> active');
  out := out || ((case when rows->4->>'state' = 'none' then 'PASS' else 'FAIL' end) || ' no account -> none');
  out := out || ((case when not (rows::text ~* 'password|token|\$2') then 'PASS' else 'FAIL' end) || ' no password data in the result');

  -- the real accounts: everyone with a synced, confirmed password now shows active
  select count(*) into real_after from public.lic_dashboard_accounts(real_emails) x where x.state = 'invited';
  out := out || ('INFO real accounts still invited after this change: ' || real_after);

  execute 'reset role';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', rdy, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', rdy::text, true);
    execute 'set local role authenticated';
    perform * from public.lic_dashboard_accounts(array['x@example.invalid']);
    out := out || 'FAIL a non-master could read dashboard accounts';
  exception when others then
    out := out || ((case when sqlerrm ~ 'Only the Proview licence administrator' then 'PASS' else 'FAIL' end) || ' a non-master is refused: ' || sqlerrm);
  end;
  execute 'reset role';

  raise exception E'dashboard ready test: %/% PASS\n%',
    (select count(*) from unnest(out) x where x like 'PASS%'), (select count(*) from unnest(out) x where x not like 'INFO%'), array_to_string(out, E'\n');
end $test$;
