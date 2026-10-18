/* Master Control: ERHEAT Shield controls and Partner logins. Loaded after platform-extra.js; uses platform.html's $, H, esc, toast, tab.
   Master Control keeps every power. Partners get a console at /app/partner.html scoped to one sector (or universal, approved here). */
'use strict';
(function () {
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const first = document.getElementById('p-clients');
  if (!tabs || !first) return;
  const call = async (base, path, method, body) => {
    const r = await fetch(base + path, { method: method || 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined });
    const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || ('HTTP ' + r.status)); return o;
  };
  const E = (p, m, b) => call('/api/platform/erheat', p, m, b); const P = (p, m, b) => call('/api/platform/partners', p, m, b);
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
  const q = (id) => document.getElementById(id);
  const mk = (name, id, html, load) => {
    const b = document.createElement('button'); b.textContent = name; b.onclick = () => { tab(id, b); load(); }; tabs.appendChild(b);
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'p-' + id; p.innerHTML = html; first.parentNode.appendChild(p);
  };

  // ------------------------------------------------------------ Partners: issue and manage logins
  mk('Partners', 'partners', `
    <div class="card" style="margin-bottom:14px"><h2>Partner logins</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Landlords, clinics, schools, bus operators and suppliers sign in at <b>/app/partner.html</b> (<a href="/app/partner.html" target="_blank" rel="noopener">open</a>). Each login is tied to one sector, so the console only shows that sector. A partner can ask for universal access; only you approve it. You issue every credential and can reset or suspend any of them. A temporary password is shown once.</p>
      <div class="row"><div class="field"><label>Name</label><input id="pt_name"/></div><div class="field"><label>Organisation</label><input id="pt_org"/></div></div>
      <div class="row"><div class="field"><label>Role</label><select id="pt_role" onchange="ptRole()"></select></div></div>
      <div class="row"><div class="field"><label>Login (email or phone)</label><input id="pt_handle"/></div><div class="field"><label>Sector</label><select id="pt_sector"></select></div></div>
      <div class="row"><div class="field"><label>Registered phone numbers (payee or verifier numbers, comma separated)</label><input id="pt_phones" placeholder="0302111222, 0244000111"/></div><div class="field"><label>They see</label><select id="pt_view"><option value="mine">Only requests that name their numbers</option><option value="all">Every request in their line(s)</option></select></div></div>
      <label style="font-size:13px"><input type="checkbox" id="pt_sms" style="width:auto"/> Send the login to their phone by SMS</label>
      <div class="row" style="margin-top:8px"><button class="primary" onclick="ptCreate()">Issue login</button></div>
      <div id="pt_new"></div></div>
    <div class="card"><h2>Partners</h2><div id="pt_list" class="muted">Loading</div></div>`, () => ptLoad());
  let SECT = []; let ROLES = [];
  window.ptRole = () => { const r = ROLES.find((x) => x.key === q('pt_role').value); if (r && r.sector) q('pt_sector').value = r.sector; };
  const ptLoad = guard(async () => {
    const o = await P('/'); SECT = o.sectors; ROLES = o.roles || [];
    q('pt_role').innerHTML = '<option value="">Choose a role (sets the sector)</option>' + ROLES.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
    q('pt_sector').innerHTML = SECT.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}: ${esc(s.who)}</option>`).join('');
    q('pt_list').innerHTML = o.partners.length ? `<table><tr><th>Who</th><th>Sector</th><th>Login</th><th>Numbers</th><th>Sees</th><th>Status</th><th></th></tr>${o.partners.map((p) => `<tr>
      <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.org)}${p.roleLabel ? ', ' + esc(p.roleLabel) : ''}</span></td>
      <td>${esc(p.sectorLabel)}${p.universalRequested ? '<br><b style="color:#c93a17">asked for universal</b>' : ''}</td>
      <td>${esc(p.handle)}<br><span class="muted">${p.lastLoginAt ? 'last in ' + esc(p.lastLoginAt.slice(0, 10)) : 'never signed in'}${p.mustChange ? ', temp password' : ''}</span></td>
      <td>${p.phones.map(esc).join('<br>') || '<span class="muted">none</span>'}</td><td>${p.view === 'all' ? 'all in line' : 'own only'}</td><td>${esc(p.status)}</td>
      <td>${p.universal ? `<button onclick="ptUni('${p.id}',false)">Withdraw universal</button>` : `<button class="${p.universalRequested ? 'primary' : ''}" onclick="ptUni('${p.id}',true)">Approve universal</button>`}
      <button onclick="ptPhones('${p.id}')">Numbers</button><button onclick="ptView('${p.id}','${p.view === 'all' ? 'mine' : 'all'}')">${p.view === 'all' ? 'Own only' : 'See all'}</button><button onclick="ptReset('${p.id}')">Reset password</button><button onclick="ptStatus('${p.id}','${p.status === 'active' ? 'suspended' : 'active'}')">${p.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td></tr>`).join('')}</table>` : 'No partner logins yet.';
  });
  const shown = (t, pw, extra) => { q('pt_new').innerHTML = `<div class="card" style="border:2px solid #f04a23;margin-top:12px"><b>${esc(t)}</b><br>Temporary password (shown once): <code style="font-size:18px;user-select:all">${esc(pw)}</code> <button onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(pw)}');toast('Copied')">Copy</button><div class="muted" style="font-size:13px">${esc(extra || '')} They must choose their own password at first sign in.</div></div>`; };
  window.ptLoad = ptLoad;
  window.ptCreate = guard(async () => {
    const o = await P('/', 'POST', { role: q('pt_role').value, name: q('pt_name').value, org: q('pt_org').value, handle: q('pt_handle').value, universal: q('pt_sector').value === 'universal', sector: q('pt_sector').value, phones: q('pt_phones').value, view: q('pt_view').value, sendSms: q('pt_sms').checked });
    shown(`Login ready for ${o.account.name} (${o.account.handle})`, o.temporaryPassword, o.sms ? (o.sms.ok ? (o.sms.sandbox ? 'SMS logged in sandbox, nothing delivered.' : 'SMS sent.') : 'SMS could not be sent, give them the password yourself.') : 'Give it to them yourself, or tick the SMS box next time.');
    ['pt_name', 'pt_org', 'pt_handle', 'pt_phones'].forEach((i) => { q(i).value = ''; }); ptLoad();
  });
  window.ptUni = guard(async (id, on) => { await P('/' + id + '/universal', 'POST', { approve: on }); toast(on ? 'Universal access approved' : 'Universal access withdrawn'); ptLoad(); });
  window.ptReset = guard(async (id) => { if (!confirm('Issue a new temporary password? Their current sessions end.')) return; const o = await P('/' + id + '/reset-password', 'POST', {}); shown('New password for ' + o.account.name, o.temporaryPassword); });
  window.ptStatus = guard(async (id, s) => { await P('/' + id, 'PATCH', { status: s }); ptLoad(); });
  window.ptView = guard(async (id, v) => { await P('/' + id, 'PATCH', { view: v }); ptLoad(); });
  window.ptPhones = guard(async (id) => { const v = prompt('Registered numbers, comma separated (these decide which requests they see):'); if (v === null) return; await P('/' + id, 'PATCH', { phones: v }); ptLoad(); });

  // ------------------------------------------------------------ ERHEAT: switches, ceilings, lender, requests
  mk('ERHEAT', 'erheat', `
    <div class="card" style="margin-bottom:14px"><h2>Account sign-up (ER HEAT and TrimesterSave)</h2><div id="eh_auth" class="muted">Loading</div></div>
    <div class="card" style="margin-bottom:14px"><h2>ERHEAT Shield: emergency loans</h2><div id="eh_cfg" class="muted">Loading</div></div>
    <div class="card" style="margin-bottom:14px"><h2>Lender hand-off</h2><div id="eh_hooks" class="muted"></div></div>
    <div class="card"><h2>Requests</h2><div id="eh_apps" class="muted"></div></div>`, () => ehLoad());
  const ehLoad = guard(async () => {
    const [o, apps, au] = await Promise.all([E('/config'), E('/apps'), call('/api/platform/patient-auth', '')]); const c = o.config;
    q('eh_auth').innerHTML = `<label><input type="checkbox" id="eh_rp" ${au.requirePhone ? 'checked' : ''} style="width:auto" onchange="ehAuth()"/> <b>Require a mobile phone to open an account</b></label>
      <p class="muted" style="font-size:13px;margin:6px 0 0">${au.requirePhone ? 'On: people must give a mobile number and confirm it by SMS code.' : 'Off: people may open an account with an email address instead, confirmed by an emailed code. Loans still need a confirmed mobile number, because lenders pay and contact borrowers on it.'} Existing accounts keep working either way. Email codes need EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM on the Biller.</p>`;
    q('eh_cfg').innerHTML = `<label><input type="checkbox" id="eh_on" ${c.enabled ? 'checked' : ''} style="width:auto"/> <b>ERHEAT is open to borrowers</b></label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="eh_rv" ${c.requireVerifiedPhone ? 'checked' : ''} style="width:auto"/> Borrowers must have a verified phone</label>
      <table style="margin-top:10px"><tr><th>Line</th><th>Open</th><th>Smallest (GHS)</th><th>Largest (GHS)</th><th>Verifier</th></tr>${Object.entries(o.lines).map(([k, l]) => `<tr><td><b>${esc(l.label)}</b>${l.voucher ? ' <span class="muted">(voucher)</span>' : ''}</td><td><input type="checkbox" id="eh_l_${k}" ${c.lines[k].enabled ? 'checked' : ''} style="width:auto"/></td><td><input id="eh_min_${k}" type="number" value="${c.lines[k].min}" style="width:90px"/></td><td><input id="eh_cap_${k}" type="number" value="${c.lines[k].cap}" max="${o.hardCap}" style="width:90px"/></td><td class="muted">${esc(l.verifier)}</td></tr>`).join('')}</table>
      <div class="row" style="margin-top:10px"><div class="field"><label>Limit for new borrowers</label><input id="eh_n" type="number" value="${c.ladder.new}"/></div><div class="field"><label>Trusted (1+ repaid)</label><input id="eh_t" type="number" value="${c.ladder.trusted}"/></div><div class="field"><label>Preferred (3+ repaid)</label><input id="eh_p" type="number" value="${c.ladder.preferred}"/></div><div class="field"><label>Hard cap</label><input value="${o.hardCap}" disabled/></div></div>
      <div class="row"><div class="field"><label>Open requests per borrower in 30 days</label><input id="eh_m" type="number" value="${c.maxApps30d}"/></div><div class="field"><label>Verifier has (hours)</label><input id="eh_vh" type="number" value="${c.verifierTtlHours}"/></div><div class="field"><label>Request lives (days)</label><input id="eh_ad" type="number" value="${c.appTtlDays}"/></div></div>
      <div class="row"><div class="field"><label>Lender name</label><input id="eh_ln" value="${esc(c.lender.name)}"/></div><div class="field"><label>Lender push URL (https)</label><input id="eh_lu" value="${esc(c.lender.pushUrl)}"/></div></div>
      <button class="primary" onclick="ehSave()">Save</button> <span class="muted" style="font-size:13px">The lender decides credit and moves the money. HNN never lends or holds funds.</span>`;
    q('eh_hooks').innerHTML = `<p style="margin-top:0">Give the lender these private URLs. They contain a secret, so share them only with the lender.</p><ul style="margin:0 0 8px 18px">${Object.entries(o.hookUrls).map(([k, u]) => `<li><b>${esc(k)}</b>: <code style="user-select:all">${esc(u)}</code></li>`).join('')}</ul><button onclick="ehRotate()">Rotate the secret</button>`;
    q('eh_apps').innerHTML = `<div class="muted" style="font-size:13px;margin-bottom:6px">${apps.total} requests${apps.flagged ? `, <b>${apps.flagged} flagged</b>` : ''}. ${Object.entries(apps.byStatus).map(([k, n]) => esc(k) + ' ' + n).join(', ')}</div>` + (apps.rows.length ? `<table><tr><th>Ref</th><th>Line</th><th>Borrower</th><th>Amount</th><th>Status</th><th>Payee</th><th>Flags</th><th>Sandbox</th></tr>${apps.rows.map((a) => `<tr><td>${esc(a.appNo)}</td><td>${esc(a.line)}</td><td>${esc(a.borrower)}<br><span class="muted">${esc(a.phone)}</span></td><td>${n2(a.verifiedAmount || a.amount)}</td><td>${esc(a.status)}</td><td>${esc(a.payee)}</td><td>${esc((a.flags || []).join(', '))}</td><td>${['submitted', 'approved', 'payee_paid', 'repaying'].includes(a.status) ? [['approve', 'Approve'], ['paid', 'Paid'], ['repay', 'Repay'], ['decline', 'Decline']].map((x) => `<button onclick="ehSim('${a.id}','${x[0]}')">${x[1]}</button>`).join('') : ''}</td></tr>`).join('')}</table>` : 'No requests yet.');
  });
  window.ehLoad = ehLoad;
  window.ehAuth = guard(async () => { await call('/api/platform/patient-auth', '', 'PUT', { requirePhone: q('eh_rp').checked }); toast(q('eh_rp').checked ? 'Mobile phone is now required' : 'Email sign-up is allowed'); ehLoad(); });
  window.ehSave = guard(async () => {
    const lines = {}; document.querySelectorAll('[id^="eh_l_"]').forEach((el) => { const k = el.id.slice(5); lines[k] = { enabled: el.checked, min: +q('eh_min_' + k).value, cap: +q('eh_cap_' + k).value }; });
    await E('/config', 'PUT', { enabled: q('eh_on').checked, requireVerifiedPhone: q('eh_rv').checked, lines, ladder: { new: +q('eh_n').value, trusted: +q('eh_t').value, preferred: +q('eh_p').value }, maxApps30d: +q('eh_m').value, verifierTtlHours: +q('eh_vh').value, appTtlDays: +q('eh_ad').value, lender: { name: q('eh_ln').value, pushUrl: q('eh_lu').value } });
    toast('Saved'); ehLoad();
  });
  window.ehRotate = guard(async () => { if (!confirm('Rotate the secret? The lender must switch to the new URLs.')) return; await E('/secret/rotate', 'POST', {}); toast('Secret rotated'); ehLoad(); });
  window.ehSim = guard(async (id, action) => { await E('/apps/' + id + '/simulate', 'POST', { action }); toast('Simulated: ' + action); ehLoad(); });
})();
