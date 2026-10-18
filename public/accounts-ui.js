/* Master Control: every account of every kind, in one place. Deactivate or reactivate, approve partner sign-ups, and
   give or take back clearances (Product Lab, sandbox to live). Loaded after erheat-ui.js; uses platform.html's H, esc, toast, tab. */
'use strict';
(function () {
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const first = document.getElementById('p-clients');
  if (!tabs || !first) return;
  const q = (id) => document.getElementById(id);
  const call = async (path, method, body) => {
    const r = await fetch('/api/platform' + path, { method: method || 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined });
    const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || ('HTTP ' + r.status)); return o;
  };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
  const b = document.createElement('button'); b.textContent = 'Accounts'; b.onclick = () => { tab('accounts', b); acLoad(); }; tabs.appendChild(b);
  const p = document.createElement('div'); p.className = 'panel'; p.id = 'p-accounts';
  p.innerHTML = `<div class="card" style="margin-bottom:14px"><h2>All accounts</h2>
    <p class="muted" style="font-size:13px;margin-top:0">Every kind of account in one list: patients, ER HEAT partners, hospitals and clinics, insurers, EMR/EHR providers and console staff. Deactivating an account stops its sign-in and API access at once. Clearances decide what an account may use: Product Lab, and switching from sandbox to live. Staff keep both until you take one away. The master key is never restricted.</p>
    <div id="ac_kinds" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"></div>
    <div class="row"><div class="field"><label>Search</label><input id="ac_q" placeholder="Name, organisation, phone, email or id" oninput="acSoon()"/></div>
    <div class="field"><label>State</label><select id="ac_state" onchange="acLoad()"><option value="">Any</option><option value="active">Active</option><option value="pending">Waiting for approval</option><option value="disabled">Deactivated</option><option value="rejected">Not approved</option><option value="suspended">Suspended</option></select></div></div></div>
    <div class="card"><div id="ac_list" class="muted">Loading</div></div>`;
  first.parentNode.appendChild(p);
  let KIND = ''; let timer = null; let SECT = [];
  const pill = (t, hot) => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;background:${hot ? '#ffe9a8' : '#e6edf3'}">${esc(t)}</span>`;
  const stateOf = (r) => ({ active: pill('Active'), pending: pill('Waiting for approval', true), disabled: pill('Deactivated', true), rejected: pill('Not approved'), suspended: pill('Suspended', true) }[r.state] || pill(r.state));
  window.acSoon = () => { clearTimeout(timer); timer = setTimeout(acLoad, 250); };
  window.acKind = (k) => { KIND = KIND === k ? '' : k; acLoad(); };
  const acLoad = guard(async () => {
    const qs = new URLSearchParams(); if (KIND) qs.set('kind', KIND); if (q('ac_q').value.trim()) qs.set('q', q('ac_q').value.trim()); if (q('ac_state').value) qs.set('status', q('ac_state').value);
    const [d, pt] = await Promise.all([call('/accounts?' + qs), SECT.length ? null : call('/partners')]); if (pt) SECT = pt.sectors.filter((s) => s.key !== 'universal');
    q('ac_kinds').innerHTML = `<button onclick="acKind('')" class="${KIND ? '' : 'primary'}">All</button>` + d.kinds.map((k) => `<button class="${KIND === k.key ? 'primary' : ''}" onclick="acKind('${k.key}')">${esc(k.label)} (${k.total}${k.pending ? ', ' + k.pending + ' waiting' : ''}${k.disabled ? ', ' + k.disabled + ' off' : ''})</button>`).join('');
    const kl = Object.fromEntries(d.kinds.map((k) => [k.key, k.label]));
    q('ac_list').innerHTML = d.rows.length ? `<table><tr><th>Account</th><th>Kind</th><th>Contact</th><th>State</th><th>Clearances</th><th></th></tr>${d.rows.map((r) => {
      const gs = Object.keys(r.grants || {}); const k = r.kind + '/' + encodeURIComponent(r.id);
      const approve = r.kind === 'partner' && r.state === 'pending' ? `<div style="margin-top:6px"><select id="ap_s_${esc(r.id)}">${SECT.map((s) => `<option value="${esc(s.key)}" ${s.key === r.sector ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <label style="font-size:12px"><input type="checkbox" id="ap_v_${esc(r.id)}" style="width:auto"/> sees every request in its line</label>
        <button class="primary" onclick="acApprove('${esc(r.id)}')">Approve</button><button onclick="acReject('${esc(r.id)}')">Decline</button></div>` : '';
      return `<tr><td><b>${esc(r.name)}</b><br><span class="muted">${esc([r.org, r.role].filter(Boolean).join(', '))}</span></td><td>${esc(kl[r.kind] || r.kind)}</td>
      <td>${esc(r.phone || '')}${r.phone && r.email ? '<br>' : ''}${esc(r.email || '')}</td><td>${stateOf(r)}${r.reason ? '<br><span class="muted">' + esc(r.reason) + '</span>' : ''}${approve}</td>
      <td>${gs.length ? gs.map((g) => `<label style="display:block;font-size:12px"><input type="checkbox" style="width:auto" ${r.grants[g] ? 'checked' : ''} onchange="acGrant('${k}','${g}',this.checked)"/> ${esc(d.grants[g] || g)}</label>`).join('') : '<span class="muted">none apply</span>'}</td>
      <td>${r.state === 'pending' || r.state === 'rejected' ? '' : r.disabled ? `<button class="primary" onclick="acToggle('${k}',false)">Reactivate</button>` : `<button onclick="acToggle('${k}',true)">Deactivate</button>`}</td></tr>`;
    }).join('')}</table>${d.total > d.rows.length ? `<p class="muted">Showing ${d.rows.length} of ${d.total}. Narrow the search to see the rest.</p>` : ''}` : '<span class="muted">No accounts match.</span>';
  });
  window.acLoad = acLoad;
  window.acToggle = guard(async (k, off) => { let reason = ''; if (off) { reason = prompt('Why is this account being deactivated? (shown to you only)'); if (reason === null) return; } await call('/accounts/' + k, 'PATCH', { disabled: off, reason }); toast(off ? 'Deactivated' : 'Reactivated'); acLoad(); });
  window.acGrant = guard(async (k, g, on) => { await call('/accounts/' + k, 'PATCH', { grants: { [g]: on } }); toast((on ? 'Cleared: ' : 'Withdrawn: ') + g); });
  window.acApprove = guard(async (id) => { await call('/partners/' + id + '/approve', 'POST', { sector: q('ap_s_' + id).value, view: q('ap_v_' + id).checked ? 'all' : 'mine' }); toast('Approved. They can sign in now.'); acLoad(); });
  window.acReject = guard(async (id) => { const reason = prompt('Reason to show them (optional):'); if (reason === null) return; await call('/partners/' + id + '/reject', 'POST', { reason }); toast('Declined'); acLoad(); });
})();
