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
  const PERSONAS = ['ceo', 'cto', 'cmo', 'product', 'sales', 'claims', 'ops', 'general', 'comms', 'partnerships', 'other'];
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
  <div class="card" style="margin-bottom:14px"><h2>Country and index lists</h2>
    <p class="muted" style="margin-top:0;font-size:13px">Add whole markets: Commonwealth countries, the French-, Portuguese-, Spanish-, Arabic-, Chinese- and Hindi-speaking markets, plus index lists such as the Ghana Club 100 and Fortune 500. Starter lists hold organisation names only (no people, no emails) and need checking against the source; use <b>Import a list</b> to load the full published ranking. Countries with strict direct-marketing law are <b>held</b> (no automated email/SMS) until you tick them as legally reviewed.</p>
    <div class="row"><div class="field"><label>Load by pack</label><select id="cp_pack"></select></div>
      <div class="field"><label>or one country</label><select id="cp_country"></select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap"><button class="primary" onclick="cpLoad('pack')">Load pack</button><button onclick="cpLoad('country')">Load country</button><button onclick="cpAfricaReport()">Load The Africa Report 2024 group</button><button onclick="cpCoreBanking()">Load top 15 core banking group</button><button onclick="cpLoad('commonwealth')">All Commonwealth</button><button onclick="cpLoad('all')">All countries</button></div></div>
    <p class="muted" id="cp_msg" style="font-size:13px"></p><div id="cp_packs"></div>
    <details style="margin:8px 0"><summary>Import a list (paste names, one per line, ranks are ignored)</summary>
      <div class="row"><div class="field"><label>List id</label><input id="cpi_id" placeholder="fortune500, ghana-club-100, my-list"/></div><div class="field"><label>Country</label><select id="cpi_c"></select></div>
        <div class="field"><label>Force type (optional)</label><select id="cpi_t"><option value="">Detect from the name</option>${opt(TYPES)}</select></div></div>
      <textarea id="cpi_text" rows="6" style="width:100%" placeholder="1. Newmont Ghana Gold&#10;2. Scancom PLC&#10;..."></textarea>
      <button onclick="cpImport()">Import</button> <span class="muted" id="cpi_msg"></span></details>
    <h3 style="margin:10px 0 4px">Countries: reach and legal review</h3><div id="cp_countries"></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Organisations</h2>
    <div class="row"><div class="field"><label>Type</label><select id="ou_ftype"><option value="">All</option>${opt(TYPES)}</select></div>
      <div class="field"><label>Country</label><select id="ou_fcc"></select></div><div class="field"><label>List</label><select id="ou_flist"></select></div>
      <div class="field"><label>Search</label><input id="ou_fq" placeholder="name"/></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:6px"><button onclick="ouOrgs()">Filter</button><button onclick="ouSeed()">Load seed lists</button></div></div>
    <div id="ou_orgs" style="margin-top:8px"></div><div id="ou_offices" style="margin-top:8px"></div>
    <div class="row" style="margin-top:8px"><div class="field"><label>Add organisation</label><input id="ou_on_name"/></div><div class="field"><label>Type</label><select id="ou_on_type">${opt(TYPES)}</select></div><div class="field"><label>Country</label><input id="ou_on_c"/></div>
      <div class="field" style="display:flex;align-items:flex-end"><button onclick="ouAddOrg()">Add</button></div></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Contacts</h2>
    <div class="row"><div class="field"><label>Organisation</label><select id="ou_co"></select></div><div class="field"><label>Name (leave blank for a team mailbox such as sales@ or info@)</label><input id="ou_cn"/></div><div class="field"><label>Role</label><input id="ou_cr"/></div>
      <div class="field"><label>Persona</label><select id="ou_cp">${opt(PERSONAS, 'other')}</select></div></div>
    <div class="row"><div class="field"><label>Work or team email (sales@, info@, enquiries@, comms@ ...)</label><input id="ou_ce2"/></div><div class="field"><label>Phone numbers, comma-separated (mobile / landline detected)</label><input id="ou_cph" placeholder="+233 24 111 2222, +233 30 222 3333"/></div><div class="field"><label>LinkedIn URL</label><input id="ou_cli"/></div>
      <div class="field"><label>Office country (blank = head office)</label><input id="ou_coff" placeholder="US, GB, IN, CH..."/></div><div class="field"><label>Language</label><input id="ou_cl" placeholder="en, fr, pt, ar..."/></div><div class="field"><label>Public source (required)</label><input id="ou_csrc" placeholder="URL of the page"/></div>
      <div class="field" style="display:flex;align-items:flex-end"><button class="primary" onclick="ouAddContact()">Add contact</button></div></div>
    <details style="margin:8px 0"><summary>Bulk import (CSV with a header row, or JSON rows)</summary>
      <p class="muted" style="font-size:12px;margin:4px 0">Columns: org, name (optional), role, persona, email, phones (separate several with ;), purpose, source (required), lang. Team mailboxes (sales@, info@, enquiries@, communications@, product-specific ones such as ghanahomeloans@) need no name. Careers, HR, privacy and no-reply mailboxes are refused.</p>
      <textarea id="ou_imp" rows="6" style="width:100%" placeholder='org,name,email,phones,purpose,source&#10;First National Bank Ghana,,ghanahomeloans@firstnationalbank.com,+233 30 222 3333;+233 24 111 2222,home loans,https://www.firstnationalbank.com/contact'></textarea>
      <button onclick="ouImport()">Import</button> <span class="muted" id="ou_impmsg"></span></details>
    <div class="row"><div class="field"><label>Status</label><select id="ou_cs2"><option value="">All</option><option>new</option><option>queued</option><option>contacted</option><option>replied</option><option>sandbox</option><option>meeting</option><option>declined</option></select></div>
      <div class="field"><label>Search</label><input id="ou_cq"/></div><div class="field" style="display:flex;align-items:flex-end"><button onclick="ouContacts()">Filter</button></div></div>
    <div id="ou_contacts" style="margin-top:8px"></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Run a campaign</h2>
    <div class="row"><div class="field"><label>Organisation type</label><select id="ou_et"><option value="">All</option>${opt(TYPES)}</select></div>
      <div class="field"><label>Persona</label><select id="ou_ep"><option value="">All</option>${opt(PERSONAS)}</select></div>
      <div class="field"><label>Group / list (optional)</label><select id="ou_el"></select></div><div class="field"><label>Office country only (optional)</label><input id="ou_eoff" placeholder="US"/></div><div class="field"><label>Campaign name (optional)</label><input id="ou_ecn" placeholder="africa-report-insurers"/></div>
      <div class="field"><label>Sequence</label><select id="ou_es"></select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:6px"><button onclick="ouEnroll()">Enrol new contacts</button><button onclick="ouRun(true)">Dry-run</button><button class="primary" onclick="ouRun(false)">Send due now</button></div></div>
    <pre id="ou_run" class="muted" style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto"></pre></div>
  <div class="card" style="margin-bottom:14px"><h2>Manual tasks: LinkedIn messages and phone calls</h2><div id="ou_tasks"></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Referral programme</h2>
    <p class="muted" style="margin-top:0;font-size:13px">Every contact gets a personal link in our emails (when this is ON). They can share a tracked link or introduce a colleague, but only after confirming they know that person. Points come from what the referred person does, never from raw sends. You decide the rewards (free text); this tracks eligibility and what you have given.</p>
    <p><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="rf_on"/> Referral programme ON</label></p>
    <div class="row"><div class="field"><label>Max introductions per referrer per day</label><input id="rf_max" type="number"/></div>
      <div class="field"><label>Points: reply</label><input id="rf_p_replied" type="number"/></div><div class="field"><label>Sandbox</label><input id="rf_p_sandbox" type="number"/></div><div class="field"><label>Meeting</label><input id="rf_p_meeting" type="number"/></div><div class="field"><label>Partner</label><input id="rf_p_partner" type="number"/></div></div>
    <div class="field"><label>Tiers, one per line: points | label | reward (what you will give)</label><textarea id="rf_tiers" rows="4" style="width:100%"></textarea></div>
    <div class="field"><label>Terms shown to referrers</label><textarea id="rf_terms" rows="3" style="width:100%"></textarea></div>
    <button class="primary" onclick="rfSave()">Save referral settings</button> <span class="muted" id="rf_msg"></span>
    <div class="row" style="margin-top:10px"><div class="field"><label>Add a referral partner (consultant, agent, ambassador)</label><input id="rf_pn" placeholder="Name"/></div><div class="field"><label>Email</label><input id="rf_pe"/></div><div class="field"><label>Organisation</label><input id="rf_po"/></div><div class="field" style="display:flex;align-items:flex-end"><button onclick="rfAddPartner()">Create link</button></div></div>
    <div id="rf_list" style="margin-top:8px"></div></div>
  <div class="card"><h2>Feedback from the sandbox</h2><div id="ou_fb"></div></div>`;
  firstPanel.parentNode.insertBefore(panel, firstPanel.nextSibling);

  const msg = (t) => { try { toast(t); } catch (e) { alert(t); } };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { msg(e.message); } };

  window.ouLoad = guard(async () => {
    const [ov, cfg, seqs] = await Promise.all([api('/overview'), api('/config'), api('/sequences')]);
    q('ou_kpis').innerHTML = `<b>${ov.orgs}</b> organisations · <b>${ov.contacts}</b> contacts (${ov.withEmail} email incl. ${ov.roleMailboxes} team mailboxes; ${ov.mobileNumbers} mobile, ${ov.nonMobileNumbers} landline/other numbers) · <b>${ov.sandboxVisitors}</b> opened the sandbox · <b>${ov.feedback}</b> feedback · <b>${ov.openTasks}</b> manual tasks · sent today: email ${ov.sentToday.email}, SMS ${ov.sentToday.sms}, WhatsApp ${ov.sentToday.whatsapp} · suppressed: ${ov.suppressed}<br>Contacts: ${Object.entries(ov.contactsByStatus).map(([k, v]) => k + ' ' + v).join(' · ') || 'none yet'}`;
    q('ou_name').value = cfg.senderName; q('ou_role').value = cfg.senderRole; q('ou_org').value = cfg.senderOrg; q('ou_reply').value = cfg.replyTo; q('ou_addr').value = cfg.postalAddress; q('ou_base').value = cfg.publicBaseUrl || location.origin; q('ou_sbx').value = cfg.sandboxUrl;
    q('ou_ce').value = cfg.caps.email; q('ou_cs').value = cfg.caps.sms; q('ou_cw').value = cfg.caps.whatsapp; q('ou_hf').value = cfg.hours.from; q('ou_ht').value = cfg.hours.to; q('ou_on').checked = cfg.enabled;
    q('ou_cfgmsg').textContent = cfg.readyToSend ? 'Ready to send' + (cfg.emailConfigured ? '' : ' (email provider not configured: email will not go out)') : 'Missing: ' + cfg.missing.join(', ');
    q('ou_es').innerHTML = seqs.sequences.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    await cpLoadMeta(); await ouOrgs(); await ouContacts(); await ouTasks(); await ouFb(); await rfLoad();
  });
  window.ouSaveCfg = guard(async () => {
    await api('/config', 'PUT', { senderName: q('ou_name').value, senderRole: q('ou_role').value, senderOrg: q('ou_org').value, replyTo: q('ou_reply').value, postalAddress: q('ou_addr').value, publicBaseUrl: q('ou_base').value, sandboxUrl: q('ou_sbx').value, enabled: q('ou_on').checked, caps: { email: q('ou_ce').value, sms: q('ou_cs').value, whatsapp: q('ou_cw').value }, hours: { from: q('ou_hf').value, to: q('ou_ht').value } });
    msg('Saved'); ouLoad();
  });
  window.ouSeed = guard(async () => { const r = await api('/seed', 'POST'); msg(`Added ${r.added} organisations (${r.total} total)`); ouLoad(); });
  window.ouOrgs = guard(async () => {
    const r = await api('/orgs?pageSize=100&type=' + encodeURIComponent(q('ou_ftype').value) + '&q=' + encodeURIComponent(q('ou_fq').value) + '&cc=' + encodeURIComponent(q('ou_fcc').value) + '&list=' + encodeURIComponent(q('ou_flist').value));
    ORGS = r.rows; q('ou_co').innerHTML = ORGS.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    q('ou_orgs').innerHTML = `<div class="muted" style="font-size:12px">${r.total} match (showing ${r.rows.length})</div><table><tr><th>Organisation</th><th>Type</th><th>Country</th><th>Language</th><th>Reach</th><th>Status</th><th>Contacts</th><th></th></tr>${r.rows.map((o) => `<tr><td>${esc(o.name)}<div class="muted" style="font-size:11px">${(o.lists || []).map(esc).join(' · ')}</div></td><td>${o.type}</td><td>${esc(o.country)}</td><td>${esc(o.lang || '')}</td><td>${o.reach && o.reach.held ? '<span title="' + esc(o.reach.reason) + '">⏸ held</span>' : '✉' + (o.reach && o.reach.sms === false ? '' : ' 💬') + ' ☎'}</td><td>${o.status}</td><td>${o.contacts}</td><td><button onclick="ouOffices('${o.id}')">Offices${(o.offices || []).length ? ' (' + o.offices.length + ')' : ''}</button></td></tr>`).join('')}</table>`;
  });
  window.ouAddOrg = guard(async () => { await api('/orgs', 'POST', { name: q('ou_on_name').value, type: q('ou_on_type').value, country: q('ou_on_c').value }); q('ou_on_name').value = ''; ouOrgs(); });
  window.ouAddContact = guard(async () => {
    await api('/contacts', 'POST', { orgId: q('ou_co').value, name: q('ou_cn').value, role: q('ou_cr').value, persona: q('ou_cp').value, email: q('ou_ce2').value, phones: q('ou_cph').value.split(',').map((x) => x.trim()).filter(Boolean), linkedin: q('ou_cli').value, lang: q('ou_cl').value || undefined, officeCc: q('ou_coff').value || undefined, source: q('ou_csrc').value });
    ['ou_cn', 'ou_cr', 'ou_ce2', 'ou_cph', 'ou_cli', 'ou_csrc', 'ou_coff'].forEach((i) => { q(i).value = ''; }); msg('Contact added'); ouContacts();
  });
  const csv = (text) => {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()); if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const split = (l) => { const out = []; let cur = '', inq = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (inq && l[i + 1] === '"') { cur += '"'; i++; } else inq = !inq; } else if (ch === ',' && !inq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
    const head = split(lines[0]).map((h) => h.toLowerCase());
    return lines.slice(1).map((l) => { const v = split(l); const o = {}; head.forEach((h, i) => { if (v[i]) o[h] = v[i]; }); if (o.phones) o.phones = o.phones.split(';').map((x) => x.trim()).filter(Boolean); return o; });
  };
  window.ouImport = guard(async () => { const raw = q('ou_imp').value.trim(); const rows = raw.startsWith('[') ? JSON.parse(raw) : csv(raw); const r = await api('/contacts/import', 'POST', { rows }); q('ou_impmsg').textContent = `Added ${r.added}; rejected ${r.rejected.length}` + (r.rejected.length ? ': ' + r.rejected.slice(0, 5).map((x) => `row ${x.row} ${x.error}`).join('; ') : ''); ouContacts(); });
  window.ouContacts = guard(async () => {
    const r = await api('/contacts?pageSize=100&status=' + encodeURIComponent(q('ou_cs2').value) + '&q=' + encodeURIComponent(q('ou_cq').value));
    q('ou_contacts').innerHTML = r.rows.length ? `<table><tr><th>Name</th><th>Org</th><th>Persona</th><th>Channels</th><th>Status</th><th></th></tr>${r.rows.map((c) => `<tr><td>${esc(c.name)}<div class="muted" style="font-size:12px">${esc(c.role || c.purpose || '')}</div></td><td>${esc(c.orgName)}</td><td>${c.persona}</td><td>${c.email ? '✉ ' + (c.kind === 'role' ? '<span class="muted">team</span> ' : '') : ''}${(c.phones || []).map((p) => (p.type === 'mobile' ? '📱' : '☎') + ' <span class="muted">' + p.type + '</span> ').join('')}${c.linkedin ? 'in ' : ''}${c.waOptIn ? 'WA✓' : ''}</td><td>${c.status}${c.seq ? ' · step ' + (c.seq.step + 1) : ''}</td><td><button onclick="ouPreview('${c.id}')">Preview</button> <button onclick="ouStatus('${c.id}','replied')">Replied</button> <button onclick="ouStatus('${c.id}','meeting')">Meeting</button> <button onclick="ouErase('${c.id}')">Erase</button></td></tr>`).join('')}</table>` : '<span class="muted">No contacts yet. Add business contacts you found on public pages, with the source.</span>';
  });
  window.ouPreview = guard(async (id) => { const p = await api(`/contacts/${id}/preview?sequence=${q('ou_es').value}&step=0`); q('ou_run').textContent = `Channel: ${p.channel}${p.translated ? ' (translated to ' + p.lang + ')' : ''}\n${p.subject ? 'Subject: ' + p.subject + '\n' : ''}\n${p.body}`; });
  window.ouStatus = guard(async (id, s) => { await api(`/contacts/${id}/status`, 'POST', { status: s }); ouContacts(); });
  window.ouErase = guard(async (id) => { if (!confirm('Erase this person? Their address stays only as a hashed suppression entry.')) return; await api('/contacts/' + id, 'DELETE'); ouContacts(); });
  window.ouEnroll = guard(async () => { const r = await api('/enroll', 'POST', { orgType: q('ou_et').value || undefined, persona: q('ou_ep').value || undefined, list: q('ou_el').value || undefined, officeCc: (q('ou_eoff') || {}).value || undefined, campaign: q('ou_ecn').value || undefined, sequenceId: q('ou_es').value }); msg(`Enrolled ${r.enrolled}`); ouContacts(); });
  window.ouRun = guard(async (dry) => {
    if (!dry && !confirm('Send all due messages now? Real emails/SMS go out if providers are live.')) return;
    const r = await api('/run', 'POST', { dryRun: dry });
    q('ou_run').textContent = r.skipped ? 'Skipped: ' + r.skipped + (r.missing ? ' (' + r.missing.join(', ') + ')' : '') : `${dry ? 'DRY-RUN: ' : ''}${r.due} due\n` + r.results.map((x) => `${x.org} / ${x.name}: ${x.channel} step ${x.step}/${x.of} -> ${x.result}${x.reason ? ' (' + x.reason + ')' : ''}`).join('\n');
    if (!dry) ouLoad();
  });
  window.ouTasks = guard(async () => {
    const r = await api('/tasks');
    q('ou_tasks').innerHTML = r.tasks.length ? r.tasks.map((t) => `<div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:8px;margin-bottom:8px"><b>${esc(t.name)}</b> · ${esc(t.org)} · ${t.kind === 'call' ? '📞 call <b>' + esc(t.phone) + '</b> <span class="muted">(' + esc(t.phoneType) + ')</span>' : '<a href="' + esc(t.profile) + '" target="_blank" rel="noopener">open LinkedIn profile</a>'}<pre style="white-space:pre-wrap;margin:6px 0">${esc(t.text)}</pre><button onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy text</button> <button class="primary" onclick="ouTaskDone('${t.id}')">${t.kind === 'call' ? 'Called' : 'Sent'}</button> <button onclick="ouTaskDone('${t.id}','skipped')">Skip</button></div>`).join('') : '<span class="muted">No open tasks.</span>';
  });
  window.ouTaskDone = guard(async (id, status) => { await api(`/tasks/${id}/done`, 'POST', { status }); ouTasks(); });
  window.ouFb = guard(async () => {
    const r = await api('/feedback');
    q('ou_fb').innerHTML = r.feedback.length ? r.feedback.map((f) => `<div style="border-bottom:1px solid var(--line,#ddd);padding:6px 0"><b>${esc(f.name || 'Anonymous')}</b> ${esc(f.org)} <span class="muted">${esc(f.at.slice(0, 10))}</span><div>${esc(f.wants)}</div></div>`).join('') : '<span class="muted">Nothing yet.</span>';
  });
  window.rfLoad = guard(async () => {
    const r = await api('/referrals'); const c = r.config;
    q('rf_on').checked = c.enabled; q('rf_max').value = c.maxIntrosPerDay;
    for (const k of ['replied', 'sandbox', 'meeting', 'partner']) q('rf_p_' + k).value = c.points[k];
    q('rf_tiers').value = c.tiers.map((t) => `${t.at} | ${t.label} | ${t.reward}`).join('\n'); q('rf_terms').value = c.terms || '';
    const t = r.totals;
    q('rf_list').innerHTML = `<div class="muted" style="font-size:13px">${t.clicks} link visits · ${t.intros} introductions · ${t.sandbox} reached the sandbox · ${t.meetings} meetings</div>` + (r.referrers.length ? `<table><tr><th>Referrer</th><th>Points</th><th>Tier</th><th>Visits</th><th>Intros</th><th>Rewards given</th><th></th></tr>${r.referrers.map((x) => `<tr><td>${esc(x.name)}<div class="muted" style="font-size:12px">${esc(x.org || '')} ${esc(x.email || '')}</div></td><td>${x.points}</td><td>${x.tier ? esc(x.tier.label) : '-'}</td><td>${x.clicks}</td><td>${x.intros.length}</td><td>${x.rewards.length}</td><td><button onclick="navigator.clipboard.writeText('${esc(x.pageLink)}')">Copy page link</button> <button onclick="rfReward('${x.code}')">Mark reward given</button></td></tr>`).join('')}</table>` : '<div class="muted">No referrers yet.</div>');
  });
  window.rfSave = guard(async () => {
    const tiers = q('rf_tiers').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [at, label, ...rest] = l.split('|').map((x) => x.trim()); return { at: Number(at), label, reward: rest.join('|').trim() }; });
    await api('/referrals/config', 'PUT', { enabled: q('rf_on').checked, maxIntrosPerDay: q('rf_max').value, points: { replied: q('rf_p_replied').value, sandbox: q('rf_p_sandbox').value, meeting: q('rf_p_meeting').value, partner: q('rf_p_partner').value }, tiers, terms: q('rf_terms').value });
    q('rf_msg').textContent = 'Saved'; rfLoad();
  });
  window.rfAddPartner = guard(async () => { const r = await api('/referrals/partners', 'POST', { name: q('rf_pn').value, email: q('rf_pe').value, org: q('rf_po').value }); q('rf_pn').value = q('rf_pe').value = q('rf_po').value = ''; msg('Partner link: ' + r.pageLink); rfLoad(); });
  window.rfReward = guard(async (code) => { const note = prompt('What did you give this referrer?'); if (!note) return; await api(`/referrals/${code}/reward`, 'POST', { note }); rfLoad(); });
  let CT = [];
  window.cpLoadMeta = guard(async () => {
    const [pk, ct] = await Promise.all([api('/packs'), api('/countries')]); CT = ct.countries;
    const co = CT.map((c) => `<option value="${c.code}">${esc(c.name)}${c.orgs ? ' (' + c.orgs + ')' : ''}</option>`).join('');
    q('cp_pack').innerHTML = pk.packs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${p.starterSize} starter, ${p.loaded} loaded)</option>`).join('');
    q('cp_country').innerHTML = co; q('cpi_c').innerHTML = '<option value="">(none)</option>' + co;
    const keepC = q('ou_fcc').value, keepL = q('ou_flist').value;
    q('ou_fcc').innerHTML = '<option value="">All</option>' + co; q('ou_el').innerHTML = '<option value="">All contacts</option>' + pk.packs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); q('ou_flist').innerHTML = '<option value="">All</option>' + pk.packs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); q('ou_fcc').value = keepC; q('ou_flist').value = keepL;
    q('cp_packs').innerHTML = `<table><tr><th>Pack</th><th>Source</th><th>Starter</th><th>Loaded</th><th>Note</th></tr>${pk.packs.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.source ? '<a href="' + esc(p.source) + '" target="_blank" rel="noopener">source</a>' : ''}</td><td>${p.starterSize}</td><td>${p.loaded}</td><td class="muted" style="font-size:12px">${esc(p.note || '')}</td></tr>`).join('')}</table>`;
    q('cp_countries').innerHTML = `<table><tr><th>Country</th><th>Languages</th><th>Level</th><th>Orgs</th><th>Contacts</th><th>Legally reviewed</th></tr>${CT.filter((c) => c.orgs || c.level === 'review').map((c) => `<tr><td>${esc(c.name)}${c.commonwealth ? ' <span class="muted">CW</span>' : ''}</td><td>${c.langs.join(', ')}</td><td>${c.level}${c.noColdSms ? ' · no cold SMS' : ''}</td><td>${c.orgs}</td><td>${c.contacts}</td><td>${c.level === 'review' ? `<input type="checkbox" ${c.approved ? 'checked' : ''} onchange="cpApprove('${c.code}', this.checked)"/>` : 'not needed'}</td></tr>`).join('')}</table>`;
  });
  window.cpApprove = guard(async (code, on) => {
    const cfg = await api('/config'); const set = new Set(cfg.approvedCountries || []); on ? set.add(code) : set.delete(code);
    if (on && !confirm('Only tick this once a lawyer has confirmed that business email and SMS outreach is acceptable in this country. Continue?')) { cpLoadMeta(); return; }
    await api('/config', 'PUT', { approvedCountries: Array.from(set) }); msg('Saved'); cpLoadMeta();
  });
  window.cpLoad = guard(async (mode) => {
    const body = mode === 'pack' ? { packs: [q('cp_pack').value] } : mode === 'country' ? { countries: [q('cp_country').value] } : mode === 'commonwealth' ? { commonwealth: true } : { all: true };
    if (mode === 'all' && !confirm('Load every country? This adds well over a thousand organisations.')) return;
    const r = await api('/packs/seed', 'POST', body); q('cp_msg').textContent = `Added ${r.added} organisations, updated ${r.merged} existing (${r.total} in total). Review the list before pitching.`; ouLoad();
  });
  window.cpCoreBanking = guard(async () => { const r = await api('/packs/core-banking', 'POST'); q('cp_msg').textContent = `Core banking group: ${r.inGroup} vendors; ${r.added} added, ${r.offices} offices added. Offices are starter data: verify each on the company's public contact page. Use "Offices" on an organisation to see which office country is open to you.`; ouLoad(); });
  window.ouOffices = guard(async (orgId) => {
    const r = await api('/orgs/' + orgId + '/offices'); const rows = r.offices.map((f) => `<tr><td>${esc(f.country || f.cc)}${f.city ? ', ' + esc(f.city) : ''}${f.home ? ' (head office record)' : ''}</td><td>${esc(f.role)}</td><td>${f.reach.held ? '<b>held: ' + esc(f.reach.reason) + '</b>' : 'open'}${f.reach.known && !f.reach.sms ? ', no cold SMS' : ''}</td><td>${f.home ? '' : '<button onclick="ouOfficeDel(\'' + orgId + '\',\'' + f.id + '\')">Remove</button>'}</td></tr>`).join('');
    q('ou_offices').innerHTML = `<table><tr><th>Office</th><th>Role</th><th>Reach now</th><th></th></tr>${rows}</table><div class="row"><div class="field"><label>Add office: country</label><input id="of_c" placeholder="US"/></div><div class="field"><label>City</label><input id="of_city"/></div><div class="field"><label>Role</label><select id="of_r"><option>regional</option><option>africa</option><option>sales</option><option>hq</option></select></div><div class="field" style="display:flex;align-items:flex-end"><button onclick="ouOfficeAdd('${orgId}')">Add office</button></div></div><p class="muted" style="font-size:12px">When a country is held, add the contact with that office country (for example US) and enrol it: the legal-review hold, SMS rules and language follow the office.</p>`;
  });
  window.ouOfficeAdd = guard(async (orgId) => { await api('/orgs/' + orgId + '/offices', 'POST', { cc: q('of_c').value, city: q('of_city').value, role: q('of_r').value }); ouOffices(orgId); });
  window.ouOfficeDel = guard(async (orgId, oid) => { await api('/orgs/' + orgId + '/offices/' + oid, 'DELETE'); ouOffices(orgId); });
  window.cpAfricaReport = guard(async () => { const r = await api('/packs/africa-report', 'POST'); q('cp_msg').textContent = `The Africa Report 2024 group: ${r.inGroup} organisations (${r.banks} banks, ${r.insurers} insurers); ${r.added} added, ${r.tagged} existing ones tagged. Pick it under "Group / list" to run a campaign on just these.`; ouLoad(); });
  window.cpImport = guard(async () => {
    const r = await api('/packs/import', 'POST', { listId: q('cpi_id').value, country: q('cpi_c').value || undefined, type: q('cpi_t').value || undefined, text: q('cpi_text').value });
    q('cpi_msg').textContent = `Read ${r.read}: added ${r.added}, already known ${r.known} (${r.tagged} newly tagged). ` + Object.entries(r.types).map(([k, v]) => k + ' ' + v).join(', '); ouLoad();
  });
})();
