-- Test for public.lic_trial_requests (migration 20261120_trial_requests.sql). Paste the whole file into the SQL editor of
-- bpssjfrinjlrnkzhytfr AFTER the migration and press Run. It is one DO block: it adds throw-away test logins, checks the
-- table as two signed-in customers, as anon and as the real master (altun@proviewtech.co.uk: lic_admins only allows that
-- email), then ALWAYS ends with an exception whose text lists every PASS / FAIL. The exception rolls everything back, so
-- nothing it added stays.
do $test$
declare
  out text[] := '{}';
  t   text   := 'zz-trialtest-' || substr(md5(random()::text), 1, 8);   -- unique per run, never a real email
  a_id uuid := gen_random_uuid(); b_id uuid := gen_random_uuid(); u_id uuid := gen_random_uuid(); adm uuid;
  a_em text; b_em text; u_em text; adm_em text;
  r record; n int; ok boolean; msg text; rid uuid; rid2 uuid;
  st text;
begin
  a_em := t || '-a@example.invalid'; b_em := t || '-b@example.invalid'; u_em := t || '-unconfirmed@example.invalid';
  -- ---------- setup (as postgres) ----------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, is_anonymous)
  values (a_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', a_em, 'x', now(), now(), now(), false),
         (b_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', b_em, 'x', now(), now(), now(), false),
         (u_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u_em, 'x', null,  now(), now(), false);
  select id, lower(email) into adm, adm_em from auth.users where lower(email) = 'altun@proviewtech.co.uk' and email_confirmed_at is not null;
  if adm is null then raise exception 'master account not found'; end if;

  -- ---------- shape ----------
  select relrowsecurity into ok from pg_class where oid = 'public.lic_trial_requests'::regclass;
  out := out || ((case when ok then 'PASS' else 'FAIL' end) || ' RLS on');
  out := out || ((case when not has_table_privilege('anon', 'public.lic_trial_requests', 'select') and not has_table_privilege('anon', 'public.lic_trial_requests', 'insert') then 'PASS' else 'FAIL' end) || ' anon has no select / insert');
  out := out || ((case when not has_table_privilege('authenticated', 'public.lic_trial_requests', 'delete') then 'PASS' else 'FAIL' end) || ' nobody signed in can delete');
  out := out || ((case when not has_column_privilege('authenticated', 'public.lic_trial_requests', 'email', 'insert') and not has_column_privilege('authenticated', 'public.lic_trial_requests', 'status', 'insert') then 'PASS' else 'FAIL' end) || ' client cannot send email / status');
  out := out || ((case when has_column_privilege('authenticated', 'public.lic_trial_requests', 'status', 'update') and not has_column_privilege('authenticated', 'public.lic_trial_requests', 'note', 'update') then 'PASS' else 'FAIL' end) || ' only status is updatable');

  -- ---------- customer A ----------
  perform set_config('request.jwt.claims', json_build_object('sub', a_id, 'role', 'authenticated', 'email', a_em)::text, true);
  perform set_config('request.jwt.claim.sub', a_id::text, true);
  execute 'set local role authenticated';
  out := out || ((case when not public.is_lic_admin() then 'PASS' else 'FAIL' end) || ' customer A is not a licence admin');

  insert into public.lic_trial_requests (app, business, note) values ('signage', '  Brags Cafe ', ' two TVs please ') returning id into rid;
  select * into r from public.lic_trial_requests where id = rid;
  out := out || ((case when r.email = a_em and r.user_id = a_id and r.status = 'new' and r.created_at > now() - interval '1 minute' then 'PASS' else 'FAIL' end) || ' insert: email / user / status / time from the session (' || coalesce(r.email, '?') || ')');
  out := out || ((case when r.business = 'Brags Cafe' and r.note = 'two TVs please' then 'PASS' else 'FAIL' end) || ' business and note trimmed');

  -- the client can't choose who it is (column not granted)
  begin
    execute format('insert into public.lic_trial_requests (app, email) values (%L, %L)', 'team', b_em);
    out := out || 'FAIL insert with someone else''s email was allowed'::text;
  exception when insufficient_privilege then out := out || 'PASS insert with an email column is refused (email comes from the JWT)'::text;
  end;
  begin
    execute format('insert into public.lic_trial_requests (app, status) values (%L, %L)', 'team', 'done');
    out := out || 'FAIL insert with a status was allowed'::text;
  exception when insufficient_privilege then out := out || 'PASS insert with a status is refused'::text;
  end;

  -- one open request per person per app
  begin
    insert into public.lic_trial_requests (app) values ('signage');
    out := out || 'FAIL second open request for the same app was allowed'::text;
  exception when unique_violation then out := out || 'PASS second open request for the same app is refused'::text;
  end;
  insert into public.lic_trial_requests (app) values ('team') returning id into rid2;
  out := out || ((case when rid2 is not null then 'PASS' else 'FAIL' end) || ' a request for another app is fine');
  begin
    insert into public.lic_trial_requests (app) values ('nonsense');
    out := out || 'FAIL unknown app allowed'::text;
  exception when check_violation then out := out || 'PASS unknown app refused'::text;
  end;
  begin
    insert into public.lic_trial_requests (app, note) values ('wifi', repeat('x', 501));
    out := out || 'FAIL 501-character note allowed'::text;
  exception when check_violation then out := out || 'PASS note longer than 500 characters refused'::text;
  end;

  -- A can't change status (only the master), nor touch the note
  update public.lic_trial_requests set status = 'done' where id = rid;
  get diagnostics n = row_count;
  out := out || ((case when n = 0 then 'PASS' else 'FAIL' end) || ' customer cannot mark their own request done (' || n || ' rows)');
  begin
    execute format('update public.lic_trial_requests set note = %L where id = %L', 'hacked', rid);
    out := out || 'FAIL customer could update the note'::text;
  exception when insufficient_privilege then out := out || 'PASS customer cannot update the note'::text;
  end;
  begin
    execute format('delete from public.lic_trial_requests where id = %L', rid);
    out := out || 'FAIL customer could delete'::text;
  exception when insufficient_privilege then out := out || 'PASS customer cannot delete'::text;
  end;
  select count(*) into n from public.lic_trial_requests;
  out := out || ((case when n = 2 then 'PASS' else 'FAIL' end) || ' customer A reads their own 2 requests (' || n || ')');

  -- ---------- customer B ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', b_id, 'role', 'authenticated', 'email', b_em)::text, true);
  perform set_config('request.jwt.claim.sub', b_id::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.lic_trial_requests;
  out := out || ((case when n = 0 then 'PASS' else 'FAIL' end) || ' customer B cannot read A''s requests (' || n || ')');
  insert into public.lic_trial_requests (app) values ('signage');   -- B has its own open request for Signage: fine
  select count(*) into n from public.lic_trial_requests;
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' B''s own Signage request is fine (one open per person per app, not per app)');

  -- B with a forged JWT email that isn't its login email
  perform set_config('request.jwt.claims', json_build_object('sub', b_id, 'role', 'authenticated', 'email', a_em)::text, true);
  begin
    insert into public.lic_trial_requests (app) values ('label');
    out := out || 'FAIL JWT email that isn''t the login''s own email was accepted'::text;
  exception when raise_exception then out := out || 'PASS JWT email must be the login''s own email'::text;
  end;

  -- ---------- unconfirmed email ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_id, 'role', 'authenticated', 'email', u_em)::text, true);
  perform set_config('request.jwt.claim.sub', u_id::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.lic_trial_requests (app) values ('signage');
    out := out || 'FAIL unconfirmed email could request'::text;
  exception when raise_exception then out := out || 'PASS unconfirmed email cannot request'::text;
  end;

  -- ---------- anon ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin
    perform 1 from public.lic_trial_requests limit 1;
    out := out || 'FAIL anon can read'::text;
  exception when insufficient_privilege then out := out || 'PASS anon cannot read'::text;
  end;
  begin
    insert into public.lic_trial_requests (app) values ('signage');
    out := out || 'FAIL anon can insert'::text;
  exception when insufficient_privilege then out := out || 'PASS anon cannot insert'::text;
  end;

  -- ---------- the master ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated', 'email', adm_em)::text, true);
  perform set_config('request.jwt.claim.sub', adm::text, true);
  execute 'set local role authenticated';
  out := out || ((case when public.is_lic_admin() then 'PASS' else 'FAIL' end) || ' master is a licence admin');
  select count(*) into n from public.lic_trial_requests where email like t || '%';
  out := out || ((case when n = 3 then 'PASS' else 'FAIL' end) || ' master reads every request (' || n || ' test rows)');
  update public.lic_trial_requests set status = 'done' where id = rid;
  select * into r from public.lic_trial_requests where id = rid;
  out := out || ((case when r.status = 'done' and r.handled_by = adm_em and r.handled_at is not null then 'PASS' else 'FAIL' end) || ' master marks done: handled_by / handled_at filled in (' || coalesce(r.handled_by, '?') || ')');
  update public.lic_trial_requests set status = 'declined' where id = rid2;
  select status into msg from public.lic_trial_requests where id = rid2;
  out := out || ((case when msg = 'declined' then 'PASS' else 'FAIL' end) || ' master declines');
  begin
    update public.lic_trial_requests set status = 'granted' where id = rid2;
    out := out || 'FAIL unknown status allowed'::text;
  exception when check_violation then out := out || 'PASS status is only new / done / declined'::text;
  end;
  -- nothing is granted: the table has no link to licences; no licence rows were touched
  select count(*) into n from pg_trigger where tgrelid = 'public.lic_trial_requests'::regclass and not tgisinternal;
  out := out || ((case when n = 1 then 'PASS' else 'FAIL' end) || ' only the guard trigger: nothing grants a licence automatically (NO_TRIAL)');

  -- ---------- after done, A may ask again ----------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', a_id, 'role', 'authenticated', 'email', a_em)::text, true);
  perform set_config('request.jwt.claim.sub', a_id::text, true);
  execute 'set local role authenticated';
  insert into public.lic_trial_requests (app) values ('signage') returning id into rid;
  out := out || ((case when rid is not null then 'PASS' else 'FAIL' end) || ' once handled, the same person may ask again');
  select handled_by, status into msg, st from public.lic_trial_requests where id = rid2;
  out := out || ((case when msg = adm_em and st = 'declined' then 'PASS' else 'FAIL' end) || ' customer sees their request was declined');

  execute 'reset role';
  raise exception E'lic_trial_requests test (rolled back)\n%\n% PASS, % FAIL',
    array_to_string(out, E'\n'),
    (select count(*) from unnest(out) x where x like 'PASS%'), (select count(*) from unnest(out) x where x like 'FAIL%');
end;
$test$;
