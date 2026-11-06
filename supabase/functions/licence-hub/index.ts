import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

// Bearer-token auth only (no cookies), so any origin is safe.
function cors(_req: Request) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

type App = { product: string; label: string; url: string; apikey: string; token: string; app_url: string };

const TYPES: Record<string, string[]> = {
  signage: ["trial7", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  bookings: ["trial", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  employee: ["trial3", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
};

async function callApp(app: App, action: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${app.url}/rest/v1/rpc/hub_call`, {
    method: "POST",
    headers: { apikey: app.apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: app.token, p_action: action, p_args: args }),
  });
  const txt = await r.text();
  let body: any;
  try { body = JSON.parse(txt); } catch { body = txt; }
  if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return body;
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...h, "Content-Type": "application/json" } });

  try {
    // who is calling?
    const auth = req.headers.get("Authorization") ?? "";
    const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: isAdmin, error: aerr } = await userDb.rpc("is_lic_admin");
    if (aerr || !isAdmin) return json({ error: "Not authorised" }, 403);
    const { data: u } = await userDb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    const adminEmail = u?.user?.email ?? null;

    const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    const { data: appsRows, error: cerr } = await db.rpc("lic_app_config");
    if (cerr) throw cerr;
    const apps: Record<string, App> = Object.fromEntries((appsRows as App[]).map((a) => [a.product, a]));

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "sync") {
      const result: Record<string, unknown> = {};
      for (const app of Object.values(apps)) {
        try {
          const d = await callApp(app, "list");
          const now = new Date().toISOString();
          const accounts = (d.accounts ?? []).map((a: any) => ({
            product: app.product, ext_id: String(a.id), name: a.name, contact_email: a.contact_email?.toLowerCase() ?? null,
            extra: { created_at: a.created_at, self_signup: a.self_signup, suspended: a.suspended ?? false, phone: a.phone ?? null },
            gone: false, synced_at: now,
          }));
          const units = (d.units ?? []).map((x: any) => ({
            product: app.product, ext_id: String(x.id), account_ext_id: x.account_id ? String(x.account_id) : null,
            name: x.name, detail: x.detail ?? null, license_type: x.license_type ?? null,
            starts_at: x.starts_at ?? null, expires_at: x.expires_at ?? null, notes: x.notes ?? null,
            extra: { last_seen: x.last_seen ?? null, archived: x.archived ?? false }, gone: false, synced_at: now,
          }));
          if (accounts.length) {
            const { error } = await db.from("lic_accounts").upsert(accounts, { onConflict: "product,ext_id" });
            if (error) throw error;
          }
          if (units.length) {
            const { error } = await db.from("lic_units").upsert(units, { onConflict: "product,ext_id" });
            if (error) throw error;
          }
          await db.from("lic_accounts").update({ gone: true }).eq("product", app.product).lt("synced_at", now);
          await db.from("lic_units").update({ gone: true }).eq("product", app.product).lt("synced_at", now);
          result[app.product] = { ok: true, accounts: accounts.length, units: units.length };
        } catch (e) {
          result[app.product] = { ok: false, error: String((e as Error).message ?? e) };
        }
      }

      // first time we see an account, attach it to a master customer (matched by email, else new)
      const { data: fresh } = await db.from("lic_accounts").select("*").eq("link_checked", false).is("customer_id", null);
      let linked = 0, created = 0;
      for (const a of fresh ?? []) {
        let cid: string | null = null;
        if (a.contact_email) {
          const { data: m } = await db.from("lic_customers").select("id").eq("contact_email", a.contact_email).limit(1);
          cid = m?.[0]?.id ?? null;
        }
        if (!cid) {
          const { data: c, error } = await db.from("lic_customers")
            .insert({ name: a.name || a.contact_email || "Unnamed", contact_email: a.contact_email, phone: a.extra?.phone ?? null })
            .select("id").single();
          if (error) continue;
          cid = c.id; created++;
        } else linked++;
        await db.from("lic_accounts").update({ customer_id: cid, link_checked: true }).eq("product", a.product).eq("ext_id", a.ext_id);
      }
      await db.from("lic_accounts").update({ link_checked: true }).eq("link_checked", false);
      return json({ ok: true, apps: result, auto_linked: linked, customers_created: created });
    }

    if (action === "set") {
      // items: [{product, unit, type|null, extend, expires, notes}]
      const items = Array.isArray(body.items) ? body.items : [body];
      const out = [];
      for (const it of items) {
        const app = apps[it.product];
        if (!app) { out.push({ ...it, ok: false, error: "Unknown product" }); continue; }
        const type = it.type ?? null;
        if (type !== null && !TYPES[it.product].includes(type)) { out.push({ ...it, ok: false, error: `Unknown licence type ${type}` }); continue; }
        const { data: before } = await db.from("lic_units").select("*").eq("product", it.product).eq("ext_id", String(it.unit)).maybeSingle();
        const { data: acc } = before?.account_ext_id
          ? await db.from("lic_accounts").select("name").eq("product", it.product).eq("ext_id", before.account_ext_id).maybeSingle()
          : { data: null };
        try {
          const after = await callApp(app, "set", {
            unit: String(it.unit), type, extend: !!it.extend, expires: it.expires ?? null, notes: it.notes ?? null,
          });
          await db.from("lic_units").update({
            license_type: after.license_type, starts_at: after.starts_at, expires_at: after.expires_at, notes: after.notes,
            synced_at: new Date().toISOString(), gone: false,
          }).eq("product", it.product).eq("ext_id", String(it.unit));
          await db.from("lic_audit").insert({
            admin_email: adminEmail, product: it.product, unit_ext_id: String(it.unit), unit_name: before?.name ?? null,
            account_name: acc?.name ?? null, action: type === null ? "removed" : (it.extend ? `extended ${type}` : `set ${type}`),
            before: before ? { license_type: before.license_type, starts_at: before.starts_at, expires_at: before.expires_at } : null,
            after,
          });
          out.push({ product: it.product, unit: it.unit, ok: true, after });
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          await db.from("lic_audit").insert({
            admin_email: adminEmail, product: it.product, unit_ext_id: String(it.unit), unit_name: before?.name ?? null,
            account_name: acc?.name ?? null, action: "failed", error: msg,
          });
          out.push({ product: it.product, unit: it.unit, ok: false, error: msg });
        }
      }
      return json({ ok: out.every((o: any) => o.ok), results: out });
    }

    if (action === "apps") {
      return json({ apps: Object.values(apps).map((a) => ({ product: a.product, label: a.label, app_url: a.app_url })), types: TYPES });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
