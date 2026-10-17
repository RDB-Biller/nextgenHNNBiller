/* Master Control: community outreach (verified contributions, channels, held-country offices) inside the Outreach tab,
   and Product Lab working groups inside the Product Lab tab. Loaded after outreach-ui.js. */
'use strict';
(function () {
  const outPanel = document.getElementById('p-outreach'); const labPanel = document.getElementById('p-pde');
  if (!outPanel) return;
  const api = async (path, method = 'GET', body) => {
    const r = await fetch('/api/platform/outreach' + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
    const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || ('HTTP ' + r.status)); return o;
  };
  const q = (id) => document.getElementById(id);
  const msg = (t) => { try { toast(t); } catch (e) { alert(t); } };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { msg(e.message); } };
  const link = (u) => (/^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u));

  outPanel.insertAdjacentHTML('beforeend', `
  <div class="card" style="margin-bottom:14px"><h2>Community: fans fill the gaps, you verify</h2>
    <p class="muted" style="font-size:13px">Share <b>/o/contribute</b> (add a public business contact with its source), <b>/o/community</b> (leaderboard and gap board) and the invite tab that now appears on every page. Each contributor gets a personal referral link, so every verified entry and invitation is traceable for rewards.</p>
    <div class="row"><button class="primary" onclick="cmGhana()">Load Ghana healthcare group</button><button onclick="cmGroupOffices()">Attach known offices of ZA / Europe groups</button><button onclick="cmLoad()">Refresh</button></div>
    <p class="muted" id="cm_msg" style="font-size:13px"></p>
    <h3>Waiting for your verification</h3><div id="cm_subs"></div>
    <h3>Held countries you can still reach through another office</h3><div id="cm_held"></div>
    <h3>Channels: email, SMS, WhatsApp</h3><div id="cm_ch"></div>
    <div class="row"><div class="field"><label>Send a test to yourself</label><select id="cm_tc"><option>email</option><option>sms</option><option>whatsapp</option></select></div><div class="field"><label>Your address or number</label><input id="cm_tt" placeholder="you@company.com or +233..."/></div><div class="field" style="display:flex;align-items:flex-end"><button onclick="cmTest()">Send test</button></div></div>
  </div>`);

  window.cmGhana = guard(async () => { const r = await api('/packs/ghana-healthcare', 'POST'); q('cm_msg').textContent = `Ghana healthcare group: ${r.inGroup} organisations (${r.added} added). Contacts are not included: add them from public pages or let contributors fill them in.`; if (window.ouLoad) ouLoad(); });
  window.cmGroupOffices = guard(async () => { const r = await api('/packs/group-offices', 'POST'); q('cm_msg').textContent = `Attached ${r.offices} offices to ${r.orgsTouched} organisations. They are starter data: verify each on the company's public contact page.`; cmLoad(); });
  window.cmReview = guard(async (id, action) => { const note = action === 'reject' ? (prompt('Reason (optional)') || '') : ''; await api('/contributions/' + id + '/review', 'POST', { action, note }); msg(action === 'approve' ? 'Approved: contact added, contributor credited' : 'Rejected'); cmLoad(); if (window.ouContacts) ouContacts(); });
  window.cmTest = guard(async () => { const r = await api('/channels/test', 'POST', { channel: q('cm_tc').value, to: q('cm_tt').value }); msg(r.ok ? (r.sandbox ? 'Sandbox: logged, nothing was sent (switch messaging to live)' : 'Sent') : 'Not sent: ' + (r.error || 'unknown')); });
  window.cmLoad = guard(async () => {
    const [subs, held, ch] = await Promise.all([api('/contributions'), api('/held-offices'), api('/channels')]);
    q('cm_subs').innerHTML = subs.rows.length ? `<table><tr><th>Contributor</th><th>For</th><th>Contact</th><th>Source (open it, then decide)</th><th></th></tr>${subs.rows.map((s) => `<tr><td>${esc(s.submitter.name)}<div class="muted" style="font-size:12px">${esc(s.submitter.email)} ${esc(s.submitter.org || '')} ${esc(s.submitter.relation || '')}</div></td><td>${esc(s.target.orgName || s.target.orgId)}<div class="muted" style="font-size:12px">${esc(s.target.country)} ${s.target.officeCc ? '· office ' + esc(s.target.officeCc) + ' ' + esc(s.target.city) : ''}</div></td><td>${esc(s.target.name || '(team mailbox)')} ${esc(s.target.role)}<div class="muted" style="font-size:12px">${esc(s.target.email)} ${esc((s.target.phones || []).join(', '))}</div></td><td style="word-break:break-all">${link(s.source)}</td><td><button class="primary" onclick="cmReview('${s.id}','approve')">Verify and add</button> <button onclick="cmReview('${s.id}','reject')">Reject</button></td></tr>`).join('')}</table>` : '<div class="muted">Nothing waiting.</div>';
    q('cm_held').innerHTML = `<div class="muted" style="font-size:13px">${held.total} organisations are in countries awaiting legal review; ${held.withOpenOffice} of them have an office in an open country.</div>` + (held.rows.length ? `<table><tr><th>Organisation</th><th>Home</th><th>Open offices</th><th>Contacts</th><th></th></tr>${held.rows.slice(0, 40).map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.country)}</td><td>${o.openOffices.map((f) => esc(f.cc + ' ' + f.city)).join(' · ') || '<span class="muted">none yet</span>'}</td><td>${o.contacts}</td><td><button onclick="ouOffices('${o.id}')">Offices</button></td></tr>`).join('')}</table>` : '');
    q('cm_ch').innerHTML = `<ul style="margin:0 0 8px 18px"><li>Email: ${ch.email.configured ? '<b>configured</b> (' + esc(ch.email.provider) + ')' : '<b>not configured.</b> ' + esc(ch.email.howTo)}</li><li>SMS / WhatsApp: ${ch.sms.providerReady ? '<b>provider ready</b> (' + esc(ch.sms.provider) + ')' : '<b>no provider yet.</b> ' + esc(ch.sms.howTo)}${ch.sms.sandbox ? ' <b>Messaging is in sandbox: nothing is really sent.</b>' : ''}</li><li>FormSubmit alerts: ${ch.formsubmit.configured ? 'on' : 'off'} <span class="muted">${esc(ch.formsubmit.note)}</span></li><li>Outreach engine: ${ch.outreach.enabled ? 'enabled' : 'off'}${ch.outreach.readyToSend ? '' : ' (settings incomplete)'}</li></ul>`;
  });
  const oldLoad = window.ouLoad; if (oldLoad) window.ouLoad = async (...a) => { const r = await oldLoad(...a); cmLoad(); return r; };

  // ------------------------------------------------ Product Lab working groups
  if (!labPanel) return;
  labPanel.insertAdjacentHTML('beforeend', `
  <div class="card" style="margin-top:14px"><h2>Working groups: co-create across companies, countries and languages</h2>
    <p class="muted" style="font-size:13px">Invite-only rooms. Everyone writes in their own language and reads in theirs (the translator). Members join from a link that carries their inviter's referral code, so the people who bring colleagues in are credited, and you can see who invited whom. Promote a shortlisted idea into a Product Lab brief.</p>
    <div class="row"><div class="field"><label>Group name</label><input id="lg_n" placeholder="Claims automation co-lab"/></div><div class="field"><label>Topic</label><input id="lg_t"/></div><div class="field"><label>Challenge this week</label><input id="lg_c"/></div><div class="field"><label>Product Lab product id (optional)</label><input id="lg_p"/></div>
      <div class="field" style="display:flex;align-items:flex-end"><button class="primary" onclick="lgCreate()">Create group</button></div></div>
    <div id="lg_list"></div><div id="lg_detail" style="margin-top:10px"></div></div>`);
  const lab = async (path, method = 'GET', body) => api('/lab' + path, method, body);
  window.lgCreate = guard(async () => { const g = await lab('/groups', 'POST', { name: q('lg_n').value, topic: q('lg_t').value, challenge: q('lg_c').value, productId: q('lg_p').value || undefined }); ['lg_n', 'lg_t', 'lg_c', 'lg_p'].forEach((i) => { q(i).value = ''; }); msg('Group created. Share its link.'); lgLoad(); lgOpen(g.id); });
  window.lgLoad = guard(async () => {
    const r = await lab('/groups'); const base = location.origin;
    q('lg_list').innerHTML = r.groups.length ? `<table><tr><th>Group</th><th>Members</th><th>Languages</th><th>Countries</th><th>Ideas</th><th>Join link</th><th></th></tr>${r.groups.map((g) => `<tr><td>${esc(g.name)}<div class="muted" style="font-size:12px">${esc(g.topic)}${g.productId ? ' · product ' + esc(g.productId) : ''}</div></td><td>${g.members}</td><td>${g.languages.map(esc).join(' ')}</td><td>${g.countries.map(esc).join(' ')}</td><td>${g.ideas}</td><td><button onclick="navigator.clipboard.writeText('${base}/o/lab/${esc(g.code)}');toast('Link copied')">Copy</button></td><td><button onclick="lgOpen('${g.id}')">Open</button></td></tr>`).join('')}</table>` : '<div class="muted">No groups yet.</div>';
  });
  window.lgOpen = guard(async (id) => {
    const g = await lab('/groups/' + id);
    q('lg_detail').innerHTML = `<h3>${esc(g.name)}</h3><div class="muted" style="font-size:13px">Link: ${esc(location.origin)}/o/lab/${esc(g.code)}</div>
    <div class="row"><div class="field"><label>Challenge</label><input id="lgd_c" value="${esc(g.challenge)}"/></div><div class="field"><label>Product Lab product id</label><input id="lgd_p" value="${esc(g.productId)}"/></div><div class="field" style="display:flex;align-items:flex-end;gap:6px"><button onclick="lgSave('${g.id}')">Save</button><button onclick="lgClose('${g.id}','${g.status === 'open' ? 'closed' : 'open'}')">${g.status === 'open' ? 'Close group' : 'Reopen'}</button></div></div>
    <h4>Members</h4><table><tr><th>Name</th><th>Organisation</th><th>Country</th><th>Language</th><th>Role</th><th>Invited by</th></tr>${g.members.map((m) => `<tr><td>${esc(m.name)}<div class="muted" style="font-size:12px">${esc(m.email)}</div></td><td>${esc(m.org)}</td><td>${esc(m.cc)}</td><td>${esc(m.lang)}</td><td>${esc(m.role)}</td><td>${esc(m.invitedBy)}</td></tr>`).join('')}</table>
    ${g.sameCompanyAcrossCountries.length ? '<h4>Same company, different geographies or languages</h4>' + g.sameCompanyAcrossCountries.map((t) => `<div>${esc(t.org)}: ${t.members.map((m) => esc(m.name + ' (' + (m.cc || '?') + ', ' + m.lang + ')')).join(', ')}</div>`).join('') : ''}
    <h4>Ideas</h4>${g.ideas.length ? g.ideas.map((i) => `<div style="border-top:1px solid var(--line,#ddd);padding:6px 0"><b>${esc(i.title)}</b> · ${i.votes} votes · ${esc(i.status)} · by ${esc(i.by || '')}<div class="muted" style="font-size:13px">${esc(i.problem)} ${esc(i.proposal)} ${esc(i.metric)}</div><button onclick="lgIdea('${g.id}','${i.id}','shortlisted')">Shortlist</button> <button onclick="lgIdea('${g.id}','${i.id}','promoted')">Promote to Product Lab brief</button> <button onclick="lgIdea('${g.id}','${i.id}','parked')">Park</button> <button onclick="lgIdeaDel('${g.id}','${i.id}')">Remove</button></div>`).join('') : '<div class="muted">No ideas yet.</div>'}`;
  });
  window.lgSave = guard(async (id) => { await lab('/groups/' + id, 'PATCH', { challenge: q('lgd_c').value, productId: q('lgd_p').value }); msg('Saved'); lgOpen(id); lgLoad(); });
  window.lgClose = guard(async (id, status) => { await lab('/groups/' + id, 'PATCH', { status }); lgOpen(id); lgLoad(); });
  window.lgIdea = guard(async (gid, iid, status) => { const r = await lab('/groups/' + gid + '/ideas/' + iid, 'PATCH', { status }); if (r.brief) { prompt('Product Lab brief (copy it into a new product):', JSON.stringify(r.brief, null, 2)); } lgOpen(gid); });
  window.lgIdeaDel = guard(async (gid, iid) => { if (!confirm('Remove this idea?')) return; await lab('/groups/' + gid + '/ideas/' + iid, 'PATCH', { remove: true }); lgOpen(gid); });
  lgLoad();
})();
