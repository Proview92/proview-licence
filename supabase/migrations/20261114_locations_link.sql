-- Locations, not customers. Only the master links them (LOCATIONS_LINK_SPEC.md, owner 12 Nov 2026).
-- A card (lic_customers) is now called a Location. Linking two locations (licence-hub 'link') merges their businesses
-- in every app they both have and merges the two cards; 'unlink' moves one linked location out again, into its own
-- businesses and its own card. To know which location units belong to which linked location, every location unit
-- remembers the location (card) it came from:
--   lic_link_origins     one row per original location: its name and contact details (kept after its card is merged
--                        away), and the card it was unlinked into (so pressing Unlink again finishes the same card)
--   lic_units.origin_id  the linked location a location unit belongs to (null = the card's own, never linked)
-- Written only by the licence-hub edge function (service role); the master reads them. Sync never touches origin_id.
-- Run before deploying the licence-hub edge function that uses them. Safe to run more than once.

create table if not exists public.lic_link_origins (
  id             uuid primary key,          -- = the id of the card the location had when it was first linked
  name           text not null,
  contact_email  text,
  phone          text,
  split_card_id  uuid references public.lic_customers(id) on delete set null,
  created_at     timestamptz not null default now()
);
alter table public.lic_link_origins enable row level security;
drop policy if exists origins_read on public.lic_link_origins;
create policy origins_read on public.lic_link_origins for select to authenticated using (public.is_lic_admin());

alter table public.lic_units add column if not exists origin_id uuid references public.lic_link_origins(id) on delete set null;
create index if not exists lic_units_origin on public.lic_units (origin_id);

comment on table public.lic_link_origins is 'Each original location that has been linked with another (LOCATIONS_LINK_SPEC). Written by licence-hub.';
comment on column public.lic_units.origin_id is 'Which linked location this location unit belongs to (null = its card''s own). Set by licence-hub link / unlink; never by sync.';
