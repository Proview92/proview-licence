-- 20261120_one_password.sql: one password on every Proview site (owner, 19 Nov 2026; /home/claude/ONE_PASSWORD_SPEC.md).
-- Licence project (bpssjfrinjlrnkzhytfr): the Proview account (dashboard.proviewcrm.co.uk) logins live here.
-- licence-hub's password_sync (every minute, and on the master's request) reads which logins set or changed a
-- password on every Proview site (each app's hub_call 'password_changes', and lic_pw_changes here), takes the newest
-- change for each email and copies that bcrypt hash to every other site where the email has a login (each app's
-- hub_call 'set_password_hash', and lic_pw_set here, which also makes the Proview account when it is missing).
--  1. hub_private.pw_changes + a trigger on auth.users (the same as in every app).
--  2. service-role functions for licence-hub: lic_pw_changes, lic_pw_accounts, lic_pw_all, lic_pw_set, cursors.
--  3. pg_cron 'licence-password-sync' every minute; it does nothing until hub_private.pw_cron.enabled is turned on.
-- Hashes are never stored outside auth.users and pw_changes, never logged and never returned to the portal page.
-- Not applied. Safe to run more than once.

-- ---------- 1. Password changes of this project's logins ----------
-- One row per password set or changed here, and per new login. Only the bcrypt hash Supabase Auth already keeps
-- (auth.users.encrypted_password); never a password. Private: only the functions below read it.
--   source  'user' = changed here (the app, a reset link, the Users panel's Change password, a new login)
--           'sync' = copied here by set_password_hash; password_changes never sends these out again (no loops)
--   kind    'set'  = a password was set or changed     'new' = a login was created (hash may be empty)
create schema if not exists hub_private;
create table if not exists hub_private.pw_changes (
  id         bigserial primary key,
  email      text not null,
  hash       text,
  changed_at timestamptz not null default clock_timestamp(),
  source     text not null default 'user' check (source in ('user', 'sync')),
  kind       text not null default 'set' check (kind in ('set', 'new'))
);
create index if not exists pw_changes_email_idx on hub_private.pw_changes (email, changed_at desc);
create index if not exists pw_changes_at_idx on hub_private.pw_changes (changed_at, id);
revoke all on table hub_private.pw_changes from public, anon, authenticated;
revoke all on sequence hub_private.pw_changes_id_seq from public, anon, authenticated;

-- after insert / after update of encrypted_password on auth.users. A change made by set_password_hash (it sets
-- proview.pw_sync for its own transaction) is recorded by set_password_hash itself, as 'sync'.
create or replace function hub_private.pw_track() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(coalesce(new.email, ''))); h text := new.encrypted_password;
begin
  -- no email, anonymous, or a device sign-in (Label handhelds: dev_…@devices.label.proviewcrm.co.uk): not a person
  if em = '' or coalesce(new.is_anonymous, false) or em ~ '@devices\.([a-z0-9-]+\.)*proviewcrm\.co\.uk$' then return null; end if;
  if coalesce(current_setting('proview.pw_sync', true), '') <> '' then return null; end if;
  if h is null or h !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' then h := null; end if;
  -- a temporary password an admin set (Signage's "Reset password" to 123456, must be changed at the next sign-in) or
  -- the random one it is replaced with when it expires: never copied to other sites
  if coalesce(new.raw_app_meta_data->>'must_change_password', '') = 'true' or coalesce(new.raw_app_meta_data->>'temp_password_expired', '') = 'true' then
    h := null;
    if tg_op = 'UPDATE' then return null; end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.encrypted_password is not distinct from old.encrypted_password or h is null then return null; end if;
    insert into hub_private.pw_changes (email, hash, source, kind) values (em, h, 'user', 'set');
  else
    insert into hub_private.pw_changes (email, hash, source, kind) values (em, h, 'user', 'new');
  end if;
  return null;
end $$;
revoke all on function hub_private.pw_track() from public, anon, authenticated;
drop trigger if exists pw_track on auth.users;
create trigger pw_track after insert or update of encrypted_password on auth.users
  for each row execute function hub_private.pw_track();


-- ---------- 2. What licence-hub's password_sync uses on this project (service role only) ----------
-- Where each project's changes were read up to (one cursor per project, this project is 'licence'), and the cron.
create table if not exists hub_private.pw_sync_state (
  product    text primary key,
  cursor_at  timestamptz,
  last_run   timestamptz,
  last_error text
);
create table if not exists hub_private.pw_cron (
  id          int primary key check (id = 1),
  enabled     boolean not null default false,   -- the every-minute run does nothing until this is turned on (go-live)
  cron_secret text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
insert into hub_private.pw_cron (id) values (1) on conflict (id) do nothing;
revoke all on table hub_private.pw_sync_state, hub_private.pw_cron from public, anon, authenticated;

-- A Proview account "has a dashboard password" (one its owner knows) when it has a bcrypt hash and either signed in
-- at least once or got that password through the sync / a password change (pw_changes kind 'set'). An account made
-- by New business with a random password, or an invite not used yet, does not.
create or replace function hub_private.lic_pw_usable(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u
                  where lower(u.email) = lower(trim(p_email)) and not coalesce(u.is_anonymous, false)
                    and coalesce(u.encrypted_password, '') ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
                    and (u.last_sign_in_at is not null
                         or exists (select 1 from hub_private.pw_changes c where c.email = lower(u.email) and c.kind = 'set')));
$$;

-- changes made on this project (as an app's password_changes)
create or replace function public.lic_pw_changes(p_since timestamptz default null, p_limit int default 500)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb; n int; lim int := least(greatest(coalesce(p_limit, 500), 1), 1000);
begin
  select coalesce(jsonb_agg(jsonb_build_object('email', q.email, 'hash', q.hash, 'changed_at', q.changed_at, 'kind', q.kind) order by q.changed_at, q.id), '[]'::jsonb),
         count(*) into out, n
  from (select c.id, c.email, c.hash, c.changed_at, c.kind from hub_private.pw_changes c
         where c.source = 'user' and (p_since is null or c.changed_at > p_since)
           and exists (select 1 from auth.users u where lower(u.email) = c.email and u.email_confirmed_at is not null
                                                   and not coalesce(u.is_anonymous, false))
         order by c.changed_at, c.id limit lim) q;
  return jsonb_build_object('ok', true, 'changes', out, 'more', n >= lim);
end $$;

-- the Proview account of each email: exists, usable (see lic_pw_usable), its hash only when usable, and the newest
-- change held here. Never shown anywhere: only licence-hub reads it, in memory, to copy the password.
create or replace function public.lic_pw_accounts(p_emails text[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', a.e,
           'exists', u.id is not null,
           'usable', hub_private.lic_pw_usable(a.e),
           'hash', case when hub_private.lic_pw_usable(a.e) then u.encrypted_password end,
           'signed_in', u.last_sign_in_at is not null,
           'held_at', (select max(c.changed_at) from hub_private.pw_changes c where c.email = a.e))), '[]'::jsonb)
  from (select distinct lower(trim(x)) as e from unnest(coalesce(p_emails, '{}'::text[])) x where coalesce(trim(x), '') <> '') a
  left join lateral (select id, encrypted_password, last_sign_in_at from auth.users
                      where lower(email) = a.e and not coalesce(is_anonymous, false) order by created_at limit 1) u on true;
$$;

-- every Proview account (dry run): email and whether it has a dashboard password. No hashes.
create or replace function public.lic_pw_all()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('email', q.e, 'has_password', hub_private.lic_pw_usable(q.e), 'confirmed', q.conf) order by q.e), '[]'::jsonb)
  from (select distinct on (lower(email)) lower(email) as e, email_confirmed_at is not null as conf
          from auth.users where email is not null and not coalesce(is_anonymous, false)
         order by lower(email), created_at) q;
$$;

-- set_password_hash for this project, plus: p_create makes the Proview account when it is missing (confirmed, with
-- this hash), so everyone with a login anywhere can sign in to the dashboard with the password they already use.
-- p_kind 'new': the hash came from a new app login, not from a password someone set (it may be a random one nobody
-- knows), so the account it makes doesn't count as having a dashboard password until it is used or set.
drop function if exists public.lic_pw_set(text, text, timestamptz, boolean);
create or replace function public.lic_pw_set(p_email text, p_hash text, p_changed_at timestamptz, p_create boolean default false, p_kind text default 'set')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare em text := lower(trim(coalesce(p_email, ''))); uid uuid; held timestamptz; k text := case when p_kind = 'new' then 'new' else 'set' end;
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if em ~ '@devices\.([a-z0-9-]+\.)*proviewcrm\.co\.uk$' then raise exception 'A device sign-in can''t have a Proview account.'; end if;
  if p_hash is null or p_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' then raise exception 'That is not a password hash.'; end if;
  if p_changed_at is null or p_changed_at > now() + interval '5 minutes' then raise exception 'changed_at is not a time.'; end if;
  perform pg_advisory_xact_lock(hashtext('pw:' || em));
  select id into uid from auth.users where lower(email) = em and not coalesce(is_anonymous, false) order by created_at limit 1;
  perform set_config('proview.pw_sync', coalesce(uid::text, 'new'), true);
  if uid is null then
    if not coalesce(p_create, false) then
      perform set_config('proview.pw_sync', '', true);
      return jsonb_build_object('ok', true, 'email', em, 'applied', false, 'reason', 'no login');
    end if;
    uid := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', em, p_hash, now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{"made_by":"password sync"}'::jsonb, now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, 'email',
            jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), null, now(), now());
    perform set_config('proview.pw_sync', '', true);
    insert into hub_private.pw_changes (email, hash, changed_at, source, kind) values (em, p_hash, p_changed_at, 'sync', k);
    return jsonb_build_object('ok', true, 'email', em, 'applied', true, 'created', true);
  end if;
  select max(changed_at) into held from hub_private.pw_changes where email = em;
  if held is not null and held >= p_changed_at then
    perform set_config('proview.pw_sync', '', true);
    return jsonb_build_object('ok', true, 'email', em, 'applied', false, 'reason', 'older');
  end if;
  update auth.users set encrypted_password = p_hash, recovery_token = '', updated_at = now()
   where lower(email) = em and not coalesce(is_anonymous, false) and encrypted_password is distinct from p_hash;
  update auth.users set recovery_token = '' where lower(email) = em and not coalesce(is_anonymous, false) and coalesce(recovery_token, '') <> '';
  if to_regclass('auth.one_time_tokens') is not null then
    execute 'delete from auth.one_time_tokens t using auth.users u where u.id = t.user_id and lower(u.email) = $1 and t.token_type::text = ''recovery_token'''
      using em;
  end if;
  perform set_config('proview.pw_sync', '', true);
  insert into hub_private.pw_changes (email, hash, changed_at, source, kind) values (em, p_hash, p_changed_at, 'sync', k);
  return jsonb_build_object('ok', true, 'email', em, 'applied', true, 'created', false);
end $$;

-- cursors and the cron secret
create or replace function public.lic_pw_state()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(product, jsonb_build_object('cursor', cursor_at, 'last_run', last_run, 'last_error', last_error)), '{}'::jsonb)
  from hub_private.pw_sync_state;
$$;
create or replace function public.lic_pw_state_set(p_product text, p_cursor timestamptz, p_error text)
returns void language sql security definer set search_path = public as $$
  insert into hub_private.pw_sync_state (product, cursor_at, last_run, last_error) values (p_product, p_cursor, now(), p_error)
  on conflict (product) do update set cursor_at = coalesce(excluded.cursor_at, hub_private.pw_sync_state.cursor_at),
                                      last_run = now(), last_error = excluded.last_error;
$$;
create or replace function public.lic_pw_cron_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select enabled and p_secret is not null and cron_secret = p_secret from hub_private.pw_cron where id = 1), false);
$$;

do $g$ declare f text; begin
  foreach f in array array['hub_private.lic_pw_usable(text)', 'public.lic_pw_changes(timestamptz,integer)', 'public.lic_pw_accounts(text[])',
                           'public.lic_pw_all()', 'public.lic_pw_set(text,text,timestamptz,boolean,text)', 'public.lic_pw_state()',
                           'public.lic_pw_state_set(text,timestamptz,text)', 'public.lic_pw_cron_ok(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $g$;

-- ---------- 3. Every minute: licence-hub password_sync ----------
-- Calls licence-hub the same way the payment check does (its Authorization header is copied from
-- hub_private.run_payment_check, so no key is written here), with this table's own cron secret. Does nothing until
-- hub_private.pw_cron.enabled is turned on (go-live step, after the dry run).
do $c$ declare d text; bearer text; begin
  d := pg_get_functiondef('hub_private.run_payment_check()'::regprocedure);
  bearer := substring(d from '''Authorization'', ''(Bearer [^'']+)''');
  if bearer is null then raise exception 'one password: could not read the Authorization header of hub_private.run_payment_check'; end if;
  execute format($f$
    create or replace function hub_private.run_password_sync() returns bigint
    language plpgsql security definer set search_path = public, extensions as $fn$
    declare s hub_private.pw_cron;
    begin
      select * into s from hub_private.pw_cron where id = 1;
      if s.id is null or not s.enabled then return null; end if;
      return net.http_post(
        url := 'https://bpssjfrinjlrnkzhytfr.supabase.co/functions/v1/licence-hub',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L, 'x-cron-secret', s.cron_secret),
        body := jsonb_build_object('action', 'password_sync'),
        timeout_milliseconds := 55000);
    end $fn$;$f$, bearer);
end $c$;
revoke all on function hub_private.run_password_sync() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'licence-password-sync';
select cron.schedule('licence-password-sync', '* * * * *', 'select hub_private.run_password_sync()');
