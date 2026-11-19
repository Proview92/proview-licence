-- Trial requests from the Proview dashboard (owner, 19 Nov 2026): "on dashboard when logged in, separate it to active apps,
-- and inactive apps, next to inactive apps, instead of open, put a request trial button".
--
-- A signed-in Proview account (auth.users on this project) presses "Request trial" next to an app it can't open yet. That
-- stores one row here: who (email from the JWT, never from the client), which app, when, and an optional business name / note.
-- Nothing is granted automatically (NO_TRIAL_SPEC: no trials at all). The master reads the requests in the licence portal
-- (Inbox and the "Trial requests" page), grants a licence by hand if he wants to, and marks the request done or declined.
--
--   status   new       waiting for the master (an "open" request: at most one per person per app)
--            done      the master dealt with it
--            declined  the master said no
--
-- RLS: a signed-in person inserts only their own row and reads only their own rows; only is_lic_admin() reads all and
-- changes status. Safe to run more than once.

create table if not exists public.lic_trial_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  email       text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  app         text not null check (app in ('signage', 'bookings', 'employee', 'wifi', 'qrmenu', 'label', 'team', 'reservations')),
  business    text check (business is null or char_length(business) <= 120),
  note        text check (note is null or char_length(note) <= 500),
  status      text not null default 'new' check (status in ('new', 'done', 'declined')),
  created_at  timestamptz not null default now(),
  handled_at  timestamptz,
  handled_by  text,
  notified_at timestamptz   -- set once the optional "new trial request" email to the master went out
);
comment on table public.lic_trial_requests is 'Trial requests from dashboard.proviewcrm.co.uk ("Request trial"). Never granted automatically: the master handles them in the licence portal.';

-- one open request per person per app
create unique index if not exists lic_trial_requests_one_open on public.lic_trial_requests (email, app) where status = 'new';
create index if not exists lic_trial_requests_created on public.lic_trial_requests (created_at desc);

-- Insert: who and when come from the session, whatever the client sent; new rows always start as "new".
-- Update: only status changes (handled_at / handled_by are filled in here); everything else stays as it was.
create or replace function public.lic_trial_requests_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null or me = '' then raise exception 'Please sign in to your Proview account.'; end if;
    if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = me) then
      raise exception 'Confirm your email address first (check your inbox).';
    end if;
    new.id := gen_random_uuid(); new.user_id := auth.uid(); new.email := me; new.status := 'new'; new.created_at := now();
    new.handled_at := null; new.handled_by := null; new.notified_at := null;
    new.business := nullif(btrim(new.business), ''); new.note := nullif(btrim(new.note), '');
    return new;
  end if;
  -- UPDATE (RLS lets only the master get here; the service role may set notified_at)
  if auth.role() <> 'service_role' then
    new.id := old.id; new.user_id := old.user_id; new.email := old.email; new.app := old.app; new.business := old.business;
    new.note := old.note; new.created_at := old.created_at; new.notified_at := old.notified_at;
    if new.status is distinct from old.status then new.handled_at := now(); new.handled_by := me;
    else new.handled_at := old.handled_at; new.handled_by := old.handled_by; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.lic_trial_requests_guard() from public, anon, authenticated;
drop trigger if exists lic_trial_requests_guard on public.lic_trial_requests;
create trigger lic_trial_requests_guard before insert or update on public.lic_trial_requests
  for each row execute function public.lic_trial_requests_guard();

alter table public.lic_trial_requests enable row level security;
revoke all on public.lic_trial_requests from anon, authenticated;
grant select on public.lic_trial_requests to authenticated;
grant insert (app, business, note) on public.lic_trial_requests to authenticated;
grant update (status) on public.lic_trial_requests to authenticated;

drop policy if exists "trial requests: insert own" on public.lic_trial_requests;
create policy "trial requests: insert own" on public.lic_trial_requests for insert to authenticated
  with check (user_id = auth.uid() and email = lower(coalesce(auth.jwt() ->> 'email', '')) and status = 'new');

drop policy if exists "trial requests: read own or master" on public.lic_trial_requests;
create policy "trial requests: read own or master" on public.lic_trial_requests for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_lic_admin());

drop policy if exists "trial requests: master updates" on public.lic_trial_requests;
create policy "trial requests: master updates" on public.lic_trial_requests for update to authenticated
  using (public.is_lic_admin()) with check (public.is_lic_admin());
-- no delete policy: requests are kept
