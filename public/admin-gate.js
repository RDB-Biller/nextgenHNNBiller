/* Sign-in for sub-admins on /app/platform.html. The chief administrator's page (a different address) keeps the platform key box.
   A sub-admin chooses their own password from an invite link, signs in with email or phone, and sees only the tabs they were given.
   The server enforces the same list: hiding a tab here is only a courtesy. */
'use strict';
(function () {
  if (window.ADMIN_MODE !== 'sub') return;
  const $$ = (id) => document.getElementById(id);
  // (Every call to /api/platform carries the sub-admin's session: the wrapper is installed by the page itself, before any script loads.)
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const gate = $$('gate');
  const TAB_AREA = { clients: 'clients', leads: 'clients', messaging: 'messaging', campaigns: 'messaging', lang: 'messaging', opmode: 'operating_mode', payers: 'payers', emr: 'payers', pde: 'product_lab', lic: 'finance', policy: 'finance', settlement: 'finance', reports: 'finance', automation: 'claims', partners: 'partners', erheat: 'partners', accounts: 'accounts' };
  const TEXT_AREA = { Partners: 'partners', ERHEAT: 'partners', Accounts: 'accounts', Outreach: 'messaging' };
  $$('keybox').style.display = 'none'; const nav = document.querySelector('.nav'); if (nav) nav.style.display = 'none';
  const hideAll = () => { if (tabs) tabs.style.display = 'none'; document.querySelectorAll('.panel').forEach((p) => { p.style.display = 'none'; }); $$('kpis').style.display = 'none'; };
  const api = async (path, method, body, auth) => {
    const r = await fetch('/admin-api' + path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + window.SUB_TOKEN } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && o.error) || 'Something went wrong.'); return o;
  };
  const msg = (t, bad) => `<div class="card" style="border-left:4px solid ${bad ? '#b3261e' : '#1f7a4a'};margin:10px 0">${esc(t)}</div>`;
  const form = (title, intro, fields, button, onsubmit) => {
    gate.innerHTML = `<div class="card" style="max-width:420px;margin:24px 0"><h2>${esc(title)}</h2><p class="muted">${esc(intro)}</p><form id="g_f">${fields.map((f) => `<div class="field"><label for="g_${f.id}">${esc(f.label)}</label><input id="g_${f.id}" type="${f.type || 'text'}" autocomplete="${f.ac || 'off'}" required/></div>`).join('')}<div id="g_e"></div><button class="primary">${esc(button)}</button></form></div>`;
    $$('g_f').onsubmit = async (e) => { e.preventDefault(); try { await onsubmit(Object.fromEntries(fields.map((f) => [f.id, $$('g_' + f.id).value]))); } catch (x) { $$('g_e').innerHTML = msg(x.message, true); } };
  };
  const enter = (o) => {
    window.SUB_TOKEN = o.token; try { sessionStorage.setItem('hnn.sub', o.token); } catch (e) { /* private window */ }
    const allowed = new Set(o.account.areas); gate.innerHTML = `<p class="muted" style="margin:6px 0">Signed in as <b>${esc(o.account.name)}</b> (${esc(o.account.presetLabel)}${o.account.readOnly ? ', read-only' : ''}). <button class="link" id="g_out" type="button">Sign out</button></p>`;
    if (o.account.sandboxed) gate.insertAdjacentHTML('beforeend', `<div class="card" style="margin:8px 0;border-left:4px solid #e9a100"><b>${o.account.demo ? 'Demo mode.' : 'Evaluation account.'}</b> You are looking at the real screens. Changes are not saved, and keys and contact details are hidden. <a href="/app/register.html">Ask for your own account</a> to configure everything.</div>`);
    $$('g_out').onclick = () => { try { sessionStorage.removeItem('hnn.sub'); } catch (e) { /* ignore */ } location.hash = ''; location.reload(); };
    if (tabs) tabs.style.display = ''; boot();
    let firstTab = null;
    [...tabs.querySelectorAll('button')].forEach((b) => {
      const m = /tab\('([a-z]+)'/.exec(b.getAttribute('onclick') || ''); const id = m ? m[1] : ''; const area = TAB_AREA[id] || TEXT_AREA[b.textContent.trim()];
      const ok = area && allowed.has(area); b.style.display = ok ? '' : 'none'; if (ok && !firstTab) firstTab = b;
    });
    document.querySelectorAll('.panel').forEach((p) => { p.style.display = ''; });
    if (firstTab) firstTab.click(); else gate.insertAdjacentHTML('beforeend', msg('Your login has no areas yet. Ask the chief administrator.', true));
  };
  const demoCard = async () => {
    let d = null; try { d = await api('/demo'); } catch (e) { /* no demo offered */ }
    if (!d || !d.enabled) return;
    gate.insertAdjacentHTML('beforeend', `<div class="card" style="max-width:420px;margin:0 0 24px;border:2px dashed #b8c4be"><h2>Just looking?</h2><p class="muted" style="margin-top:0">${esc(d.note)}</p>
      <p style="margin:6px 0"><b>Dummy credentials</b><br>Login: <code style="user-select:all">${esc(d.handle)}</code><br>Password: <code style="user-select:all">${esc(d.password)}</code></p>
      <button class="primary" id="g_demo" type="button">Try the demo</button> <a href="/app/register.html" style="margin-left:10px">Ask for your own account</a></div>`);
    $$('g_demo').onclick = async () => { try { enter(await api('/login', 'POST', { handle: d.handle, password: d.password })); } catch (x) { toast(x.message); } };
  };
  const signin = () => { form('Master Control sign-in', 'Sign in with the email or mobile number you were invited with.', [{ id: 'h', label: 'Email or mobile number', ac: 'username' }, { id: 'p', label: 'Password', type: 'password', ac: 'current-password' }], 'Sign in', async (v) => enter(await api('/login', 'POST', { handle: v.h, password: v.p }))); demoCard(); };
  hideAll();
  const m = /invite=([\w-]+)/.exec(location.hash);
  if (m) form('Choose your password', 'Your invite is valid. Choose a password of at least 10 characters. You will use it with your email or mobile number to sign in.', [{ id: 'p', label: 'New password', type: 'password', ac: 'new-password' }], 'Save and continue', async (v) => { const o = await api('/accept-invite', 'POST', { token: m[1], password: v.p }); history.replaceState(null, '', location.pathname); enter(o); });
  else { let t = ''; try { t = sessionStorage.getItem('hnn.sub') || ''; } catch (e) { /* ignore */ } if (t) { window.SUB_TOKEN = t; api('/me', 'GET', null, true).then((o) => enter({ token: t, account: o.account })).catch(() => { window.SUB_TOKEN = ''; signin(); }); } else signin(); }
})();
