# Proview Licences

Admin portal for licences across Proview Signage, Bookings, Employee and WiFi.
Live at https://license.proviewcrm.co.uk (GitHub Pages).

- `index.html` – the portal (static page, signs in to the `proview-licence` Supabase project)
- `supabase/functions/licence-hub` – edge function that syncs from and pushes licence changes to each app's `hub_call` RPC

WiFi (wifi.proviewcrm.co.uk) is a Node server rather than a Supabase project, but it answers the same
`POST /rest/v1/rpc/hub_call` and `/rest/v1/rpc/hub_plans` calls, so the hub treats it like the other apps.
