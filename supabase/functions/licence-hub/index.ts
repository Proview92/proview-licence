import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

// Bearer-token auth only (no cookies), so any origin is safe.
function cors(_req: Request) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

type App = { product: string; label: string; url: string; apikey: string; token: string; app_url: string };

const TYPES: Record<string, string[]> = {
  signage: ["trial7", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  bookings: ["trial", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  employee: ["trial3", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  wifi: ["trial", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
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

const PAY_PLANS = ["m1", "m3", "m6", "m12", "m24", "m36", "lifetime"];
const REF_CODES: Record<string, string> = { pvs: "signage", pvb: "bookings", pve: "employee", pvw: "wifi" };

async function loadApps(db: any): Promise<Record<string, App>> {
  const { data, error } = await db.rpc("lic_app_config");
  if (error) throw error;
  return Object.fromEntries((data as App[]).map((a) => [a.product, a]));
}

// send each product's active plans to its app, where customers see "Buy / renew online"
async function pushPlans(db: any, apps: Record<string, App>) {
  const { data: plans } = await db.from("lic_plans").select("*").eq("active", true);
  const out: Record<string, unknown> = {};
  for (const app of Object.values(apps)) {
    const mine = Object.fromEntries((plans ?? []).filter((p: any) => p.product === app.product)
      .map((p: any) => [p.plan, { label: p.label, amount: p.amount, currency: p.currency, link: p.link, ref: Object.keys(REF_CODES).find((k) => REF_CODES[k] === app.product) }]));
    try {
      const r = await fetch(`${app.url}/rest/v1/rpc/hub_plans`, {
        method: "POST", headers: { apikey: app.apikey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: app.token, p_plans: mine }),
      });
      out[app.product] = r.ok ? { ok: true, plans: Object.keys(mine).length } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { out[app.product] = { ok: false, error: String((e as Error).message ?? e) }; }
  }
  return out;
}

const fmtDay = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

// read paid Stripe Checkout Sessions and apply licences for references made by the apps:
//   pvs__<screen uuid>__<plan>   pvb__<site id>__<plan>   pve__<org id>__<member id>__<plan>   pvw__<wifi site id>__<plan>
async function checkPayments(db: any, apps: Record<string, App>) {
  const { data: cfg } = await db.rpc("lic_stripe_config");
  const c = (cfg as any[])?.[0];
  if (!c?.enabled || !c?.secret_key) return { ok: true, skipped: "Online payments are off or no Stripe key is saved" };
  const since = Math.max(Number(c.last_created || 0) - 3600, Math.floor(Date.now() / 1000) - 30 * 86400);
  let applied = 0, seen = 0, maxCreated = Number(c.last_created || 0), after: string | null = null, err: string | null = null;
  const { data: planRows } = await db.from("lic_plans").select("*");
  const planOf = (prod: string, plan: string) => (planRows ?? []).find((p: any) => p.product === prod && p.plan === plan);
  try {
    for (let page = 0; page < 10; page++) {
      const u = new URL("https://api.stripe.com/v1/checkout/sessions");
      u.searchParams.set("limit", "100"); u.searchParams.set("created[gte]", String(since));
      if (after) u.searchParams.set("starting_after", after);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${c.secret_key}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(`Stripe said ${r.status}: ${j?.error?.message ?? ""}`.slice(0, 200));
      for (const x of j.data ?? []) {
        seen++; maxCreated = Math.max(maxCreated, Number(x.created || 0));
        if (x.payment_status !== "paid") continue;
        const ref: string = x.client_reference_id || "";
        const parts = ref.split("__");
        const product = REF_CODES[parts[0]];
        if (!product || parts.length < 3) continue;
        const plan = parts[parts.length - 1];
        const unit = parts.slice(1, -1).join("/");
        const { data: ins } = await db.from("lic_payments").insert({
          session_id: x.id, product, unit_ext_id: unit, plan, amount: x.amount_total, currency: x.currency,
          email: x.customer_details?.email ?? null, paid_at: new Date(Number(x.created) * 1000).toISOString(),
        }).select("session_id");
        if (!ins?.length) continue; // already handled
        const p = planOf(product, plan);
        const note = (n: string) => db.from("lic_payments").update({ note: n }).eq("session_id", x.id);
        if (!p) { await note("Unknown plan; not applied"); continue; }
        if (Number(x.amount_total) < p.amount || String(x.currency).toLowerCase() !== p.currency) { await note("Amount does not match the plan; not applied"); continue; }
        try {
          const res = await callApp(apps[product], "set", { unit, type: plan, extend: true, notes: `Paid online ${fmtDay()}` });
          const { data: before } = await db.from("lic_units").select("name,account_ext_id,license_type,expires_at").eq("product", product).eq("ext_id", unit).maybeSingle();
          const { data: acc } = before?.account_ext_id
            ? await db.from("lic_accounts").select("name").eq("product", product).eq("ext_id", before.account_ext_id).maybeSingle() : { data: null };
          await db.from("lic_units").update({ license_type: res.license_type, starts_at: res.starts_at, expires_at: res.expires_at, notes: res.notes, synced_at: new Date().toISOString() })
            .eq("product", product).eq("ext_id", unit);
          await db.from("lic_payments").update({ applied: true, applied_at: new Date().toISOString(), note: null }).eq("session_id", x.id);
          await db.from("lic_audit").insert({ admin_email: "Online payment (Stripe)", product, unit_ext_id: unit, unit_name: before?.name ?? null,
            account_name: acc?.name ?? null, action: `paid online ${plan}`,
            before: before ? { license_type: before.license_type, expires_at: before.expires_at } : null,
            after: { ...res, amount: x.amount_total, currency: x.currency, email: x.customer_details?.email ?? null } });
          applied++;
        } catch (e) { await note("Could not apply: " + String((e as Error).message ?? e).slice(0, 150)); }
      }
      if (!j.has_more || !j.data?.length) break;
      after = j.data[j.data.length - 1].id;
    }
  } catch (e) { err = String((e as Error).message ?? e).slice(0, 250); }
  await db.rpc("lic_stripe_update", { p_last_created: maxCreated, p_error: err });
  return { ok: !err, applied, seen, error: err };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...h, "Content-Type": "application/json" } });

  try {
    const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // scheduled payment check (pg_cron in this project) — authenticated by a secret only the database knows
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret && action === "check_payments") {
      const { data: cfg } = await db.rpc("lic_stripe_config");
      const c = (cfg as any[])?.[0];
      if (!c || cronSecret !== c.cron_secret) return json({ error: "Not authorised" }, 403);
      return json(await checkPayments(db, await loadApps(db)));
    }

    // who is calling?
    const auth = req.headers.get("Authorization") ?? "";
    const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: isAdmin, error: aerr } = await userDb.rpc("is_lic_admin");
    if (aerr || !isAdmin) return json({ error: "Not authorised" }, 403);
    const { data: u } = await userDb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    const adminEmail = u?.user?.email ?? null;

    const apps = await loadApps(db);

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

    if (action === "save_plans") {
      // plans: [{product, plan, label, amount, currency, link, active}]
      const plans = Array.isArray(body.plans) ? body.plans : [];
      for (const p of plans) {
        if (!TYPES[p.product] || !PAY_PLANS.includes(p.plan)) throw new Error(`Unknown plan ${p.product}/${p.plan}`);
        if (p.active && !/^https:\/\/(buy|checkout)\.stripe\.com\//.test(p.link || "")) throw new Error(`${p.label}: paste a Stripe Payment Link (https://buy.stripe.com/…)`);
        if (p.active && !(Number(p.amount) > 0)) throw new Error(`${p.label}: enter the price`);
      }
      const touched = [...new Set(plans.map((p: any) => p.product))];
      for (const prod of touched) await db.from("lic_plans").delete().eq("product", prod);
      const rows = plans.filter((p: any) => p.active).map((p: any) => ({
        product: p.product, plan: p.plan, label: p.label, amount: Math.round(Number(p.amount)), currency: (p.currency || "gbp").toLowerCase(),
        link: p.link.trim(), active: true, updated_at: new Date().toISOString() }));
      if (rows.length) { const { error } = await db.from("lic_plans").insert(rows); if (error) throw error; }
      const pushed = await pushPlans(db, apps);
      await db.from("lic_audit").insert({ admin_email: adminEmail, action: "updated online prices", after: { products: touched, plans: rows.length } });
      return json({ ok: true, pushed });
    }

    if (action === "push_plans") return json({ ok: true, pushed: await pushPlans(db, apps) });

    if (action === "check_payments") return json(await checkPayments(db, apps));

    if (action === "apps") {
      return json({ apps: Object.values(apps).map((a) => ({ product: a.product, label: a.label, app_url: a.app_url })), types: TYPES });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
