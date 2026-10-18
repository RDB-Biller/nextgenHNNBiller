/* Master Control: price books. The official NHIS Medicines List is the original default. Illustrative samples (NHS England, US Medicare-style,
   private insurer schedules, Nigeria, Kenya, South Africa, India, Germany, self-pay) show other pricing structures. Master Control can pick the
   platform default, switch books on or off for clinics, and upload its own book from a CSV. Open in the demo too (changes stay in the visitor's private copy). */
'use strict';
(function () {
  const tabs = document.querySelector('.tabs:not(.subtabs)'); const first = document.getElementById('p-clients'); if (!tabs || !first) return;
  const q = (id) => document.getElementById(id);
  const call = async (method, body, path) => { const r = await fetch('/api/platform/price-books' + (path || ''), { method: method || 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined }); const o = await r.json().catch(() => null); if (!r.ok) throw new Error((o && (o.message || o.error)) || 'HTTP ' + r.status); return o; };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
  const b = document.createElement('button'); b.textContent = 'Price books'; b.onclick = () => { tab('pricebooks', b); pbLoad(); }; tabs.appendChild(b);
  const p = document.createElement('div'); p.className = 'panel'; p.id = 'p-pricebooks';
  p.innerHTML = `<div class="card" style="margin-bottom:14px"><h2>Price books</h2>
    <p class="muted" style="font-size:13px;margin-top:0">A price book is the list of items and prices a clinic searches when it builds a bill. The <b>NHIS Medicines List</b> (official, in cedis) is the original default. The others are <b>illustrative samples</b> so you can see how different pricing structures look (public tariffs, private insurers, self-pay). They are not official tariffs. Pick the <b>platform default</b> for clinics that have not chosen their own, switch books on or off, or upload your own from a CSV. Bills are always made and settled in GHS; a book in another currency is converted at the Master Control rate when an item is added.</p>
    <div id="pb_list" class="muted">Loading</div></div>
    <div class="card"><h2>Upload your own price book</h2>
    <p class="muted" style="font-size:13px;margin-top:0">A CSV with a header row. Required columns: <code>name</code>, <code>price</code>. Optional: <code>code</code>, <code>unit</code>, <code>category</code>, <code>level</code>. Prices are in the currency you choose below. <a href="#" id="pb_tpl">Download a template</a>.</p>
    <div class="row"><div class="field"><label>Name</label><input id="pb_name" placeholder="e.g. Our hospital tariff 2026"/></div><div class="field"><label>Prices are in</label><select id="pb_cur"></select></div><div class="field"><label>Region (optional)</label><input id="pb_region" placeholder="Ghana"/></div></div>
    <div class="field"><label>CSV file</label><input id="pb_file" type="file" accept=".csv,.txt,text/csv"/></div>
    <div class="field"><label>Or paste the rows</label><textarea id="pb_csv" rows="4" placeholder="code,name,unit,category,price"></textarea></div>
    <button class="primary" id="pb_up">Upload price book</button><div id="pb_msg" class="muted" style="margin-top:8px"></div></div>`;
  first.parentNode.appendChild(p);
  let D = null;
  const badge = (x) => x.official ? '<span class="pill settled">Official</span>' : x.builtin ? '<span class="pill awaiting_payer">Illustrative</span>' : '<span class="pill">Uploaded</span>';
  const draw = () => {
    if (!D) return; q('pb_cur').innerHTML = D.currencies.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join(''); q('pb_cur').value = q('pb_cur').dataset.v || 'GHS';
    q('pb_list').innerHTML = `<table><tr><th>Default</th><th>Price book</th><th>Currency</th><th>Items</th><th>Offered to clinics</th><th></th></tr>${D.books.map((x) => `<tr>
      <td><input type="radio" name="pb_def" style="width:auto" ${x.isDefault ? 'checked' : ''} onchange="pbDefault('${esc(x.id)}')"/></td>
      <td><b>${esc(x.name)}</b> ${badge(x)}<br><span class="muted">${esc(x.region || '')}${x.region && x.note ? ' · ' : ''}${esc(x.note || '')}</span></td>
      <td>${esc(x.currency)}</td><td>${x.itemCount.toLocaleString()}</td>
      <td>${x.id === 'nhis-gh' ? '<span class="muted">always</span>' : `<input type="checkbox" style="width:auto" ${x.enabled ? 'checked' : ''} onchange="pbOffer('${esc(x.id)}',this.checked)"/>`}</td>
      <td>${x.builtin ? '' : `<button class="ghost" onclick="pbDelete('${esc(x.id)}')">Delete</button>`}</td></tr>`).join('')}</table>`;
  };
  const pbLoad = guard(async () => { D = await call(); draw(); });
  window.pbDefault = guard(async (id) => { D = await call('PUT', { defaultId: id }); draw(); toast('Platform default saved'); });
  window.pbOffer = guard(async (id, on) => { const off = D.books.filter((x) => !x.enabled).map((x) => x.id).filter((x) => x !== id); if (!on) off.push(id); try { D = await call('PUT', { disabled: off }); } catch (e) { toast(e.message); D = await call(); } draw(); });
  window.pbDelete = guard(async (id) => { if (!confirm('Delete this price book?')) return; await call('DELETE', null, '/' + encodeURIComponent(id)); toast('Deleted'); pbLoad(); });
  q('pb_cur').onchange = () => { q('pb_cur').dataset.v = q('pb_cur').value; };
  q('pb_file').onchange = () => { const f = q('pb_file').files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { q('pb_csv').value = String(rd.result || ''); if (!q('pb_name').value) q('pb_name').value = f.name.replace(/\.[^.]+$/, ''); }; rd.readAsText(f); };
  q('pb_tpl').onclick = guard(async (e) => { e.preventDefault(); const r = await fetch('/api/platform/price-books/template.csv', { headers: H() }); const t = await r.text(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'price-book-template.csv'; a.click(); });
  q('pb_up').onclick = guard(async () => {
    const o = await call('POST', { name: q('pb_name').value, currency: q('pb_cur').value, region: q('pb_region').value, csv: q('pb_csv').value });
    q('pb_msg').innerHTML = `Imported <b>${o.imported}</b> items into <b>${esc(o.book.name)}</b>.${o.skippedCount ? ` ${o.skippedCount} rows were skipped: ${o.skipped.slice(0, 5).map((s) => `row ${s.row} (${esc(s.reason)})`).join(', ')}${o.skippedCount > 5 ? '…' : ''}.` : ''}`;
    q('pb_csv').value = ''; q('pb_file').value = ''; pbLoad();
  });
})();
