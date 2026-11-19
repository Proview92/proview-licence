-- Test for public.lic_dashboard_accounts (migration 20261119_dashboard_accounts.sql). Paste the whole file into the SQL
-- editor of bpssjfrinjlrnkzhytfr AFTER the migration and press Run. It is one DO block: it adds throw-away test logins,
-- checks the function as the master, as another signed-in person and as anon, then ALWAYS ends with an exception whose
-- text lists every PASS / FAIL. The exception rolls everything back, so nothing it added stays.
do $test$
declare
  out text[] := '{}';
  t   text   := 'zz-dashtest-' || substr(md5(random()::text), 1, 8);   -- unique per run, never a real email
  adm uuid := gen_random_uuid(); act uuid := gen_random_uuid(); inv uuid := gen_random_uuid();
  conf uuid := gen_random_uuid(); anon_u uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  rows jsonb; n int; ok boolean; msg text; res text;
begin
  -- ---------- setup (as postgres) ----------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, last_sign_in_at, created_at, updated_at, is_anonymous)
  values
    (act,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-active@example.invalid',  'x', now() - interval '5 days', null, now() - interval '1 day', now() - interval '5 days', now(), false),
    (inv,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-invited@example.invalid', '',  null, now() - interval '2 hours', null, now() - interval '2 hours', now(), false),
    (conf,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-made@example.invalid',    'x', now(), null, null, now() - interval '3 hours', now(), false),
    (anon_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-anon@example.invalid',    null, null, null, now(), now(), now(), true),
    (other,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-other@example.invalid',   'x', now(), null, now(), now(), now(), false);
  -- lic_admins only allows the real master (check lic_admins_master_only), so test as that account.
  select id into adm from auth.users where lower(email) = 'altun@proviewtech.co.uk' and email_confirmed_at is not null;
  if adm is null then raise exception 'master account not found'; end if;

  -- ---------- shape: security definer, fixed search_path, no password / token columns ----------
  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), pg_get_function_result(p.oid) into ok, msg, res
  from pg_proc p where p.oid = 'public.lic_dashboard_accounts(text[])'::regprocedure;
  out := out || ((case when ok then 'PASS' else 'FAIL' end) || ' security definer');
  out := out || ((case when msg like '%search_path=public%' then 'PASS' else 'FAIL' end) || ' search_path fixed (' || msg || ')');
  out := out || ((case when res !~* 'password|token|meta|phone' then 'PASS' else 'FAIL' end) || ' returns only email/state/times: ' || res);
  out := out || ((case when not has_function_privilege('anon', 'public.lic_dashboard_accounts(text[])', 'execute') then 'PASS' else 'FAIL' end) || ' anon cannot execute');
  out := out || ((case when has_function_privilege('authenticated', 'public.lic_dashboard_accounts(text[])', 'execute') then 'PASS' else 'FAIL' end) || ' authenticated can execute (the function itself checks the master)');

  -- ---------- as the master ----------
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', adm::text, true);
  execute 'set local role authenticated';
  out := out || ((case when public.is_lic_admin() then 'PASS' else 'FAIL' end) || ' test master is a licence admin');

  select jsonb_agg(to_jsonb(x)), count(*) into rows, n from public.lic_dashboard_accounts(array[
    '  ' || upper(t) || '-ACTIVE@Example.Invalid ',   -- case and spaces don't matter
    t || '-invited@example.invalid',
    t || '-made@example.invalid',
    t || '-nobody@example.invalid',
    t || '-anon@example.invalid',
    t || '-active@example.invalid',                    -- duplicate: dropped
    '', null]) x;
  out := out || ((case when n = 5 then 'PASS' else 'FAIL' end) || ' one row per distinct email, blanks dropped (' || n || ')');
  out := out || ((case when rows->0->>'email' = t || '-active@example.invalid' and rows->3->>'email' = t || '-nobody@example.invalid' then 'PASS' else 'FAIL' end) || ' order kept, emails lower-cased and trimmed');
  out := out || ((case when rows->0->>'state' = 'active' and rows->0->>'last_sign_in_at' is not null and rows->0->>'email_confirmed_at' is not null then 'PASS' else 'FAIL' end) || ' signed in before -> active with last sign-in (' || coalesce(rows->>0, '') || ')');
  out := out || ((case when rows->1->>'state' = 'invited' and rows->1->>'invited_at' is not null and rows->1->>'email_confirmed_at' is null then 'PASS' else 'FAIL' end) || ' invited, not confirmed -> invited');
  out := out || ((case when rows->2->>'state' = 'invited' and rows->2->>'invited_at' is null and rows->2->>'email_confirmed_at' is not null then 'PASS' else 'FAIL' end) || ' made by New business, never signed in -> invited');
  out := out || ((case when rows->3->>'state' = 'none' and rows->3->>'created_at' is null then 'PASS' else 'FAIL' end) || ' no account -> none, no times');
  out := out || ((case when rows->4->>'state' = 'none' then 'PASS' else 'FAIL' end) || ' anonymous login is not a Proview account -> none');
  out := out || ((case when not (rows::text ~* 'password|token|"x"') then 'PASS' else 'FAIL' end) || ' no password data in the result');

  select count(*) into n from public.lic_dashboard_accounts('{}'::text[]);
  out := out || ((case when n = 0 then 'PASS' else 'FAIL' end) || ' empty list -> no rows');
  select count(*) into n from public.lic_dashboard_accounts(null);
  out := out || ((case when n = 0 then 'PASS' else 'FAIL' end) || ' null -> no rows');
  begin
    perform public.lic_dashboard_accounts(array(select 'e' || g || '@x.invalid' from generate_series(1, 501) g));
    out := out || 'FAIL more than 500 emails refused';
  exception when others then out := out || ('PASS more than 500 emails refused: ' || sqlerrm);
  end;

  -- ---------- as someone else signed in (not a licence admin) ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', other::text, true);
  execute 'set local role authenticated';
  begin
    perform public.lic_dashboard_accounts(array[t || '-active@example.invalid']);
    out := out || 'FAIL a signed-in non-admin is refused';
  exception when others then out := out || ((case when sqlerrm ~* 'administrator' then 'PASS' else 'FAIL' end) || ' a signed-in non-admin is refused: ' || sqlerrm);
  end;

  -- ---------- as anon ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin
    perform public.lic_dashboard_accounts(array[t || '-active@example.invalid']);
    out := out || 'FAIL anon is refused';
  exception when insufficient_privilege then out := out || ('PASS anon is refused: ' || sqlerrm);
            when others then out := out || ((case when sqlerrm ~* 'administrator|permission' then 'PASS' else 'FAIL' end) || ' anon is refused: ' || sqlerrm);
  end;
  execute 'reset role';

  raise exception E'lic_dashboard_accounts test (rolled back, nothing kept): % PASS, % FAIL\n%',
    (select count(*) from unnest(out) x where x like 'PASS%'), (select count(*) from unnest(out) x where x like 'FAIL%'),
    array_to_string(out, E'\n');
end
$test$;
