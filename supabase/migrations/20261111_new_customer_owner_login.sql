-- "New customer" (licence portal) works like Signage's "Add business": the master creates the customer
-- together with a ready-to-use Proview account login for its owner, in one go. No email is sent.
--
-- Until now a customer (lic_customers) had no login of its own: the only logins on this project are
-- Proview accounts (auth.users), used by the portal (licence admins in lic_admins only) and by
-- dashboard.proviewcrm.co.uk, which signs people in to the apps where that email is an owner/manager.
-- This adds the smallest link: the customer remembers its owner's login (owner_user_id) plus the name,
-- email and mobile typed for them. Safe to run more than once.

alter table public.lic_customers
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists owner_name    text,
  add column if not exists owner_email   text,
  add column if not exists owner_mobile  text;
create index if not exists lic_customers_owner_idx on public.lic_customers (owner_user_id);

-- Master only (is_lic_admin, the portal's existing rule). All or nothing: any error undoes the customer.
--  * New email: a confirmed login with this password (name and mobile in its metadata), no email sent.
--  * Email already has a login: it becomes the owner, and its password is NEVER changed.
create or replace function public.lic_add_customer(
  p_business text, p_name text, p_email text, p_mobile text, p_password text,
  p_contact_email text default null, p_phone text default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  biz  text := trim(coalesce(p_business, ''));
  nm   text := trim(coalesce(p_name, ''));
  em   text := lower(trim(coalesce(p_email, '')));
  mob  text := nullif(trim(coalesce(p_mobile, '')), '');
  ce   text := nullif(lower(trim(coalesce(p_contact_email, ''))), '');
  uid  uuid;
  cid  uuid;
  existing boolean := false;
begin
  if not public.is_lic_admin() then raise exception 'Only the Proview licence administrator can add customers.'; end if;
  if length(biz) < 2 then raise exception 'Enter the business name.'; end if;
  if length(nm) < 2 then raise exception 'Enter the owner''s name.'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if ce is not null and ce !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid contact email, or leave it empty.'; end if;

  insert into public.lic_customers (name, contact_email, phone, notes, owner_name, owner_email, owner_mobile)
  values (biz, coalesce(ce, em), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), nm, em, mob)
  returning id into cid;

  select id into uid from auth.users where lower(email) = em and not coalesce(is_anonymous, false) limit 1;
  if uid is not null then
    existing := true;                       -- keep their password exactly as it is
  else
    if length(coalesce(p_password, '')) < 8 then raise exception 'The password needs at least 8 characters.'; end if;
    uid := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', em,
            extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_strip_nulls(jsonb_build_object('full_name', nm, 'mobile', mob)), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, 'email',
            jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), now(), now(), now());
  end if;

  update public.lic_customers set owner_user_id = uid where id = cid;
  return jsonb_build_object('customer_id', cid, 'user_id', uid, 'email', em, 'existing', existing);
end;
$$;
revoke all on function public.lic_add_customer(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.lic_add_customer(text, text, text, text, text, text, text, text) to authenticated;
