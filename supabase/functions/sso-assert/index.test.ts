// Deno tests for sso-assert's master-open claim (MASTER_OPEN_PROTOCOL.md), against mocks:
// Supabase auth + is_lic_admin and each app's sso-login "check" are answered by a stubbed fetch;
// the assertion is signed with a throw-away Ed25519 key and checked with the real WebCrypto verify.
//   deno test -A supabase/functions/sso-assert/index.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
Deno.env.set("SSO_PRIVATE_JWK", JSON.stringify(priv));
Deno.env.set("SUPABASE_URL", "http://mock.local");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");

const USERS: Record<string, { email: string; admin: boolean }> = {
  "admin-jwt": { email: "Master@Proview.test", admin: true },
  "owner-jwt": { email: "owner@cafe.test", admin: false },
};
const seen: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const body = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
  seen.push({ url: req.url, body });
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.host === "mock.local" && url.pathname === "/auth/v1/user") {
    const u = USERS[jwt]; return u ? j({ id: "u-" + jwt, email: u.email, email_confirmed_at: "2026-01-01T00:00:00Z" }) : j({ message: "bad jwt" }, 401);
  }
  if (url.host === "mock.local" && url.pathname === "/rest/v1/rpc/is_lic_admin") return j(!!USERS[jwt]?.admin);
  if (/\/functions\/v1\/sso-login$|\/customer\/sso\/check$/.test(url.pathname)) return j({ ok: true });
  return j({ message: "mock: no route " + req.url }, 404);
};

let handler!: (r: Request) => Promise<Response>;
(Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const call = async (body: unknown, jwt = "admin-jwt") => {
  const r = await handler(new Request("http://fn.local/", { method: "POST", headers: { Authorization: "Bearer " + jwt, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function claims(url: string) {
  const tok = url.split("#pv_sso=")[1];
  const [p, s] = tok.split(".");
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, unb64u(s), unb64u(p));
  return { ok, c: JSON.parse(new TextDecoder().decode(unb64u(p))) };
}

Deno.test("no business: assertion unchanged (no biz claim)", async () => {
  const r = await call({ action: "go", app: "signage" });
  assertEquals(r.status, 200);
  assert(r.body.url.startsWith("https://app.proviewsignage.co.uk/#pv_sso="));
  const { ok, c } = await claims(r.body.url);
  assert(ok, "signature verifies");
  assertEquals(Object.keys(c).sort(), ["aud", "email", "exp", "iat", "iss", "jti", "mode"]);
  assertEquals(c.mode, "login"); assertEquals(c.email, "master@proview.test");
});

Deno.test("licence admin + business: signed biz claim", async () => {
  for (const app of ["signage", "bookings", "employee", "label", "qrmenu", "wifi"]) {
    const r = await call({ action: "go", app, business: "b-123" });
    assertEquals(r.status, 200, app);
    const { ok, c } = await claims(r.body.url);
    assert(ok, app + " signature verifies");
    assertEquals(c.biz, "b-123"); assertEquals(c.aud, app); assertEquals(c.mode, "login");
    assert(c.exp - c.iat <= 120);
  }
  // numeric ids are stringified; `biz` works as an alias
  const n = await call({ action: "go", app: "bookings", biz: 42 });
  assertEquals((await claims(n.body.url)).c.biz, "42");
  // the "check" assertion sent to the app never carries biz
  const checks = seen.filter((x) => /sso-login|sso\/check/.test(x.url)).map((x) => x.body as { assertion: string });
  for (const x of checks) assert(!("biz" in JSON.parse(new TextDecoder().decode(unb64u(x.assertion.split(".")[0])))));
});

Deno.test("non-admin with business: refused, nothing signed", async () => {
  const n0 = seen.length;
  const r = await call({ action: "go", app: "signage", business: "b-123" }, "owner-jwt");
  assertEquals(r.status, 403);
  assert(!r.body.url);
  assert(!seen.slice(n0).some((x) => /sso-login/.test(x.url)), "no app was asked");
  // the same person without business still works as today
  const ok = await call({ action: "go", app: "signage" }, "owner-jwt");
  assertEquals(ok.status, 200); assert(!("biz" in (await claims(ok.body.url)).c));
});

Deno.test("bad business values refused", async () => {
  assertEquals((await call({ action: "go", app: "signage", business: "x".repeat(201) })).status, 400);
  assertEquals((await call({ action: "go", app: "signage", business: { a: 1 } })).status, 400);
  assertEquals((await call({ action: "go", app: "signage", business: "   " })).status, 400);
  // empty string = no business (unchanged behaviour)
  const r = await call({ action: "go", app: "signage", business: "" });
  assertEquals(r.status, 200); assert(!("biz" in (await claims(r.body.url)).c));
});

Deno.test("not signed in: 401", async () => {
  assertEquals((await call({ action: "go", app: "signage", business: "b" }, "nobody")).status, 401);
});

addEventListener("unload", () => { globalThis.fetch = realFetch; });
