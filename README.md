# Proview Licences

Admin portal for licences across Proview Signage, Bookings and Employee.
Live at https://license.proviewcrm.co.uk (GitHub Pages).

- `index.html` – the portal (static page, signs in to the `proview-licence` Supabase project)
- `supabase/functions/licence-hub` – edge function that syncs from and pushes licence changes to each app's `hub_call` RPC
