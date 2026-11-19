// Licence portal: Proview dashboard accounts (owner, 19 Nov 2026). The business page's "Proview dashboard" line, the
// dashboard chip on every app's Users panel, "Send dashboard invite" (only for ❌ / ⏳, never for staff), its toasts, and
// the automatic invite of "+ Add user", New business and Add to app. Headless Chrome with a mocked Supabase and licence-hub.
// Usage: node supabase/tests/portal_dashboard_invite_ui.test.js (screenshots go to the temp folder).
const puppeteer = require('/opt/npm-tools/node_modules/puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '../..'), PORT = 8771, BASE = `http://127.0.0.1:${PORT}/`;
const UID = '11111111-1111-1111-1111-111111111111', EMAIL = 'altun@proviewtech.co.uk';
const results = []; const ok = (n, c) => results.push((c ? 'PASS ' : 'FAIL ') + n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, s) => { const f = path.join(ROOT, decodeURIComponent(new URL(q.url, BASE).pathname)); fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'text/plain' }); s.end(b); }); }).listen(PORT);
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600, b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, email: EMAIL, role: 'authenticated', exp }) + '.x';
  return { access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: UID, email: EMAIL, app_metadata: {}, user_metadata: {}, aud: 'authenticated' } };
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const L = (product, ext_id, account_ext_id, name) => ({ product, kind: 'location', ext_id, account_ext_id, name, license_type: 'm12', expires_at: iso(200), gone: false, extra: {} });
const DB = {
  lic_customers: [{ id: 'cb', name: 'BRAGS AND BRAMS', contact_email: 'babnewington@gmail.com', created_at: iso(-3) }, { id: 'cq', name: 'Quiet Cafe', contact_email: 'q@x.test', created_at: iso(-5) }],
  lic_accounts: [{ product: 'signage', ext_id: 'sg1', name: 'BRAGS AND BRAMS', customer_id: 'cb', gone: false, extra: {} },
                 { product: 'team', ext_id: 'tm1', name: 'BRAGS AND BRAMS', customer_id: 'cb', gone: false, extra: {} },
                 { product: 'reservations', ext_id: 'rv1', name: 'BRAGS AND BRAMS', customer_id: 'cb', gone: false, extra: {} },
                 { product: 'bookings', ext_id: 'bk1', name: 'BRAGS AND BRAMS', customer_id: 'cb', gone: false, extra: {} }],   // on hold: hidden
  lic_units: [L('signage', 'loc/1', 'sg1', 'BRAGS AND BRAMS'), L('team', 't1', 'tm1', 'BRAGS AND BRAMS'), L('reservations', 'r1', 'rv1', 'BRAGS AND BRAMS'), L('bookings', 'b1', 'bk1', 'BRAGS AND BRAMS')],
  lic_link_origins: [], lic_plans: [], lic_payments: [], lic_audit: [],
};
const ROLES = {
  signage: [{ value: 'manager', label: 'Owner / Admin' }, { value: 'site_manager', label: 'Location manager' }, { value: 'editor', label: 'Editor' }],
  team: [{ value: 'Owner', label: 'Owner' }, { value: 'Admin', label: 'Admin' }, { value: 'Manager', label: 'Manager' }, { value: 'Staff', label: 'Staff' }],
  reservations: [{ value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }, { value: 'manager', label: 'Manager' }, { value: 'staff', label: 'Staff' }],
  bookings: [{ value: 'owner', label: 'Owner' }],
};
const usr = (email, role, name = '') => ({ email, role, name, has_login: true, last_sign_in: iso(-1) });
const USERS = {
  sg1: [usr('babnewington@gmail.com', 'manager', 'Bab Newington'), usr('editor@x.test', 'editor', 'Ed')],
  tm1: [usr('BabNewington@gmail.com', 'Owner', 'Bab Newington'), usr('mgr@x.test', 'Manager', 'Meg'), usr('staff@x.test', 'Staff', 'Sam'), usr('fail@x.test', 'Admin', 'Faye')],
  rv1: [usr('babnewington@gmail.com', 'owner', 'Bab Newington'), usr('active@x.test', 'admin', 'Ava')],
  bk1: [usr('held@x.test', 'owner')],
};
// Proview accounts (auth.users) as lic_dashboard_accounts reports them
const ACC = { 'mgr@x.test': 'invited', 'active@x.test': 'active', 'fail@x.test': 'invited', 'q@x.test': 'active' };
const statusRow = (e) => { const s = ACC[e] || 'none'; return { email: e, state: s, created_at: s === 'none' ? null : iso(-2), email_confirmed_at: s === 'active' ? iso(-2) : null, invited_at: s === 'invited' ? iso(-2) : null, last_sign_in_at: s === 'active' ? iso(-1) : null }; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errs = [], hubCalls = [], rpcCalls = [], authCalls = [];
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => { errs.push('native dialog: ' + d.message()); d.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) || u.includes('cdn.jsdelivr.net')) return r.continue();
    if (u.includes('esm.sh/@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: "export * from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';" });
    const j = (b, s = 200) => r.respond({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: JSON.stringify(b) });
    if (r.method() === 'OPTIONS') return j({});
    if (u.includes('/auth/v1/recover') || u.includes('/auth/v1/invite')) { authCalls.push(u); return j({}); }
    if (u.includes('/auth/v1/user')) return j(session().user);
    if (u.includes('/rpc/is_lic_admin')) return j(true);
    if (u.includes('/rpc/lic_dashboard_accounts')) { const b = JSON.parse(r.postData() || '{}'); rpcCalls.push(b.p_emails); return j(b.p_emails.map(statusRow)); }
    if (u.includes('/rpc/lic_add_customer')) { const b = JSON.parse(r.postData()); ACC[b.p_email] = 'invited'; return j({ customer_id: 'cnew', user_id: 'u', email: b.p_email, existing: false }); }
    if (u.includes('/functions/v1/')) {
      const b = JSON.parse(r.postData() || '{}'); hubCalls.push(b);
      if (b.action === 'users') {
        if (b.op === 'list') return j({ users: USERS[b.account] || [], roles: ROLES[b.product] || [] });
        if (b.op === 'add') { USERS[b.account].push(usr(b.email, b.role, b.name)); return j({ ok: true }); }
        return j({ ok: true });
      }
      if (b.action === 'dashboard_invite') {
        if (/^(fail|boom)@/.test(b.email)) return j({ error: "The dashboard invite couldn't be sent: Error sending invite email" }, 400);
        const was = ACC[b.email] || 'none';
        if (was === 'active' || (b.only_if_missing && was !== 'none')) return j({ ok: true, email: b.email, state: was, sent: null });
        ACC[b.email] = 'invited'; return j({ ok: true, email: b.email, state: was, sent: was === 'none' ? 'invite' : 'recovery' });
      }
      if (b.action === 'create_business') return j({ ok: true, results: Object.fromEntries((b.apps || []).map((k) => [k, { ok: true, account_id: 'new-' + k }])) });
      return j({ ok: true, apps: {} });
    }
    const m = u.match(/\/rest\/v1\/(\w+)/); if (m && DB[m[1]]) return j(DB[m[1]]);
    if (u.includes('/rest/v1/')) return j([]);
    return j({});
  });
  await page.goto(BASE + 'README.md', { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('sb-bpssjfrinjlrnkzhytfr-auth-token', JSON.stringify(s)); }, session());
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(1000);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toast > div')].map((d) => ({ t: d.textContent, err: d.className === 'err' })));
  const clearToasts = () => page.evaluate(() => { document.querySelectorAll('#toast > div').forEach((d) => d.remove()); });
  const line = () => page.evaluate(() => [...document.querySelectorAll('[data-dashline] .dl-row')].map((r) => ({ email: r.dataset.dashrow, from: r.querySelector('small')?.textContent, chip: r.querySelector('[data-dashchip]')?.dataset.dashchip, chipText: r.querySelector('[data-dashchip]')?.textContent, btn: !!r.querySelector('[data-dashinv]') })));

  // ---------- business page ----------
  await page.evaluate(() => document.querySelector('[data-open="cb"]')?.click() || document.querySelector('[data-cust="cb"]')?.click()); await wait(900);
  const head = await page.evaluate(() => document.querySelector('[data-dashline] .dl-h b')?.textContent);
  ok('business page has a "Proview dashboard" line', head === 'Proview dashboard');
  const L1 = await line();
  const by = Object.fromEntries(L1.map((x) => [x.email, x]));
  ok('owner emails: contact email + every owner/admin/manager login, deduplicated ' + JSON.stringify(L1.map((x) => x.email)),
    L1.length === 4 && ['babnewington@gmail.com', 'mgr@x.test', 'fail@x.test', 'active@x.test'].every((e) => by[e]));
  ok('one row for babnewington from contact email + Signage + Team + Reservations: ' + by['babnewington@gmail.com']?.from,
    /Contact email/.test(by['babnewington@gmail.com']?.from) && /Signage Owner \/ Admin/.test(by['babnewington@gmail.com']?.from) && /Team Owner/.test(by['babnewington@gmail.com']?.from) && /Reservations Owner/.test(by['babnewington@gmail.com']?.from));
  ok('staff and editor logins are not owner emails', !by['staff@x.test'] && !by['editor@x.test']);
  ok('on-hold Bookings: its logins are not read or listed', !by['held@x.test'] && !hubCalls.some((c) => c.action === 'users' && c.product === 'bookings'));
  ok('states: none ❌ / invited ⏳ / active ✅ ' + JSON.stringify(L1.map((x) => x.chipText)),
    by['babnewington@gmail.com']?.chip === 'none' && /❌/.test(by['babnewington@gmail.com']?.chipText) && by['mgr@x.test']?.chip === 'invited' && /⏳/.test(by['mgr@x.test']?.chipText) && by['active@x.test']?.chip === 'active' && /✅/.test(by['active@x.test']?.chipText));
  ok('Send dashboard invite next to ❌ and ⏳, not next to ✅', by['babnewington@gmail.com'].btn && by['mgr@x.test'].btn && !by['active@x.test'].btn);
  const lastSign = await page.evaluate(() => document.querySelector('[data-dashrow="active@x.test"] [data-dashchip]')?.title);
  ok('✅ shows the last sign-in ' + lastSign, /last signed in/i.test(lastSign || ''));
  ok('statuses read with lic_dashboard_accounts (one call for the business) ' + JSON.stringify(rpcCalls), rpcCalls.length >= 1 && rpcCalls[0].includes('babnewington@gmail.com'));
  await page.screenshot({ path: path.join(os.tmpdir(), 'dash-invite-business.png'), fullPage: true });

  // send: success
  await clearToasts(); hubCalls.length = 0;
  await page.click('[data-dashrow="babnewington@gmail.com"] [data-dashinv]'); await wait(700);
  const inv = hubCalls.find((c) => c.action === 'dashboard_invite');
  ok('Send dashboard invite calls the licence hub ' + JSON.stringify(inv), inv && inv.email === 'babnewington@gmail.com' && inv.name === 'Bab Newington' && inv.account_name === 'BRAGS AND BRAMS' && !inv.only_if_missing);
  let T = await toasts();
  ok('success toast ' + JSON.stringify(T), T.some((x) => !x.err && x.t === 'Dashboard invite sent to babnewington@gmail.com'));
  const L2 = Object.fromEntries((await line()).map((x) => [x.email, x]));
  ok('after sending, babnewington shows ⏳ invited (button stays to re-send)', L2['babnewington@gmail.com']?.chip === 'invited' && L2['babnewington@gmail.com']?.btn);
  ok('no Supabase auth email sent from the browser', !authCalls.length);
  // send: failure shows the real error text
  await clearToasts();
  await page.click('[data-dashrow="fail@x.test"] [data-dashinv]'); await wait(700);
  T = await toasts();
  ok('error toast with the real error text ' + JSON.stringify(T), T.some((x) => x.err && x.t === "The dashboard invite couldn't be sent: Error sending invite email"));
  ok('after a failure the button can be pressed again', await page.evaluate(() => { const b = document.querySelector('[data-dashrow="fail@x.test"] [data-dashinv]'); return !!b && !b.disabled && b.textContent === 'Send dashboard invite'; }));

  // ---------- Users panel (Team) ----------
  await page.click('[data-users="team|tm1"]'); await wait(900);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#usersDlg .ud-row')].map((r) => ({ t: r.querySelector('.ud-n').textContent.replace(/\s+/g, ' '), chip: r.querySelector('[data-dashchip]')?.dataset.dashchip, btn: r.querySelector('[data-dashinv]')?.dataset.dashinv || null })));
  let R = await rows();
  const rowOf = (e) => R.find((x) => x.t.toLowerCase().includes(e));
  ok('Users panel: every login has a dashboard chip ' + JSON.stringify(R.map((x) => x.chip)), R.length === 4 && R.every((x) => x.chip && x.chip !== 'unknown'));
  ok('Users panel: owner ⏳ (just invited) and manager ⏳ have Send dashboard invite', rowOf('babnewington')?.chip === 'invited' && rowOf('babnewington')?.btn === 'babnewington@gmail.com' && rowOf('mgr@x.test')?.btn === 'mgr@x.test');
  ok('Users panel: staff login gets a chip but never an invite button', rowOf('staff@x.test')?.chip === 'none' && !rowOf('staff@x.test')?.btn);
  await page.screenshot({ path: path.join(os.tmpdir(), 'dash-invite-users.png') });
  // Reservations panel: active admin has no button
  await page.evaluate(() => document.querySelector('#usersDlg [data-udx]').click()); await wait(200);
  await page.click('[data-users="reservations|rv1"]'); await wait(900);
  R = await rows();
  ok('Users panel (Reservations): active admin shows ✅ and no button', rowOf('active@x.test')?.chip === 'active' && !rowOf('active@x.test')?.btn);
  // send from the Users panel
  await clearToasts(); hubCalls.length = 0;
  await page.evaluate(() => document.querySelector('#usersDlg [data-dashinv="babnewington@gmail.com"]').click()); await wait(700);
  T = await toasts();
  ok('Users panel: Send dashboard invite re-sends to an ⏳ account ' + JSON.stringify(T), hubCalls.some((c) => c.action === 'dashboard_invite' && c.email === 'babnewington@gmail.com') && T.some((x) => !x.err && /Dashboard invite sent to babnewington@gmail.com/.test(x.t)));
  await page.evaluate(() => document.querySelector('#usersDlg [data-udx]').click()); await wait(200);

  // ---------- + Add user: automatic invite for owner/admin/manager, none for staff ----------
  await page.click('[data-users="team|tm1"]'); await wait(800);
  const addUser = async (name, email, role) => {
    await page.evaluate(() => document.querySelector('#usersDlg [data-udadd]').click()); await wait(200);
    await page.evaluate((name, email, role) => { const f = document.querySelector('#usersDlg [data-udform="add"]'); f.querySelector('[name=name]').value = name; f.querySelector('[name=email]').value = email; f.querySelector('[name=role]').value = role; }, name, email, role);
    await clearToasts(); hubCalls.length = 0;
    await page.evaluate(() => document.querySelector('#usersDlg [data-udform="add"] button.primary').click()); await wait(1000);
  };
  await addUser('Nia New', 'nia@x.test', 'Manager');
  let di = hubCalls.find((c) => c.action === 'dashboard_invite');
  T = await toasts();
  ok('Add user (Manager): adds, then sends the dashboard invite only if missing ' + JSON.stringify(di), hubCalls[0]?.action === 'users' && hubCalls[0]?.op === 'add' && di && di.email === 'nia@x.test' && di.only_if_missing === true && di.name === 'Nia New');
  ok('Add user (Manager): toast says the invite went ' + JSON.stringify(T), T.some((x) => !x.err && x.t === 'nia@x.test added. Dashboard invite sent.'));
  R = await rows();
  ok('Add user: the new login shows ⏳ after the list reloads', rowOf('nia@x.test')?.chip === 'invited');
  await addUser('Stan Staff', 'stan@x.test', 'Staff');
  T = await toasts();
  ok('Add user (Staff): no dashboard invite ' + JSON.stringify(hubCalls.map((c) => c.action + ':' + (c.op || ''))), hubCalls.some((c) => c.op === 'add') && !hubCalls.some((c) => c.action === 'dashboard_invite') && T.some((x) => x.t === 'stan@x.test added.'));
  await addUser('Act Ive', 'active@x.test', 'Admin');
  T = await toasts();
  ok('Add user (Admin) with an existing Proview account: no "invite sent" ' + JSON.stringify(T), T.some((x) => x.t === 'active@x.test added.'));
  await addUser('Bo Om', 'boom@x.test', 'Owner');
  T = await toasts();
  ok('Add user: the login is added but a failed invite shows its real error ' + JSON.stringify(T), T.some((x) => x.err && x.t === "boom@x.test added. The dashboard invite couldn't be sent: Error sending invite email"));
  await page.evaluate(() => document.querySelector('#usersDlg [data-udx]').click()); await wait(200);

  // ---------- New business: the invite goes through the same licence-hub path ----------
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(800);
  hubCalls.length = 0; authCalls.length = 0; await clearToasts();
  await page.click('#newCustBtn'); await wait(300);
  await page.evaluate(() => {
    const set = (id, v) => { const i = document.getElementById(id); i.value = v; };
    set('pvAbBiz', 'Fresh Bakery'); set('pvAbName', 'Fay Baker'); set('pvAbEmail', 'fay@x.test');
    const c = document.querySelector('input[name="pvAbC_apps"][value="signage"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => document.getElementById('pvAbGo').click()); await wait(1200);
  di = hubCalls.find((c) => c.action === 'dashboard_invite');
  ok('New business (invite): one dashboard_invite from the licence hub, no browser reset email ' + JSON.stringify(di), di && di.email === 'fay@x.test' && di.name === 'Fay Baker' && !di.only_if_missing && !authCalls.length);
  const done = await page.evaluate(() => document.getElementById('ncDoneBody')?.textContent || '');
  ok('New business result says the invite was sent ' + done.slice(0, 80), /Invite sent to fay@x.test/.test(done));

  // ---------- Add to app: the owner gets a dashboard invite only when the email has no Proview account ----------
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(800);
  const addToApp = async (email) => {
    hubCalls.length = 0; await clearToasts();
    await page.evaluate(() => document.querySelector('[data-addapp="cq|signage"]').click()); await wait(500);
    await page.evaluate((email) => { document.getElementById('aaName').value = 'Quinn Owner'; document.getElementById('aaEmail').value = email; document.getElementById('aaGo').click(); }, email);
    await wait(1200);
  };
  await addToApp('quinn@x.test');
  di = hubCalls.find((c) => c.action === 'dashboard_invite');
  T = await toasts();
  ok('Add to app: new owner email gets the dashboard invite (only if missing) ' + JSON.stringify(di) + JSON.stringify(T), di && di.email === 'quinn@x.test' && di.only_if_missing === true && T.some((x) => /Dashboard invite sent to quinn@x.test/.test(x.t)));
  await addToApp('q@x.test');
  T = await toasts();
  ok('Add to app: owner already on the dashboard: no invite sent ' + JSON.stringify(T), hubCalls.some((c) => c.action === 'dashboard_invite') && !T.some((x) => /Dashboard invite sent/.test(x.t)) && T.some((x) => /Quiet Cafe added to Signage/.test(x.t)));

  // ---------- phone width: the business page's dashboard line fits ----------
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(800);
  await page.evaluate(() => document.querySelector('[data-open="cb"]')?.click()); await wait(1200);
  const fit = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-dashline] .dl-row').length, over: document.documentElement.scrollWidth - window.innerWidth }));
  ok('390px: dashboard line shown, no horizontal overflow ' + JSON.stringify(fit), fit.rows >= 4 && fit.over <= 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'dash-invite-390.png'), fullPage: true });

  ok('no page errors ' + JSON.stringify(errs), !errs.length);
  console.log(results.join('\n'));
  const f = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - f} PASS, ${f} FAIL`);
  await browser.close(); srv.close(); process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
