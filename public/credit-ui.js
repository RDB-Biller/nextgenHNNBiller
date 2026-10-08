/* InsureCredit applicant + funder page. Four design variants chosen per product in Product Lab.
 * ?t=<token>  applicant offer      ?s=<shareToken>  funder justification note
 * ?demo=1&design=&accent=&brand=&headline=&button=&over=1  static preview used by Product Lab (no server data) */
(function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toFixed(2);
  const toast = (m) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); };
  const Q = new URLSearchParams(location.search);
  let root, state = { step: 0 };

  async function api(path, body) {
    const r = await fetch('/credit/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || j.error || 'Something went wrong'); e.code = (j.error && j.error !== 'error') ? j.error : j.message; throw e; }
    return j;
  }

  const DEMO_REPORT = { diagnosis: 'Acute appendicitis', narrative: 'Ama was assessed at Sample Hospital with a working diagnosis of acute appendicitis. The treatment below was recommended.', investigations: ['Full blood count', 'Abdominal ultrasound'], medications: ['Ceftriaxone 1 g IV'], procedures: ['Appendicectomy'], other: [], signedOff: true, disclaimer: 'Sample only.' };
  function demoView() {
    const over = Q.get('over') === '1'; const amount = over ? 3400 : Number(Q.get('amount') || 480);
    return { demo: true, applicationNo: '55731792', status: 'opened', facility: 'Sample Hospital', currency: 'GHS', patientFirstName: 'Ama', amount, loanCap: 2000, overCap: over, loanableAmount: over ? 0 : amount,
      overCapPolicy: 'share_only', live: true, funderChannels: 'email_or_sms', consent: { scoring: false, texts: { scoring: 'I agree that HNN Biller may send my application number, the amount and my micro medical report to ConfirmU so it can assess my credit.', report_share: 'I agree that HNN Biller may send my micro medical report to the person below.' } },
      design: { variant: Q.get('design') || 'classic', accent: Q.get('accent') || '#0E5C4A', brand: Q.get('brand') || 'InsureCredit', headline: Q.get('headline') || 'Need help with this bill?', buttonLabel: Q.get('button') || 'Apply now', termsNote: Q.get('terms') || '', footnote: Q.get('foot') || '' },
      ussd: { code: Q.get('ussd') || '*789*963#', instructions: 'Dial *789*963# and enter application number 55731792.' }, report: DEMO_REPORT, shares: [], decision: null };
  }

  function reportHtml(r) {
    if (!r) return '';
    const li = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    return `<div class="ic-report"><h3>${esc(r.kind === 'micro' || !r.kind ? 'Micro medical report' : 'Medical report')}</h3>
      <p style="font-size:14px;margin:0 0 8px">${esc(r.narrative)}</p>
      ${r.diagnosis ? `<p style="font-size:14px;margin:0 0 6px"><b>Working diagnosis:</b> ${esc(r.diagnosis)}</p>` : ''}
      ${r.investigations && r.investigations.length ? '<b style="font-size:13px">Investigations</b>' + li(r.investigations) : ''}
      ${r.medications && r.medications.length ? '<b style="font-size:13px">Medication</b>' + li(r.medications) : ''}
      ${r.procedures && r.procedures.length ? '<b style="font-size:13px">Procedures</b>' + li(r.procedures) : ''}
      <p class="ic-note">${r.signedOff ? 'Signed off by a clinician. ' : 'Awaiting clinician sign-off. '}${esc(r.disclaimer || '')}</p></div>`;
  }

  function head(v) {
    const d = v.design;
    return `<div class="ic-top"><div class="ic-brand">${esc(d.brand)}</div><span class="muted" style="font-size:13px">${esc(v.facility)}</span></div>`;
  }
  function foot(v) {
    const d = v.design;
    return `${d.termsNote ? `<p class="ic-note">${esc(d.termsNote)}</p>` : ''}${d.footnote ? `<p class="ic-note">${esc(d.footnote)}</p>` : ''}
      <p class="ic-note">Application number <b>${esc(v.applicationNo)}</b>. HNN Biller does not lend money; credit decisions are made by ConfirmU.${v.demo ? ' (Preview with sample data.)' : ''}</p>`;
  }
  function ussdHtml(v) { return v.ussd ? `<div class="ic-ussd">Prefer your phone keypad? Dial <b>${esc(v.ussd.code)}</b> and enter application number <b>${esc(v.applicationNo)}</b>.</div>` : ''; }

  function statusCard(v) {
    const map = { submitted_to_scorer: ['With ConfirmU', 'Your application has been sent for a credit check. We will text you the outcome.'],
      approved: ['Approved', v.decision && v.decision.approvedAmount ? `Approved: GHS ${num(v.decision.approvedAmount)}. Check your phone for next steps.` : 'Approved. Check your phone for next steps.'],
      declined: ['Not approved', 'This application was not approved. Your medical report can still be shared with someone who may help.'],
      cancelled: ['Cancelled', 'This application was cancelled.'], expired: ['Expired', 'This offer has expired. Ask the hospital or your insurer to send a new link.'] };
    const m = map[v.status]; if (!m) return '';
    return `<div class="ic-card"><span class="ic-pill ${v.status === 'declined' || v.status === 'expired' || v.status === 'cancelled' ? 'bad' : ''}">${esc(m[0])}</span><p style="margin:10px 0 0">${esc(m[1])}</p></div>`;
  }

  function shareForm(v) {
    const ch = v.funderChannels || 'email_or_sms';
    const done = (v.shares || []).filter((s) => !s.revoked);
    return `<div class="ic-card"><h3 style="margin:0 0 6px;font-size:16px">${v.overCap ? 'Ask someone to help fund this bill' : 'Need more than this?'}</h3>
      <p class="muted" style="font-size:14px;margin:0 0 10px">${v.overCap ? `This bill is above the GHS ${num(v.loanCap)} micro-loan limit. ` : ''}We can send your micro medical report, as a justification note, to someone who may help, such as your employer's HR. Only with your consent.</p>
      ${done.map((s) => `<p style="font-size:13px;margin:4px 0">Sent to ${esc(s.to)} <button type="button" class="ic-btn ghost" style="display:inline;width:auto;padding:4px 10px;font-size:12px" data-revoke="${esc(s.id)}">Withdraw</button></p>`).join('')}
      <div class="field"><label>Their name</label><input id="sh_name" autocomplete="off"/></div>
      ${ch !== 'sms' ? '<div class="field"><label>Their email</label><input id="sh_email" type="email" autocomplete="off"/></div>' : ''}
      ${ch !== 'email' ? '<div class="field"><label>Their phone</label><input id="sh_phone" type="tel" autocomplete="off"/></div>' : ''}
      <div class="field"><label>Who are they to you?</label><input id="sh_rel" placeholder="e.g. HR manager"/></div>
      <label class="ic-check"><input type="checkbox" id="sh_consent"/><span>${esc(v.consent.texts.report_share)}</span></label>
      <button class="ic-btn ghost" id="sh_go" type="button">Send my report</button></div>`;
  }

  function offerBody(v) {
    const d = v.design; const can = v.live && v.loanableAmount > 0 && ['offered', 'opened', 'consented'].includes(v.status);
    const closed = ['submitted_to_scorer', 'approved', 'declined', 'cancelled', 'expired'].includes(v.status);
    const amountBlock = `<p class="muted" style="margin:0;font-size:13px">${v.overCap ? 'Your bill' : 'You can borrow'}</p>
      <div class="ic-amt">GHS ${num(v.overCap ? v.amount : v.loanableAmount)}</div>
      <p class="muted" style="margin:0;font-size:13px">${v.overCap ? `Above the GHS ${num(v.loanCap)} micro-loan limit, so a loan is not available for this bill.` : `Towards your out-of-pocket payment at ${esc(v.facility)}. Up to GHS ${num(v.loanCap)}.`}</p>`;
    const apply = can ? `<div class="ic-card"><label class="ic-check"><input type="checkbox" id="c_score" ${v.consent.scoring ? 'checked' : ''}/><span>${esc(v.consent.texts.scoring)}</span></label>
      <button class="ic-btn" id="ap_go" type="button">${esc(d.buttonLabel)}</button></div>` : '';
    return { amountBlock, apply, closed, can };
  }

  function layout(v) {
    const d = v.design; const o = offerBody(v); const variant = d.variant;
    const rep = v.report ? `<div class="ic-card"><details ${variant === 'compact' ? '' : 'open'}><summary>Your micro medical report (sent with your application)</summary>${reportHtml(v.report)}</details></div>` : '';
    const stat = statusCard(v);
    const share = v.live || v.demo ? (v.overCap || v.overCapPolicy === 'partial_and_share' || v.status === 'declined' ? shareForm(v) : '') : '';
    if (variant === 'story') {
      return `${head(v)}<div class="ic-hero"><h1>${esc(d.headline)}</h1>${o.amountBlock.replace(/class="muted"/g, 'style="color:#fff;opacity:.85;margin:0;font-size:13px"')}</div>${stat}${o.apply}${rep}${v.ussd ? `<div class="ic-card">${ussdHtml(v)}</div>` : ''}${share}${foot(v)}`;
    }
    if (variant === 'stepper') {
      const n = state.step; const steps = ['Offer', 'Report', 'Apply'];
      const bar = `<div class="ic-steps">${steps.map((_, i) => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div><p class="eyebrow" style="color:var(--ac)">Step ${n + 1} of 3 · ${steps[n]}</p>`;
      let body;
      if (o.closed) body = stat;
      else if (n === 0) body = `<div class="ic-card"><h2 style="margin:0 0 6px;font-size:20px">${esc(d.headline)}</h2>${o.amountBlock}</div><button class="ic-btn" data-step="1" type="button">Continue</button>`;
      else if (n === 1) body = `${rep || '<div class="ic-card muted">No report attached.</div>'}<button class="ic-btn" data-step="2" type="button">Looks right, continue</button><button class="ic-btn ghost" data-step="0" type="button" style="margin-top:8px">Back</button>`;
      else body = `${o.apply || ''}${ussdHtml(v) ? `<div class="ic-card">${ussdHtml(v)}</div>` : ''}<button class="ic-btn ghost" data-step="1" type="button">Back</button>`;
      return `${head(v)}${bar}${body}${n === 0 || o.closed ? share : ''}${foot(v)}`;
    }
    // classic + compact
    return `${head(v)}<div class="ic-card"><h2 style="margin:0 0 6px;font-size:${variant === 'compact' ? 17 : 22}px">${esc(d.headline)}</h2>${o.amountBlock}</div>${stat}${o.apply}${rep}${v.ussd ? `<div class="ic-card">${ussdHtml(v)}</div>` : ''}${share}${foot(v)}`;
  }

  function paint(v) {
    state.v = v;
    root.className = 'wrap ic' + (v.design.variant === 'compact' ? ' compact' : '');
    root.style.setProperty('--ac', v.design.accent || '#0E5C4A');
    root.innerHTML = layout(v);
    wire(v);
  }

  function wire(v) {
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { state.step = Number(b.dataset.step); paint(state.v); }));
    const ap = root.querySelector('#ap_go');
    if (ap) ap.addEventListener('click', async () => {
      const c = root.querySelector('#c_score');
      if (!c.checked) return toast('Please tick the consent box first');
      if (v.demo) return toast('Preview only: nothing is sent');
      ap.disabled = true;
      try {
        await api(`${encodeURIComponent(Q.get('t'))}/consent`, { scoring: true });
        const r = await api(`${encodeURIComponent(Q.get('t'))}/apply`, {});
        if (r.redirectUrl) { location.href = r.redirectUrl; return; }
        paint(await api(encodeURIComponent(Q.get('t'))));
      } catch (e) { toast(e.message); ap.disabled = false; }
    });
    const sh = root.querySelector('#sh_go');
    if (sh) sh.addEventListener('click', async () => {
      const g = (id) => { const el = root.querySelector('#' + id); return el ? el.value.trim() : ''; };
      if (!root.querySelector('#sh_consent').checked) return toast('Please tick the consent box first');
      if (v.demo) return toast('Preview only: nothing is sent');
      sh.disabled = true;
      try {
        paint(await api(`${encodeURIComponent(Q.get('t'))}/share`, { name: g('sh_name'), email: g('sh_email'), phone: g('sh_phone'), relationship: g('sh_rel'), consent: true }));
        toast('Your report has been sent');
      } catch (e) { toast(e.message); sh.disabled = false; }
    });
    root.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      try { paint(await api(`${encodeURIComponent(Q.get('t'))}/shares/${encodeURIComponent(b.dataset.revoke)}/revoke`, {})); toast('Withdrawn'); } catch (e) { toast(e.message); }
    }));
  }

  function funderPaint(n) {
    const d = n.design || { accent: '#0E5C4A', brand: 'InsureCredit' };
    root.className = 'wrap ic'; root.style.setProperty('--ac', d.accent || '#0E5C4A');
    root.innerHTML = `<div class="ic-top"><div class="ic-brand">${esc(d.brand)}</div><span class="muted" style="font-size:13px">${esc(n.facility)}</span></div>
      <div class="ic-card"><p class="eyebrow" style="color:var(--ac)">Medical justification note</p>
      <p style="margin:0 0 6px">${esc(n.requestedBy || 'A patient')} is seeking financial assistance of</p><div class="ic-amt">${esc(n.currency)} ${num(n.requestedAmount)}</div>
      <p class="muted" style="font-size:13px;margin:0">${n.relationship ? 'Sent to you as: ' + esc(n.relationship) + '. ' : ''}Link valid until ${esc(String(n.expiresAt).slice(0, 10))}.</p></div>
      <div class="ic-card">${reportHtml(n.report)}</div><p class="ic-note">${esc(n.statement)}</p>`;
  }

  // Fallback: open the offer with the application number and the phone it was sent to.
  function lookupForm(msg) {
    root.className = 'wrap ic';
    root.innerHTML = `<div class="ic-card"><div class="ic-brand">InsureCredit</div>
      <p class="muted" style="font-size:14px">${esc(msg || 'Open your offer with the application number from your text message.')}</p>
      <div class="field"><label>Application number (8 digits)</label><input id="lk_no" inputmode="numeric" autocomplete="off"/></div>
      <div class="field"><label>Phone number the text was sent to</label><input id="lk_ph" type="tel" autocomplete="off"/></div>
      <button class="ic-btn" id="lk_go" type="button">Open my offer</button></div>`;
    root.querySelector('#lk_go').addEventListener('click', async () => {
      try {
        const r = await api('lookup', { applicationNo: root.querySelector('#lk_no').value, phone: root.querySelector('#lk_ph').value });
        location.href = '/credit/?t=' + encodeURIComponent(r.token);
      } catch (e) { toast(e.code === 'application_not_found' ? 'Those details do not match an offer' : e.message); }
    });
  }
  async function boot(el) {
    root = el;
    try {
      if (Q.get('demo') === '1') return paint(demoView());
      if (Q.get('s')) return funderPaint(await api('share/' + encodeURIComponent(Q.get('s'))));
      if (!Q.get('t')) return lookupForm();
      paint(await api(encodeURIComponent(Q.get('t'))));
    } catch (e) {
      const m = { offer_not_found: 'This link was not found.', note_not_found: 'This note was not found.', note_withdrawn: 'The sender has withdrawn this note.', note_expired: 'This note has expired.' }[e.code] || e.message;
      if (e.code === 'offer_not_found') return lookupForm('This link did not work (it may have been cut short in the text message). Open your offer with your application number instead.');
      root.innerHTML = `<div class="ic-card"><b>InsureCredit</b><p style="color:var(--bad)">${esc(m)}</p></div>`;
    }
  }
  window.IC = { boot, demoView };
})();
