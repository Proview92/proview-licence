// Licence portal: Businesses wording (was Locations), linked-business cards, Link / Unlink / Split (LOCATIONS_LINK_SPEC). Headless Chrome with a
// mocked Supabase and licence-hub. Usage: node supabase/tests/portal_locations_ui.test.js (screenshots go to the temp folder).
const puppeteer = require('/opt/npm-tools/node_modules/puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = require('path').resolve(__dirname, '../..'), BASE = 'http://127.0.0.1:8768/';
const UID = '11111111-1111-1111-1111-111111111111', EMAIL = 'altun@proviewtech.co.uk';
const results = []; const ok = (n, c) => results.push((c ? 'PASS ' : 'FAIL ') + n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, s) => { const f = path.join(ROOT, decodeURIComponent(new URL(q.url, BASE).pathname)); fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'text/plain' }); s.end(b); }); }).listen(8768);
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600, b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, email: EMAIL, role: 'authenticated', exp }) + '.x';
  return { access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: UID, email: EMAIL, app_metadata: {}, user_metadata: {}, aud: 'authenticated' } };
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const L = (product, ext_id, account_ext_id, name, origin_id = null) => ({ product, kind: 'location', ext_id, account_ext_id, name, license_type: 'm12', expires_at: iso(200), gone: false, extra: {}, origin_id });
const DB = {
  lic_customers: [{ id: 'ca', name: 'Cafe Alpha', contact_email: 'a@x.test' }, { id: 'cg', name: 'Gamma Grill', contact_email: 'g@x.test' }, { id: 'co', name: 'Old Group', contact_email: 'o@x.test' }],
  lic_accounts: [{ product: 'signage', ext_id: 'sa', name: 'Cafe Alpha', customer_id: 'ca', gone: false, extra: {} }, { product: 'bookings', ext_id: 'ba', name: 'Cafe Alpha', customer_id: 'ca', gone: false, extra: {} },
                 { product: 'label', ext_id: 'lb', name: 'Cafe Beta', customer_id: 'ca', gone: false, extra: {} },
                 { product: 'signage', ext_id: 'sg', name: 'Gamma Grill', customer_id: 'cg', gone: false, extra: {} },
                 { product: 'signage', ext_id: 'so', name: 'Old Group', customer_id: 'co', gone: false, extra: {} }],
  lic_units: [L('signage', 'loc/a', 'sa', 'Cafe Alpha', 'ca'), L('signage', 'loc/b', 'sa', 'Cafe Beta', 'cb'), L('bookings', 'cafe-alpha', 'ba', 'Cafe Alpha', 'ca'), L('label', 'site_b', 'lb', 'Cafe Beta', 'cb'),
              L('signage', 'loc/g', 'sg', 'Gamma Grill'), L('signage', 'loc/o1', 'so', 'Old Group'), L('signage', 'loc/o2', 'so', 'Old Group Soho')],
  lic_link_origins: [{ id: 'ca', name: 'Cafe Alpha' }, { id: 'cb', name: 'Cafe Beta' }],
  lic_plans: [], lic_payments: [], lic_audit: [],
};
const PLAN = [{ customer_id: 'co', customer_name: 'Old Group', businesses: [{ product: 'signage', account: 'so', account_name: 'Old Group', keep: { ext_id: 'loc/o1', name: 'Old Group' }, out: [{ ext_id: 'loc/o2', name: 'Old Group Soho' }] }],
  new_cards: [{ name: 'Old Group Soho', units: [{ product: 'signage', account: 'so', ext_id: 'loc/o2', name: 'Old Group Soho' }] }] }];
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errs = [], hubCalls = [];
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
    if (u.includes('/functions/v1/')) {
      const b = JSON.parse(r.postData() || '{}'); hubCalls.push(b);
      if (b.action === 'split_preview') return j({ ok: true, plan: PLAN });
      if (b.action === 'split') return j({ ok: true, split: [{ ok: true, name: 'Old Group Soho', results: {} }] });
      if (b.action === 'link') return j({ ok: false, customer: b.customer_a, removed_b: false, results: { signage: { ok: true, linked: 1 }, label: { ok: false, error: 'Label is down' } } });
      if (b.action === 'unlink') return j({ ok: true, customer: 'new', results: { signage: { ok: true, unlinked: 1 } } });
      return j({ ok: true, apps: {} });
    }
    const m = u.match(/\/rest\/v1\/(\w+)/); if (m && DB[m[1]]) return j(DB[m[1]]);
    if (u.includes('/rest/v1/')) return j([]);
    return j({});
  });
  await page.goto(BASE + 'README.md', { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('sb-bpssjfrinjlrnkzhytfr-auth-token', JSON.stringify(s)); }, session());
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await wait(1200);
  const txt = (s) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim(), s);
  const okBtn = async () => { await page.evaluate(() => document.getElementById('askOk').click()); await wait(400); };

  ok('sidebar and title say Businesses', (await txt('a[data-tab="customers"]')) === 'Businesses' && (await txt('#pageTitle')) === 'Businesses');
  ok('header picker: "All businesses (3)" ' + (await txt('#hdr-biz option')), (await txt('#hdr-biz option')) === 'All businesses (3)');
  ok('New business button, search placeholder', (await txt('#newCustBtn')) === 'New business' && (await page.$eval('#q', (e) => e.placeholder)) === 'Search businesses or app accounts');
  const stats = await page.evaluate(() => [...document.querySelectorAll('#custStats .ov-stat .tiny')].map((x) => x.textContent));
  ok('stat "Businesses" (not Customers), "App accounts" kept ' + stats.join(','), stats[0] === 'Businesses' && stats.includes('App accounts'));
  const noLoc = () => page.evaluate(() => { const t = [document.body.innerText, ...[...document.querySelectorAll('[placeholder],[aria-label],[title]')].map((e) => [e.placeholder, e.getAttribute('aria-label'), e.title].join(' '))].join(' '); return (t.match(/.{0,30}\blocations?\b.{0,30}/gi) || []); });
  const nl1 = await noLoc(); ok('list page: no visible "location" text ' + JSON.stringify(nl1), !nl1.length);
  const cardA = await page.evaluate(() => { const c = document.querySelector('[data-cust="ca"]'); return { h: c.querySelector('h3').textContent, sub: c.querySelector('.ov-bh .muted').textContent }; });
  ok('linked card title "Cafe Alpha + Cafe Beta", "2 linked businesses" under it ' + JSON.stringify(cardA), cardA.h === 'Cafe Alpha + Cafe Beta' && /^2 linked businesses/.test(cardA.sub));
  ok('a business on its own keeps its name', (await page.evaluate(() => document.querySelector('[data-cust="cg"] h3').textContent)) === 'Gamma Grill');
  const ban = await txt('#splitBanner');
  ok('banner: "1 business is still grouped from before" ' + ban, /1 business is still grouped from before/.test(ban) && /Split them/.test(ban));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'locations-1440.png') });
  // split: preview, then confirm
  await page.click('[data-split]'); await wait(500);
  const prev = await txt('#askMsg');
  ok('split preview lists the business, what it keeps and the new card ' + prev.slice(0, 160), (await txt('#askTitle')) === 'Split grouped businesses?' && !/location/i.test(prev) && (await page.evaluate(() => document.getElementById('askDlg').open)) && /Old Group/.test(prev) && /keeps Old Group/.test(prev) && /New cards: Old Group Soho \(Signage\)/.test(prev));
  ok('nothing split before confirming', !hubCalls.some((c) => c.action === 'split'));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'split-preview.png') });
  await okBtn(); await wait(300);
  ok('confirm runs hub split', hubCalls.some((c) => c.action === 'split'));
  // detail of the linked card
  await page.click('[data-cust="ca"] [data-open="ca"]'); await wait(300);
  const det = await txt('#custList');
  ok('detail: "← All businesses", "Link with another business…", no Merge ' , /← All businesses/.test(det) && /Link with another business…/.test(det) && !/Merge/.test(det));
  const nl2 = await noLoc(); ok('business page: no visible "location" text ' + JSON.stringify(nl2), !nl2.length);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-unlink]')].map((b) => b.dataset.unlink));
  ok('linked businesses listed, each with Unlink ' + JSON.stringify(rows), JSON.stringify(rows) === JSON.stringify(['ca|ca', 'ca|cb']) && /Linked businesses/.test(det) && /2 businesses are linked in every app/.test(det) && /Cafe Beta\s*Signage · Label/.test(det));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'location-page.png') });
  await page.click('[data-unlink="ca|cb"]'); await wait(300);
  ok('Unlink asks first: ' + (await txt('#askTitle')), (await txt('#askTitle')) === 'Unlink Cafe Beta?' && /becomes a business on its own again/.test(await txt('#askMsg')));
  await okBtn();
  const ul = hubCalls.filter((c) => c.action === 'unlink').pop();
  ok('Unlink sends { customer, origin } ' + JSON.stringify(ul), ul && ul.customer === 'ca' && ul.origin === 'cb');
  // link: picker -> confirm -> hub link; partial result reported
  await page.click('[data-link="ca"]'); await wait(300);
  const pick = await page.evaluate(() => ({ head: document.getElementById('moveHead').textContent, ok: document.getElementById('moveOk').textContent, opts: [...document.querySelectorAll('#moveTo option')].map((o) => o.textContent) }));
  ok('Link picker lists the other businesses ' + JSON.stringify(pick), pick.head === 'Link with another business' && pick.ok === 'Next' && pick.opts.length === 2 && pick.opts.some((o) => /Gamma Grill/.test(o)) && !pick.opts.some((o) => /Cafe Alpha/.test(o)));
  await page.select('#moveTo', 'cg'); await page.evaluate(() => document.getElementById('moveDlg').close('ok')); await wait(300);
  const cm = await txt('#askMsg');
  ok('Link confirm explains it (apps in common, owners and managers get both) ' + cm.slice(0, 120), /Cafe Alpha \+ Cafe Beta and Gamma Grill become one card/.test(cm) && /In Signage/.test(cm) && /Owners and managers of either business get both/.test(cm) && (await txt('#askTitle')) === 'Link these businesses?' && (await txt('#askOk')) === 'Link businesses');
  ok('nothing linked before confirming', !hubCalls.some((c) => c.action === 'link'));
  await okBtn(); await wait(500);
  const lk = hubCalls.filter((c) => c.action === 'link').pop();
  ok('Link sends { customer_a, customer_b } ' + JSON.stringify(lk), lk && lk.customer_a === 'ca' && lk.customer_b === 'cg');
  const part = await txt('#askMsg');
  ok('partial link reported per app: ' + part, (await txt('#askTitle')) === 'Linked in some apps only' && /Signage: linked/.test(part) && /Label: not done: Label is down/.test(part));
  await okBtn();
  await page.setViewport({ width: 390, height: 844, isMobile: true }); await wait(300);
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'location-page-390.png'), fullPage: false });
  ok('390px: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= 392));
  ok('no page errors ' + JSON.stringify(errs), !errs.length);
  console.log(results.join('\n')); const f = results.filter((x) => x.startsWith('FAIL')).length; console.log(`${results.length - f} PASS, ${f} FAIL`);
  await browser.close(); srv.close();
})();
