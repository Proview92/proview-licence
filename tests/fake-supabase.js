// Stand-in for @supabase/supabase-js used only by tests/smoke.py (served via page.route).
// window.__PV_SIGNED_OUT = true shows the sign-in screen; otherwise a signed-in admin with sample data.
const day = 86400000, now = Date.now(), iso = (d) => new Date(now + d * day).toISOString();
const DATA = {
  lic_customers: [
    { id: "c1", name: "Bella Cucina", contact_email: "owner@bellacucina.co.uk", phone: "07700 900131", notes: "Pays by invoice" },
    { id: "c2", name: "Harbour Café", contact_email: "hello@harbourcafe.co.uk", phone: null, notes: null },
    { id: "c3", name: "Northside Gym", contact_email: "admin@northsidegym.com", phone: "0161 555 0101", notes: null },
    { id: "c4", name: "The Red Lion", contact_email: null, phone: null, notes: null },
  ],
  lic_accounts: [
    { product: "signage", ext_id: "s1", customer_id: "c1", name: "Bella Cucina", contact_email: "owner@bellacucina.co.uk", extra: {} },
    { product: "bookings", ext_id: "b1", customer_id: "c1", name: "Bella Cucina", contact_email: "owner@bellacucina.co.uk", extra: {} },
    { product: "wifi", ext_id: "w1", customer_id: "c2", name: "Harbour Café", contact_email: "hello@harbourcafe.co.uk", extra: { self_signup: true } },
    { product: "employee", ext_id: "e1", customer_id: "c3", name: "Northside Gym", contact_email: "admin@northsidegym.com", extra: {} },
    { product: "qrmenu", ext_id: "q1", customer_id: "c3", name: "Northside Gym", contact_email: "admin@northsidegym.com", extra: {} },
  ],
  lic_units: [
    { product: "signage", ext_id: "su1", account_ext_id: "s1", name: "Front window TV", detail: "Samsung 55\"", license_type: "m12", expires_at: iso(200), extra: { last_seen: iso(-0.1) } },
    { product: "signage", ext_id: "su2", account_ext_id: "s1", name: "Menu board", detail: "", license_type: "m1", expires_at: iso(12), extra: {} },
    { product: "bookings", ext_id: "bu1", account_ext_id: "b1", name: "Main restaurant", detail: "London", license_type: "lifetime", expires_at: null, extra: {} },
    { product: "wifi", ext_id: "wu1", account_ext_id: "w1", name: "Harbour Café", detail: "", license_type: "m3", expires_at: iso(-3), extra: {} },
    { product: "employee", ext_id: "eu1", account_ext_id: "e1", name: "Front desk team", detail: "", license_type: "trial3", expires_at: iso(2), extra: {} },
    { product: "qrmenu", ext_id: "qu1", account_ext_id: "q1", name: "Gym café", detail: "", license_type: null, expires_at: null, extra: {} },
  ],
  lic_audit: [
    { at: iso(-0.2), admin_email: "sam.admin@proview.co.uk", product: "signage", unit_name: "Front window TV", account_name: "Bella Cucina", action: "set", before: { expires_at: iso(-165) }, after: { license_type: "m12", expires_at: iso(200) } },
    { at: iso(-1), admin_email: "sam.admin@proview.co.uk", product: "wifi", unit_name: "Harbour Café", account_name: "Harbour Café", action: "failed", error: "App unreachable" },
  ],
  lic_plans: [{ product: "signage", plan: "m12", amount: 12000, link: "https://buy.stripe.com/test_123", active: true }],
  lic_payments: [
    { id: 1, created_at: iso(-2), paid_at: iso(-2), product: "signage", unit_ext_id: "su1", plan: "m12", amount: 12000, currency: "gbp", email: "owner@bellacucina.co.uk", applied: true },
    { id: 2, created_at: iso(-1), paid_at: iso(-1), product: "wifi", unit_ext_id: "wu1", plan: "m3", amount: 3000, currency: "gbp", email: "hello@harbourcafe.co.uk", applied: false, note: "Unit not found" },
  ],
};
function q(table) {
  const res = { data: DATA[table] || [], error: null };
  const b = { select: () => b, order: () => b, limit: () => b, eq: () => b, update: () => b, insert: () => b, delete: () => b,
    single: () => b, then: (ok, bad) => Promise.resolve(res).then(ok, bad) };
  return b;
}
export function createClient() {
  const out = !!window.__PV_SIGNED_OUT;
  const session = out ? null : { user: { email: "sam.admin@proview.co.uk" } };
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}), signInWithPassword: async () => ({ error: { message: "Invalid login credentials" } }),
      signUp: async () => ({ data: {}, error: null }), resetPasswordForEmail: async () => ({}), updateUser: async () => ({}),
    },
    from: q,
    rpc: async (name) => name === "is_lic_admin" ? { data: true, error: null }
      : name === "lic_payment_settings" ? { data: { enabled: true, has_key: true, key_hint: "rk_live_…9x2", checked_at: iso(-0.01) }, error: null }
      : { data: null, error: null },
    functions: { invoke: async (fn, { body }) => body.action === "sync"
      ? { data: { apps: { signage: { ok: true, units: 2 }, bookings: { ok: true, units: 1 }, employee: { ok: true, units: 1 }, wifi: { ok: true, units: 1 }, qrmenu: { ok: false, error: "timeout" } } }, error: null }
      : { data: { results: [] }, error: null } },
  };
}
