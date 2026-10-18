/* Master Control: currencies. GHS and USD are the two main ones (each person picks their default); everything else is in the "Other" list.
   Rates are units per 1 US dollar and are approximate display rates: HNN Biller bills, lends and settles in GHS. */
'use strict';
(function () {
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const first = document.getElementById('p-clients'); if (!tabs || !first) return;
  const q = (id) => document.getElementById(id);
  const call = async (method, body) => { const r = await fetch('/api/platform/currencies', { method: method || 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined }); const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || 'HTTP ' + r.status); return o; };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
  const b = document.createElement('button'); b.textContent = 'Currencies'; b.onclick = () => { tab('currencies', b); cuLoad(); }; tabs.appendChild(b);
  const p = document.createElement('div'); p.className = 'panel'; p.id = 'p-currencies';
  p.innerHTML = `<div class="card" style="margin-bottom:14px"><h2>Currencies</h2>
    <p class="muted" style="font-size:13px;margin-top:0">Everything is billed, lent and repaid in <b>GHS</b>. People can <i>view</i> amounts in another currency. <b>GHS</b> and <b>USD</b> are the two main ones: each person ticks their default the first time they sign in and can flip between them. All other currencies are in the <b>Other</b> list, with the naira and East Africa first. Rates are units per 1 US dollar. Until you save your own, the built-in rates are only a starting point and are shown to people as indicative.</p>
    <div class="row"><div class="field"><label>Default for people who have not chosen</label><select id="cu_def"><option value="GHS">GHS (cedi)</option><option value="USD">USD (US dollar)</option></select></div><div class="field"><label>Rates as of</label><input id="cu_asof" type="date"/></div><div class="field" style="display:flex;align-items:flex-end"><button class="primary" onclick="cuSave()">Save rates and settings</button></div></div>
    <div class="field"><label>Search</label><input id="cu_q" placeholder="Code, name or region" oninput="cuDraw()"/></div><div id="cu_list" class="muted">Loading</div></div>`;
  first.parentNode.appendChild(p);
  let D = null; const edits = {}; const off = new Set();
  const cuLoad = guard(async () => { D = await call(); q('cu_def').value = D.config.platformDefault; q('cu_asof').value = D.config.asOf || ''; off.clear(); D.config.disabled.forEach((c) => off.add(c)); cuDraw(); });
  window.cuDraw = () => {
    if (!D) return; const t = q('cu_q').value.trim().toLowerCase();
    const rows = D.currencies.filter((c) => !t || [c.code, c.name, c.region].some((v) => v.toLowerCase().includes(t)));
    q('cu_list').innerHTML = `<table><tr><th>Currency</th><th>Region</th><th>Per 1 USD</th><th>Offered</th></tr>${rows.map((c) => { const main = D.main.includes(c.code); return `<tr><td><b>${esc(c.code)}</b> ${esc(c.symbol)}<br><span class="muted">${esc(c.name)}</span></td><td>${esc(c.region)}</td>
      <td><input style="width:130px" value="${esc(edits[c.code] !== undefined ? edits[c.code] : D.config.rates[c.code])}" ${c.code === 'USD' ? 'disabled' : ''} onchange="cuRate('${c.code}',this.value)"/></td>
      <td>${main ? '<span class="muted">always (main)</span>' : `<input type="checkbox" style="width:auto" ${off.has(c.code) ? '' : 'checked'} onchange="cuOff('${c.code}',this.checked)"/>`}</td></tr>`; }).join('')}</table>`;
  };
  window.cuRate = (c, v) => { edits[c] = v; }; window.cuOff = (c, on) => { if (on) off.delete(c); else off.add(c); };
  window.cuSave = guard(async () => { const rates = {}; for (const [c, v] of Object.entries(edits)) rates[c] = Number(v); const body = { platformDefault: q('cu_def').value, disabled: [...off] }; if (Object.keys(rates).length) { body.rates = rates; body.asOf = q('cu_asof').value || undefined; } await call('PUT', body); toast('Saved'); Object.keys(edits).forEach((k) => delete edits[k]); cuLoad(); });
})();
