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
  qrmenu: ["trial3", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"],
  label: ["trial", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"], // per location (trial = set by hand)
};

// What a unit is (PER_LOCATION_LICENCE_SPEC): every app licenses each location; Signage also each TV and Employee each
// extra person over the package ("Staff add-on"). An app that sends no kind sends its old unit type, DEFAULT_KIND.
const KINDS: Record<string, string[]> = {
  signage: ["screen", "location"], employee: ["staff", "location"],
  bookings: ["location"], wifi: ["location"], qrmenu: ["location"], label: ["location"],
};
const DEFAULT_KIND: Record<string, string> = { signage: "screen", employee: "staff", bookings: "location", wifi: "location", qrmenu: "location", label: "location" };
const kindOf = (product: string, k: unknown) => {
  const v = typeof k === "string" && k ? k : DEFAULT_KIND[product];
  return (KINDS[product] ?? []).includes(v) ? v : null;
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
const REF_CODES: Record<string, string> = { pvs: "signage", pvb: "bookings", pve: "employee", pvw: "wifi", pvq: "qrmenu", pvl: "label" };
const codeOf = (product: string) => Object.keys(REF_CODES).find((k) => REF_CODES[k] === product);
// Stripe client_reference_id (/home/claude/HUB_UNITS.md): the unit is the middle parts joined with "/", as before.
//   pvs__<screen>__<plan>                 Signage TV            unit <screen>
//   pvs__loc__<site>__<plan>              Signage location      unit loc/<site>          (the unit id Signage lists)
//   pve__<org>__<member>__<plan>          Employee staff add-on unit <org>/<member>
//   pve__loc__<org>__<location>__<plan>   Employee location     unit loc/<org>/<location> (the unit id Employee lists)
//   pvl__<site>__<plan>                   Label location        unit <site>   (pvl__loc__<site>__<plan> also accepted)
//   pvb / pvq / pvw __<id>__<plan>        Bookings / QR Menu / WiFi location (unchanged)
// kind: "location" when the second part is "loc", else the app's default kind.
export function parseRef(ref: string) {
  const parts = (ref || "").split("__"); const product = REF_CODES[parts[0]];
  if (!product || parts.length < 3 || parts.some((x) => !x)) return null;
  const loc = parts[1] === "loc";
  if (loc && parts.length < 4) return null;
  const kind = loc ? "location" : DEFAULT_KIND[product];
  if (!KINDS[product].includes(kind)) return null;
  // location-only apps list their locations without the "loc/" prefix
  const idParts = loc && DEFAULT_KIND[product] === "location" ? parts.slice(2, -1) : parts.slice(1, -1);
  return { product, kind, plan: parts[parts.length - 1], unit: idParts.join("/") };
}
// The prices an app gets (hub_plans), as in HUB_UNITS.md. ref = the product code; the app builds the full reference.
//   one kind (Bookings, QR Menu, WiFi, Label), or an app that doesn't list other kinds yet: flat { m12: {...} } with
//   only its default kind (older builds read it as they always have)
//   several kinds, app lists them: { location: { m12: {...} }, screen: { m12: {...} } }   (Employee: location / staff)
export function plansFor(product: string, rows: any[], kindsListed: Set<string>) {
  const code = codeOf(product), def = DEFAULT_KIND[product];
  const entry = (p: any) => [p.plan, { label: p.label, amount: p.amount, currency: p.currency, link: p.link, ref: code, kind: p.kind || def, plan: p.plan }];
  const mine = rows.filter((p: any) => p.product === product);
  const nested = KINDS[product].length > 1 && KINDS[product].some((k) => k !== def && kindsListed.has(k));
  if (!nested) return Object.fromEntries(mine.filter((p: any) => (p.kind || def) === def).map(entry));
  return Object.fromEntries(KINDS[product].map((k) => [k, Object.fromEntries(mine.filter((p: any) => (p.kind || def) === k).map(entry))]));
}

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
    if (!TYPES[app.product]?.length) continue;
    // the per-kind form goes only to an app that already lists units of another kind (an older build would read the
    // kind names as plans)
    const { data: kinds } = await db.from("lic_units").select("kind").eq("product", app.product).eq("gone", false);
    const mine = plansFor(app.product, plans ?? [], new Set((kinds ?? []).map((k: any) => k.kind)));
    try {
      const r = await fetch(`${app.url}/rest/v1/rpc/hub_plans`, {
        method: "POST", headers: { apikey: app.apikey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: app.token, p_plans: mine }),
      });
      const n = Object.values(mine).reduce((t: number, v: any) => t + (v && typeof v === "object" && !("link" in v) ? Object.keys(v).length : 1), 0);
      out[app.product] = r.ok ? { ok: true, plans: n } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { out[app.product] = { ok: false, error: String((e as Error).message ?? e) }; }
  }
  return out;
}

const fmtDay = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

// ---------- online payments (Stripe) ----------
// The apps open a Stripe Payment Link with client_reference_id set to:
//   pvs__<screen uuid>__<plan>   pvb__<site id>__<plan>   pve__<org id>__<member id>__<plan> (staff add-on)   pvw__<wifi site id>__<plan>
//   pvq__<qrmenu location id>__<plan>   pvl__<label location id>__<plan>   pvs__loc__<site id>__<plan>   pve__loc__<org id>__<location id>__<plan>
// Every 5 minutes (and on "Check now") we read Stripe and:
//   • apply paid checkouts (one-off plans, and the first month of a monthly subscription)
//   • remember which subscription belongs to which licence, then apply each monthly renewal invoice
//   • record declined / abandoned checkouts and failed renewals, with Stripe's reason, for "Failed payments"
// The restricted key needs read access to Checkout Sessions, Invoices and PaymentIntents.
const STRIPE_VERSION = "2024-06-20"; // pinned so invoice.subscription / invoice.payment_intent keep their shape

const DECLINES: Record<string, string> = {
  insufficient_funds: "Insufficient funds", card_declined: "Card declined", generic_decline: "Card declined by the bank",
  do_not_honor: "Card declined by the bank", expired_card: "Card has expired", incorrect_cvc: "Wrong security code (CVC)",
  incorrect_number: "Wrong card number", invalid_cvc: "Wrong security code (CVC)", invalid_expiry_year: "Wrong expiry date",
  invalid_expiry_month: "Wrong expiry date", lost_card: "Card reported lost", stolen_card: "Card reported stolen",
  fraudulent: "Blocked as suspected fraud", processing_error: "Card processing error, try again",
  authentication_required: "Card needs 3D Secure authentication", card_not_supported: "Card not supported",
  currency_not_supported: "Card doesn't support this currency", pickup_card: "Card can't be used (bank asked to keep it)",
  restricted_card: "Card is restricted", transaction_not_allowed: "Card doesn't allow this payment",
  withdrawal_count_limit_exceeded: "Card limit reached", card_velocity_exceeded: "Card limit reached",
  payment_intent_authentication_failure: "3D Secure authentication failed",
};
function declineReason(e: any): string | null {
  if (!e) return null;
  const code = e.decline_code || e.code;
  const nice = (code && DECLINES[code]) || e.message || code || "Payment failed";
  return code && !DECLINES[code] ? `${nice} (${code})` : nice;
}

async function stripeList(key: string, path: string, params: Record<string, string>, onItem: (x: any) => Promise<void>) {
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const u = new URL(`https://api.stripe.com/v1/${path}`);
    u.searchParams.set("limit", "100");
    for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
    if (after) u.searchParams.set("starting_after", after);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION } });
    const j = await r.json();
    if (!r.ok) {
      const m = j?.error?.message ?? "";
      if (r.status === 403 || /permission/i.test(m)) throw new Error(`The Stripe key can't read ${path.replace("checkout/", "checkout ")}. In Stripe, edit the restricted key and give it Read access to Checkout Sessions, Invoices and PaymentIntents.`);
      throw new Error(`Stripe said ${r.status}: ${m}`.slice(0, 200));
    }
    for (const x of j.data ?? []) await onItem(x);
    if (!j.has_more || !j.data?.length) break;
    after = j.data[j.data.length - 1].id;
  }
}

async function checkPayments(db: any, apps: Record<string, App>) {
  const { data: cfg } = await db.rpc("lic_stripe_config");
  const c = (cfg as any[])?.[0];
  if (!c?.enabled || !c?.secret_key) return { ok: true, skipped: "Online payments are off or no Stripe key is saved" };
  // checkouts stay open for up to 24 hours, so always look back at least 25 hours
  const since = Math.max(Number(c.last_created || 0) - 25 * 3600, Math.floor(Date.now() / 1000) - 30 * 86400);
  let applied = 0, seen = 0, failed = 0, maxCreated = Number(c.last_created || 0), err: string | null = null;
  const { data: planRows } = await db.from("lic_plans").select("*");
  const planOf = (prod: string, kind: string, plan: string) =>
    (planRows ?? []).find((p: any) => p.product === prod && (p.kind || DEFAULT_KIND[prod]) === kind && p.plan === plan);
  const iso = (t: number) => new Date(Number(t) * 1000).toISOString();

  // add the paid time to the licence; returns an error message or null
  async function applyPaid(id: string, product: string, kind: string, unit: string, plan: string, amount: number, currency: string, email: string | null, what: string) {
    const note = (n: string) => db.from("lic_payments").update({ note: n }).eq("session_id", id);
    const p = planOf(product, kind, plan);
    if (!p) { await note("Unknown plan; not applied"); return; }
    if (Number(amount) < p.amount || String(currency).toLowerCase() !== p.currency) { await note("Amount does not match the plan; not applied"); return; }
    try {
      if (!apps[product]) { await note("This app isn't connected to the licence portal; not applied"); return; }
      const res = await callApp(apps[product], "set", { unit, kind, type: plan, extend: true, notes: `${what} ${fmtDay()}` });
      const { data: before } = await db.from("lic_units").select("name,account_ext_id,license_type,expires_at").eq("product", product).eq("ext_id", unit).maybeSingle();
      const { data: acc } = before?.account_ext_id
        ? await db.from("lic_accounts").select("name").eq("product", product).eq("ext_id", before.account_ext_id).maybeSingle() : { data: null };
      await db.from("lic_units").update({ license_type: res.license_type, starts_at: res.starts_at, expires_at: res.expires_at, notes: res.notes, synced_at: new Date().toISOString() })
        .eq("product", product).eq("ext_id", unit);
      await db.from("lic_payments").update({ applied: true, applied_at: new Date().toISOString(), note: null }).eq("session_id", id);
      await db.from("lic_audit").insert({ admin_email: "Online payment (Stripe)", product, unit_ext_id: unit, unit_name: before?.name ?? null,
        account_name: acc?.name ?? null, action: `${what.toLowerCase()} ${plan}${kind === DEFAULT_KIND[product] ? "" : ` (${kind})`}`,
        before: before ? { license_type: before.license_type, expires_at: before.expires_at } : null,
        after: { ...res, amount, currency, email } });
      applied++;
    } catch (e) { await note("Could not apply: " + String((e as Error).message ?? e).slice(0, 150)); }
  }
  // a failure row per checkout / invoice; updated while Stripe retries, closed once it's paid
  async function recordFailure(id: string, row: Record<string, unknown>) {
    const { data: ex } = await db.from("lic_payments").select("session_id,resolved").eq("session_id", id).maybeSingle();
    if (ex?.resolved) return;
    if (ex) await db.from("lic_payments").update({ status: row.status, reason: row.reason, note: row.note }).eq("session_id", id);
    else { await db.from("lic_payments").insert({ session_id: id, applied: false, ...row }); failed++; }
  }
  const resolveFailures = (base: string) => db.from("lic_payments").update({ resolved: true }).like("session_id", `${base}:%`);

  try {
    // 1) checkouts
    await stripeList(c.secret_key, "checkout/sessions", { "created[gte]": String(since), "expand[]": "data.payment_intent" }, async (x) => {
      seen++; maxCreated = Math.max(maxCreated, Number(x.created || 0));
      const r = parseRef(x.client_reference_id);
      if (!r) return;
      const email = x.customer_details?.email ?? null;
      const sub = typeof x.subscription === "string" ? x.subscription : x.subscription?.id;
      if (x.payment_status === "paid") {
        if (sub) await db.from("lic_subscriptions").upsert({ subscription_id: sub, product: r.product, kind: r.kind, unit_ext_id: r.unit, plan: r.plan, email }, { onConflict: "subscription_id" });
        const { data: ins } = await db.from("lic_payments").insert({
          session_id: x.id, product: r.product, unit_kind: r.kind, unit_ext_id: r.unit, plan: r.plan, amount: x.amount_total, currency: x.currency,
          email, paid_at: iso(x.created), status: "paid", kind: "checkout", subscription_id: sub ?? null,
        }).select("session_id");
        await resolveFailures(x.id);
        // an earlier declined / abandoned try for the same licence is now settled
        await db.from("lic_payments").update({ resolved: true }).eq("product", r.product).eq("unit_ext_id", r.unit)
          .eq("kind", "checkout").in("status", ["failed", "abandoned"]).lte("paid_at", iso(x.created));
        if (!ins?.length) return; // already handled
        await applyPaid(x.id, r.product, r.kind, r.unit, r.plan, x.amount_total, x.currency, email, sub ? "Subscribed online" : "Paid online");
        return;
      }
      // not paid: a declined card shows on the payment intent; an expired checkout with no attempt means the customer left
      const pi = typeof x.payment_intent === "object" ? x.payment_intent : null;
      const declined = declineReason(pi?.last_payment_error);
      if (!declined && x.status !== "expired") return; // still open, nothing tried yet
      await recordFailure(`${x.id}:failed`, {
        product: r.product, unit_kind: r.kind, unit_ext_id: r.unit, plan: r.plan, amount: x.amount_total, currency: x.currency, email,
        paid_at: iso(x.created), kind: "checkout", subscription_id: sub ?? null,
        status: declined ? "failed" : "abandoned",
        reason: declined ?? "Customer left the checkout without paying",
        note: declined ? (x.status === "expired" ? "Checkout expired after the card was declined" : "The customer can still retry on the same checkout") : "Checkout expired",
      });
    });

    // 2) monthly renewals (and failed renewals)
    const { data: subs } = await db.from("lic_subscriptions").select("*");
    if (subs?.length) {
      const subOf = (id: string) => subs.find((s: any) => s.subscription_id === id);
      await stripeList(c.secret_key, "invoices", { "created[gte]": String(since), "expand[]": "data.payment_intent" }, async (inv) => {
        if (inv.billing_reason !== "subscription_cycle") return; // the first month comes through the checkout
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? inv.parent?.subscription_details?.subscription;
        const s = subId && subOf(subId);
        if (!s) return;
        const email = inv.customer_email ?? s.email ?? null;
        const sk = s.kind || DEFAULT_KIND[s.product];
        const base = { product: s.product, unit_kind: sk, unit_ext_id: s.unit_ext_id, plan: s.plan, amount: inv.amount_due, currency: inv.currency, email, kind: "renewal", subscription_id: subId };
        if (inv.status === "paid") {
          const { data: ins } = await db.from("lic_payments").insert({
            session_id: inv.id, ...base, amount: inv.amount_paid, status: "paid",
            paid_at: iso(inv.status_transitions?.paid_at || inv.created),
          }).select("session_id");
          await resolveFailures(inv.id);
          await db.from("lic_payments").update({ resolved: true }).eq("subscription_id", subId).eq("status", "failed").lte("paid_at", iso(inv.created));
          if (!ins?.length) return;
          await applyPaid(inv.id, s.product, sk, s.unit_ext_id, s.plan, inv.amount_paid, inv.currency, email, "Renewed online");
          return;
        }
        if (!(inv.status === "open" && inv.attempt_count > 0) && inv.status !== "uncollectible") return;
        const pi = typeof inv.payment_intent === "object" ? inv.payment_intent : null;
        const reason = declineReason(pi?.last_payment_error) ?? inv.last_finalization_error?.message ?? "Renewal payment failed";
        const next = inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }) : null;
        await recordFailure(`${inv.id}:failed`, {
          ...base, paid_at: iso(inv.created), status: "failed", reason,
          note: inv.status === "uncollectible" ? "Stripe has stopped retrying; the licence won't be renewed"
            : `Attempt ${inv.attempt_count}${next ? `; Stripe will retry on ${next}` : ""}`,
        });
      });
    }
  } catch (e) { err = String((e as Error).message ?? e).slice(0, 250); }
  await db.rpc("lic_stripe_update", { p_last_created: maxCreated, p_error: err });
  return { ok: !err, applied, seen, failed, error: err };
}

// read every app's accounts and units (or only those given), then attach accounts seen for the first time to a
// master customer: matched by contact email, else a new customer
async function syncApps(db: any, list: App[]) {
  const result: Record<string, unknown> = {};
  for (const app of list) {
    try {
      const d = await callApp(app, "list");
      const now = new Date().toISOString();
      const accounts = (d.accounts ?? []).map((a: any) => ({
        product: app.product, ext_id: String(a.id), name: a.name, contact_email: a.contact_email?.toLowerCase() ?? null,
        extra: { created_at: a.created_at, self_signup: a.self_signup, suspended: a.suspended ?? false, phone: a.phone ?? null },
        gone: false, synced_at: now,
      }));
      const units = (d.units ?? []).filter((x: any) => kindOf(app.product, x.kind)).map((x: any) => ({
        product: app.product, kind: kindOf(app.product, x.kind), ext_id: String(x.id), account_ext_id: x.account_id ? String(x.account_id) : null,
        name: x.name, detail: x.detail ?? null, license_type: x.license_type ?? null,
        starts_at: x.starts_at ?? null, expires_at: x.expires_at ?? null, notes: x.notes ?? null,
        extra: { last_seen: x.last_seen ?? null, archived: x.archived ?? false,
          // Employee staff (HUB_UNITS.md): covered by the location package (10 per licensed location) or by a valid add-on
          ...(typeof x.covered === "boolean" ? { covered: x.covered } : {}), ...(typeof x.package === "boolean" ? { package: x.package } : {}),
          ...(typeof x.needs_addon === "boolean" ? { needs_addon: x.needs_addon } : {}), ...(x.location_id ? { location_id: String(x.location_id) } : {}) },
        gone: false, synced_at: now,
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
  return { ok: true, apps: result, auto_linked: linked, customers_created: created };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// New customer's "3-day trial" (Licence cards, as each app's own Add business): the hub call that starts it in each app,
// for the business that hub_call 'add_business' has just made (r = that call's answer). Each app's own master trial:
//   Signage   'trial' { account_id }   -> master_trial (business trial + its location's trial7; TVs paired during it play)
//   Employee  'trial' { account_id }   -> pe_master_trial (owner trial3 + location trial3: staff package and staff follow)
//   Bookings  'set' trial  on the new location   (= bk_master_trial: 3 days on the business's unlicensed location)
//   QR Menu   'set' trial3 on the new location   (= pq_master_trial: 3 days)
//   WiFi      'set' trial  on the new location   (= WiFi's own Add business trial, setLicence 'trial': 3 days)
//   Label     'set' trial  until now + 3 days    (= Label's own Add business, pl_set_site_licence 'trial')
// The location is the one add_business just made with no licence, so this never replaces a licence already set.
const TRIAL_NOTE = "3-day trial chosen in the licence portal's New customer";
export function trialCall(product: string, r: any, now = Date.now()): [string, Record<string, unknown>] | null {
  const site = r?.site_id != null ? String(r.site_id) : "";
  const set = (type: string, extra: Record<string, unknown> = {}) =>
    site ? ["set", { unit: site, kind: "location", type, extend: false, expires: null, notes: TRIAL_NOTE, ...extra }] as [string, Record<string, unknown>] : null;
  switch (product) {
    case "signage": case "employee": return r?.account_id ? ["trial", { account_id: String(r.account_id) }] : null;
    case "bookings": case "wifi": return set("trial");
    case "qrmenu": return set("trial3");
    case "label": return set("trial", { expires: new Date(now + 3 * 86400e3).toISOString() });
  }
  return null;
}
// either answer -> { applied, expires_at, license_type? }
export function trialResult(action: string, a: any) {
  if (action === "trial") return { applied: !!a?.applied, expires_at: a?.expires_at ?? null };
  return { applied: /^trial/.test(String(a?.license_type ?? "")), expires_at: a?.expires_at ?? null, license_type: a?.license_type ?? null };
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

    if (action === "sync") return json(await syncApps(db, Object.values(apps)));

    // New customer: create the business, a same-name location and the owner's login in each ticked app, through
    // each app's hub_call 'add_business' (the app's own master Add business; token-authorised). Apps can't share a
    // transaction, so each app is all or nothing on its own and the result is per app. Each new account is linked
    // to the customer straight away, then the apps that worked are synced.
    // body: { customer_id, apps: ["signage", ...], business, name, email, mobile, password, contact_email,
    //         licence: 'none' | 'trial' | 'set', invite: true|false }
    //   licence 'trial': straight after each app's add_business, that app's own 3-day trial (trialCall above);
    //   'none' / 'set': no licence (for 'set' the portal opens the customer's page so the master sets them there).
    //   invite: only recorded in the audit. With an invite the portal sends a random password nobody sees (as each
    //   app's own invite does) and emails ONE set-your-password link for the Proview login; the owner opens each app
    //   from the dashboard (sso-assert), which signs them in without the app's password.
    if (action === "create_business") {
      const { data: cust } = await db.from("lic_customers").select("id,name,contact_email").eq("id", body.customer_id ?? "").maybeSingle();
      if (!cust) return json({ error: "Customer not found" }, 400);
      const want: string[] = Array.isArray(body.apps) ? [...new Set(body.apps.map(String))] as string[] : [];
      if (!want.length) return json({ error: "Tick at least one app." }, 400);
      const business = String(body.business ?? "").trim(), name = String(body.name ?? "").trim();
      const email = String(body.email ?? "").trim().toLowerCase(), password = String(body.password ?? "");
      const contact = String(body.contact_email ?? cust.contact_email ?? "").trim().toLowerCase() || email;
      if (business.length < 2) return json({ error: "Enter the business name." }, 400);
      if (name.length < 2) return json({ error: "Enter the owner's name." }, 400);
      if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
      const licence = ["none", "trial", "set"].includes(body.licence) ? body.licence : "none";
      const args = { business, name, email, mobile: String(body.mobile ?? "").trim() || null, password, contact_email: contact };
      const results: Record<string, any> = {};
      await Promise.all(want.map(async (product) => {
        const app = apps[product];
        if (!app) { results[product] = { ok: false, error: "This app isn't connected to the licence portal." }; return; }
        try {
          const r = await callApp(app, "add_business", args);
          const ext = String(r?.account_id ?? "");
          if (!ext) throw new Error("The app didn't say which account it made.");
          const { error } = await db.from("lic_accounts").upsert({ product, ext_id: ext, name: business, contact_email: contact,
            customer_id: cust.id, link_checked: true, gone: false, synced_at: new Date().toISOString() }, { onConflict: "product,ext_id" });
          results[product] = { ok: true, existing: !!r.existing, account_id: ext, ...(error ? { link_error: error.message } : {}) };
          await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: business, action: "added business",
            after: { customer: cust.name, owner: email, existing: !!r.existing, account_id: ext, licence, invite: !!body.invite } });
          if (licence === "trial") {
            // the business is made either way: a trial that can't start is reported on its own, not as a failed app
            const tc = trialCall(product, { ...r, account_id: ext });
            try {
              if (!tc) throw new Error("The app didn't say which location it made.");
              const t = trialResult(tc[0], await callApp(app, tc[0], tc[1]));
              results[product].trial = t;
              await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: business,
                unit_ext_id: tc[0] === "set" ? String(tc[1].unit) : null,
                action: t.applied ? "started 3-day trial" : "no trial (already licensed)", after: { ...t, account_id: ext } });
            } catch (e) {
              const msg = String((e as Error).message ?? e);
              results[product].trial_error = msg;
              await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: business, action: "failed", error: `3-day trial: ${msg}` });
            }
          }
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          results[product] = { ok: false, error: msg };
          await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: business, action: "failed", error: `Add business: ${msg}` });
        }
      }));
      const done = want.filter((p) => results[p]?.ok).map((p) => apps[p]);
      let sync: unknown = null;
      if (done.length) { try { sync = await syncApps(db, done); } catch (e) { sync = { ok: false, error: String((e as Error).message ?? e) }; } }
      return json({ ok: want.every((p) => results[p]?.ok), results, sync });
    }

    if (action === "set") {
      // items: [{product, unit, type|null, extend, expires, notes}]
      const items = Array.isArray(body.items) ? body.items : [body];
      const out = [];
      for (const it of items) {
        const app = apps[it.product];
        if (!app) { out.push({ ...it, ok: false, error: "Unknown product" }); continue; }
        const type = it.type ?? null;
        if (type !== null && !(TYPES[it.product] ?? []).includes(type)) { out.push({ ...it, ok: false, error: `Unknown licence type ${type}` }); continue; }
        const { data: before } = await db.from("lic_units").select("*").eq("product", it.product).eq("ext_id", String(it.unit)).maybeSingle();
        const kind = kindOf(it.product, it.kind ?? before?.kind);
        if (!kind) { out.push({ ...it, ok: false, error: `Unknown kind ${it.kind}` }); continue; }
        const { data: acc } = before?.account_ext_id
          ? await db.from("lic_accounts").select("name").eq("product", it.product).eq("ext_id", before.account_ext_id).maybeSingle()
          : { data: null };
        try {
          const after = await callApp(app, "set", {
            unit: String(it.unit), kind, type, extend: !!it.extend, expires: it.expires ?? null, notes: it.notes ?? null,
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
          out.push({ product: it.product, kind, unit: it.unit, ok: true, after });
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
      // plans: [{product, kind?, plan, label, amount, currency, link, active}] (no kind = the product's default kind)
      const plans = (Array.isArray(body.plans) ? body.plans : []).map((p: any) => ({ ...p, kind: p.kind || DEFAULT_KIND[p.product] }));
      for (const p of plans) {
        if (!TYPES[p.product] || !PAY_PLANS.includes(p.plan) || !(KINDS[p.product] ?? []).includes(p.kind)) throw new Error(`Unknown plan ${p.product}/${p.kind}/${p.plan}`);
        if (p.active && !/^https:\/\/(buy|checkout)\.stripe\.com\//.test(p.link || "")) throw new Error(`${p.label}: paste a Stripe Payment Link (https://buy.stripe.com/…)`);
        if (p.active && !(Number(p.amount) > 0)) throw new Error(`${p.label}: enter the price`);
      }
      // replace the prices of each product + kind sent (a kind not sent keeps its prices)
      const touched = [...new Set(plans.map((p: any) => p.product))];
      const pairs = [...new Set(plans.map((p: any) => `${p.product}|${p.kind}`))] as string[];
      for (const pk of pairs) { const [prod, kind] = pk.split("|"); await db.from("lic_plans").delete().eq("product", prod).eq("kind", kind); }
      const rows = plans.filter((p: any) => p.active).map((p: any) => ({
        product: p.product, kind: p.kind, plan: p.plan, label: p.label, amount: Math.round(Number(p.amount)), currency: (p.currency || "gbp").toLowerCase(),
        link: p.link.trim(), active: true, updated_at: new Date().toISOString() }));
      if (rows.length) { const { error } = await db.from("lic_plans").insert(rows); if (error) throw error; }
      const pushed = await pushPlans(db, apps);
      await db.from("lic_audit").insert({ admin_email: adminEmail, action: "updated online prices", after: { products: touched, plans: rows.length } });
      return json({ ok: true, pushed });
    }

    if (action === "push_plans") return json({ ok: true, pushed: await pushPlans(db, apps) });

    if (action === "check_payments") return json(await checkPayments(db, apps));

    if (action === "apps") {
      return json({ apps: Object.values(apps).map((a) => ({ product: a.product, label: a.label, app_url: a.app_url })), types: TYPES, kinds: KINDS, default_kind: DEFAULT_KIND });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
