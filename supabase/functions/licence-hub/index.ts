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
  label: ["trial", "m1", "m3", "m6", "m12", "m24", "m36", "lifetime", "custom"], // per handheld (trial = set by hand)
};

// What a unit is (PER_LOCATION_LICENCE_SPEC): every app licenses each location; Signage also each TV and Employee each
// extra person over the package ("Staff add-on"). An app that sends no kind sends its old unit type, DEFAULT_KIND.
const KINDS: Record<string, string[]> = {
  // owner 12 Nov 2026: Signage licenses each TV only, Label each handheld only, WiFi and QR Menu each location only
  signage: ["screen"], employee: ["staff", "location"],
  bookings: ["location"], wifi: ["location"], qrmenu: ["location"], label: ["handheld"],
};
const DEFAULT_KIND: Record<string, string> = { signage: "screen", employee: "staff", bookings: "location", wifi: "location", qrmenu: "location", label: "handheld" };
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
//   pvl__<hl id>__<plan>                  Label handheld        unit <hl id> (Label migration 013)
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
    // Label: the business gets a spare 3-day trial licence that its first paired handheld takes (Label migration 013)
    case "label": return r?.account_id ? ["trial", { account_id: String(r.account_id), notes: TRIAL_NOTE }] : null;
  }
  return null;
}
// either answer -> { applied, expires_at, license_type? }
export function trialResult(action: string, a: any) {
  if (action === "trial") return { applied: !!a?.applied, expires_at: a?.expires_at ?? null };
  return { applied: /^trial/.test(String(a?.license_type ?? "")), expires_at: a?.expires_at ?? null, license_type: a?.license_type ?? null };
}

// ---------- linked locations (LOCATIONS_LINK_SPEC.md, contract: LOCATIONS_LINK_PROTOCOL.md) ----------
// A card (lic_customers) is a Location. Linking card B into card A merges B's business into A's in every app where both
// have one (hub_call 'link'), moves B's other app accounts to A, and removes B once it holds nothing. Unlinking moves one
// linked location (all its location units, grouped by lic_units.origin_id) out into new businesses (hub_call 'unlink')
// and a new card. Apps can't share a transaction: each app call is all or nothing, the portal is updated straight after
// each call that worked, and a failed app is reported and left as it was, so pressing the button again finishes it.
const LINK_ORDER = ["signage", "bookings", "employee", "label", "qrmenu", "wifi"];
const byAge = (x: any, y: any) => String(x.extra?.created_at ?? "").localeCompare(String(y.extra?.created_at ?? "")) || String(x.ext_id).localeCompare(String(y.ext_id));
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const errText = (e: unknown) => String((e as Error)?.message ?? e);

// Locations for Link / Unlink. Bookings, Employee, QR Menu and WiFi list a licence unit per location (kind 'location').
// Signage (licensed per TV) and Label (per handheld) don't (owner, 12 Nov 2026), so their locations are read from where
// their TVs / handhelds are (extra.location_id): one location unit per product + account + location, ext_id = the
// location's id (what the app's 'unlink' takes), origin = the first origin among its TVs / handhelds. A Signage / Label
// business with no TV / handheld has no location here: Link and Unlink move its whole account, as for one location.
const DEVICE_KIND: Record<string, string> = { signage: "screen", label: "handheld" };
export function locationUnits(units: any[], accounts: any[] = []) {
  const out = units.filter((u) => !u.gone && u.kind === "location");
  const by = new Map<string, any>();
  for (const u of units) {
    const loc = u.extra?.location_id;
    if (u.gone || !loc || DEVICE_KIND[u.product] !== u.kind) continue;
    const key = `${u.product}|${u.account_ext_id}|${loc}`;
    if (!by.has(key)) {
      const acc = accounts.find((a) => a.product === u.product && a.ext_id === u.account_ext_id);
      const nm = u.product === "signage" ? String(u.detail ?? "").split(" · ")[0] : String(u.detail ?? "");
      by.set(key, { product: u.product, kind: "location", virtual: true, ext_id: String(loc), account_ext_id: u.account_ext_id,
                    name: nm || acc?.name || "Location", origin_id: null, gone: false, members: [] });
    }
    const v = by.get(key);
    v.members.push(u.ext_id);
    if (!v.origin_id && u.origin_id) v.origin_id = u.origin_id;
  }
  return [...out, ...by.values()];
}

// The linked locations of a card: its location units grouped by where they came from (null origin = the card's own).
export function linkedGroups(card: any, accounts: any[], units: any[], origins: any[]) {
  const mine = accounts.filter((a) => a.customer_id === card.id && !a.gone);
  const locs = units.filter((u) => !u.gone && u.kind === "location" && mine.some((a) => a.product === u.product && a.ext_id === u.account_ext_id));
  const groups = new Map<string, any>();
  for (const u of locs) {
    const key = u.origin_id ?? card.id;
    if (!groups.has(key)) {
      const o = origins.find((x) => x.id === key);
      groups.set(key, { origin: key, name: o?.name ?? card.name, units: [] });
    }
    groups.get(key).units.push(u);
  }
  return [...groups.values()].sort((x, y) => (x.origin === card.id ? -1 : y.origin === card.id ? 1 : String(x.name).localeCompare(String(y.name))));
}

// Today's businesses with more than one location, before linking existed: each extra location becomes its own card.
// The location named like its business (else the first by name) stays; the others leave. Locations of one card with the
// same name in different apps go to the same new card (they are the same place).
export function splitPlan(customers: any[], accounts: any[], units: any[], only?: string) {
  const plan: any[] = [];
  for (const c of customers) {
    if (only && c.id !== only) continue;
    const items: any[] = [];
    for (const a of accounts.filter((x) => x.customer_id === c.id && !x.gone).sort((x, y) => LINK_ORDER.indexOf(x.product) - LINK_ORDER.indexOf(y.product) || byAge(x, y))) {
      const locs = units.filter((u) => !u.gone && u.kind === "location" && u.product === a.product && u.account_ext_id === a.ext_id)
        .sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.ext_id).localeCompare(String(y.ext_id)));
      // locations that came from a link are unlinked with Unlink; only locations grouped together before linking
      // existed (same origin, usually none) are split
      const byOrigin = new Map<string, any[]>();
      for (const u of locs) { const k = u.origin_id ?? ""; byOrigin.set(k, [...(byOrigin.get(k) ?? []), u]); }
      for (const grp of byOrigin.values()) {
        if (grp.length < 2) continue;
        const keep = grp.find((u) => norm(u.name) === norm(a.name)) ?? grp[0];
        items.push({ product: a.product, account: a.ext_id, account_name: a.name, keep: { ext_id: keep.ext_id, name: keep.name },
                     out: grp.filter((u) => u !== keep).map((u) => ({ ext_id: u.ext_id, name: u.name })) });
      }
    }
    if (!items.length) continue;
    const cards = new Map<string, any>();
    for (const it of items) for (const o of it.out) {
      const k = norm(o.name);
      if (!cards.has(k)) cards.set(k, { name: o.name, units: [] });
      cards.get(k).units.push({ product: it.product, account: it.account, ext_id: o.ext_id, name: o.name });
    }
    plan.push({ customer_id: c.id, customer_name: c.name, businesses: items, new_cards: [...cards.values()] });
  }
  return plan;
}

async function loadLinkData(db: any) {
  const [c, a, u, o] = await Promise.all([
    db.from("lic_customers").select("*"), db.from("lic_accounts").select("*"),
    db.from("lic_units").select("*").eq("gone", false), db.from("lic_link_origins").select("*")]);
  for (const r of [c, a, u, o]) if (r.error) throw r.error;
  return { customers: c.data ?? [], accounts: a.data ?? [], units: locationUnits(u.data ?? [], a.data ?? []), origins: o.data ?? [] };
}

// every location unit of the card that has no origin yet belongs to the card's own location
async function ensureOrigin(db: any, card: any) {
  await db.from("lic_link_origins").upsert({ id: card.id, name: card.name, contact_email: card.contact_email ?? null, phone: card.phone ?? null },
    { onConflict: "id", ignoreDuplicates: true });
  const { data: accts } = await db.from("lic_accounts").select("product,ext_id").eq("customer_id", card.id).eq("gone", false);
  for (const a of accts ?? []) {
    await db.from("lic_units").update({ origin_id: card.id }).eq("product", a.product).eq("account_ext_id", a.ext_id).is("origin_id", null);
  }
}

// after an app moved units between accounts: re-point the portal's rows (unit ids that contain the account id change)
async function repoint(db: any, product: string, fromAcc: string | null, toAcc: string, renamed: any[] = [], only?: string) {
  if (fromAcc) await db.from("lic_units").update({ account_ext_id: toAcc }).eq("product", product).eq("account_ext_id", fromAcc);
  if (only) await db.from("lic_units").update({ account_ext_id: toAcc }).eq("product", product).eq("ext_id", only);
  for (const r of Array.isArray(renamed) ? renamed : []) {
    const from = String(r?.from ?? ""), to = String(r?.to ?? "");
    if (!from || !to || from === to) continue;
    const { data: there } = await db.from("lic_units").select("ext_id").eq("product", product).eq("ext_id", to).maybeSingle();
    if (there) await db.from("lic_units").update({ gone: true }).eq("product", product).eq("ext_id", from);
    else await db.from("lic_units").update({ ext_id: to, account_ext_id: toAcc }).eq("product", product).eq("ext_id", from);
    await db.from("lic_subscriptions").update({ unit_ext_id: to }).eq("product", product).eq("unit_ext_id", from);
    await db.from("lic_payments").update({ unit_ext_id: to }).eq("product", product).eq("unit_ext_id", from);
  }
}

async function linkCards(db: any, apps: Record<string, App>, adminEmail: string | null, aId: string, bId: string) {
  if (!aId || !bId) return { status: 400, body: { error: "Choose the two locations to link." } };
  if (aId === bId) return { status: 400, body: { error: "A location can't be linked with itself." } };
  const { data: A } = await db.from("lic_customers").select("*").eq("id", aId).maybeSingle();
  const { data: B } = await db.from("lic_customers").select("*").eq("id", bId).maybeSingle();
  if (!A || !B) return { status: 400, body: { error: "Location not found. Press Sync and try again." } };
  await ensureOrigin(db, A); await ensureOrigin(db, B);
  const { data: all } = await db.from("lic_accounts").select("*").in("customer_id", [A.id, B.id]).eq("gone", false);
  const results: Record<string, any> = {}, touched = new Set<string>();
  for (const product of LINK_ORDER) {
    const la = (all ?? []).filter((x: any) => x.product === product && x.customer_id === A.id).sort(byAge);
    const lb = (all ?? []).filter((x: any) => x.product === product && x.customer_id === B.id).sort(byAge);
    if (!la.length && !lb.length) continue;
    const target = la[0] ?? lb[0];
    const froms = [...la.slice(1), ...lb].filter((x: any) => x.ext_id !== target.ext_id);
    const label = apps[product]?.label ?? product;
    if (target.customer_id !== A.id) {   // only B has this app: its account just moves to A (nothing changes in the app)
      await db.from("lic_accounts").update({ customer_id: A.id, link_checked: true }).eq("product", product).eq("ext_id", target.ext_id);
    }
    if (!froms.length) { results[product] = { ok: true, label, moved: target.customer_id !== A.id, linked: 0 }; continue; }
    const app = apps[product];
    if (!app) { results[product] = { ok: false, label, linked: 0, error: "This app isn't connected to the licence portal." }; continue; }
    let n = 0;
    for (const from of froms) {
      try {
        const r = await callApp(app, "link", { into: String(target.ext_id), from: String(from.ext_id) });
        if (!r?.ok) throw new Error(r?.message ?? "The app didn't confirm the link.");
        await repoint(db, product, String(from.ext_id), String(target.ext_id), r.renamed_units);
        await db.from("lic_accounts").update({ gone: true, customer_id: A.id, link_checked: true }).eq("product", product).eq("ext_id", from.ext_id);
        await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: target.name, action: "linked locations",
          after: { into: target.ext_id, from: from.ext_id, from_name: from.name, moved_sites: r.moved_sites ?? [], already: !!r.already } });
        n++; touched.add(product);
      } catch (e) {
        const msg = errText(e);
        results[product] = { ok: false, label, linked: n, error: msg };
        await db.from("lic_audit").insert({ admin_email: adminEmail, product, account_name: from.name, action: "failed", error: `Link with ${target.name}: ${msg}` });
        break;
      }
    }
    results[product] ??= { ok: true, label, linked: n };
  }
  // card B goes once it holds nothing any more (a failed app keeps its account there, so Link can be pressed again)
  const { data: left } = await db.from("lic_accounts").select("product").eq("customer_id", B.id).eq("gone", false);
  let removed = false;
  if (!left?.length) {
    await db.from("lic_accounts").update({ customer_id: A.id }).eq("customer_id", B.id);
    if (B.notes) await db.from("lic_customers").update({ notes: [A.notes, B.notes].filter(Boolean).join("\n") }).eq("id", A.id);
    await db.from("lic_customers").delete().eq("id", B.id);
    removed = true;
  }
  await db.from("lic_audit").insert({ admin_email: adminEmail, account_name: A.name, action: removed ? `linked with ${B.name}` : `partly linked with ${B.name}`,
    after: { into: A.id, from: B.id, results } });
  let sync: unknown = null;
  if (touched.size) { try { sync = await syncApps(db, [...touched].map((p) => apps[p]).filter(Boolean)); } catch (e) { sync = { ok: false, error: errText(e) }; } }
  const ok = Object.values(results).every((r: any) => r.ok);
  return { status: 200, body: { ok, customer: A.id, removed_b: removed, results, sync } };
}

// Move location units (each { product, account, ext_id, name }) out of their businesses into one new card.
// In an app where the unit is its business's only location, the whole account moves to the new card instead.
async function unlinkUnits(db: any, apps: Record<string, App>, adminEmail: string | null, card: any, items: any[], newName: string, origin?: any) {
  let newCard: any = null;
  if (origin?.split_card_id) { const { data } = await db.from("lic_customers").select("*").eq("id", origin.split_card_id).maybeSingle(); newCard = data; }
  if (!newCard) {
    const { data, error } = await db.from("lic_customers").insert({ name: newName || "Unnamed", contact_email: origin?.contact_email ?? card.contact_email ?? null,
      phone: origin?.phone ?? card.phone ?? null, notes: `Unlinked from ${card.name}` }).select("*").single();
    if (error) throw error;
    newCard = data;
    if (origin?.id) await db.from("lic_link_origins").update({ split_card_id: newCard.id }).eq("id", origin.id);
  }
  const results: Record<string, any> = {}, touched = new Set<string>(), firstNew: Record<string, string> = {};
  for (const product of LINK_ORDER) {
    const mine = items.filter((x) => x.product === product);
    if (!mine.length) continue;
    const app = apps[product], label = app?.label ?? product;
    results[product] = { ok: true, label, unlinked: 0 };
    for (const it of mine) {
      try {
        const { data: accUnits } = await db.from("lic_units").select("*").eq("product", product).eq("account_ext_id", it.account).eq("gone", false);
        const count = locationUnits(accUnits ?? []).length;
        let acc: string;
        if ((count ?? 0) <= 1) {   // nothing to split in the app: the account itself moves
          await db.from("lic_accounts").update({ customer_id: newCard.id, link_checked: true }).eq("product", product).eq("ext_id", it.account);
          acc = String(it.account);
        } else {
          if (!app) throw new Error("This app isn't connected to the licence portal.");
          const r = await callApp(app, "unlink", { account: String(it.account), site: String(it.ext_id) });
          if (!r?.ok || !r.account) throw new Error(r?.message ?? "The app didn't say which business it made.");
          acc = String(r.account);
          await db.from("lic_accounts").upsert({ product, ext_id: acc, name: it.name, contact_email: newCard.contact_email ?? null, customer_id: newCard.id,
            link_checked: true, gone: false, synced_at: new Date().toISOString() }, { onConflict: "product,ext_id" });
          await repoint(db, product, null, acc, r.renamed_units, String(it.ext_id));
          if (DEVICE_KIND[product]) {   // Signage / Label: the location's TVs / handhelds move with it
            await db.from("lic_units").update({ account_ext_id: acc }).eq("product", product).eq("extra->>location_id", String(it.ext_id));
            if (!origin) await db.from("lic_units").update({ origin_id: null }).eq("product", product).eq("extra->>location_id", String(r.site ?? it.ext_id));
          }
          if (!origin) await db.from("lic_units").update({ origin_id: null }).eq("product", product).eq("ext_id", String(r.site ?? it.ext_id));
          touched.add(product);
        }
        // two locations of one linked location in the same app: one business for them again
        if (firstNew[product] && firstNew[product] !== acc && app) {
          const l = await callApp(app, "link", { into: firstNew[product], from: acc });
          await repoint(db, product, acc, firstNew[product], l.renamed_units);
          await db.from("lic_accounts").update({ gone: true, customer_id: newCard.id }).eq("product", product).eq("ext_id", acc);
        } else firstNew[product] = acc;
        results[product].unlinked++;
        await db.from("lic_audit").insert({ admin_email: adminEmail, product, unit_ext_id: String(it.ext_id), unit_name: it.name, account_name: card.name,
          action: "unlinked location", after: { from: it.account, into: firstNew[product], card: newCard.id } });
      } catch (e) {
        const msg = errText(e);
        results[product] = { ...results[product], ok: false, error: msg };
        await db.from("lic_audit").insert({ admin_email: adminEmail, product, unit_ext_id: String(it.ext_id), unit_name: it.name, account_name: card.name,
          action: "failed", error: `Unlink: ${msg}` });
        break;
      }
    }
  }
  let sync: unknown = null;
  if (touched.size) { try { sync = await syncApps(db, [...touched].map((p) => apps[p]).filter(Boolean)); } catch (e) { sync = { ok: false, error: errText(e) }; } }
  return { ok: Object.values(results).every((r: any) => r.ok), customer: newCard.id, name: newCard.name, results, sync };
}

async function unlinkCard(db: any, apps: Record<string, App>, adminEmail: string | null, body: any) {
  const d = await loadLinkData(db);
  const card = d.customers.find((c: any) => c.id === body.customer);
  if (!card) return { status: 400, body: { error: "Location not found. Press Sync and try again." } };
  const groups = linkedGroups(card, d.accounts, d.units, d.origins);
  let items: any[], name: string, origin: any = null;
  if (body.origin) {
    const g = groups.find((x) => x.origin === body.origin);
    origin = d.origins.find((o: any) => o.id === body.origin) ?? null;
    if (!g) {
      // pressed again after it worked: the location is already on its own card
      if (origin?.split_card_id && d.customers.some((c: any) => c.id === origin.split_card_id)) {
        return { status: 200, body: { ok: true, already: true, customer: origin.split_card_id, results: {} } };
      }
      return { status: 400, body: { error: "That location isn't linked here any more. Press Sync and try again." } };
    }
    if (groups.length < 2) return { status: 400, body: { error: `${card.name} isn't linked with another location.` } };
    items = g.units.map((u: any) => ({ product: u.product, account: u.account_ext_id, ext_id: u.ext_id, name: u.name }));
    name = g.name;
  } else {
    const u = d.units.find((x: any) => x.product === body.app && x.ext_id === String(body.site ?? "") && !x.gone);
    const a = u && d.accounts.find((x: any) => x.product === u.product && x.ext_id === u.account_ext_id && x.customer_id === card.id);
    if (!u || !a) return { status: 400, body: { error: "That location isn't on this card. Press Sync and try again." } };
    items = [{ product: u.product, account: u.account_ext_id, ext_id: u.ext_id, name: u.name }];
    name = u.name;
  }
  const r = await unlinkUnits(db, apps, adminEmail, card, items, name, origin);
  await db.from("lic_audit").insert({ admin_email: adminEmail, account_name: card.name, action: `unlinked ${name}`, after: { card: card.id, new_card: r.customer, results: r.results } });
  return { status: 200, body: r };
}

async function splitCards(db: any, apps: Record<string, App>, adminEmail: string | null, only?: string) {
  const d = await loadLinkData(db);
  const plan = splitPlan(d.customers, d.accounts, d.units, only);
  const out: any[] = [];
  for (const p of plan) {
    const card = d.customers.find((c: any) => c.id === p.customer_id);
    for (const nc of p.new_cards) {
      try { const r = await unlinkUnits(db, apps, adminEmail, card, nc.units, nc.name); out.push({ ...r, from: p.customer_id, from_name: p.customer_name, name: nc.name }); }
      catch (e) { out.push({ from: p.customer_id, from_name: p.customer_name, name: nc.name, ok: false, error: errText(e) }); }
    }
  }
  if (plan.length) await db.from("lic_audit").insert({ admin_email: adminEmail, action: "split grouped locations", after: { cards: out.map((x) => ({ from: x.from, name: x.name, ok: x.ok, to: x.customer ?? null, error: x.error })) } });
  return { ok: out.every((x) => x.ok), split: out, planned: plan.length };
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

    // Locations (LOCATIONS_LINK_SPEC): link two locations, unlink one, and the one-off split of businesses that already
    // had several locations. Master only (checked above).
    //   link   { customer_a, customer_b }        B is linked into A (A keeps its card)
    //   unlink { customer, origin }              one linked location of the card, in every app
    //          { customer, app, site }           one location unit of one app (as the split does)
    //   split_preview { customer? }  -> { plan }  split { customer? } -> { ok, split: [...] }
    if (action === "link") { const r = await linkCards(db, apps, adminEmail, String(body.customer_a ?? ""), String(body.customer_b ?? "")); return json(r.body, r.status); }
    if (action === "unlink") { const r = await unlinkCard(db, apps, adminEmail, body); return json(r.body, r.status); }
    if (action === "split_preview") { const d = await loadLinkData(db); return json({ ok: true, plan: splitPlan(d.customers, d.accounts, d.units, body.customer || undefined) }); }
    if (action === "split") return json(await splitCards(db, apps, adminEmail, body.customer || undefined));

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
