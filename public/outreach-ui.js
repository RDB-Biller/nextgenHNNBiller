/* Master Control > Outreach: B2B prospecting to get banks, insurers, core-banking / EHR / adjudication vendors and
   hospitals into the sandbox. Loaded after platform-extra.js (uses $, H, esc, toast, tab from platform.html). */
'use strict';
(function () {
  const api = async (path, method = 'GET', body) => {
    const r = await fetch('/api/platform/outreach' + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
    const o = await r.json().catch(() => null);
    if (!r.ok) throw new Error((o && (o.message || o.error)) || ('HTTP ' + r.status));
    return o;
  };
  const q = (id) => document.getElementById(id);
  const TYPES = ['bank', 'insurer', 'reinsurer', 'core_banking', 'ehr', 'adjudication', 'hospital', 'other'];
  const PERSONAS = ['ceo', 'cto', 'cmo', 'product', 'sales', 'claims', 'ops', 'other'];
  const opt = (a, sel) => a.map((x) => `<option value="${x}"${x === sel ? ' selected' : ''}>${x.replace('_', ' ')}</option>`).join('');
  let ORGS = [];

  const tabs = document.querySelector('.tabs:not(.subtabs)');
  const firstPanel = document.getElementById('p-clients');
  if (!tabs || !firstPanel) return;
  const btn = document.createElement('button'); btn.textContent = 'Outreach'; btn.onclick = () => { tab('outreach', btn); ouLoad(); };
  tabs.appendChild(btn);
  const panel = document.createElement('div'); panel.className = 'panel'; panel.id = 'p-outreach';
  panel.innerHTML = `
  <div class="card" style="margin-bottom:14px"><h2>Outreach: get decision makers into the sandbox</h2>
    <p class="muted" style="margin-top:0;font-size:13px">Business contacts only, each with a public source. Every message carries who we are and a one-click opt-out; STOP replies and unsubscribes are permanent across all channels. <b>LinkedIn is never automated</b> (it creates tasks you send by hand) and <b>WhatsApp only goes to people who replied or opted in</b>. Nothing sends until the switch below is on, your identity and address are set, and the provider is live.</p>
    <div id="ou_kpis" class="muted" style="font-size:13px"></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Settings</h2>
    <div class="row">
      <div class="field"><label>Sender name</label><input id="ou_name"/></div><div class="field"><label>Sender role</label><input id="ou_role"/></div>
      <div class="field"><label>Organisation</label><input id="ou_org"/></div><div class="field"><label>Reply-to email</label><input id="ou_reply"/></div></div>
    <div class="row"><div class="field"><label>Postal address (shown in every email)</label><input id="ou_addr"/></div>
      <div class="field"><label>Public base URL of this Biller (for links)</label><input id="ou_base" placeholder="https://hnnbiller.xchangeinsure.com"/></div>
      <div class="field"><label>Sandbox link target</label><input id="ou_sbx"/></div></div>
    <div class="row"><div class="field"><label>Daily cap: email</label><input id="ou_ce" type="number"/></div><div class="field"><label>SMS</label><input id="ou_cs" type="number"/></div><div class="field"><label>WhatsApp</label><input id="ou_cw" type="number"/></div>
      <div class="field"><label>Sending hours (UTC) from</label><input id="ou_hf" type="number"/></div><div class="field"><label>to</label><input id="ou_ht" type="number"/></div></div>
    <p><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ou_on"/> Outreach ON (sweeps send due steps every 30 minutes)</label>
    <button class="primary" onclick="ouSaveCfg()">Save</button> <span class="muted" id="ou_cfgmsg"></span></p></div>
  <div class="card" style="margin-bottom:14px"><h2>Organisations</h2>
    <div class="row"><div class="field"><label>Type</label><select id="ou_ftype"><option value="">All</option>${opt(TYPES)}</select></div>
      <div class="field"><label>Search</label><input id="ou_fq" placeholder="name or country"/></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:6px"><button onclick="ouOrgs()">Filter</button><button onclick="ouSeed()">Load seed lists</button></div></div>
    <div id="ou_orgs" style="margin-top:8px"></div>
    <div class="row" style="margin-top:8px"><div class="field"><label>Add organisation</label><input id="ou_on_name"/></div><div class="field"><label>Type</label><select id="ou_on_type">${opt(TYPES)}</select></div><div class="field"><label>Country</label><input id="ou_on_c"/></div>
      <div class="field" style="display:flex;align-items:flex-end"><button onclick="ouAddOrg()">Add</button></div></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Contacts</h2>
    <div class="row"><div class="field"><label>Organisation</label><select id="ou_co"></select></div><div class="field"><label>Name</label><input id="ou_cn"/></div><div class="field"><label>Role</label><input id="ou_cr"/></div>
      <div class="field"><label>Persona</label><select id="ou_cp">${opt(PERSONAS, 'other')}</select></div></div>
    <div class="row"><div class="field"><label>Work email</label><input id="ou_ce2"/></div><div class="field"><label>Phone</label><input id="ou_cph"/></div><div class="field"><label>LinkedIn URL</label><input id="ou_cli"/></div>
      <div class="field"><label>Language</label><input id="ou_cl" placeholder="en, fr, pt, ar..."/></div><div class="field"><label>Public source (required)</label><input id="ou_csrc" placeholder="URL of the page"/></div>
      <div class="field" style="display:flex;align-items:flex-end"><button class="primary" onclick="ouAddContact()">Add contact</button></div></div>
    <details style="margin:8px 0"><summary>Bulk import (JSON rows)</summary>
      <textarea id="ou_imp" rows="5" style="width:100%" placeholder='[{"org":"Zenith Bank Ghana","name":"A B","role":"CTO","persona":"cto","email":"a@x.com","source":"https://...","lang":"en"}]'></textarea>
      <button onclick="ouImport()">Import</button> <span class="muted" id="ou_impmsg"></span></details>
    <div class="row"><div class="field"><label>Status</label><select id="ou_cs2"><option value="">All</option><option>new</option><option>queued</option><option>contacted</option><option>replied</option><option>sandbox</option><option>meeting</option><option>declined</option></select></div>
      <div class="field"><label>Search</label><input id="ou_cq"/></div><div class="field" style="display:flex;align-items:flex-end"><button onclick="ouContacts()">Filter</button></div></div>
    <div id="ou_contacts" style="margin-top:8px"></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Run a campaign</h2>
    <div class="row"><div class="field"><label>Organisation type</label><select id="ou_et"><option value="">All</option>${opt(TYPES)}</select></div>
      <div class="field"><label>Persona</label><select id="ou_ep"><option value="">All</option>${opt(PERSONAS)}</select></div>
      <div class="field"><label>Sequence</label><select id="ou_es"></select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:6px"><button onclick="ouEnroll()">Enrol new contacts</button><button onclick="ouRun(true)">Dry-run</button><button class="primary" onclick="ouRun(false)">Send due now</button></div></div>
    <pre id="ou_run" class="muted" style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto"></pre></div>
  <div class="card" style="margin-bottom:14px"><h2>LinkedIn tasks (send by hand)</h2><div id="ou_tasks"></div></div>
  <div class="card"><h2>Feedback from the sandbox</h2><div id="ou_fb"></div></div>`;
  firstPanel.parentNode.insertBefore(panel, firstPanel.nextSibling);

  const msg = (t) => { try { toast(t); } catch (e) { alert(t); } };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { msg(e.message); } };

  window.ouLoad = guard(async () => {
    const [ov, cfg, seqs] = await Promise.all([api('/overview'), api('/config'), api('/sequences')]);
    q('ou_kpis').innerHTML = `<b>${ov.orgs}</b> organisations · <b>${ov.contacts}</b> contacts (${ov.withEmail} email, ${ov.withPhone} phone) · <b>${ov.sandboxVisitors}</b> opened the sandbox · <b>${ov.feedback}</b> feedback · <b>${ov.openTasks}</b> LinkedIn tasks · sent today: email ${ov.sentToday.email}, SMS ${ov.sentToday.sms}, WhatsApp ${ov.sentToday.whatsapp} · suppressed: ${ov.suppressed}<br>Contacts: ${Object.entries(ov.contactsByStatus).map(([k, v]) => k + ' ' + v).join(' · ') || 'none yet'}`;
    q('ou_name').value = cfg.senderName; q('ou_role').value = cfg.senderRole; q('ou_org').value = cfg.senderOrg; q('ou_reply').value = cfg.replyTo; q('ou_addr').value = cfg.postalAddress; q('ou_base').value = cfg.publicBaseUrl || location.origin; q('ou_sbx').value = cfg.sandboxUrl;
    q('ou_ce').value = cfg.caps.email; q('ou_cs').value = cfg.caps.sms; q('ou_cw').value = cfg.caps.whatsapp; q('ou_hf').value = cfg.hours.from; q('ou_ht').value = cfg.hours.to; q('ou_on').checked = cfg.enabled;
    q('ou_cfgmsg').textContent = cfg.readyToSend ? 'Ready to send' + (cfg.emailConfigured ? '' : ' (email provider not configured: email will not go out)') : 'Missing: ' + cfg.missing.join(', ');
    q('ou_es').innerHTML = seqs.sequences.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    await ouOrgs(); await ouContacts(); await ouTasks(); await ouFb();
  });
  window.ouSaveCfg = guard(async () => {
    await api('/config', 'PUT', { senderName: q('ou_name').value, senderRole: q('ou_role').value, senderOrg: q('ou_org').value, replyTo: q('ou_reply').value, postalAddress: q('ou_addr').value, publicBaseUrl: q('ou_base').value, sandboxUrl: q('ou_sbx').value, enabled: q('ou_on').checked, caps: { email: q('ou_ce').value, sms: q('ou_cs').value, whatsapp: q('ou_cw').value }, hours: { from: q('ou_hf').value, to: q('ou_ht').value } });
    msg('Saved'); ouLoad();
  });
  window.ouSeed = guard(async () => { const r = await api('/seed', 'POST'); msg(`Added ${r.added} organisations (${r.total} total)`); ouLoad(); });
  window.ouOrgs = guard(async () => {
    const r = await api('/orgs?pageSize=100&type=' + encodeURIComponent(q('ou_ftype').value) + '&q=' + encodeURIComponent(q('ou_fq').value));
    ORGS = r.rows; q('ou_co').innerHTML = ORGS.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    q('ou_orgs').innerHTML = `<div class="muted" style="font-size:12px">${r.total} match (showing ${r.rows.length})</div><table><tr><th>Organisation</th><th>Type</th><th>Country</th><th>Status</th><th>Contacts</th></tr>${r.rows.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.type}</td><td>${esc(o.country)}</td><td>${o.status}</td><td>${o.contacts}</td></tr>`).join('')}</table>`;
  });
  window.ouAddOrg = guard(async () => { await api('/orgs', 'POST', { name: q('ou_on_name').value, type: q('ou_on_type').value, country: q('ou_on_c').value }); q('ou_on_name').value = ''; ouOrgs(); });
  window.ouAddContact = guard(async () => {
    await api('/contacts', 'POST', { orgId: q('ou_co').value, name: q('ou_cn').value, role: q('ou_cr').value, persona: q('ou_cp').value, email: q('ou_ce2').value, phone: q('ou_cph').value, linkedin: q('ou_cli').value, lang: q('ou_cl').value || undefined, source: q('ou_csrc').value });
    ['ou_cn', 'ou_cr', 'ou_ce2', 'ou_cph', 'ou_cli', 'ou_csrc'].forEach((i) => { q(i).value = ''; }); msg('Contact added'); ouContacts();
  });
  window.ouImport = guard(async () => { const rows = JSON.parse(q('ou_imp').value); const r = await api('/contacts/import', 'POST', { rows }); q('ou_impmsg').textContent = `Added ${r.added}; rejected ${r.rejected.length}` + (r.rejected.length ? ': ' + r.rejected.slice(0, 5).map((x) => `row ${x.row} ${x.error}`).join('; ') : ''); ouContacts(); });
  window.ouContacts = guard(async () => {
    const r = await api('/contacts?pageSize=100&status=' + encodeURIComponent(q('ou_cs2').value) + '&q=' + encodeURIComponent(q('ou_cq').value));
    q('ou_contacts').innerHTML = r.rows.length ? `<table><tr><th>Name</th><th>Org</th><th>Persona</th><th>Channels</th><th>Status</th><th></th></tr>${r.rows.map((c) => `<tr><td>${esc(c.name)}<div class="muted" style="font-size:12px">${esc(c.role)}</div></td><td>${esc(c.orgName)}</td><td>${c.persona}</td><td>${c.email ? '✉ ' : ''}${c.phone ? '☎ ' : ''}${c.linkedin ? 'in ' : ''}${c.waOptIn ? 'WA✓' : ''}</td><td>${c.status}${c.seq ? ' · step ' + (c.seq.step + 1) : ''}</td><td><button onclick="ouPreview('${c.id}')">Preview</button> <button onclick="ouStatus('${c.id}','replied')">Replied</button> <button onclick="ouStatus('${c.id}','meeting')">Meeting</button> <button onclick="ouErase('${c.id}')">Erase</button></td></tr>`).join('')}</table>` : '<span class="muted">No contacts yet. Add business contacts you found on public pages, with the source.</span>';
  });
  window.ouPreview = guard(async (id) => { const p = await api(`/contacts/${id}/preview?sequence=${q('ou_es').value}&step=0`); q('ou_run').textContent = `Channel: ${p.channel}${p.translated ? ' (translated to ' + p.lang + ')' : ''}\n${p.subject ? 'Subject: ' + p.subject + '\n' : ''}\n${p.body}`; });
  window.ouStatus = guard(async (id, s) => { await api(`/contacts/${id}/status`, 'POST', { status: s }); ouContacts(); });
  window.ouErase = guard(async (id) => { if (!confirm('Erase this person? Their address stays only as a hashed suppression entry.')) return; await api('/contacts/' + id, 'DELETE'); ouContacts(); });
  window.ouEnroll = guard(async () => { const r = await api('/enroll', 'POST', { orgType: q('ou_et').value || undefined, persona: q('ou_ep').value || undefined, sequenceId: q('ou_es').value }); msg(`Enrolled ${r.enrolled}`); ouContacts(); });
  window.ouRun = guard(async (dry) => {
    if (!dry && !confirm('Send all due messages now? Real emails/SMS go out if providers are live.')) return;
    const r = await api('/run', 'POST', { dryRun: dry });
    q('ou_run').textContent = r.skipped ? 'Skipped: ' + r.skipped + (r.missing ? ' (' + r.missing.join(', ') + ')' : '') : `${dry ? 'DRY-RUN: ' : ''}${r.due} due\n` + r.results.map((x) => `${x.org} / ${x.name}: ${x.channel} step ${x.step}/${x.of} -> ${x.result}${x.reason ? ' (' + x.reason + ')' : ''}`).join('\n');
    if (!dry) ouLoad();
  });
  window.ouTasks = guard(async () => {
    const r = await api('/tasks');
    q('ou_tasks').innerHTML = r.tasks.length ? r.tasks.map((t) => `<div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:8px;margin-bottom:8px"><b>${esc(t.name)}</b> · ${esc(t.org)} · <a href="${esc(t.profile)}" target="_blank" rel="noopener">open profile</a><pre style="white-space:pre-wrap;margin:6px 0">${esc(t.text)}</pre><button onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy text</button> <button class="primary" onclick="ouTaskDone('${t.id}')">Sent</button> <button onclick="ouTaskDone('${t.id}','skipped')">Skip</button></div>`).join('') : '<span class="muted">No open tasks.</span>';
  });
  window.ouTaskDone = guard(async (id, status) => { await api(`/tasks/${id}/done`, 'POST', { status }); ouTasks(); });
  window.ouFb = guard(async () => {
    const r = await api('/feedback');
    q('ou_fb').innerHTML = r.feedback.length ? r.feedback.map((f) => `<div style="border-bottom:1px solid var(--line,#ddd);padding:6px 0"><b>${esc(f.name || 'Anonymous')}</b> ${esc(f.org)} <span class="muted">${esc(f.at.slice(0, 10))}</span><div>${esc(f.wants)}</div></div>`).join('') : '<span class="muted">Nothing yet.</span>';
  });
})();
