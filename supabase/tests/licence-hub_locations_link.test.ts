// Tests licence-hub's link / unlink / split (LOCATIONS_LINK_SPEC, LOCATIONS_LINK_PROTOCOL) under Deno against in-memory
// mocks (no network): the portal's PostgREST and the six apps' hub_call. Usage:
//   deno run -A supabase/tests/licence-hub_locations_link.test.ts supabase/functions/licence-hub/index.ts
const out: string[] = [];
const ok = (c: unknown, m: string) => out.push((c ? "PASS " : "FAIL ") + m);
Deno.env.set("SUPABASE_URL", "http://portal.mock"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service"); Deno.env.set("SUPABASE_ANON_KEY", "anon");

// ---------- the apps: businesses (accounts) and units, with link / unlink as in the protocol ----------
type U = { id: string; kind: string; account_id: string; name: string; license_type?: string | null };
const A: Record<string, { accounts: { id: string; name: string }[]; units: U[]; seq: number; fail?: string }> = {};
const prods = ["signage", "bookings", "employee", "label", "qrmenu", "wifi"];
for (const p of prods) A[p] = { accounts: [], units: [], seq: 0 };
const emp = (p: string) => p === "employee";   // Employee's unit ids contain the account id
const locId = (p: string, acc: string, l: string) => emp(p) ? `loc/${acc}/${l}` : p === "signage" ? `loc/${l}` : l;
const bare = (p: string, id: string) => emp(p) ? id.split("/").pop()! : p === "signage" ? id.replace(/^loc\//, "") : id;
const calls: any[] = [];
function hub(p: string, action: string, a: any): [number, any] {
  const s = A[p]; calls.push({ p, action, a });
  if (s.fail && s.fail === action) return [400, { message: `${p} is down` }];
  if (action === "list") return [200, { accounts: s.accounts, units: s.units }];
  if (action === "link") {
    if (a.into === a.from) return [400, { message: "An account can't be linked to itself." }];
    if (!s.accounts.some((x) => x.id === a.into)) return [400, { message: "Account not found: " + a.into }];
    if (!s.accounts.some((x) => x.id === a.from)) return [400, { message: "Account not found: " + a.from }];
    const renamed: any[] = [], moved: string[] = [];
    for (const u of s.units.filter((x) => x.account_id === a.from)) {
      const was = u.id; if (emp(p)) u.id = u.kind === "location" ? locId(p, a.into, bare(p, u.id)) : `${a.into}/${u.id.split("/")[1]}`;
      if (emp(p) && s.units.some((x) => x !== u && x.id === u.id)) u.id += "_x1";   // Employee: an id A already uses gets a new one
      if (was !== u.id) renamed.push({ kind: u.kind, from: was, to: u.id });
      u.account_id = a.into; if (u.kind === "location") moved.push(u.id);
    }
    s.accounts = s.accounts.filter((x) => x.id !== a.from);
    return [200, { ok: true, account: a.into, from: a.from, moved_sites: moved, already: false, renamed_units: renamed }];
  }
  if (action === "unlink") {
    const u = s.units.find((x) => x.kind === "location" && (x.id === a.site));
    if (!u) return [400, { message: "Location not found: " + a.site }];
    if (u.account_id !== a.account) return [400, { message: `That location is not in account ${a.account}.` }];
    if (s.units.filter((x) => x.kind === "location" && x.account_id === a.account).length < 2) return [400, { message: "x has only that one location, so there is nothing to unlink." }];
    const nid = `${p}-new-${++s.seq}`; s.accounts.push({ id: nid, name: u.name });
    const was = u.id; u.account_id = nid; if (emp(p)) u.id = locId(p, nid, bare(p, u.id));
    return [200, { ok: true, account: nid, from: a.account, site: u.id, already: false, renamed_units: was !== u.id ? [{ kind: "location", from: was, to: u.id }] : [] }];
  }
  return [400, { message: "unknown action " + action }];
}
const addBiz = (p: string, id: string, name: string, locs: [string, string][]) => {
  A[p].accounts.push({ id, name }); for (const [l, n] of locs) A[p].units.push({ id: locId(p, id, l), kind: "location", account_id: id, name: n, license_type: "m12" });
};

// ---------- the portal ----------
const T: Record<string, any[]> = { lic_customers: [], lic_accounts: [], lic_units: [], lic_audit: [], lic_payments: [], lic_subscriptions: [], lic_link_origins: [], lic_plans: [] };
const KEYS: Record<string, string[]> = { lic_accounts: ["product", "ext_id"], lic_units: ["product", "ext_id"], lic_link_origins: ["id"], lic_customers: ["id"] };
const apps = prods.map((p) => ({ product: p, label: "Proview " + p, url: `http://app.mock/${p}`, apikey: "k", token: "tok-" + p, app_url: "https://" + p }));
function filt(rows: any[], q: URLSearchParams) {
  return rows.filter((r) => { for (const [k, v] of q) {
    if (["select", "limit", "order", "on_conflict", "columns"].includes(k)) continue;
    const i = v.indexOf("."); const op = v.slice(0, i), val = v.slice(i + 1); const cell = r[k];
    if (op === "eq" && String(cell) !== val) return false;
    if (op === "is" && val === "null" && cell != null) return false;
    if (op === "lt" && !(String(cell) < val)) return false;
    if (op === "in") { const set = val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")); if (!set.includes(String(cell))) return false; }
  } return true; });
}
const J = (st: number, b?: unknown, h: Record<string, string> = {}) => new Response(b === undefined ? null : JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json", ...h } });
let cid = 0;
async function portal(req: Request) {
  const u = new URL(req.url); const auth = req.headers.get("authorization") || "";
  const txt = ["GET", "DELETE", "HEAD"].includes(req.method) ? "" : await req.text(); const body = txt ? JSON.parse(txt) : null; let m;
  if (u.pathname === "/auth/v1/user") return auth.includes("admin-jwt") ? J(200, { id: "a1", email: "master@proview.test" }) : J(401, { message: "bad jwt" });
  if ((m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/))) {
    if (m[1] === "is_lic_admin") return J(200, auth.includes("admin-jwt"));
    if (m[1] === "lic_app_config") return J(200, apps);
    return J(404, { message: "no rpc " + m[1] });
  }
  if ((m = u.pathname.match(/^\/rest\/v1\/(\w+)$/))) {
    const t = T[m[1]]; if (!t) return J(404, { message: "no table " + m[1] });
    const q = u.searchParams; const prefer = req.headers.get("prefer") || ""; const one = (req.headers.get("accept") || "").includes("pgrst.object");
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Range": `*/${filt(t, q).length}` } });
    if (req.method === "GET") { const rows = filt(t, q); if (one) return rows.length === 1 ? J(200, rows[0]) : rows.length === 0 ? J(406, { code: "PGRST116", message: "0 rows" }) : J(406, { message: "many" }); return J(200, rows); }
    if (req.method === "POST") { const list = Array.isArray(body) ? body : [body]; const res: any[] = [];
      for (const r of list) { const keys = KEYS[m[1]]; const ex = keys && t.find((x) => keys.every((k) => r[k] !== undefined && x[k] === r[k]));
        if (ex && prefer.includes("merge-duplicates")) { Object.assign(ex, r); res.push(ex); }
        else if (ex && prefer.includes("ignore-duplicates")) { /* skip */ }
        else if (ex) return J(409, { code: "23505", message: "duplicate key" });
        else { const row: any = { ...r }; if (m[1] === "lic_customers" && !row.id) row.id = "card-new-" + (++cid); if (m[1] === "lic_audit") row.id = t.length + 1; t.push(row); res.push(row); } }
      return prefer.includes("return=representation") ? J(201, one ? res[0] : res) : J(201); }
    if (req.method === "PATCH") { filt(t, q).forEach((r) => Object.assign(r, body)); return J(204); }
    if (req.method === "DELETE") { const del = new Set(filt(t, q)); T[m[1]] = t.filter((r) => !del.has(r)); return J(204); }
  }
  return J(404, { message: "mock: no route " + req.method + " " + u.pathname });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(String(input), init); const u = new URL(req.url);
  if (u.host === "portal.mock") return portal(req);
  if (u.host === "app.mock") { const p = u.pathname.split("/")[1]; const b = await req.json(); if (b.p_token !== "tok-" + p) return J(401, { message: "not authorised" });
    const [st, r] = hub(p, b.p_action, b.p_args ?? {}); return J(st, r); }
  return realFetch(input, init);
}) as typeof fetch;
let handler: (r: Request) => Promise<Response> = async () => J(500);
(Deno as any).serve = (h: any) => { handler = h; return {}; };
const mod = await import(new URL(Deno.args[0], `file://${Deno.cwd()}/`).href);
const call = async (body: unknown, jwt = "admin-jwt") => { const r = await handler(new Request("http://fn/", { method: "POST", headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const card = (id: string) => T.lic_customers.find((c) => c.id === id);
const accOf = (p: string, ext: string) => T.lic_accounts.find((a) => a.product === p && a.ext_id === ext);
const unit = (p: string, ext: string) => T.lic_units.find((u) => u.product === p && u.ext_id === ext);

// ---------- data: Cafe Alpha (Signage, Bookings, Employee), Cafe Beta (Signage, Employee, Label), Old Group (Signage, 2 locations) ----------
addBiz("signage", "sa", "Cafe Alpha", [["s-a", "Cafe Alpha"]]); addBiz("signage", "sb", "Cafe Beta", [["s-b", "Cafe Beta"]]);
addBiz("bookings", "ba", "Cafe Alpha", [["cafe-alpha", "Cafe Alpha"]]);
addBiz("employee", "ea", "Cafe Alpha", [["l1", "Cafe Alpha"]]); addBiz("employee", "eb", "Cafe Beta", [["l1", "Cafe Beta"]]);
A.employee.units.push({ id: "eb/m1", kind: "staff", account_id: "eb", name: "Cy" });
addBiz("label", "lb", "Cafe Beta", [["site_b", "Cafe Beta"]]);
addBiz("signage", "so", "Old Group", [["s-o1", "Old Group"], ["s-o2", "Old Group Soho"]]);
addBiz("bookings", "bo", "Old Group", [["old-group", "Old Group"], ["old-soho", "Old Group Soho"]]);
T.lic_customers.push({ id: "card-a", name: "Cafe Alpha", contact_email: "a@x.test" }, { id: "card-b", name: "Cafe Beta", contact_email: "b@x.test" }, { id: "card-o", name: "Old Group", contact_email: "o@x.test" });
let r = await call({ action: "sync" });
for (const a of T.lic_accounts) a.customer_id = a.name === "Cafe Alpha" ? "card-a" : a.name === "Cafe Beta" ? "card-b" : "card-o";
T.lic_subscriptions.push({ subscription_id: "sub1", product: "employee", unit_ext_id: "loc/eb/l1", plan: "m1", kind: "location" });
ok(r.body.ok && T.lic_units.length === 11, `sync pulled the test units (${T.lic_units.length})`);

// ---------- refusals ----------
r = await call({ action: "link", customer_a: "card-a", customer_b: "card-b" }, "nobody");
ok(r.status === 403, "link: non-admin refused");
r = await call({ action: "link", customer_a: "card-a", customer_b: "card-a" });
ok(r.status === 400 && /itself/.test(r.body.error), "link: a location with itself refused");

// ---------- split preview (before linking) ----------
r = await call({ action: "split_preview" });
const pl = r.body.plan;
ok(pl.length === 1 && pl[0].customer_id === "card-o" && pl[0].businesses.length === 2 && pl[0].new_cards.length === 1
   && pl[0].new_cards[0].name === "Old Group Soho" && pl[0].new_cards[0].units.length === 2
   && pl[0].businesses.every((b: any) => b.keep.name === "Old Group"), `split preview: Old Group keeps "Old Group" in Signage and Bookings; "Old Group Soho" becomes one new card (${JSON.stringify(pl).slice(0, 200)})`);

// ---------- link: one app fails ----------
A.label.fail = undefined; A.employee.fail = "link";
r = await call({ action: "link", customer_a: "card-a", customer_b: "card-b" });
ok(!r.body.ok && r.body.results.signage?.ok && r.body.results.employee?.ok === false && /employee is down/.test(r.body.results.employee.error)
   && r.body.results.label?.ok && r.body.results.label.moved && r.body.results.bookings?.ok, `partial link: Signage linked, Label moved, Employee failed and says why (${JSON.stringify(r.body.results)})`);
ok(card("card-b") && !r.body.removed_b && accOf("employee", "eb")?.customer_id === "card-b" && !accOf("employee", "eb")?.gone, "partial link: card B stays, holding only the app that failed");
ok(accOf("signage", "sb")?.gone && unit("signage", "loc/s-b")?.account_ext_id === "sa" && accOf("label", "lb")?.customer_id === "card-a", "partial link: portal matches what happened (Signage B gone into A, Label B's account on card A)");
ok(unit("signage", "loc/s-b")?.origin_id === "card-b" && unit("signage", "loc/s-a")?.origin_id === "card-a", "each location remembers which location it came from");
// ---------- press again: finishes ----------
A.employee.fail = undefined;
const nLink = calls.filter((c) => c.action === "link").length;
r = await call({ action: "link", customer_a: "card-a", customer_b: "card-b" });
ok(r.body.ok && r.body.removed_b && !card("card-b"), `link again: Employee linked, card B removed (${JSON.stringify(r.body.results)})`);
ok(calls.filter((c) => c.action === "link").slice(nLink).every((c) => c.p === "employee"), "link again: only the app that hadn't linked is called");
ok(unit("employee", "loc/ea/l1_x1")?.origin_id === "card-b" && unit("employee", "loc/ea/l1_x1")?.account_ext_id === "ea" && !unit("employee", "loc/eb/l1")
   && unit("employee", "ea/m1")?.account_ext_id === "ea", "Employee's renamed units (location and staff) re-pointed, keeping their origin");
ok(T.lic_subscriptions[0].unit_ext_id === "loc/ea/l1_x1", `a Stripe subscription follows its renamed unit (${T.lic_subscriptions[0].unit_ext_id})`);
const groups = mod.linkedGroups(card("card-a"), T.lic_accounts, T.lic_units, T.lic_link_origins);
ok(groups.length === 2 && groups[0].name === "Cafe Alpha" && groups[1].name === "Cafe Beta" && groups[1].units.length === 3, `card A shows 2 linked locations: Cafe Alpha + Cafe Beta (${groups.map((g: any) => g.name + ":" + g.units.length)})`);
r = await call({ action: "split_preview", customer: "card-a" });
ok(r.body.plan.length === 0, "linked locations are not offered for the split (they are unlinked with Unlink)");

// ---------- unlink Cafe Beta ----------
r = await call({ action: "unlink", customer: "card-a", origin: "card-b" });
const nc = r.body.customer;
ok(r.body.ok && card(nc)?.name === "Cafe Beta", `unlink: ok, new card "Cafe Beta" (${JSON.stringify(r.body.results)})`);
ok(accOf("label", "lb")?.customer_id === nc, "unlink: Label (only Beta had it, one location) moved back as it is");
const sNew = T.lic_accounts.find((a) => a.product === "signage" && a.customer_id === nc && !a.gone);
ok(sNew && unit("signage", "loc/s-b")?.account_ext_id === sNew.ext_id && A.signage.accounts.some((a) => a.id === sNew.ext_id), "unlink: Signage made a new business; its location unit points at it");
const eNew = T.lic_accounts.find((a) => a.product === "employee" && a.customer_id === nc && !a.gone);
ok(eNew && T.lic_units.some((u) => u.product === "employee" && u.ext_id === `loc/${eNew.ext_id}/l1_x1` && u.account_ext_id === eNew.ext_id), "unlink: Employee's renamed location unit re-pointed to the new business");
ok(mod.linkedGroups(card("card-a"), T.lic_accounts, T.lic_units, T.lic_link_origins).length === 1, "card A is a location on its own again");
const nUn = calls.filter((c) => c.action === "unlink").length;
r = await call({ action: "unlink", customer: "card-a", origin: "card-b" });
ok(r.body.ok && r.body.already && r.body.customer === nc && calls.filter((c) => c.action === "unlink").length === nUn, "unlink again: already done, same card, no app called");
r = await call({ action: "unlink", customer: "card-a", origin: "card-a" });
ok(r.status === 400 && /isn't linked/.test(r.body.error), `unlink of a location on its own refused (${r.body.error})`);

// ---------- split ----------
r = await call({ action: "split" });
const soho = T.lic_customers.find((c) => c.name === "Old Group Soho");
ok(r.body.ok && soho, `split: ok, "Old Group Soho" card made (${JSON.stringify(r.body.split).slice(0, 200)})`);
ok(T.lic_accounts.filter((a) => a.customer_id === soho?.id && !a.gone).length === 2
   && unit("signage", "loc/s-o2")?.account_ext_id !== "so" && unit("bookings", "old-soho")?.account_ext_id !== "bo", "split: the Soho location left in Signage and Bookings, both on the new card");
ok(soho && mod.linkedGroups(soho, T.lic_accounts, T.lic_units, T.lic_link_origins)[0]?.name === "Old Group Soho" && unit("signage", "loc/s-o2")?.origin_id == null, "split: the new card's location is its own (no origin)");
r = await call({ action: "split_preview" });
ok(r.body.plan.length === 0, "nothing left to split");

console.log(out.join("\n"));
console.log(`\n${out.filter((x) => x.startsWith("PASS")).length}/${out.length} PASS`);
