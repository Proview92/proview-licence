/* pv-addbiz.js: the master's "+ Add business" pop-up (design D), one copy shared byte-for-byte by all six Proview apps
   (Signage, Bookings, Employee, Label, QR Menu, WiFi) and the licence portal, so it looks the same everywhere: size, position, colours, fonts.
   Do not edit one app's copy: change it once and copy the same file into every app.
   window.pvAddBiz({ onSubmit }) opens it. onSubmit(v, ui) gets
     v  = { biz, name, email, mobile, invite, lic, password, checks, extra }
                                                              (trimmed; email lower-cased; invite true/false;
                                                                 lic 'none' | 'trial' | 'set'; password as typed;
                                                                 checks { section key: [ticked values] }; extra { field key: trimmed value })
     ui = { el, close, input(key) }                           (key: 'biz' | 'name' | 'email' | 'mobile' | 'pw', an extra field's key,
                                                                 or a checks section's key: its first tick box)
   and does the app's own checks and server calls. Return true to close the pop-up; anything else keeps it open.
   The primary button is disabled while onSubmit runs.
   Optional (all leave the six apps' pop-up exactly as it is when left out; used by the licence portal's "New customer"):
     title, go (primary button text), hint (footer text), pwPlaceholder,
     signin: 'password'  -> no "How will they sign in?" choice: a Password field (with Suggest and the eye) only,
     licence: false      -> no Licence cards,
     sections: [ { key, legend, req, optional, all: { title, sub }, checks: [ { value, title, sub } ] }      tick-box cards
               | { key, legend, req, optional, fields: [ { key, label, type, ph, full, area, req, optional } ] } ]   field grid
     (added after the Licence cards, in this order; labels and text are HTML). */
(function () {
  if (window.pvAddBiz) return;
  var F = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';
  var CSS = [
    '.pv-addbiz-back{position:fixed;inset:0;z-index:55;display:flex;margin:0;padding:0;background:rgba(20,20,24,.5);overflow:hidden}',
    '.pv-addbiz,.pv-addbiz *{box-sizing:border-box}',
    '.pv-addbiz [hidden]{display:none!important}',
    '.pv-addbiz{position:relative;display:block;margin:auto;width:min(680px,calc(100vw - 28px));max-width:calc(100% - 36px);max-height:calc(100% - 36px);overflow:auto;padding:24px;border:0;border-radius:18px;background:#fff;color:#17171c;box-shadow:0 30px 80px rgba(0,0,0,.3);font:400 15px/1.45 ' + F + ';letter-spacing:normal;text-align:left;text-transform:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',
    '.pv-addbiz .pv-ab-form{display:block;margin:0;padding:0}',
    '.pv-addbiz .pv-ab-head{display:flex;align-items:center;justify-content:space-between;gap:0;margin:0 0 8px;padding:0;border:0}',
    '.pv-addbiz .pv-ab-title{margin:0;padding:0;font:700 20px/1.45 ' + F + ';letter-spacing:-.015em;color:#17171c;text-transform:none}',
    '.pv-addbiz .pv-ab-x{display:block;flex:none;width:auto;height:auto;min-width:0;min-height:0;margin:0;padding:0 4px;border:0;border-radius:0;background:none;box-shadow:none;font:400 26px/1 Arial,sans-serif;color:#8b8b95;cursor:pointer}',
    '.pv-addbiz .pv-ab-x:hover{color:#17171c;background:none}',
    '.pv-addbiz .pv-ab-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;margin:0;padding:0}',
    '.pv-addbiz .pv-ab-field{display:block;min-width:0;margin:0;padding:0}',
    '.pv-addbiz .pv-ab-label{display:block;margin:0 0 5px;padding:0;font:600 13px/1.45 ' + F + ';letter-spacing:normal;color:#55555f;text-transform:none;cursor:default}',
    '.pv-addbiz .pv-ab-req{color:#d92d20}',
    '.pv-addbiz .pv-ab-optl{font-weight:400;color:#55555f}',
    '.pv-addbiz .pv-ab-inp{display:inline-block;-webkit-appearance:none;appearance:none;width:100%;min-width:0;height:auto;min-height:0;margin:0;padding:9px 11px;border:1px solid #e4e2dc;border-radius:9px;background:#fff;box-shadow:none;font:400 15px ' + F + ';letter-spacing:normal;color:#17171c;outline:0}',
    '.pv-addbiz .pv-ab-inp::placeholder{color:#757575;opacity:1}',
    '.pv-addbiz .pv-ab-inp:focus{outline:2px solid #4a6cd0;outline-offset:-1px;border-color:transparent;box-shadow:none}',
    '.pv-addbiz .pv-ab-set{display:grid;gap:8px;min-width:0;margin:18px 0 0;padding:0;border:0}',
    '.pv-addbiz .pv-ab-legend{display:block;float:none;width:auto;margin:0;padding:0 0 8px;border:0;font:600 13px/1.45 ' + F + ';letter-spacing:normal;color:#55555f;text-transform:none}',
    '.pv-addbiz .pv-ab-card{display:flex;align-items:flex-start;gap:12px;margin:0;padding:13px 14px;border:1px solid #d9d6ce;border-radius:12px;background:#fff;box-shadow:none;font:400 15px/1.45 ' + F + ';color:#17171c;text-transform:none;cursor:pointer}',
    '.pv-addbiz .pv-ab-card.on{padding:12px 13px;border:2px solid #3b7fd4;background:#f3f7fd}',
    '.pv-addbiz .pv-ab-radio{display:block;flex:none;-webkit-appearance:auto;appearance:auto;width:18px;height:18px;min-width:0;min-height:0;margin:2px 0 0;padding:0;border:0;outline:0;font:inherit;color:inherit;accent-color:#2f6fc4;box-shadow:none;cursor:pointer}',
    '.pv-addbiz .pv-ab-t{display:block;flex:1;min-width:0}',
    '.pv-addbiz .pv-ab-tt{display:block;font:600 14px/1.45 ' + F + ';color:#17171c}',
    '.pv-addbiz .pv-ab-ts{display:block;font:400 13px/18px ' + F + ';color:#55555f}',
    '.pv-addbiz .pv-ab-pill{display:block;flex:none;margin:0;padding:3px 8px;border:0;border-radius:999px;background:#e2ecfa;font:700 11px/1.45 ' + F + ';letter-spacing:normal;color:#1f4f96;white-space:nowrap}',
    '.pv-addbiz .pv-ab-lic{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    // sign-in choices side by side, styled like the licence cards
    '.pv-addbiz .pv-ab-si{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '.pv-addbiz .pv-ab-si .pv-ab-card{flex-wrap:wrap;gap:8px;padding:12px}',
    '.pv-addbiz .pv-ab-si .pv-ab-card.on{padding:11px}',
    '.pv-addbiz .pv-ab-si .pv-ab-ts{font-size:12px;line-height:17px}',
    '.pv-addbiz .pv-ab-si .pv-ab-t{flex:1 1 calc(100% - 30px)}',
    '.pv-addbiz .pv-ab-si .pv-ab-pill{margin-left:30px}',
    '.pv-addbiz .pv-ab-lic .pv-ab-card{flex-wrap:wrap;gap:8px;padding:12px}',
    '.pv-addbiz .pv-ab-lic .pv-ab-card.on{padding:11px}',
    '.pv-addbiz .pv-ab-lic .pv-ab-ts{font-size:12px;line-height:17px}',
    '.pv-addbiz .pv-ab-pwrow{display:block;margin:2px 0 0}',
    '.pv-addbiz .pv-ab-pwline{display:flex;align-items:center;gap:6px;flex-wrap:nowrap}',
    '.pv-addbiz .pv-ab-pwwrap{position:relative;flex:1;min-width:0}',
    '.pv-addbiz .pv-ab-pwwrap .pv-ab-inp{padding-right:44px}',
    '.pv-addbiz .pv-ab-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:36px;height:34px;min-width:0;min-height:0;margin:0;padding:0;border:0;border-radius:8px;background:transparent;box-shadow:none;font:inherit;color:#8b8b95;cursor:pointer}',
    '.pv-addbiz .pv-ab-eye:hover{color:#17171c;background:rgba(0,0,0,.05)}',
    '.pv-addbiz .pv-ab-eye svg{display:block;width:18px;height:18px}',
    '.pv-addbiz .pv-ab-foot{display:flex;align-items:center;gap:8px;margin:20px -24px 0;padding:16px 24px 0;border:0;border-top:1px solid #eceae4}',
    '.pv-addbiz .pv-ab-hint{flex:1;font:400 12px/1.45 ' + F + ';color:#8b8b95}',
    '.pv-addbiz .pv-ab-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:none;width:auto;height:38px;min-width:0;min-height:0;margin:0;padding:0 14px;border:1px solid #e4e2dc;border-radius:10px;background:#fff;box-shadow:none;font:600 14px ' + F + ';letter-spacing:normal;color:#17171c;text-transform:none;text-decoration:none;white-space:nowrap;filter:none;opacity:1;cursor:pointer}',
    '.pv-addbiz .pv-ab-btn:hover{border-color:#cfccc4;background:#fbfaf8}',
    '.pv-addbiz .pv-ab-btn.pv-ab-pri{border-color:transparent;background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);color:#fff}',
    '.pv-addbiz .pv-ab-btn.pv-ab-pri:hover{border-color:transparent;background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);filter:brightness(.95)}',
    '.pv-addbiz .pv-ab-btn.pv-ab-sm{height:32px;padding:0 11px;border-radius:8px;font-size:13px}',
    '.pv-addbiz .pv-ab-btn:disabled{opacity:.5;cursor:not-allowed;filter:none}',
    '.pv-addbiz .pv-ab-full{grid-column:1/-1}',
    '.pv-addbiz textarea.pv-ab-inp{display:block;resize:vertical;min-height:62px}',
    '.pv-addbiz .pv-ab-chks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.pv-addbiz .pv-ab-chks .pv-ab-card{align-items:center}',
    '.pv-addbiz .pv-ab-chks .pv-ab-radio{margin:0}',
    '.pv-addbiz .pv-ab-chks .pv-ab-all{grid-column:1/-1}',
    '@media (max-width:700px){.pv-addbiz .pv-ab-grid{grid-template-columns:1fr}}',
    '@media (max-width:640px){.pv-addbiz .pv-ab-lic,.pv-addbiz .pv-ab-si{grid-template-columns:1fr}.pv-addbiz .pv-ab-chks{grid-template-columns:repeat(2,minmax(0,1fr))}.pv-addbiz .pv-ab-foot{flex-wrap:wrap}.pv-addbiz .pv-ab-hint{flex-basis:100%}}',
    '@media (hover:none) and (pointer:coarse){.pv-addbiz .pv-ab-inp,.pv-addbiz .pv-ab-radio{font-size:16px!important}}'
  ].join('\n');
  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/></svg>';
  var req = '<span class="pv-ab-req"> *</span>';
  var field = function (id, label, type, ph) {
    return '<div class="pv-ab-field"><label class="pv-ab-label" for="' + id + '">' + label + '</label><input class="pv-ab-inp" id="' + id + '" type="' + type + '" placeholder="' + ph + '" autocomplete="off"></div>';
  };
  var card = function (name, val, title, sub, on, pill, type, cls) {
    return '<label class="pv-ab-card' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '"><input class="pv-ab-radio" type="' + (type || 'radio') + '" name="' + name + '" value="' + val + '"' + (on ? ' checked' : '') + '>' +
      '<span class="pv-ab-t"><b class="pv-ab-tt">' + title + '</b>' + (sub ? '<span class="pv-ab-ts">' + sub + '</span>' : '') + '</span>' + (pill ? '<span class="pv-ab-pill">' + pill + '</span>' : '') + '</label>';
  };
  var optl = ' <span class="pv-ab-optl">(optional)</span>';
  var legend = function (x) { return '<legend class="pv-ab-legend">' + x.legend + (x.req ? req : '') + (x.optional ? optl : '') + '</legend>'; };
  var pwRow = function (o, hidden) {
    return '<div class="pv-ab-pwrow" id="pvAbPwRow"' + (hidden ? ' hidden' : '') + '><label class="pv-ab-label" for="pvAbPw">Password' + req + '</label>' +
        '<div class="pv-ab-pwline"><div class="pv-ab-pwwrap"><input class="pv-ab-inp" id="pvAbPw" type="password" placeholder="' + (o.pwPlaceholder || 'At least 6 characters') + '" autocomplete="new-password">' +
        '<button type="button" class="pv-ab-eye" id="pvAbEye" tabindex="-1" aria-label="Show password" title="Show password">' + EYE + '</button></div>' +
        '<button type="button" class="pv-ab-btn pv-ab-sm" id="pvAbSuggest">Suggest</button></div></div>';
  };
  var section = function (x) {
    if (x.checks) return '<fieldset class="pv-ab-set" data-pv-ab-sec="' + x.key + '">' + legend(x) + '<div class="pv-ab-chks">' +
      (x.all ? card('pvAbAll_' + x.key, 'all', x.all.title || 'Select all', x.all.sub || '', false, '', 'checkbox', 'pv-ab-all') : '') +
      x.checks.map(function (c) { return card('pvAbC_' + x.key, c.value, c.title, c.sub || '', !!c.on, '', 'checkbox'); }).join('') + '</div></fieldset>';
    return '<fieldset class="pv-ab-set" data-pv-ab-sec="' + x.key + '">' + legend(x) + '<div class="pv-ab-grid">' + (x.fields || []).map(function (f) {
      var id = 'pvAbX_' + f.key, lab = f.label + (f.req ? req : '') + (f.optional ? optl : '');
      if (!f.area && !f.full) return field(id, lab, f.type || 'text', f.ph || '');
      return '<div class="pv-ab-field pv-ab-full"><label class="pv-ab-label" for="' + id + '">' + lab + '</label>' + (f.area
        ? '<textarea class="pv-ab-inp" id="' + id + '" rows="' + (f.rows || 2) + '" placeholder="' + (f.ph || '') + '" autocomplete="off"></textarea>'
        : '<input class="pv-ab-inp" id="' + id + '" type="' + (f.type || 'text') + '" placeholder="' + (f.ph || '') + '" autocomplete="off">') + '</div>';
    }).join('') + '</div></fieldset>';
  };
  var build = function (o) {
    var choose = o.signin !== 'password';
    return '<div class="pv-addbiz" role="dialog" aria-modal="true" aria-labelledby="pvAbTitle"><form class="pv-ab-form" novalidate autocomplete="off">' +
    '<div class="pv-ab-head"><h2 class="pv-ab-title" id="pvAbTitle">' + (o.title || 'Add business') + '</h2><button type="button" class="pv-ab-x" data-pv-ab-close aria-label="Close" title="Close">×</button></div>' +
    '<div class="pv-ab-grid">' +
      field('pvAbBiz', 'Business name' + req, 'text', 'e.g. Tolians') +
      field('pvAbName', 'Owner’s name' + req, 'text', 'e.g. Sam Taylor') +
      field('pvAbEmail', 'Owner’s email' + req, 'email', 'name@company.com') +
      field('pvAbMob', 'Mobile <span class="pv-ab-optl">(optional)</span>', 'tel', '07…') +
    '</div>' +
    (choose ? '<fieldset class="pv-ab-set"><legend class="pv-ab-legend">How will they sign in?</legend>' +
      '<div class="pv-ab-si">' +
      card('pvAbSi', 'invite', 'Email them an invite', 'They get an email link and choose their own password.', true, 'Recommended') +
      card('pvAbSi', 'pw', 'Set a password now', 'No email is sent. You pass the password on yourself.', false) +
      '</div>' +
      pwRow(o, true) +
    '</fieldset>' : '<div class="pv-ab-set">' + pwRow(o, false) + '</div>') +
    (o.licence === false ? '' : '<fieldset class="pv-ab-set"><legend class="pv-ab-legend">Licence</legend><div class="pv-ab-lic">' +
      card('pvAbLic', 'none', 'None yet', 'They buy one when they sign in.', true) +
      card('pvAbLic', 'trial', '3-day trial', 'Full access for 3 days, then it locks.', false) +
      card('pvAbLic', 'set', 'Set it now', 'Then set it in the licence portal.', false) +
    '</div></fieldset>') +
    (o.sections || []).map(section).join('') +
    '<div class="pv-ab-foot"><span class="pv-ab-hint">' + (o.hint || 'Adds the business and a location with the same name.') + '</span>' +
      '<button type="button" class="pv-ab-btn" data-pv-ab-close>Cancel</button><button type="submit" class="pv-ab-btn pv-ab-pri" id="pvAbGo">' + (o.go || (choose ? 'Add and send invite' : 'Add business')) + '</button></div>' +
    '</form></div>';
  };
  var rand = function (n) {
    var a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint32Array(n)), s = '';
    for (var i = 0; i < n; i++) s += a[r[i] % a.length];
    return s;
  };
  window.pvAddBiz = function (o) {
    o = o || {};
    if (!document.getElementById('pv-addbiz-css')) { var st = document.createElement('style'); st.id = 'pv-addbiz-css'; st.textContent = CSS; document.head.appendChild(st); }
    var old = document.querySelector('.pv-addbiz-back'); if (old && old._close) old._close();
    var back = document.createElement('div'); back.className = 'pv-addbiz-back'; back.innerHTML = build(o); document.body.appendChild(back);
    var q = function (s) { return back.querySelector(s); }, form = q('form'), go = q('#pvAbGo'), pw = q('#pvAbPw'), eye = q('#pvAbEye');
    var ids = { biz: 'pvAbBiz', name: 'pvAbName', email: 'pvAbEmail', mobile: 'pvAbMob', pw: 'pvAbPw' };
    var input = function (k) { return q('#' + (ids[k] || k)) || q('#pvAbX_' + k) || q('input[name="pvAbAll_' + k + '"]') || q('input[name="pvAbC_' + k + '"]'); };
    var pick = function (n) { var r = q('input[name="' + n + '"]:checked'); return r ? r.value : ''; };
    var onKey = function (e) { if (e.key === 'Escape' && document.body.contains(back)) { e.stopPropagation(); close(); } };
    var close = function () { if (!back.parentNode) return; back.remove(); document.removeEventListener('keydown', onKey, true); if (o.onClose) o.onClose(); };
    back._close = close;
    document.addEventListener('keydown', onKey, true);
    var downOnBack = false;
    back.addEventListener('mousedown', function (e) { downOnBack = e.target === back; });
    back.addEventListener('click', function (e) { if (e.target === back && downOnBack) close(); });
    back.querySelectorAll('[data-pv-ab-close]').forEach(function (b) { b.addEventListener('click', close); });
    var showPw = function (on) { pw.type = on ? 'text' : 'password'; eye.innerHTML = on ? EYE_OFF : EYE; eye.title = on ? 'Hide password' : 'Show password'; eye.setAttribute('aria-label', eye.title); };
    eye.addEventListener('click', function () { showPw(pw.type === 'password'); pw.focus(); });
    q('#pvAbSuggest').addEventListener('click', function () { pw.value = rand(10); showPw(true); });
    var syncChecks = function (sec) {
      var all = sec.querySelector('.pv-ab-all input'), cs = [].slice.call(sec.querySelectorAll('.pv-ab-card:not(.pv-ab-all) input')), on = cs.filter(function (c) { return c.checked; }).length;
      if (all) { all.checked = on === cs.length; all.indeterminate = on > 0 && on < cs.length; }
      sec.querySelectorAll('.pv-ab-card input').forEach(function (c) { c.closest('.pv-ab-card').classList.toggle('on', c.checked); });
    };
    form.addEventListener('change', function (e) {
      var t = e.target; if (t && t.type === 'checkbox' && t.closest('[data-pv-ab-sec]')) { var sec = t.closest('[data-pv-ab-sec]');
        if (t.value === 'all' && t.closest('.pv-ab-all')) sec.querySelectorAll('.pv-ab-card:not(.pv-ab-all) input').forEach(function (c) { c.checked = t.checked; });
        syncChecks(sec); return; }
      if (!t || t.type !== 'radio') return;
      back.querySelectorAll('input[name="' + t.name + '"]').forEach(function (r) { r.closest('.pv-ab-card').classList.toggle('on', r.checked); });
      if (t.name === 'pvAbSi') { var p = t.value === 'pw'; q('#pvAbPwRow').hidden = !p; go.textContent = p ? 'Add business' : 'Add and send invite'; if (p) pw.focus(); }
    });
    var ui = { el: back, close: close, input: input };
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (go.disabled) return;
      var v = { biz: input('biz').value.trim(), name: input('name').value.trim(), email: input('email').value.trim().toLowerCase(), mobile: input('mobile').value.trim(),
        invite: o.signin === 'password' ? false : pick('pvAbSi') !== 'pw', lic: pick('pvAbLic') || 'none', password: pw.value, checks: {}, extra: {} };
      (o.sections || []).forEach(function (x) {
        if (x.checks) v.checks[x.key] = [].slice.call(back.querySelectorAll('input[name="pvAbC_' + x.key + '"]:checked')).map(function (c) { return c.value; });
        (x.fields || []).forEach(function (f) { v.extra[f.key] = q('#pvAbX_' + f.key).value.trim(); });
      });
      go.disabled = true; var done = false;
      try { done = (await (o.onSubmit ? o.onSubmit(v, ui) : true)) === true; }
      finally { go.disabled = false; }
      if (done) close();
    });
    setTimeout(function () { var f = input('biz'); if (f && back.parentNode) f.focus(); }, 30);
    return ui;
  };
})();
