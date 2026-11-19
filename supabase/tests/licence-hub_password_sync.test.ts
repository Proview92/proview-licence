// Tests licence-hub's one-password sync (ONE_PASSWORD_SPEC.md) under Deno against in-memory sites that behave like the
// SQL (hub_call 'password_changes' / 'set_password_hash', lic_pw_*): newest change wins, no loops, it never makes app
// logins, it does make the Proview account, it skips apps on hold, and on hold / banned logins stay blocked. Then the
// HTTP side: the minute run's secret, Activity rows (emails only, never hashes), the dry run (sends nothing) and the
// explicit invite list. No network. Usage:
//   deno run -A supabase/tests/licence-hub_password_sync.test.ts supabase/functions/licence-hub/index.ts
const out: string[] = [];
const ok = (c: unknown, m: string) => out.push((c ? "PASS " : "FAIL ") + m);
Deno.env.set("SUPABASE_URL", "http://portal.mock"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service"); Deno.env.set("SUPABASE_ANON_KEY", "anon");
let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 500 });
(Deno as any).serve = (h: any) => { handler = h; return {}; };

// ---------- an in-memory site, as the SQL behaves ----------
const H = (n: number) => "$2a$10$" + String(n).padStart(53, "x").slice(0, 53);   // bcrypt-shaped test hashes
type U = { hash: string | null; banned: boolean; confirmed: boolean; signedIn: boolean };
type Row = { email: string; hash: string | null; changed_at: string; source: "user" | "sync"; kind: "set" | "new" };
let clock = Date.parse("2026-11-20T09:00:00Z");
const tick = (s = 1) => new Date(clock += s * 1000).toISOString();
class Site {
  users = new Map<string, U>(); rows: Row[] = []; calls: string[] = []; failPush = 0;
  constructor(public product: string) {}
  newLogin(email: string, hash: string | null, o: Partial<U> = {}) { this.users.set(email, { hash, banned: false, confirmed: true, signedIn: false, ...o }); this.rows.push({ email, hash, changed_at: tick(), source: "user", kind: "new" }); }
  change(email: string, hash: string) { this.users.get(email)!.hash = hash; this.rows.push({ email, hash, changed_at: tick(), source: "user", kind: "set" }); }
  held(email: string) { const r = this.rows.filter((x) => x.email === email).map((x) => Date.parse(x.changed_at)); return r.length ? Math.max(...r) : null; }
  async pull(since: string | null) {
    this.calls.push("password_changes");
    const changes = this.rows.filter((r) => r.source === "user" && this.users.get(r.email)?.confirmed && (!since || Date.parse(r.changed_at) > Date.parse(since)))
      .map(({ email, hash, changed_at, kind }) => ({ email, hash, changed_at, kind }));
    return { changes, more: false };
  }
  async push(email: string, hash: string, at: string, create = false, kind: "set" | "new" = "set") {
    this.calls.push("set_password_hash");
    if (this.failPush > 0) { this.failPush--; throw new Error(`${this.product} is down`); }
    const u = this.users.get(email);
    if (!u && !create) return { applied: false, reason: "no login" };
    const held = this.held(email);
    if (u && held !== null && held >= Date.parse(at)) return { applied: false, reason: "older" };
    if (!u) this.users.set(email, { hash, banned: false, confirmed: true, signedIn: false }); else u.hash = hash;   // ban and confirmation kept
    this.rows.push({ email, hash, changed_at: at, source: "sync", kind });
    return { applied: true, created: !u };
  }
}
class Licence extends Site {
  async set(email: string, hash: string, at: string, create: boolean, kind: "set" | "new" = "set") { return this.push(email, hash, at, create, kind); }
  async accounts(emails: string[]) {
    return emails.map((email) => {
      const u = this.users.get(email);
      const usable = !!u?.hash && (u.signedIn || this.rows.some((r) => r.email === email && r.kind === "set"));
      return { email, exists: !!u, usable, hash: usable ? u!.hash : null };
    });
  }
}
function world() {
  const lic = new Licence("licence"), sg = new Site("signage"), tm = new Site("team"), rv = new Site("reservations"), bk = new Site("bookings"), em = new Site("employee");
  const cursors: Record<string, { cursor: string | null; error: string | null }> = {};
  const deps = {
    apps: [sg, tm, rv, bk, em].map((s) => ({ product: s.product, pull: (x: string | null) => s.pull(x), push: (e: string, h: string, a: string) => s.push(e, h, a) })),
    licence: { product: "licence", pull: (x: string | null) => lic.pull(x), push: (e: string, h: string, a: string) => lic.push(e, h, a),
               set: (e: string, h: string, a: string, c: boolean, k?: "set" | "new") => lic.set(e, h, a, c, k), accounts: (e: string[]) => lic.accounts(e) },
    state: async () => Object.fromEntries(Object.entries(cursors).map(([k, v]) => [k, { cursor: v.cursor }])),
    saveState: async (p: string, c: string | null, e: string | null) => { cursors[p] = { cursor: c ?? cursors[p]?.cursor ?? null, error: e }; },
  };
  return { lic, sg, tm, rv, bk, em, cursors, deps };
}

const mod = await import(new URL(Deno.args[0], `file://${Deno.cwd()}/`).href);
const { passwordSync, startPlan, PW_ON_HOLD } = mod;

// ---------- newest change wins ----------
{
  const w = world();
  w.sg.newLogin("ann@x.test", H(1)); w.tm.newLogin("ann@x.test", H(2)); w.rv.newLogin("ann@x.test", H(3));
  w.lic.newLogin("ann@x.test", H(4), { signedIn: true });
  w.sg.change("ann@x.test", H(10));
  w.tm.change("ann@x.test", H(11));   // newer
  const r = await passwordSync(w.deps);
  ok(r.ok && w.sg.users.get("ann@x.test")!.hash === H(11) && w.rv.users.get("ann@x.test")!.hash === H(11) && w.lic.users.get("ann@x.test")!.hash === H(11),
     "newest change wins: Team's later password is now on Signage, Reservations and the dashboard " + JSON.stringify(r));
  ok(w.tm.users.get("ann@x.test")!.hash === H(11), "the site with the newest change keeps it");
  ok(JSON.stringify(r.synced) === '["ann@x.test"]', "result lists the email synced");
  ok(!JSON.stringify(r).includes("$2a$"), "the result has no hashes");

  // no loops: a second run copies nothing, and synced rows are never read back
  const before = w.sg.rows.length + w.tm.rows.length + w.rv.rows.length + w.lic.rows.length;
  const r2 = await passwordSync(w.deps);
  const after = w.sg.rows.length + w.tm.rows.length + w.rv.rows.length + w.lic.rows.length;
  ok(r2.ok && !r2.synced.length && !r2.created.length && after === before, "no loops: the next run copies nothing " + JSON.stringify(r2));
  const r3 = await passwordSync(w.deps);
  ok(r3.read === 0 || r3.synced.length === 0, "no loops: and the run after that neither");
  // an older change arriving late (Signage's) does not undo the newer one
  w.sg.rows.push({ email: "ann@x.test", hash: H(9), changed_at: new Date(clock - 3600e3).toISOString(), source: "user", kind: "set" });
  w.sg.users.get("ann@x.test")!.hash = H(9);
  await passwordSync(w.deps);
  ok(w.tm.users.get("ann@x.test")!.hash === H(11) && w.lic.users.get("ann@x.test")!.hash === H(11), "an older change read late is refused everywhere else");
}

// ---------- never makes app logins; makes the Proview account ----------
{
  const w = world();
  w.sg.newLogin("bob@x.test", H(1)); w.sg.change("bob@x.test", H(20));
  const r = await passwordSync(w.deps);
  ok(!w.tm.users.has("bob@x.test") && !w.rv.users.has("bob@x.test"), "never makes an app login where the email has none");
  ok(w.lic.users.get("bob@x.test")?.hash === H(20) && w.lic.users.get("bob@x.test")?.confirmed === true, "makes the Proview account, confirmed, with the same hash");
  ok(JSON.stringify(r.created) === '["bob@x.test"]', "result lists the Proview account made " + JSON.stringify(r.created));
  ok(w.tm.calls.includes("set_password_hash"), "(the other apps were asked, and said: no login)");
}

// ---------- new logins: dashboard password wins; no Proview account -> made from the new login ----------
{
  const w = world();
  w.lic.newLogin("cat@x.test", H(30), { signedIn: true });          // she signs in to the dashboard with H(30)
  w.rv.newLogin("cat@x.test", null);                                 // dashboard hand-off made a Reservations login, no password
  w.tm.newLogin("cat@x.test", H(31));                                // Add user with a typed password
  w.lic.newLogin("dan@x.test", H(40));                               // New business: random password nobody knows
  w.sg.newLogin("dan@x.test", H(41)); w.sg.users.get("dan@x.test")!.signedIn = true;
  w.sg.rows.push({ email: "dan@x.test", hash: H(41), changed_at: new Date(clock - 86400e3).toISOString(), source: "sync", kind: "set" });   // older, not read
  w.tm.newLogin("eve@x.test", H(50));                                // new login, no Proview account yet
  const r = await passwordSync(w.deps);
  ok(w.rv.users.get("cat@x.test")!.hash === H(30) && w.tm.users.get("cat@x.test")!.hash === H(30), "new app logins get the person's dashboard password " + JSON.stringify(r.adopted));
  ok(w.lic.users.get("cat@x.test")!.hash === H(30), "the dashboard password is not changed by a new login");
  ok(w.sg.users.get("dan@x.test")!.hash === H(41), "a random password on a new Proview account never overwrites an app password people use");
  ok(w.lic.users.get("eve@x.test")?.hash === H(50) && r.created.includes("eve@x.test"), "no Proview account: it is made with the new login's password");
  ok(!(await w.lic.accounts(["eve@x.test"]))[0].usable, "... but (maybe a random password) it doesn't count as a dashboard password yet");
  w.rv.newLogin("eve@x.test", H(51));
  await passwordSync(w.deps);
  ok(w.rv.users.get("eve@x.test")!.hash === H(51), "so a later new login keeps its own password (no unknown one copied onto it)");
  w.tm.change("eve@x.test", H(52));
  await passwordSync(w.deps);
  ok([w.lic, w.tm, w.rv].every((s) => s.users.get("eve@x.test")!.hash === H(52)), "once she sets a password anywhere it is the same everywhere");
}

// ---------- apps on hold are skipped ----------
{
  const w = world();
  w.bk.newLogin("fay@x.test", H(1)); w.bk.change("fay@x.test", H(60));
  w.em.newLogin("fay@x.test", H(2));
  w.sg.newLogin("fay@x.test", H(3)); w.sg.change("fay@x.test", H(61));
  const r = await passwordSync(w.deps);
  ok(JSON.stringify(PW_ON_HOLD) === '["bookings","employee"]', "on hold list = the portal's ON_HOLD (Bookings, Employee)");
  ok(!w.bk.calls.length && !w.em.calls.length, "apps on hold are never read or written " + JSON.stringify([w.bk.calls, w.em.calls]));
  ok(w.bk.users.get("fay@x.test")!.hash === H(60) && w.em.users.get("fay@x.test")!.hash === H(2), "their logins keep their own passwords");
  ok(w.lic.users.get("fay@x.test")?.hash === H(61), "Bookings' change was not read (Signage's is the one copied)");
  ok(JSON.stringify(r.skipped_on_hold) === '["bookings","employee"]' && !("bookings" in w.cursors), "result says which were skipped; no cursor for them");
}

// ---------- on hold / banned logins stay blocked ----------
{
  const w = world();
  w.sg.newLogin("gus@x.test", H(1), { banned: true });
  w.tm.newLogin("gus@x.test", H(2)); w.tm.change("gus@x.test", H(70));
  await passwordSync(w.deps);
  const u = w.sg.users.get("gus@x.test")!;
  ok(u.hash === H(70) && u.banned === true, "a login on hold in Signage gets the password but stays on hold");
  const used = new Set([...w.sg.calls, ...w.tm.calls, ...w.rv.calls]);
  ok([...used].every((c) => c === "password_changes" || c === "set_password_hash"), "the sync only ever calls the two password actions " + JSON.stringify([...used]));
}

// ---------- a failed copy is retried ----------
{
  const w = world();
  w.sg.newLogin("hal@x.test", H(1)); w.rv.newLogin("hal@x.test", H(2)); w.sg.change("hal@x.test", H(80));
  w.rv.failPush = 1;
  const r = await passwordSync(w.deps);
  ok(!r.ok && r.errors.reservations && w.rv.users.get("hal@x.test")!.hash === H(2), "Reservations down: reported " + JSON.stringify(r.errors));
  ok(!JSON.stringify(r.errors).includes("$2a$"), "errors name the email only");
  const r2 = await passwordSync(w.deps);
  ok(r2.ok && w.rv.users.get("hal@x.test")!.hash === H(80), "next run copies it (Signage's cursor waited)");
  const r3 = await passwordSync(w.deps);
  ok(r3.ok && !r3.synced.length, "and then stops");
}

// ---------- the dry run plan ----------
{
  const p = startPlan(
    [{ email: "a@x.test", has_password: true }, { email: "b@x.test", has_password: false }, { email: "lonely@x.test", has_password: true }],
    { signage: [{ email: "a@x.test" }, { email: "b@x.test" }, { email: "c@x.test" }], team: [{ email: "a@x.test" }, { email: "c@x.test" }] });
  const row = (e: string) => p.rows.find((r: any) => r.email === e);
  ok(p.emails === 4 && p.a === 1 && p.b === 2 && p.nothing === 1, "dry run counts: 4 emails, 1 (a), 2 (b), 1 nothing " + JSON.stringify({ e: p.emails, a: p.a, b: p.b, n: p.nothing }));
  ok(JSON.stringify(row("a@x.test").apps) === '["signage","team"]' && row("a@x.test").action === "a", "(a) dashboard password -> copied to its apps");
  ok(row("c@x.test").dashboard === "none" && row("c@x.test").action === "b", "(b) no Proview account -> set-your-password email");
  ok(JSON.stringify(p.would_get_email) === '["b@x.test","c@x.test"]', "the would-get-email list");
}

// ---------- HTTP: the minute run, Activity, dry run, explicit invites ----------
const LIC = new Licence("licence"), SG = new Site("signage"), TM = new Site("team"), BK = new Site("bookings");
LIC.newLogin("ivy@x.test", H(90), { signedIn: true }); SG.newLogin("ivy@x.test", H(91)); TM.newLogin("ivy@x.test", H(92));
LIC.newLogin("jon@x.test", H(93)); SG.newLogin("jon@x.test", H(94)); TM.newLogin("kim@x.test", H(95)); BK.newLogin("lee@x.test", H(96));
// these logins existed before the migration: nothing recorded for them yet
for (const s of [LIC, SG, TM, BK]) s.rows.length = 0;
const SITES: Record<string, Site> = { signage: SG, team: TM, bookings: BK };
const REF: Record<string, string> = { signage: "zbuyafrdhbgqyaepiajm", team: "guiwijyxzyffnmiiwpcf", bookings: "bgsimnrmlzsrfkjpntvj" };
const nodeCalls: string[] = [];
const audit: any[] = [], mails: string[] = []; const state: Record<string, any> = {}; let cronOn = true;
const J = (st: number, b?: unknown) => new Response(b === undefined ? null : JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(String(input), init); const u = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const txt = req.method === "GET" ? "" : await req.text(); const b = txt ? JSON.parse(txt) : null;
  if (u.host === "wifi.proviewcrm.co.uk") { nodeCalls.push(u.pathname); return J(500, { message: "the Node server must never be called" }); }
  if (u.host.endsWith(".supabase.co")) {
    const s = SITES[Object.keys(REF).find((k) => REF[k] === u.host.split(".")[0])!];
    if (b.p_token !== "tok") return J(400, { message: "not authorised" });
    if (b.p_action === "password_changes") return J(200, b.p_args.all ? { ok: true, logins: [...s.users.keys()].map((email) => ({ email, has_password: true })) } : { ok: true, ...(await s.pull(b.p_args.since)) });
    if (b.p_action === "set_password_hash") return J(200, { ok: true, ...(await s.push(b.p_args.email, b.p_args.hash, b.p_args.changed_at)) });
    return J(400, { message: "unexpected action " + b.p_action });
  }
  if (u.host !== "portal.mock") return J(404);
  const P = u.pathname;
  if (P === "/auth/v1/user") return J(200, { id: "a1", email: "master@proview.test" });
  if (P === "/rest/v1/rpc/is_lic_admin") return J(200, auth.includes("admin-jwt"));
  if (P === "/rest/v1/rpc/lic_app_config") return J(200, [...["signage", "team", "bookings"].map((p) => ({ product: p, label: p, url: `https://${REF[p]}.supabase.co`, apikey: "k", token: "tok", app_url: "" })),
    { product: "wifi", label: "WiFi", url: "https://wifi.proviewcrm.co.uk", apikey: "k", token: "tok", app_url: "" }]);   // the old WiFi Node server
  if (P === "/rest/v1/rpc/lic_pw_cron_ok") return J(200, cronOn && b.p_secret === "cron-secret");
  if (P === "/rest/v1/rpc/lic_pw_state") return J(200, state);
  if (P === "/rest/v1/rpc/lic_pw_state_set") { state[b.p_product] = { cursor: b.p_cursor ?? state[b.p_product]?.cursor ?? null }; return J(200, null); }
  if (P === "/rest/v1/rpc/lic_pw_changes") return J(200, { ok: true, ...(await LIC.pull(b.p_since)) });
  if (P === "/rest/v1/rpc/lic_pw_set") return J(200, { ok: true, ...(await LIC.set(b.p_email, b.p_hash, b.p_changed_at, b.p_create, b.p_kind)) });
  if (P === "/rest/v1/rpc/lic_pw_accounts") return J(200, (await LIC.accounts(b.p_emails)).map((a) => ({ ...a, held_at: LIC.held(a.email) ? new Date(LIC.held(a.email)!).toISOString() : null })));
  if (P === "/rest/v1/rpc/lic_pw_all") return J(200, [...LIC.users.keys()].map((email) => ({ email, has_password: !!LIC.users.get(email)!.signedIn })));
  if (P === "/rest/v1/rpc/lic_dashboard_accounts") return J(200, b.p_emails.map((e: string) => ({ email: e, state: LIC.users.has(e) ? "invited" : "none", email_confirmed_at: LIC.users.has(e) ? "2026-11-01T00:00:00Z" : null })));
  if (P === "/rest/v1/lic_audit" && req.method === "POST") { audit.push(...(Array.isArray(b) ? b : [b])); return J(201); }
  if (P === "/auth/v1/invite" || P === "/auth/v1/recover") { mails.push(String(b.email)); return J(200, {}); }
  return J(404, { message: "mock: no route " + req.method + " " + P });
}) as typeof fetch;
const call = async (body: unknown, headers: Record<string, string> = { Authorization: "Bearer admin-jwt" }) => {
  const r = await handler(new Request("http://fn/", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

let r = await call({ action: "password_sync" }, { "x-cron-secret": "wrong" });
ok(r.status === 403, "minute run with a wrong secret: refused");
cronOn = false; r = await call({ action: "password_sync" }, { "x-cron-secret": "cron-secret" }); cronOn = true;
ok(r.status === 403, "minute run while switched off: refused");
r = await call({ action: "password_sync" }, { Authorization: "Bearer someone" });
ok(r.status === 403, "password_sync by someone who isn't the master: refused");

// dry run: sends nothing, changes nothing
const snap = JSON.stringify([...SG.users, ...TM.users, ...LIC.users]);
r = await call({ action: "password_start" });
ok(r.status === 200 && r.body.dry_run === true && r.body.emails === 3 && r.body.a === 1 && r.body.b === 2, "dry run: 3 emails, 1 (a), 2 (b) " + JSON.stringify({ e: r.body.emails, a: r.body.a, b: r.body.b, w: r.body.would_get_email }));
ok(JSON.stringify(r.body.would_get_email) === '["jon@x.test","kim@x.test"]', "dry run: would-get-email list");
ok(!r.body.rows.some((x: any) => x.email === "lee@x.test") && !r.body.rows.some((x: any) => x.sites.includes("bookings")) && !BK.calls.length, "dry run: Bookings (on hold) not read");
ok(!mails.length && JSON.stringify([...SG.users, ...TM.users, ...LIC.users]) === snap && !SG.calls.includes("set_password_hash"), "dry run sends nothing and changes nothing");
ok(!JSON.stringify(r.body).includes("$2a$"), "dry run answer has no hashes");

// (a): the dashboard password goes to the apps of that email
r = await call({ action: "password_start", apply: true });
ok(r.body.ok && r.body.copied === 2 && SG.users.get("ivy@x.test")!.hash === H(90) && TM.users.get("ivy@x.test")!.hash === H(90), "(a) applied: ivy's dashboard password now on Signage and Team " + JSON.stringify(r.body));
ok(SG.users.get("jon@x.test")!.hash === H(94), "(b) people keep their app password until they set one");
ok(!mails.length, "applying (a) sends no email");

// the minute run
SG.change("jon@x.test", H(99));
r = await call({ action: "password_sync" }, { "x-cron-secret": "cron-secret" });
ok(r.status === 200 && LIC.users.get("jon@x.test")!.hash === H(99) && !TM.users.has("jon@x.test"), "minute run: Signage's change reached the dashboard, no Team login made " + JSON.stringify(r.body));
const row = audit.find((a) => a.action === "Password sync");
ok(row && row.after.emails.includes("jon@x.test") && row.admin_email === "Password sync (every minute)", "logged in Activity with the email " + JSON.stringify(row));
ok(!JSON.stringify(audit).includes("$2a$"), "Activity never holds a hash");
const n = audit.length;
r = await call({ action: "password_sync" }, { "x-cron-secret": "cron-secret" });
ok(r.status === 200 && audit.length === n, "a run that changes nothing logs nothing");
ok(!BK.calls.length, "Bookings (on hold) never called");
ok(!nodeCalls.length && JSON.stringify(r.body.not_supabase) === '["wifi"]', "the old WiFi Node server is never synced " + JSON.stringify(r.body.not_supabase));

// explicit invite list
r = await call({ action: "password_invites" });
ok(r.status === 400 && !mails.length, "invites without a list: refused, nothing sent");
r = await call({ action: "password_invites", emails: ["kim@x.test", "ivy@x.test", "Kim@x.test "] });
ok(r.status === 200 && JSON.stringify(mails) === '["kim@x.test"]', "invites: only the listed email without a dashboard password gets one " + JSON.stringify(mails));
ok(r.body.results["ivy@x.test"]?.skipped, "ivy (already has a dashboard password) skipped");

console.log(out.join("\n"));
console.log(`\n${out.filter((x) => x.startsWith("PASS")).length}/${out.length} PASS`);
if (out.some((x) => x.startsWith("FAIL"))) Deno.exit(1);
