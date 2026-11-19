-- Proview dashboard accounts (owner, 19 Nov 2026): the licence portal shows, for each owner / admin / manager email, whether
-- it has a Proview account (the login of dashboard.proviewcrm.co.uk, i.e. auth.users on this project) and in what state:
--   none     no Proview account for this email
--   invited  an account exists but nobody has signed in with it yet (invite or "choose a password" email not used yet)
--   active   signed in at least once (last_sign_in_at)
-- Master only (is_lic_admin). Reads only the email and the created / confirmed / invited / last-sign-in times:
-- never passwords, tokens or metadata. Emails are matched case-insensitively; each asked email gets exactly one row,
-- in the order given, duplicates and blanks dropped. Safe to run more than once.

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
           case when u.id is null then 'none' when u.last_sign_in_at is not null then 'active' else 'invited' end,
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
