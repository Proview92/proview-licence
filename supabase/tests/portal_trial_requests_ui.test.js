// Licence portal: trial requests from the Proview dashboard (owner, 19 Nov 2026). The "Trial requests" page (email, app,
// note, date, status, Mark done / Decline, link to the business with that email, New / Done / Declined / All), its count
// in the menu, the Inbox items with Mark done / Decline, ON_HOLD apps left out, and the page at 390px.
// Headless Chrome with a mocked Supabase. Usage: node supabase/tests/portal_trial_requests_ui.test.js
const puppeteer = require('/opt/npm-tools/node_modules/puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '../..'), PORT = 8774, BASE = `http://127.0.0.1:${PORT}/`;
const UID = '11111111-1111-1111-1111-111111111111', EMAIL = 'altun@proviewtech.co.uk';
const results = []; const ok = (n, c) => results.push((c ? 'PASS ' : 'FAIL ') + n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, s) => { const f = path.join(ROOT, decodeURIComponent(new URL(q.url, BASE).pathname)); fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' }); s.end(b); }); }).listen(PORT);
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600, b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, email: EMAIL, role: 'authenticated', exp }) + '.x';
  return { access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: UID, email: EMAIL, app_metadata: {}, user_metadata: {}, aud: 'authenticated' } };
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const L = (product, ext_id, account_ext_id, name) => ({ product, kind: 'location', ext_id, account_ext_id, name, license_type: 'm12', expires_at: iso(200), gone: false, extra: {} });
const TR = (id, email, app, status, d, business = null, note = null) => ({ id, email, app, business, note, status, created_at: iso(d), handled_at: status === 'new' ? null : iso(d + 0.5), handled_by: status === 'new' ? null : EMAIL, user_id: 'u', notified_at: null });
const DB = {
  lic_customers: [{ id: 'cb', name: 'BRAGS AND BRAMS', contact_email: 'babnewington@gmail.com', created_at: iso(-3) },
                  { id: 'cq', name: 'Quiet Cafe', contact_email: 'q@x.test', owner_email: 'Owner@Quiet.test', created_at: iso(-5) }],
  lic_accounts: [{ product: 'signage', ext_id: 'sg1', name: 'BRAGS AND BRAMS', customer_id: 'cb', gone: false, extra: {} },
                 { product: 'team', ext_id: 'tm1', name: 'Quiet Cafe', contact_email: 'manager@quiet.test', customer_id: 'cq', gone: false, extra: {} }],
  lic_units: [L('signage', 'loc/1', 'sg1', 'BRAGS AND BRAMS'), L('team', 't1', 'tm1', 'Quiet Cafe')],
  lic_link_origins: [], lic_plans: [], lic_payments: [], lic_audit: [],
  lic_trial_requests: [
    TR('t1', 'babnewington@gmail.com', 'label', 'new', -0.2, 'Brags Cafe', 'Two handhelds please'),
    TR('t2', 'owner@quiet.test', 'wifi', 'new', -1),                     // matches Quiet Cafe by owner email
    TR('t3', 'manager@quiet.test', 'qrmenu', 'new', -2, null, 'menu for 2 sites'),   // matches by an app account's contact email
    TR('t4', 'stranger@x.test', 'signage', 'new', -3),                    // no business
    TR('t5', 'old@x.test', 'team', 'done', -9),
    TR('t6', 'nope@x.test', 'reservations', 'declined', -10),
    TR('t7', 'held@x.test', 'bookings', 'new', -0.1),                     // ON_HOLD: never shown
    TR('t8', 'held2@x.test', 'employee', 'new', -0.1),
  ],
};
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errs = [], patches = [];
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
    if (u.includes('/auth/v1/user')) return j(session().user);
    if (u.includes('/rpc/is_lic_admin')) return j(true);
    if (u.includes('/rpc/lic_dashboard_accounts')) { const b = JSON.parse(r.postData() || '{}'); return j((b.p_emails || []).map((e) => ({ email: e, state: 'none' }))); }
    if (u.includes('/functions/v1/')) return j({ ok: true, apps: {} });
    if (u.includes('/rest/v1/lic_trial_requests') && r.method() === 'PATCH') {
      const id = (new URL(u).searchParams.get('id') || '').replace(/^eq\./, ''), b = JSON.parse(r.postData() || '{}'); patches.push({ id, ...b });
      const row = DB.lic_trial_requests.find((x) => x.id === id); Object.assign(row, { status: b.status, handled_at: new Date().toISOString(), handled_by: EMAIL });
      return j(row);
    }
    const m = u.match(/\/rest\/v1\/(\w+)/); if (m && DB[m[1]]) return j(DB[m[1]]);
    if (u.includes('/rest/v1/')) return j([]);
    return j({});
  });
  await page.goto(BASE + 'README.md', { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('sb-bpssjfrinjlrnkzhytfr-auth-token', JSON.stringify(s)); }, session());
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(1200);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toast > div')].map((d) => ({ t: d.textContent, err: d.className === 'err' })));
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#trList tbody tr')].map((tr) => ({ id: tr.dataset.trial, cells: [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()), biz: tr.querySelector('[data-trbiz]')?.dataset.trbiz || null, btns: [...tr.querySelectorAll('[data-trset]')].map((b) => b.textContent) })));

  // ---------- menu ----------
  const nav = await page.evaluate(() => { const a = document.querySelector('.side .nav a[data-tab="trials"]'); return a && { t: a.textContent.replace(/\s+/g, ' ').trim(), cnt: a.querySelector('#trialCnt')?.textContent, hidden: a.querySelector('#trialCnt')?.hidden }; });
  ok('"Trial requests" in the menu with the number of new ones (ON_HOLD left out) ' + JSON.stringify(nav), nav && /Trial/.test(nav.t) && nav.cnt === '4' && nav.hidden === false);

  // ---------- the list ----------
  await page.click('.side .nav a[data-tab="trials"]'); await wait(700);
  ok('page title "Trial requests"', (await page.evaluate(() => document.getElementById('pageTitle').textContent)) === 'Trial requests');
  const heads = await page.evaluate(() => [...document.querySelectorAll('#trList thead th')].map((th) => th.textContent));
  ok('columns: when, email, app, note, business, status ' + JSON.stringify(heads), JSON.stringify(heads) === JSON.stringify(['Asked', 'Email', 'App', 'Note', 'Business', 'Status', '']));
  let R = await rows();
  ok('New filter: the 4 new requests, newest first ' + JSON.stringify(R.map((r) => r.id)), JSON.stringify(R.map((r) => r.id)) === JSON.stringify(['t1', 't2', 't3', 't4']));
  ok('ON_HOLD: Bookings / Employee requests are never shown', !R.some((r) => /Bookings|Employee|held@|held2@/.test(r.cells.join(' '))));
  const r1 = R[0];
  ok('row shows email, app, business name + note, date, status ' + JSON.stringify(r1.cells), r1.cells[1] === 'babnewington@gmail.com' && r1.cells[2] === 'Proview Label' && /Brags Cafe/.test(r1.cells[3]) && /Two handhelds please/.test(r1.cells[3]) && /\d/.test(r1.cells[0]) && r1.cells[5] === 'New');
  ok('Mark done / Decline on new requests', JSON.stringify(r1.btns) === JSON.stringify(['Mark done', 'Decline']));
  ok('business link by contact email ' + R[0].biz + ' / owner email ' + R[1].biz + ' / an app account’s email ' + R[2].biz, R[0].biz === 'cb' && R[1].biz === 'cq' && R[2].biz === 'cq' && R[0].cells[4] === 'BRAGS AND BRAMS' && R[1].cells[4] === 'Quiet Cafe');
  ok('no business: says so ' + R[3].cells[4], R[3].biz === null && R[3].cells[4] === 'No business with this email');
  await page.screenshot({ path: path.join(os.tmpdir(), 'portal-trials.png'), fullPage: true });

  // ---------- Mark done / Decline ----------
  await page.click('tr[data-trial="t1"] [data-trset="done"]'); await wait(700);
  ok('Mark done updates only the status ' + JSON.stringify(patches), patches.length === 1 && patches[0].id === 't1' && patches[0].status === 'done' && Object.keys(patches[0]).length === 2);
  R = await rows();
  ok('done request leaves the New list, count goes down', !R.some((r) => r.id === 't1') && (await page.evaluate(() => document.getElementById('trialCnt').textContent)) === '3');
  ok('toast "Trial request marked done"', (await toasts()).some((t) => !t.err && t.t === 'Trial request marked done'));
  await page.click('tr[data-trial="t4"] [data-trset="declined"]'); await wait(700);
  ok('Decline ' + JSON.stringify(patches[1]), patches[1]?.id === 't4' && patches[1]?.status === 'declined' && (await page.evaluate(() => document.getElementById('trialCnt').textContent)) === '2');
  await page.select('#trFilter', 'all'); await wait(300);
  R = await rows();
  ok('All: every request but the on-hold ones (6) ' + R.length, R.length === 6);
  const st = Object.fromEntries(R.map((r) => [r.id, r.cells[5]]));
  ok('statuses shown: New / Done / Declined with the date handled ' + JSON.stringify(st), /^New$/.test(st.t2) && /^Done/.test(st.t1) && /^Declined/.test(st.t4) && /^Done/.test(st.t5) && /^Declined/.test(st.t6));
  ok('handled requests can be reopened', JSON.stringify(R.find((r) => r.id === 't5').btns) === JSON.stringify(['Reopen']));
  await page.select('#trFilter', 'declined'); await wait(200);
  ok('Declined filter ' + JSON.stringify((await rows()).map((r) => r.id)), JSON.stringify((await rows()).map((r) => r.id).sort()) === JSON.stringify(['t4', 't6']));
  await page.select('#trFilter', 'new'); await wait(200);

  // business link opens the business
  await page.click('tr[data-trial="t2"] [data-trbiz]'); await wait(800);
  ok('business link opens that business', await page.evaluate(() => !document.querySelector('[data-view="customers"]').classList.contains('hidden')) && /Quiet Cafe/.test(await page.evaluate(() => document.querySelector('[data-view="customers"]').textContent)));

  // ---------- Inbox ----------
  const inbox = await page.evaluate(async () => (await window.__pvAll.inbox()).filter((i) => i.key.startsWith('trial:')).map((i) => ({ key: i.key, title: i.title, sub: i.sub, unread: i.unread, acts: i.actions.map((a) => a.label) })));
  ok('Inbox lists each new trial request ' + JSON.stringify(inbox.map((i) => i.title)), inbox.length === 2 && inbox.some((i) => i.title === 'Trial request: Proview WiFi from owner@quiet.test') && inbox.some((i) => i.title === 'Trial request: Proview QR Menu from manager@quiet.test'));
  ok('Inbox item: note and business, unread, Mark done / Decline ' + JSON.stringify(inbox[0]), inbox.every((i) => i.unread && JSON.stringify(i.acts) === JSON.stringify(['Mark done', 'Decline'])) && inbox.some((i) => /menu for 2 sites/.test(i.sub) && /Business: Quiet Cafe/.test(i.sub)));
  ok('Inbox leaves out done / declined / on-hold requests', !inbox.some((i) => /t1|t4|t5|t6|t7|t8/.test(i.key)));
  await page.evaluate(async () => { const it = (await window.__pvAll.inbox()).find((i) => i.key === 'trial:t3'); await it.actions[1].run(); }); await wait(500);
  ok('Decline from the Inbox ' + JSON.stringify(patches[2]), patches[2]?.id === 't3' && patches[2]?.status === 'declined');
  const after = await page.evaluate(async () => (await window.__pvAll.inbox()).filter((i) => i.key.startsWith('trial:')).length);
  ok('then it leaves the Inbox', after === 1);

  // ---------- 390px ----------
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE + 'README.md'); await page.goto(BASE + 'index.html#trials', { waitUntil: 'networkidle0' }); await wait(1500);
  const fit = await page.evaluate(() => ({ shown: !document.querySelector('[data-view="trials"]').classList.contains('hidden'), rows: document.querySelectorAll('#trList tbody tr').length, over: document.documentElement.scrollWidth - window.innerWidth,
    labels: [...document.querySelectorAll('#trList tbody tr:first-child td')].map((td) => td.getAttribute('data-label')) }));
  ok('#trials opens the page (link in the email) and it fits at 390px ' + JSON.stringify(fit), fit.shown && fit.rows === 1 && fit.over <= 0);
  ok('390px: rows become labelled cards ' + JSON.stringify(fit.labels), fit.labels.includes('Email') && fit.labels.includes('Business'));
  await page.screenshot({ path: path.join(os.tmpdir(), 'portal-trials-390.png'), fullPage: true });

  ok('no page errors ' + JSON.stringify(errs), !errs.length);
  console.log(results.join('\n'));
  const f = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - f} PASS, ${f} FAIL`);
  await browser.close(); srv.close(); process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
