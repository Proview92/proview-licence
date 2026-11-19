// New location with "3-day trial": Proview WiFi never starts one (NO_TRIAL_SPEC.md; owner 19 Nov 2026).
//   deno run -A supabase/tests/licence-hub_no_wifi_trial.test.ts
Deno.env.set("SUPABASE_URL", "http://portal.mock"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service"); Deno.env.set("SUPABASE_ANON_KEY", "anon");
const { trialCall, NO_TRIAL_APPS } = await import("../functions/licence-hub/index.ts");
const out: string[] = []; const ok = (c: unknown, m: string) => out.push((c ? "PASS " : "FAIL ") + m);
const r = { site_id: "s-1", account_id: "a-1" };
ok(trialCall("wifi", r) === null, "WiFi: no trial call");
ok(NO_TRIAL_APPS.has("wifi") && NO_TRIAL_APPS.size === 1, "only WiFi is a no-trial app");
ok(JSON.stringify(trialCall("bookings", r)) === JSON.stringify(["set", { unit: "s-1", kind: "location", type: "trial", extend: false, expires: null, notes: "3-day trial chosen in the licence portal's New customer" }]), "Bookings unchanged");
ok(trialCall("qrmenu", r)?.[1].type === "trial3" && trialCall("signage", r)?.[0] === "trial", "QR Menu / Signage unchanged");
const html = await Deno.readTextFile(new URL("../../index.html", import.meta.url));
ok(/wifi:\s*\{[^}]*app: "https:\/\/wifi\.proviewcrm\.co\.uk\/app\/", trial: null/.test(html), "portal UI: WiFi app link /app/, no trial plan");
console.log(out.join("\n")); const f = out.filter((x) => x.startsWith("FAIL")).length;
console.log(`${out.length - f} passed, ${f} failed`); Deno.exit(f ? 1 : 0);
