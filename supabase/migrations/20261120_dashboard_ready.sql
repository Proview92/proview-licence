-- Dashboard status after one password (owner, 19 Nov 2026: "remove the dashboard invited messages for the already setup
-- users, as we set the passwords already"). lic_dashboard_accounts said 'invited' for every Proview account that had
-- never signed in at dashboard.proviewcrm.co.uk, even when its password was already copied from the person's apps by
-- the password sync. Now an account counts as 'active' (Dashboard ✅, no "Send dashboard invite") when it has signed in
-- OR it has a confirmed email and a password its owner knows (hub_private.lic_pw_usable: the synced / changed password).
-- 'invited' is left only for accounts nobody can sign in to yet (invite not used, or a random password from New
-- business). Same columns as before; last_sign_in_at stays empty for "password set, not signed in yet".
-- Needs 20261120_one_password.sql (hub_private.lic_pw_usable). Safe to run more than once.

create or replace function public.lic_dashboard_accounts(p_emails text[])
returns table (email text, state text, created_at timestamptz, email_confirmed_at timestamptz,
               invited_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_lic_admin() then raise exception 'Only the Proview licence administrator can see dashboard accounts.'; end if;
  if coalesce(array_length(p_emails, 1), 0) > 500 then raise exception 'Ask for at most 500 emails at a time.'; end if;
  return query
    with asked as (
      select e, min(o) as o
      from (select lower(trim(x)) as e, o from unnest(coalesce(p_emails, '{}'::text[])) with ordinality as t(x, o)) s
      where e is not null and e <> ''
      group by e
    )
    select a.e,
           case when u.id is null then 'none'
                when u.last_sign_in_at is not null then 'active'
                when u.email_confirmed_at is not null and hub_private.lic_pw_usable(a.e) then 'active'
                else 'invited' end,
           u.created_at, u.email_confirmed_at, u.invited_at, u.last_sign_in_at
    from asked a
    left join lateral (
      select au.id, au.created_at, au.email_confirmed_at, au.invited_at, au.last_sign_in_at
      from auth.users au
      where lower(au.email) = a.e and not coalesce(au.is_anonymous, false)
      order by au.created_at
      limit 1
    ) u on true
    order by a.o;
end;
$$;
revoke all on function public.lic_dashboard_accounts(text[]) from public, anon;
grant execute on function public.lic_dashboard_accounts(text[]) to authenticated;
