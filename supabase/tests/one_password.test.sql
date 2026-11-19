-- Test for migration 20261120_one_password.sql (one password on every Proview site). Paste the whole file into the SQL
-- editor of bpssjfrinjlrnkzhytfr AFTER the migration and press Run. It is one DO block: it adds throw-away Proview
-- accounts (emails under example.invalid), checks the trigger, lic_pw_changes / lic_pw_accounts / lic_pw_all /
-- lic_pw_set, who may call them, and the cron switch, then ALWAYS ends with an exception whose text lists every
-- PASS / FAIL. The exception rolls everything back, so nothing it added or changed stays.
do $test$
declare
  out text[] := '{}';
  t   text := 'zz-pwtest-' || substr(md5(random()::text), 1, 8);   -- unique per run, never a real email
  act uuid := gen_random_uuid(); rnd uuid := gen_random_uuid(); inv uuid := gen_random_uuid(); held uuid := gen_random_uuid();
  h1 text := extensions.crypt('first-password', extensions.gen_salt('bf', 4));
  h2 text := extensions.crypt('second-password', extensions.gen_salt('bf', 4));
  h3 text := extensions.crypt('third-password', extensions.gen_salt('bf', 4));
  r jsonb; x jsonb; n int; n2 int; ok boolean; msg text; c0 timestamptz; ban timestamptz; sec text;
begin
  c0 := clock_timestamp();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, last_sign_in_at, recovery_token, banned_until, created_at, updated_at, is_anonymous)
  values
    (act,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-active@example.invalid', h1, now(), null, now(), 'reset-pending', null, now(), now(), false),
    (rnd,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-random@example.invalid', h2, now(), null, null, '', null, now(), now(), false),
    (inv,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-invited@example.invalid', '', null, now(), null, '', null, now(), now(), false),
    (held, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', t || '-held@example.invalid', h1, now(), null, now(), '', now() + interval '100 years', now(), now(), false);

  -- ---------- trigger ----------
  select count(*) into n from hub_private.pw_changes where email like t || '%' and kind = 'new' and source = 'user';
  out := out || ((case when n = 4 then 'PASS' else 'FAIL' end) || ' new Proview accounts are recorded as kind new (' || n || ')');
  update auth.users set encrypted_password = h3 where id = act;
  select count(*) into n from hub_private.pw_changes where email = t || '-active@example.invalid' and kind = 'set' and source = 'user' and hash = h3;
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' a dashboard password change is recorded as kind set');
  update auth.users set last_sign_in_at = now() where id = act;
  select count(*) into n from hub_private.pw_changes where email = t || '-active@example.invalid' and kind = 'set';
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' a sign-in is not a password change');

  -- ---------- lic_pw_changes ----------
  r := public.lic_pw_changes(c0 - interval '1 second', 500);
  select count(*) into n from jsonb_array_elements(r->'changes') e where e->>'email' like t || '%';
  out := out || ((case when n = 4 then 'PASS' else 'FAIL' end) || ' lic_pw_changes: 4 changes of confirmed accounts (the unconfirmed invite left out) (' || n || ')');
  select count(*) into n from jsonb_array_elements(r->'changes') e where e->>'email' = t || '-active@example.invalid' and e->>'kind' = 'set' and e->>'hash' = h3;
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' lic_pw_changes carries the hash and kind');

  -- ---------- lic_pw_accounts: who has a dashboard password ----------
  r := public.lic_pw_accounts(array[t || '-ACTIVE@example.invalid ', t || '-random@example.invalid', t || '-invited@example.invalid', t || '-nobody@example.invalid', '']);
  out := out || ((case when jsonb_array_length(r) = 4 then 'PASS' else 'FAIL' end) || ' one row per email, blanks dropped');
  select e into x from jsonb_array_elements(r) e where e->>'email' = t || '-active@example.invalid';
  out := out || ((case when (x->>'usable')::boolean and x->>'hash' = h3 then 'PASS' else 'FAIL' end) || ' signed in before -> has a dashboard password, hash given to the hub');
  select e into x from jsonb_array_elements(r) e where e->>'email' = t || '-random@example.invalid';
  out := out || ((case when (x->>'exists')::boolean and not (x->>'usable')::boolean and x->>'hash' is null then 'PASS' else 'FAIL' end) || ' made by New business, never signed in -> no dashboard password, no hash');
  select e into x from jsonb_array_elements(r) e where e->>'email' = t || '-invited@example.invalid';
  out := out || ((case when (x->>'exists')::boolean and not (x->>'usable')::boolean then 'PASS' else 'FAIL' end) || ' invite not used -> no dashboard password');
  select e into x from jsonb_array_elements(r) e where e->>'email' = t || '-nobody@example.invalid';
  out := out || ((case when not (x->>'exists')::boolean and not (x->>'usable')::boolean then 'PASS' else 'FAIL' end) || ' no account -> exists false');

  -- ---------- lic_pw_all (dry run) ----------
  r := public.lic_pw_all();
  select count(*) into n from jsonb_array_elements(r) e where e->>'email' like t || '%';
  select count(*) into n2 from jsonb_array_elements(r) e where e->>'email' like t || '%' and (e->>'has_password')::boolean;
  out := out || ((case when n = 4 and n2 = 2 then 'PASS' else 'FAIL' end) || ' lic_pw_all: 4 accounts, 2 with a dashboard password (' || n || ', ' || n2 || ')');
  out := out || ((case when r::text !~ '\$2[aby]\$' then 'PASS' else 'FAIL' end) || ' lic_pw_all: no hashes');

  -- ---------- lic_pw_set ----------
  select count(*) into n from auth.users;
  r := public.lic_pw_set(t || '-nobody@example.invalid', h2, clock_timestamp(), false);
  select count(*) into n2 from auth.users;
  out := out || ((case when r->>'applied' = 'false' and n = n2 then 'PASS' else 'FAIL' end) || ' without create: no account is made ' || r::text);
  r := public.lic_pw_set(t || '-New@example.invalid', h2, clock_timestamp(), true);
  select count(*) into n from auth.users u join auth.identities i on i.user_id = u.id
   where u.email = t || '-new@example.invalid' and u.encrypted_password = h2 and u.email_confirmed_at is not null and i.provider = 'email';
  out := out || ((case when (r->>'created')::boolean and n = 1 then 'PASS' else 'FAIL' end) || ' create: a confirmed Proview account with that hash and an email identity ' || r::text);
  select count(*) into n from hub_private.pw_changes where email = t || '-new@example.invalid';
  select count(*) into n2 from hub_private.pw_changes where email = t || '-new@example.invalid' and source = 'sync' and kind = 'set';
  out := out || ((case when n = 1 and n2 = 1 then 'PASS' else 'FAIL' end) || ' the made account is recorded once, as sync (never sent back out)');
  out := out || ((case when hub_private.lic_pw_usable(t || '-new@example.invalid') then 'PASS' else 'FAIL' end) || ' an account made by the sync has a dashboard password');
  r := public.lic_pw_set(t || '-fromnew@example.invalid', h1, clock_timestamp(), true, 'new');
  out := out || ((case when (r->>'created')::boolean and not hub_private.lic_pw_usable(t || '-fromnew@example.invalid') then 'PASS' else 'FAIL' end) || ' an account made from a new app login (kind new) is not a dashboard password yet');

  r := public.lic_pw_set(t || '-active@example.invalid', h1, now() - interval '1 hour', true);
  select encrypted_password = h3 into ok from auth.users where id = act;
  out := out || ((case when r->>'applied' = 'false' and r->>'reason' = 'older' and ok then 'PASS' else 'FAIL' end) || ' an older change is refused ' || r::text);
  r := public.lic_pw_set(t || '-active@example.invalid', h2, clock_timestamp(), true);
  select encrypted_password = h2 and coalesce(recovery_token, '') = '' and email_confirmed_at is not null into ok from auth.users where id = act;
  out := out || ((case when r->>'applied' = 'true' and not (r->>'created')::boolean and ok then 'PASS' else 'FAIL' end) || ' a newer change is applied, recovery token cleared, still confirmed');
  select count(*) into n from auth.users where lower(email) = t || '-active@example.invalid';
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' no second account made');
  r := public.lic_pw_changes(c0 - interval '1 second', 500);
  select count(*) into n from jsonb_array_elements(r->'changes') e where e->>'hash' = h2 and e->>'email' = t || '-active@example.invalid';
  out := out || ((case when n = 0 then 'PASS' else 'FAIL' end) || ' a synced change is not sent out again');
  select banned_until into ban from auth.users where id = held;
  r := public.lic_pw_set(t || '-held@example.invalid', h3, clock_timestamp(), true);
  select banned_until is not distinct from ban and encrypted_password = h3 into ok from auth.users where id = held;
  out := out || ((case when ok then 'PASS' else 'FAIL' end) || ' an account on hold stays on hold');
  begin perform public.lic_pw_set(t || '-active@example.invalid', 'not-a-hash', now(), true, 'set'); msg := 'no error';
  exception when others then msg := sqlerrm; end;
  out := out || ((case when msg = 'That is not a password hash.' then 'PASS' else 'FAIL' end) || ' a non-bcrypt value is refused: ' || msg);

  -- ---------- cursors ----------
  perform public.lic_pw_state_set('zz-test', c0, null);
  perform public.lic_pw_state_set('zz-test', null, 'boom');
  r := public.lic_pw_state();
  out := out || ((case when (r->'zz-test'->>'cursor')::timestamptz = c0 and r->'zz-test'->>'last_error' = 'boom' then 'PASS' else 'FAIL' end) || ' a failed run keeps the cursor and records the error');

  -- ---------- cron switch ----------
  select cron_secret into sec from hub_private.pw_cron where id = 1;
  update hub_private.pw_cron set enabled = false where id = 1;
  out := out || ((case when hub_private.run_password_sync() is null and not public.lic_pw_cron_ok(sec) then 'PASS' else 'FAIL' end) || ' switched off: the minute run does nothing and the secret is refused');
  update hub_private.pw_cron set enabled = true where id = 1;
  out := out || ((case when public.lic_pw_cron_ok(sec) and not public.lic_pw_cron_ok('wrong') and not public.lic_pw_cron_ok(null) then 'PASS' else 'FAIL' end) || ' switched on: only the right secret is accepted');
  select count(*) into n from cron.job where jobname = 'licence-password-sync' and schedule = '* * * * *';
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' pg_cron job licence-password-sync every minute');

  -- ---------- who may call them ----------
  select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and has_function_privilege('service_role', f, 'execute'))
    into ok from unnest(array['public.lic_pw_changes(timestamptz,integer)', 'public.lic_pw_accounts(text[])', 'public.lic_pw_all()',
                              'public.lic_pw_set(text,text,timestamptz,boolean,text)', 'public.lic_pw_state()', 'public.lic_pw_state_set(text,timestamptz,text)',
                              'public.lic_pw_cron_ok(text)']) f;
  out := out || ((case when ok then 'PASS' else 'FAIL' end) || ' only the service role (licence-hub) can call the lic_pw functions');
  out := out || ((case when not has_table_privilege('authenticated', 'hub_private.pw_changes', 'select') and not has_table_privilege('anon', 'hub_private.pw_changes', 'select') then 'PASS' else 'FAIL' end) || ' nobody signed in can read pw_changes');
  execute 'set local role authenticated';
  begin perform public.lic_pw_accounts(array[t || '-active@example.invalid']); msg := 'no error';
  exception when others then msg := sqlerrm; end;
  execute 'reset role';
  out := out || ((case when msg ~* 'permission denied' then 'PASS' else 'FAIL' end) || ' a signed-in person cannot read hashes: ' || msg);

  raise exception E'one password test (20261120_one_password.sql, rolled back, nothing kept): % PASS, % FAIL\n%',
    (select count(*) from unnest(out) o where o like 'PASS%'), (select count(*) from unnest(out) o where o like 'FAIL%'),
    array_to_string(out, E'\n');
end
$test$;
