// Proview account → app sign-in ("one Proview account").
//
// The signed-in Proview account (Supabase Auth on this project) asks for a short-lived,
// Ed25519-signed assertion "this person controls <email>", addressed to one app. The app
// verifies it with the public key and signs that same email in with its own login system,
// but only if that email is an owner/manager there (staff keep their own logins).
//
//   POST { action: "go", app, return? }  → { url }    open this URL to arrive signed in
//   POST { action: "apps" }              → { apps: [{ app, name, url, ok, reason }] }
//
// Ed25519 private key: hub_private.sso_keys (or the SSO_PRIVATE_JWK secret). Apps hold only the public key.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const APPS: Record<string, { name: string; home: string; origins: string[]; land: string; check: string }> = {
  bookings: {
    name: "Proview Bookings", home: "https://bookings.proviewcrm.co.uk/",
    origins: ["https://bookings.proviewcrm.co.uk"], land: "",
    check: "https://bgsimnrmlzsrfkjpntvj.supabase.co/functions/v1/sso-login",
  },
  employee: {
    name: "Proview Employee", home: "https://employee.proviewcrm.co.uk/",
    origins: ["https://employee.proviewcrm.co.uk"], land: "",
    check: "https://xcuxrcvebbtmhttruulz.supabase.co/functions/v1/sso-login",
  },
  signage: {
    name: "Proview Signage", home: "https://app.proviewsignage.co.uk/",
    origins: ["https://app.proviewsignage.co.uk", "https://proview92.github.io"], land: "",
    check: "https://zbuyafrdhbgqyaepiajm.supabase.co/functions/v1/sso-login",
  },
  label: {
    name: "Proview Label", home: "https://label.proviewcrm.co.uk/",
    origins: ["https://label.proviewcrm.co.uk", "https://proview92.github.io"], land: "",
    check: "https://fiqoirnlmhjzicvktdwa.supabase.co/functions/v1/sso-login",
  },
  qrmenu: {
    name: "Proview QR Menu", home: "https://qrmenu.proviewcrm.co.uk/",
    origins: ["https://qrmenu.proviewcrm.co.uk", "https://proview92.github.io"], land: "",
    check: "https://yblafwttmqaqvfvedaoc.supabase.co/functions/v1/sso-login",
  },
  wifi: {
    name: "Proview WiFi", home: "https://wifi.proviewcrm.co.uk/customer",
    origins: ["https://wifi.proviewcrm.co.uk"], land: "https://wifi.proviewcrm.co.uk/customer/sso",
    check: "https://wifi.proviewcrm.co.uk/customer/sso/check",
  },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let KEY: CryptoKey | null = null;
async function key() {
  if (KEY) return KEY;
  // Private key: SSO_PRIVATE_JWK secret if set, else hub_private.sso_keys (readable only by the service role).
  let jwk = Deno.env.get("SSO_PRIVATE_JWK") ? JSON.parse(Deno.env.get("SSO_PRIVATE_JWK")!) : null;
  if (!jwk) {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data, error } = await admin.rpc("sso_private_key");
    if (error || !data) throw new Error("Signing key missing");
    jwk = data;
  }
  KEY = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return KEY;
}
async function assertion(email: string, app: string, mode: "login" | "check") {
  const now = Math.floor(Date.now() / 1000);
  const p = new TextEncoder().encode(JSON.stringify({ iss: "proview-account", aud: app, email, mode, iat: now, exp: now + 120, jti: crypto.randomUUID() }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await key(), p));
  return b64u(p) + "." + b64u(sig);
}

// Where to land in the app: its "return" address if it's on that app's own site, else its home page.
function landing(app: string, ret?: string) {
  const a = APPS[app];
  if (a.land) return a.land;
  try {
    const u = new URL(String(ret || ""));
    if (a.origins.includes(u.origin)) { u.hash = ""; return u.toString(); }
  } catch { /* fall through */ }
  return a.home;
}

async function check(app: string, email: string) {
  try {
    const r = await fetch(APPS[app].check, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: await assertion(email, app, "check") }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, reason: j.reason || (r.ok ? "" : "Couldn’t reach this app") };
  } catch {
    return { ok: false, reason: "Couldn’t reach this app" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!user?.email) return json({ error: "Please sign in to your Proview account." }, 401);
  if (!user.email_confirmed_at) return json({ error: "Confirm your email address first (check your inbox)." }, 403);
  const email = user.email.toLowerCase();

  const body = await req.json().catch(() => ({}));
  if (body.action === "apps") {
    const apps = await Promise.all(Object.entries(APPS).map(async ([id, a]) => ({ app: id, name: a.name, url: a.home, ...(await check(id, email)) })));
    return json({ email, apps });
  }
  if (body.action === "go") {
    const app = String(body.app || "");
    if (!APPS[app]) return json({ error: "Unknown app" }, 400);
    const c = await check(app, email);
    if (!c.ok) return json({ error: `${APPS[app].name}: ${c.reason || "no account for this email."}` }, 403);
    return json({ url: landing(app, body.return) + "#pv_sso=" + await assertion(email, app, "login") });
  }
  return json({ error: "Unknown action" }, 400);
});
