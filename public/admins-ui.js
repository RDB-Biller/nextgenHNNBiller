/* Master Control (chief administrator only): invite sub-admins, choose what each may open, suspend or re-invite them. */
'use strict';
(function () {
  if (window.ADMIN_MODE === 'sub') return;
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const first = document.getElementById('p-clients'); if (!tabs || !first) return;
  const q = (id) => document.getElementById(id);
  const call = async (path, method, body) => { const r = await fetch('/api/platform/admins' + path, { method: method || 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined }); const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || 'HTTP ' + r.status); return o; };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
  const b = document.createElement('button'); b.textContent = 'Admins'; b.onclick = () => { tab('admins', b); adLoad(); }; tabs.appendChild(b);
  const p = document.createElement('div'); p.className = 'panel'; p.id = 'p-admins';
  p.innerHTML = `<div class="card" style="margin-bottom:14px"><h2>Invite an admin</h2>
    <p class="muted" style="font-size:13px;margin-top:0">Sub-admins open <b>/app/platform.html</b> (not this page). They get an invite link, choose their own password, and see only the areas you give them. There is no shared key and no default password. This page and the platform key stay with you.</p>
    <div class="row"><div class="field"><label>Name</label><input id="ad_name"/></div><div class="field"><label>Email</label><input id="ad_email" type="email"/></div><div class="field"><label>Mobile (optional)</label><input id="ad_phone"/></div></div>
    <div class="row"><div class="field"><label>Role</label><select id="ad_preset" onchange="adPreset()"></select></div><div class="field" style="display:flex;align-items:flex-end"><label style="font-size:13px"><input type="checkbox" id="ad_ro" style="width:auto"/> Read-only (can look, cannot change)</label></div></div>
    <div id="ad_areas" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:4px;margin:8px 0"></div>
    <label style="font-size:13px"><input type="checkbox" id="ad_sms" style="width:auto"/> Send the invite link by SMS</label>
    <div class="row" style="margin-top:8px"><button class="primary" onclick="adInvite()">Create invite</button></div><div id="ad_new"></div></div>
    <div class="card"><h2>Admins</h2><div id="ad_list" class="muted">Loading</div></div>`;
  first.parentNode.appendChild(p);
  let D = { areas: [], presets: [], admins: [] };
  const checked = () => [...document.querySelectorAll('#ad_areas input:checked')].map((i) => i.value);
  const drawAreas = (sel) => { q('ad_areas').innerHTML = D.areas.map((a) => `<label style="font-size:13px"><input type="checkbox" value="${esc(a.key)}" style="width:auto" ${sel.includes(a.key) ? 'checked' : ''}/> ${esc(a.label)}</label>`).join(''); };
  window.adPreset = () => { const pr = D.presets.find((x) => x.key === q('ad_preset').value); drawAreas(pr ? pr.areas : []); };
  const adLoad = guard(async () => {
    D = await call('/'); q('ad_preset').innerHTML = D.presets.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join(''); adPreset();
    q('ad_list').innerHTML = D.admins.length ? `<table><tr><th>Who</th><th>Role</th><th>Can open</th><th>Status</th><th></th></tr>${D.admins.map((a) => `<tr><td><b>${esc(a.name)}</b><br><span class="muted">${esc(a.handle)}</span></td><td>${esc(a.presetLabel)}${a.readOnly ? '<br><span class="muted">read-only</span>' : ''}</td><td>${a.areaLabels.map(esc).join('<br>')}</td><td>${esc(a.status)}<br><span class="muted">${a.lastLoginAt ? 'last in ' + esc(a.lastLoginAt.slice(0, 10)) : 'never signed in'}</span></td>
      <td><button onclick="adAreas('${a.id}')">Change areas</button><button onclick="adRO('${a.id}',${!a.readOnly})">${a.readOnly ? 'Allow changes' : 'Make read-only'}</button><button onclick="adInv('${a.id}')">New invite</button>${a.status === 'active' ? `<button onclick="adStatus('${a.id}','suspended')">Suspend</button>` : a.status === 'suspended' ? `<button class="primary" onclick="adStatus('${a.id}','active')">Reactivate</button>` : ''}<button onclick="adRemove('${a.id}')">Remove</button></td></tr>`).join('')}</table>` : '<span class="muted">No admins yet.</span>';
  });
  const shown = (o, label) => { q('ad_new').innerHTML = `<div class="card" style="border:2px solid #f04a23;margin-top:12px"><b>${esc(label)}</b><br>Invite link (shown once, valid ${o.expiresInDays} days):<br><code style="user-select:all;word-break:break-all">${esc(o.inviteLink)}</code> <button onclick="navigator.clipboard&&navigator.clipboard.writeText(${JSON.stringify(o.inviteLink).replace(/"/g, '&quot;')});toast('Copied')">Copy</button><br><span class="muted">${o.sms ? (o.sms.ok ? (o.sms.sandbox ? 'SMS logged in sandbox, nothing delivered.' : 'SMS sent.') : 'SMS could not be sent, share the link yourself.') : 'Send it to them yourself, or tick the SMS box next time.'}</span></div>`; };
  window.adInvite = guard(async () => { const o = await call('/', 'POST', { name: q('ad_name').value, email: q('ad_email').value, phone: q('ad_phone').value, preset: q('ad_preset').value, areas: checked(), readOnly: q('ad_ro').checked, sendSms: q('ad_sms').checked }); shown(o, 'Invite ready for ' + o.account.name); ['ad_name', 'ad_email', 'ad_phone'].forEach((i) => { q(i).value = ''; }); adLoad(); });
  window.adInv = guard(async (id) => { if (!confirm('Issue a new invite? Their current password stops working until they use it.')) return; shown(await call('/' + id + '/invite', 'POST', {}), 'New invite'); adLoad(); });
  window.adStatus = guard(async (id, s) => { await call('/' + id, 'PATCH', { status: s }); adLoad(); });
  window.adRO = guard(async (id, v) => { await call('/' + id, 'PATCH', { readOnly: v }); adLoad(); });
  window.adAreas = guard(async (id) => { const a = D.admins.find((x) => x.id === id); const v = prompt('Areas, comma separated.\nAvailable: ' + D.areas.map((x) => x.key).join(', '), a.areas.join(', ')); if (v === null) return; await call('/' + id, 'PATCH', { preset: 'custom', areas: v.split(',').map((s) => s.trim()).filter(Boolean) }); adLoad(); });
  window.adRemove = guard(async (id) => { if (!confirm('Remove this admin for good?')) return; await call('/' + id, 'DELETE'); adLoad(); });
})();
