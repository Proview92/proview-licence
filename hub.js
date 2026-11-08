/* Proview hub: the shared header tray (status, search, chat, inbox, bell),
   search palette, team chat panel, inbox panel and the avatar's account menu. The same file is used by
   Proview Employee and Proview Signage; each app passes in its own data
   through PVHub.init(adapter). */
(function () {
  'use strict';
  const SVG = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    page: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  };
  const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG[k] || k}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (String(n || '').replace(/@.*/, '').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').split(/[\s._-]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?');
  const ago = (t) => { const s = (Date.now() - new Date(t).getTime()) / 1000; if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; const d = new Date(t); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  const css = `
.hdr-cap{display:flex;align-items:center;gap:2px;background:#f3f2ee;border-radius:12px;padding:3px;flex:none}
.hdr-cap>button,.hdr-cap>a{width:34px;height:34px;min-width:34px;border-radius:9px;background:transparent!important;border:0!important;display:grid;place-items:center;position:relative;color:#17171c;padding:0!important;cursor:pointer;box-shadow:none!important}
.hdr-cap>button:hover,.hdr-cap>a:hover{background:#fff!important}
.hdr-cap svg{width:18px!important;height:18px!important}
.hdr-dot{width:9px;height:9px;border-radius:50%;background:#12a150;margin:0 9px;flex:none;display:block}
.hdr-dot.saving{background:#4a6cd0;animation:hubPulse 1s infinite}.hdr-dot.offline{background:#d48a00}.hdr-dot.error{background:#d92d20}
@keyframes hubPulse{50%{opacity:.35}}
.hub-badge{position:absolute;top:0;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#d92d20;color:#fff;font-size:10.5px;font-weight:700;line-height:16px;text-align:center;box-sizing:border-box}
.hub-badge:empty,.hub-badge.hidden{display:none}
.pv-dash{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 13px;border-radius:10px;border:1px solid #e4e2dc;background:#fff;color:#17171c!important;font:inherit;font-weight:600;font-size:14px;text-decoration:none!important;flex:none;white-space:nowrap}
.pv-dash:hover{background:#f3f2ee}
.pv-dash svg{width:17px!important;height:17px!important}
@media (max-width:700px){.pv-dash{width:34px;height:34px;padding:0;justify-content:center}.pv-dash span{display:none}}
@media (max-width:700px){.hdr-cap{padding:2px;gap:0}.hdr-cap>button,.hdr-cap>a{width:30px;min-width:30px;height:30px}.hdr-dot{margin:0 6px}}
.hdr-cap>button:focus-visible,.hdr-cap>a:focus-visible,.pv-dash:focus-visible{outline:2px solid #5a8dee;outline-offset:2px}
.pv-acct{position:fixed;z-index:310;width:264px;max-width:calc(100vw - 16px);background:#fff;border:1px solid #e4e2dc;border-radius:12px;box-shadow:0 12px 32px rgba(20,20,30,.16);padding:6px;font-size:14px;color:#17171c;box-sizing:border-box}
.pv-acct-h{display:flex;align-items:center;gap:10px;padding:8px 8px 12px;margin-bottom:6px;border-bottom:1px solid #eceae4;min-width:0}
.pv-acct-h .ct{flex:1;min-width:0}.pv-acct-h b{display:block;font-size:14px;font-weight:700;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-acct-h small{display:block;font-size:12.5px;line-height:17px;color:#8b8b95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-acct-i{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:0 10px;border-radius:8px;border:0;background:none;font:inherit;font-size:14px;font-weight:550;color:#17171c!important;text-decoration:none!important;cursor:pointer;text-align:left;box-sizing:border-box}
.pv-acct-i:hover,.pv-acct-i:focus-visible{background:#f3f2ee;outline:0}
.pv-acct-i svg{width:17px!important;height:17px!important;color:#4a4a55;flex:none}
.pv-acct-sep{height:1px;background:#eceae4;margin:6px 4px}
.hub-bg{position:fixed;inset:0;background:rgba(20,20,26,.38);z-index:300;display:flex}
.hub-pal{margin:12vh auto auto;width:min(580px,92vw);background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.25);overflow:hidden;font-size:15px;color:#17171c}
.hub-pal .hp-in{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #eceae4;color:#8b8b95}
.hub-pal input{flex:1;border:0!important;outline:0;font:inherit;font-size:16px;padding:16px 0;background:none;color:#17171c;box-shadow:none!important}
.hub-pal .hp-list{max-height:min(420px,60vh);overflow:auto;padding:6px}
.hub-pal .hp-g{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b8b95;padding:10px 10px 4px}
.hub-pal .hp-row{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:9px;cursor:pointer}
.hub-pal .hp-row.on{background:#f1f0ec}
.hub-pal .hp-row .hp-ic{width:30px;height:30px;border-radius:8px;background:#f3f2ee;display:grid;place-items:center;color:#4a4a55;flex:none}
.hub-pal .hp-row b{font-weight:600}.hub-pal .hp-row small{display:block;color:#8b8b95;font-size:13px}
.hub-pal .hp-empty{padding:22px;text-align:center;color:#8b8b95}
.hub-pal .hp-foot{border-top:1px solid #eceae4;padding:8px 14px;font-size:12px;color:#8b8b95}
.hub-panel{margin-left:auto;height:100%;width:min(760px,100vw);background:#fff;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.18);color:#17171c;font-size:15px}
.hub-panel.narrow{width:min(440px,100vw)}
.hub-ph{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #eceae4}
.hub-ph h3{margin:0;font-size:18px;font-weight:700;flex:1}
.hub-x{width:34px;height:34px;border-radius:9px;border:0;background:none;display:grid;place-items:center;cursor:pointer;color:#17171c}.hub-x:hover{background:#f3f2ee}
.hub-cbox{flex:1;display:grid;grid-template-columns:240px 1fr;min-height:0}
.hub-convs{border-right:1px solid #eceae4;overflow:auto;padding:8px}
.hub-conv{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;cursor:pointer}
.hub-conv:hover{background:#f6f5f1}.hub-conv.on{background:#eef1fb}
.hub-av{width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center;background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);color:#fff;font-weight:700;font-size:12.5px}
.hub-av.all{background:#17171c}
.hub-conv .ct{flex:1;min-width:0}.hub-conv b{display:block;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hub-conv small{display:block;font-size:12.5px;color:#8b8b95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hub-conv .n{background:#d92d20;color:#fff;border-radius:9px;font-size:11px;font-weight:700;min-width:18px;height:18px;line-height:18px;text-align:center;padding:0 5px}
.hub-thread{display:flex;flex-direction:column;min-height:0;min-width:0}
.hub-th{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #eceae4;font-weight:600}
.hub-th .hub-back{display:none}
.hub-msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#faf9f6}
.hub-msg{max-width:78%;align-self:flex-start}
.hub-msg .bub{background:#fff;border:1px solid #eceae4;border-radius:14px 14px 14px 4px;padding:8px 12px;white-space:pre-wrap;word-wrap:break-word}
.hub-msg.me{align-self:flex-end}.hub-msg.me .bub{background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);color:#fff;border:0;border-radius:14px 14px 4px 14px}
.hub-msg .meta{font-size:11.5px;color:#8b8b95;margin:2px 6px}.hub-msg.me .meta{text-align:right}
.hub-day{align-self:center;font-size:12px;color:#8b8b95;padding:4px 0}
.hub-comp{display:flex;gap:8px;padding:10px;border-top:1px solid #eceae4;align-items:flex-end}
.hub-comp textarea{flex:1;resize:none;border:1px solid #e4e2dc;border-radius:10px;padding:9px 12px;font:inherit;font-size:15px;max-height:120px;outline:0;min-height:40px;box-sizing:border-box}
.hub-comp textarea:focus{border-color:#4a6cd0}
.hub-send{width:40px;height:40px;border-radius:10px;border:0;background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);color:#fff;display:grid;place-items:center;cursor:pointer;flex:none}
.hub-note{margin:auto;max-width:340px;text-align:center;color:#6e6e78;padding:30px 20px;font-size:14px}
.hub-list{flex:1;overflow:auto}
.hub-item{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid #f0efea;align-items:flex-start}
.hub-item.unread{background:#f6f8fe}
.hub-item .ii{width:34px;height:34px;border-radius:9px;background:#f3f2ee;display:grid;place-items:center;flex:none;color:#4a4a55}
.hub-item .it{flex:1;min-width:0}.hub-item b{font-weight:600}.hub-item .is{font-size:13px;color:#6e6e78;margin-top:2px}
.hub-item .ia{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.hub-item .ia button{height:32px;padding:0 12px;border-radius:8px;border:1px solid #e4e2dc;background:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;color:#17171c}
.hub-item .ia button.pri{background:linear-gradient(135deg,#2f84d4 0%,#5a5fbb 100%);color:#fff;border:0}
.hub-item .ia button.bad{color:#c62828}
.hub-item .tm{font-size:12px;color:#8b8b95;white-space:nowrap}
.hub-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid #eceae4}
.hub-tabs button{border:0;background:none;padding:6px 12px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;color:#6e6e78;cursor:pointer}
.hub-tabs button.on{background:#f3f2ee;color:#17171c}
@media (max-width:700px){.hub-cbox{grid-template-columns:1fr}.hub-cbox.open .hub-convs{display:none}.hub-cbox:not(.open) .hub-thread{display:none}.hub-th .hub-back{display:grid}.hub-pal{margin-top:8vh}}
`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  let A = null;               // the app adapter
  const badges = { chat: new Set(), inbox: new Set() };
  const lastKey = (k) => 'pvhub.' + (A && A.key ? A.key() : 'x') + '.' + k;

  function close() { document.querySelectorAll('.hub-bg').forEach((e) => e.remove()); document.removeEventListener('keydown', onEsc, true); }
  function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function overlay(inner, onBg) {
    close();
    const bg = document.createElement('div'); bg.className = 'hub-bg';
    bg.innerHTML = inner;
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) (onBg || close)(); });
    document.body.appendChild(bg);
    document.addEventListener('keydown', onEsc, true);
    return bg;
  }

  /* ---------------- header tray ---------------- */
  function badge(kind) { const b = document.createElement('span'); b.className = 'hub-badge hidden'; badges[kind].add(b); setTimeout(paint, 0); return b; }
  function btn(kind, title, onClick) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hub-' + kind; b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = svg(kind === 'inbox' ? 'mail' : kind);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    if (kind === 'chat' || kind === 'inbox') b.appendChild(badge(kind));
    return b;
  }
  /** "Dashboard" link back to dashboard.proviewcrm.co.uk (owners, admins and managers only: pass show=false for others). */
  function dashLink(show) {
    if (!show) return null;
    const a = document.createElement('a');
    a.className = 'pv-dash'; a.href = 'https://dashboard.proviewcrm.co.uk/';
    a.title = 'Proview dashboard: all your Proview apps'; a.setAttribute('aria-label', 'Proview dashboard');
    a.innerHTML = svg('grid') + '<span>Dashboard</span>';
    return a;
  }
  /** Build the tray: [status dot, search, chat, inbox, bell]. bellEl is the app's own bell button. */
  function tray({ dot, bell }) {
    const cap = document.createElement('div'); cap.className = 'hdr-cap';
    if (!dot) { dot = document.createElement('span'); dot.className = 'hdr-dot'; dot.title = 'Online'; dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Online'); }
    dot.classList.add('hdr-dot');
    cap.appendChild(dot);
    cap.appendChild(btn('search', 'Search (Ctrl+K)', openSearch));
    cap.appendChild(btn('chat', 'Team chat', openChat));
    cap.appendChild(btn('inbox', 'Inbox', openInbox));
    if (bell) { bell.classList.remove('btn', 'ghost', 'icon', 'icon-btn'); const old = bell.querySelector('svg'); if (old) old.outerHTML = svg('bell'); cap.appendChild(bell); }
    return cap;
  }
  function paint() {
    if (!A) return;
    const set = (kind, n) => badges[kind].forEach((b) => { if (!b.isConnected) { if (b._live) badges[kind].delete(b); return; } b._live = true; b.textContent = n > 9 ? '9+' : n ? String(n) : ''; b.classList.toggle('hidden', !n); });
    try { set('chat', chatUnread()); } catch (e) {}
    try { set('inbox', A.inbox ? A.inbox.count() : 0); } catch (e) {}
  }

  /* ---------------- search ---------------- */
  function openSearch() {
    const bg = overlay(`<div class="hub-pal" role="dialog" aria-label="Search"><div class="hp-in">${svg('search', 18)}<input placeholder="Search pages and people" aria-label="Search"></div><div class="hp-list"></div><div class="hp-foot">↑ ↓ to move · Enter to open · Esc to close</div></div>`);
    const inp = bg.querySelector('input'), list = bg.querySelector('.hp-list');
    let rows = [], on = 0;
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      rows = (A.searchItems ? A.searchItems(q) : []).slice(0, 40);
      on = 0;
      if (!rows.length) { list.innerHTML = `<div class="hp-empty">${q ? 'Nothing matches “' + esc(inp.value) + '”' : 'Start typing to search'}</div>`; return; }
      let g = '', html = '';
      rows.forEach((r, i) => {
        if (r.group !== g) { g = r.group; html += `<div class="hp-g">${esc(g)}</div>`; }
        html += `<div class="hp-row${i === 0 ? ' on' : ''}" data-i="${i}"><span class="hp-ic">${r.av ? `<span class="hub-av" style="width:30px;height:30px;font-size:11px">${esc(initials(r.label))}</span>` : svg(r.icon || 'page', 16)}</span><span><b>${esc(r.label)}</b>${r.hint ? `<small>${esc(r.hint)}</small>` : ''}</span></div>`;
      });
      list.innerHTML = html;
    };
    const pick = (i) => { const r = rows[i]; if (!r) return; close(); setTimeout(() => r.run(), 0); };
    const move = (d) => { const els = list.querySelectorAll('.hp-row'); if (!els.length) return; els[on]?.classList.remove('on'); on = (on + d + els.length) % els.length; els[on].classList.add('on'); els[on].scrollIntoView({ block: 'nearest' }); };
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'Enter') { e.preventDefault(); pick(on); } });
    list.addEventListener('click', (e) => { const r = e.target.closest('.hp-row'); if (r) pick(+r.dataset.i); });
    draw(); setTimeout(() => inp.focus(), 0);
  }
  document.addEventListener('keydown', (e) => {
    if (!A) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  });

  /* ---------------- chat ---------------- */
  // conversation ids: 'all' (everyone) or a person id (direct message)
  const readAt = (conv) => (ls.get(lastKey('read')) || {})[conv] || 0;
  const markRead = (conv) => { const r = ls.get(lastKey('read')) || {}; r[conv] = Date.now(); ls.set(lastKey('read'), r); paint(); };
  const convOf = (m, me) => (m.to && m.to !== 'all' ? (m.by === me ? m.to : m.by) : 'all');
  function chatUnread() {
    if (!A || !A.chat) return 0;
    const me = A.chat.me().id, msgs = A.chat.cached() || [];
    return msgs.filter((m) => m.by !== me && new Date(m.at).getTime() > readAt(convOf(m, me))).length;
  }
  let chatState = null;
  async function openChat(conv) {
    if (!A || !A.chat) return;
    const bg = overlay(`<div class="hub-panel" role="dialog" aria-label="Team chat"><div class="hub-ph"><h3>Team chat</h3><button class="hub-x" aria-label="Close">${svg('x')}</button></div><div class="hub-cbox"><div class="hub-convs"></div><div class="hub-thread"><div class="hub-th"><button class="hub-x hub-back" aria-label="Back">${svg('left')}</button><span class="tt"></span></div><div class="hub-msgs"></div><div class="hub-comp"><textarea rows="1" placeholder="Write a message"></textarea><button class="hub-send" aria-label="Send">${svg('send', 18)}</button></div></div></div></div>`);
    bg.querySelector('.hub-ph .hub-x').onclick = close;
    const S = chatState = { bg, conv: conv || 'all', open: !!conv };
    const box = bg.querySelector('.hub-cbox'), convs = bg.querySelector('.hub-convs'), msgsEl = bg.querySelector('.hub-msgs'), ta = bg.querySelector('textarea');
    bg.querySelector('.hub-back').onclick = () => { S.open = false; box.classList.remove('open'); drawConvs(); };
    const err = A.chat.unavailable && A.chat.unavailable();
    if (err) { box.outerHTML = `<div class="hub-note">${esc(err)}</div>`; return; }
    const drawConvs = () => {
      const me = A.chat.me().id, msgs = A.chat.cached() || [];
      const last = {}; const unread = {};
      msgs.forEach((m) => { const c = convOf(m, me); if (!last[c] || m.at > last[c].at) last[c] = m; if (m.by !== me && new Date(m.at).getTime() > readAt(c)) unread[c] = (unread[c] || 0) + 1; });
      const people = A.chat.people().filter((p) => p.id !== me);
      people.sort((a, b) => (last[b.id] ? new Date(last[b.id].at) : 0) - (last[a.id] ? new Date(last[a.id].at) : 0) || a.name.localeCompare(b.name));
      const row = (id, name, sub, all) => `<div class="hub-conv${S.conv === id ? ' on' : ''}" data-c="${esc(id)}"><span class="hub-av${all ? ' all' : ''}">${all ? svg('users', 16) : esc(initials(name))}</span><span class="ct"><b>${esc(name)}</b><small>${esc(last[id] ? (last[id].by === me ? 'You: ' : '') + last[id].text : sub || '')}</small></span>${unread[id] ? `<span class="n">${unread[id]}</span>` : ''}</div>`;
      convs.innerHTML = row('all', A.chat.teamName ? A.chat.teamName() : 'Everyone', 'Whole team', true) + people.map((p) => row(p.id, p.name, p.sub)).join('');
    };
    const drawMsgs = () => {
      const me = A.chat.me().id;
      const list = (A.chat.cached() || []).filter((m) => convOf(m, me) === S.conv).sort((a, b) => new Date(a.at) - new Date(b.at));
      const who = (id) => (A.chat.people().find((p) => p.id === id) || {}).name || 'Someone';
      bg.querySelector('.tt').textContent = S.conv === 'all' ? (A.chat.teamName ? A.chat.teamName() : 'Everyone') : who(S.conv);
      if (!list.length) { msgsEl.innerHTML = `<div class="hub-note">${S.conv === 'all' ? 'Say hello to the team. Everyone in the business can read messages here.' : 'Only you and ' + esc(who(S.conv)) + ' can see this conversation.'}</div>`; return; }
      let day = '', html = '';
      list.forEach((m) => {
        const d = new Date(m.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        if (d !== day) { day = d; html += `<div class="hub-day">${esc(d)}</div>`; }
        const mine = m.by === me;
        html += `<div class="hub-msg${mine ? ' me' : ''}"><div class="bub">${esc(m.text)}</div><div class="meta">${mine ? '' : esc(m.byName || who(m.by)) + ' · '}${hm(m.at)}</div></div>`;
      });
      msgsEl.innerHTML = html; msgsEl.scrollTop = msgsEl.scrollHeight;
    };
    S.redraw = () => { drawConvs(); drawMsgs(); if (S.open || window.innerWidth > 700) markRead(S.conv); };
    convs.addEventListener('click', (e) => { const c = e.target.closest('.hub-conv'); if (!c) return; S.conv = c.dataset.c; S.open = true; box.classList.add('open'); S.redraw(); ta.focus(); });
    const send = async () => {
      const t = ta.value.trim(); if (!t) return;
      ta.value = ''; ta.style.height = '';
      try { await A.chat.send(S.conv, t); } catch (e) { ta.value = t; alert(e.message || 'Couldn’t send that message'); }
      S.redraw();
    };
    bg.querySelector('.hub-send').onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });
    if (S.open) box.classList.add('open');
    S.redraw();
    try { if (A.chat.refresh) { await A.chat.refresh(); if (chatState === S && S.bg.isConnected) S.redraw(); } } catch (e) {}
  }
  /** apps call this when messages arrive */
  function chatChanged() { paint(); if (chatState && chatState.bg.isConnected) chatState.redraw(); }

  /* ---------------- inbox ---------------- */
  let inboxBg = null;
  async function openInbox() {
    if (!A || !A.inbox) return;
    const bg = inboxBg = overlay(`<div class="hub-panel narrow" role="dialog" aria-label="Inbox"><div class="hub-ph"><h3>Inbox</h3><button class="hub-x" aria-label="Close">${svg('x')}</button></div><div class="hub-list"><div class="hub-note">Loading…</div></div></div>`);
    bg.querySelector('.hub-x').onclick = close;
    const draw = async () => {
      let items = [];
      try { items = await A.inbox.items(); } catch (e) { bg.querySelector('.hub-list').innerHTML = `<div class="hub-note">${esc(e.message || 'Couldn’t load your inbox')}</div>`; return; }
      const list = bg.querySelector('.hub-list');
      if (!items.length) { list.innerHTML = `<div class="hub-note">${esc(A.inbox.empty || 'You’re all caught up.')}</div>`; return; }
      list.innerHTML = items.map((it, i) => `<div class="hub-item${it.unread ? ' unread' : ''}" data-i="${i}"><span class="ii">${svg(it.icon || 'mail', 17)}</span><div class="it"><b>${esc(it.title)}</b>${it.sub ? `<div class="is">${esc(it.sub)}</div>` : ''}${it.actions && it.actions.length ? `<div class="ia">${it.actions.map((a, j) => `<button data-a="${j}" class="${a.kind || ''}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>${it.at ? `<span class="tm">${ago(it.at)}</span>` : ''}</div>`).join('');
      list.onclick = async (e) => {
        const row = e.target.closest('.hub-item'); if (!row) return;
        const it = items[+row.dataset.i]; const b = e.target.closest('button[data-a]');
        if (b) { b.disabled = true; try { await it.actions[+b.dataset.a].run(); } catch (er) { alert(er.message || 'That didn’t work'); } paint(); if (bg.isConnected) draw(); return; }
        if (it.open) { close(); it.open(); }
      };
      if (A.inbox.seen) { A.inbox.seen(); paint(); }
    };
    draw();
  }

  /* ---------------- account menu (the avatar in the header) ---------------- */
  // PVHub.accountMenu(avatarButton, { name, email, sub, items: [{ label, icon, href | run, sep }] })
  // Opens under the avatar, right-aligned to it. Click the avatar again, click outside, press Esc,
  // pick an item or change page to close. Up/Down move between items.
  let acct = null;
  function closeAccount() { if (!acct) return; acct.el.remove(); acct.btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', acct.out, true); document.removeEventListener('keydown', acct.key, true); removeEventListener('hashchange', closeAccount); acct = null; }
  function accountMenu(btn, o) {
    if (acct) { const was = acct.btn; closeAccount(); if (was === btn) return; }
    const m = document.createElement('div'); m.className = 'pv-acct'; m.setAttribute('role', 'menu'); m.setAttribute('aria-label', 'My account');
    m.innerHTML = `<div class="pv-acct-h"><span class="hub-av">${esc(o.initials || initials(o.name || o.email))}</span><span class="ct"><b>${esc(o.name || '')}</b>${o.email ? `<small>${esc(o.email)}</small>` : ''}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span></div>`;
    (o.items || []).forEach((it) => {
      if (it.sep) { const d = document.createElement('div'); d.className = 'pv-acct-sep'; m.appendChild(d); }
      const el = document.createElement(it.href ? 'a' : 'button'); el.className = 'pv-acct-i'; el.setAttribute('role', 'menuitem');
      if (it.href) { el.href = it.href; if (/^https?:/.test(it.href)) { el.target = '_self'; } } else el.type = 'button';
      el.innerHTML = svg(it.icon || 'page', 17) + `<span>${esc(it.label)}</span>`;
      el.addEventListener('click', (e) => { closeAccount(); if (it.run) { e.preventDefault(); it.run(); } });
      m.appendChild(el);
    });
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    m.style.top = Math.round(r.bottom + 8) + 'px';
    m.style.right = Math.max(8, Math.round(innerWidth - r.right)) + 'px';
    const items = () => [...m.querySelectorAll('.pv-acct-i')];
    acct = { el: m, btn,
      out: (e) => { if (!m.contains(e.target) && !btn.contains(e.target)) closeAccount(); },
      key: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeAccount(); btn.focus(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const l = items(), i = l.indexOf(document.activeElement); l[(i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length]?.focus(); }
      } };
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', acct.out, true); document.addEventListener('keydown', acct.key, true);
    addEventListener('hashchange', closeAccount);
    if (o.focusFirst) items()[0]?.focus();
  }

  window.PVHub = {
    init(adapter) { A = adapter; paint(); },
    adapter: () => A,
    tray, dashLink, accountMenu, closeAccount, paint, chatChanged, openSearch, openChat, openInbox, close, svg, initials,
  };
})();
