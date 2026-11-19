// Optional: email the master when someone presses "Request trial" on dashboard.proviewcrm.co.uk (owner, 19 Nov 2026).
//
//   POST { id }   (the signed-in person's own JWT)  → { ok, sent }
//
// The dashboard calls this right after it stores a request in public.lic_trial_requests. It sends at most one email per
// request: only for the caller's own request, still "new", made in the last 10 minutes and not emailed before
// (notified_at). Nothing is granted: the email only tells the master to look in the licence portal (NO_TRIAL_SPEC).
//
// Needs the RESEND_API_KEY secret (Resend; proviewcrm.co.uk is verified there). Without it, it does nothing and says so.
// Optional secrets: TRIAL_MAIL_TO (default altun@proviewtech.co.uk), TRIAL_MAIL_FROM (default Proview <noreply@proviewcrm.co.uk>).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const NAMES: Record<string, string> = { bookings: "Proview Bookings", employee: "Proview Employee", signage: "Proview Signage", label: "Proview Label", wifi: "Proview WiFi", qrmenu: "Proview QR Menu", team: "Proview Team", reservations: "Proview Reservations" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!user?.email) return json({ error: "Please sign in to your Proview account." }, 401);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ ok: true, sent: false, why: "RESEND_API_KEY not set" });
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Unknown request" }, 400);

  // claim it (once): the caller's own, still new, recent, not emailed yet
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: r, error } = await admin.from("lic_trial_requests").update({ notified_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", user.id).eq("status", "new").is("notified_at", null)
    .gte("created_at", new Date(Date.now() - 10 * 60000).toISOString()).select().maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!r) return json({ ok: true, sent: false });

  const app = NAMES[r.app] || r.app;
  const when = new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const html = `<p><b>${esc(r.email)}</b> asked for a trial of <b>${esc(app)}</b> on ${esc(when)}.</p>`
    + (r.business ? `<p>Business: ${esc(r.business)}</p>` : "") + (r.note ? `<p>Note: ${esc(r.note)}</p>` : "")
    + `<p>Nothing has been granted. Open the licence portal to grant a licence by hand, then mark the request done or declined:<br>`
    + `<a href="https://license.proviewcrm.co.uk/#trials">license.proviewcrm.co.uk · Trial requests</a></p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("TRIAL_MAIL_FROM") || "Proview <noreply@proviewcrm.co.uk>",
      to: [Deno.env.get("TRIAL_MAIL_TO") || "altun@proviewtech.co.uk"],
      reply_to: r.email,
      subject: `Trial request: ${app} from ${r.email}`,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => ({ ok: false, text: async () => String(e) } as Response));
  if (!res.ok) {
    await admin.from("lic_trial_requests").update({ notified_at: null }).eq("id", id);   // let a later try send it
    return json({ ok: false, sent: false, error: (await res.text()).slice(0, 300) }, 502);
  }
  return json({ ok: true, sent: true });
});
