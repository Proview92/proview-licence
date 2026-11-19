// Tests licence-hub's dashboard_invite (Proview dashboard account invites, owner 19 Nov 2026) under Deno against in-memory
// mocks (no network): the portal's Supabase Auth (invite / recover), lic_dashboard_accounts and lic_audit. Usage:
//   deno run -A supabase/tests/licence-hub_dashboard_invite.test.ts supabase/functions/licence-hub/index.ts
const out: string[] = [];
const ok = (c: unknown, m: string) => out.push((c ? "PASS " : "FAIL ") + m);
Deno.env.set("SUPABASE_URL", "http://portal.mock"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service"); Deno.env.set("SUPABASE_ANON_KEY", "anon");

// Proview accounts (auth.users) by email
type Acc = { email: string; email_confirmed_at: string | null; invited_at: string | null; last_sign_in_at: string | null; created_at: string };
const USERS: Record<string, Acc> = {};
const add = (email: string, a: Partial<Acc>) => { USERS[email] = { email, email_confirmed_at: null, invited_at: null, last_sign_in_at: null, created_at: new Date().toISOString(), ...a }; };
const audit: any[] = [], mails: { kind: string; email: string; redirect: string | null; data?: any; auth: string }[] = [];
let failNext: [number, any] | null = null;   // the next auth email call fails like GoTrue does
let statusRpc = 0;
const J = (st: number, b?: unknown) => new Response(b === undefined ? null : JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(String(input), init); const u = new URL(req.url);
  if (u.host !== "portal.mock") return realFetch(input, init);
  const auth = req.headers.get("authorization") || req.headers.get("apikey") || "";
  const txt = req.method === "GET" ? "" : await req.text(); const body = txt ? JSON.parse(txt) : null;
  if (u.pathname === "/auth/v1/user") return auth.includes("admin-jwt") ? J(200, { id: "a1", email: "master@proview.test" }) : J(401, { message: "bad jwt" });
  if (u.pathname === "/rest/v1/rpc/is_lic_admin") return J(200, auth.includes("admin-jwt"));
  if (u.pathname === "/rest/v1/rpc/lic_dashboard_accounts") {
    statusRpc++;
    if (!auth.includes("admin-jwt")) return J(400, { message: "Only the Proview licence administrator can see dashboard accounts." });
    return J(200, (body.p_emails as string[]).map((e) => { const a = USERS[e]; return a ? { ...a, state: a.last_sign_in_at ? "active" : "invited" } : { email: e, state: "none", created_at: null, email_confirmed_at: null, invited_at: null, last_sign_in_at: null }; }));
  }
  if (u.pathname === "/rest/v1/rpc/lic_app_config") return J(200, []);
  if (u.pathname === "/rest/v1/lic_audit" && req.method === "POST") { audit.push(...(Array.isArray(body) ? body : [body])); return J(201); }
  if (u.pathname === "/auth/v1/invite" || u.pathname === "/auth/v1/recover") {
    const kind = u.pathname.endsWith("invite") ? "invite" : "recovery";
    if (kind === "invite" && !auth.includes("service")) return J(403, { msg: "User not allowed" });
    if (failNext) { const f = failNext; failNext = null; return J(f[0], f[1]); }
    const e = String(body.email);
    if (kind === "invite") {
      if (USERS[e]?.email_confirmed_at) return J(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      if (!USERS[e]) add(e, {}); USERS[e].invited_at = new Date().toISOString();
    }
    mails.push({ kind, email: e, redirect: u.searchParams.get("redirect_to"), data: body.data, auth });
    return J(200, kind === "invite" ? { id: "u-" + e, email: e } : {});
  }
  return J(404, { message: "mock: no route " + req.method + " " + u.pathname });
}) as typeof fetch;
let handler: (r: Request) => Promise<Response> = async () => J(500);
(Deno as any).serve = (h: any) => { handler = h; return {}; };
await import(new URL(Deno.args[0], `file://${Deno.cwd()}/`).href);
const call = async (body: unknown, jwt = "admin-jwt") => { const r = await handler(new Request("http://fn/", { method: "POST", headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const DASH = "https://dashboard.proviewcrm.co.uk/";

add("active@x.test", { email_confirmed_at: "2026-11-01T10:00:00Z", last_sign_in_at: "2026-11-18T09:00:00Z" });
add("invited@x.test", { invited_at: "2026-11-18T09:00:00Z" });
add("made@x.test", { email_confirmed_at: "2026-11-18T09:00:00Z" });   // New business: confirmed, random password nobody knows

// refusals
let r = await call({ action: "dashboard_invite", email: "new@x.test" }, "nobody");
ok(r.status === 403 && !mails.length, "non-admin refused, nothing sent");
r = await call({ action: "dashboard_invite", email: "not an email" });
ok(r.status === 400 && /valid email/.test(r.body.error) && !mails.length, "bad email refused");

// none -> account made + invite email to the dashboard
r = await call({ action: "dashboard_invite", email: "  New@X.test ", name: "Bab Newington", account_name: "BRAGS AND BRAMS" });
ok(r.status === 200 && r.body.ok && r.body.sent === "invite" && r.body.state === "none" && r.body.email === "new@x.test", "no account: invite sent " + JSON.stringify(r.body));
ok(mails.at(-1)?.kind === "invite" && mails.at(-1)?.email === "new@x.test" && mails.at(-1)?.redirect === DASH, "invite email: lower-cased email, redirect_to the dashboard " + JSON.stringify(mails.at(-1)));
ok(mails.at(-1)?.data?.full_name === "Bab Newington" && mails.at(-1)?.auth.includes("service"), "invite uses the service role and carries the name");
ok(USERS["new@x.test"]?.invited_at, "the Proview account now exists (invited)");
const a1 = audit.at(-1);
ok(a1?.action === "Dashboard invite" && a1.after?.email === "new@x.test" && a1.after?.sent === "invite" && a1.before?.state === "none" && a1.account_name === "BRAGS AND BRAMS" && !a1.error && a1.admin_email === "master@proview.test", "logged in Activity " + JSON.stringify(a1));

// invited, not confirmed -> the invite again
let n = mails.length;
r = await call({ action: "dashboard_invite", email: "invited@x.test" });
ok(r.body.sent === "invite" && r.body.state === "invited" && mails.length === n + 1 && mails.at(-1)?.kind === "invite", "invited, not confirmed: invite sent again");

// confirmed but never signed in -> "choose a password" (recovery) email to the dashboard
r = await call({ action: "dashboard_invite", email: "made@x.test" });
ok(r.body.sent === "recovery" && r.body.state === "invited" && mails.at(-1)?.kind === "recovery" && mails.at(-1)?.redirect === DASH, "confirmed, never signed in: choose-a-password email " + JSON.stringify(mails.at(-1)));

// active -> nothing
n = mails.length;
r = await call({ action: "dashboard_invite", email: "active@x.test" });
ok(r.status === 200 && r.body.ok && r.body.sent === null && r.body.state === "active" && mails.length === n, "active: nothing sent");

// only_if_missing (automatic invites)
r = await call({ action: "dashboard_invite", email: "invited@x.test", only_if_missing: true });
ok(r.body.sent === null && mails.length === n, "only_if_missing: an existing account gets nothing");
r = await call({ action: "dashboard_invite", email: "auto@x.test", only_if_missing: true });
ok(r.body.sent === "invite" && mails.at(-1)?.email === "auto@x.test", "only_if_missing: no account -> invite");

// failures: the real error text comes back and is logged
failNext = [500, { code: 500, error_code: "unexpected_failure", msg: "Error sending invite email" }];
r = await call({ action: "dashboard_invite", email: "broken@x.test" });
ok(r.status === 400 && r.body.error === "The dashboard invite couldn't be sent: Error sending invite email", "SMTP failure: real error text " + JSON.stringify(r.body));
ok(audit.at(-1)?.error === r.body.error, "failure logged with its error");
failNext = [429, { code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 42 seconds." }];
r = await call({ action: "dashboard_invite", email: "made@x.test" });
ok(r.status === 400 && /only request this after 42 seconds/.test(r.body.error) && /Try again in a minute/.test(r.body.error), "rate limit: real text plus 'try again' " + JSON.stringify(r.body));
r = await call({ action: "dashboard_invite", email: "active2@x.test" }, "admin-jwt");
ok(r.body.sent === "invite", "next call works after a failure");

console.log(out.join("\n"));
console.log(`\n${out.filter((x) => x.startsWith("PASS")).length}/${out.length} PASS`);
if (out.some((x) => x.startsWith("FAIL"))) Deno.exit(1);
