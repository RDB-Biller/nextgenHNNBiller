/* Shared renderer for Product Lab solutions on patient-, hospital- and payer-facing pages. */
'use strict';
const SolUI=(()=>{
  const esc=(x)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n2=(n)=>Number(n||0).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2});
  const table=(rows,cols)=>!rows||!rows.length?'<p class="muted" style="font-size:13px">None.</p>'
    :`<table><thead><tr>${cols.map(c=>`<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>`
     +rows.map(r=>`<tr>${cols.map(c=>`<td>${esc(typeof c[2]==='function'?c[2](r):r[c[0]])}</td>`).join('')}</tr>`).join('')+'</tbody></table>';

  function pharmacy(d){
    let h=d.advice?`<p style="background:var(--brand-soft);padding:10px;border-radius:8px">${esc(d.advice)}</p>`:'';
    if(d.basket)h+=`<p style="margin:8px 0 4px"><b>Basket total</b> <span class="muted" style="font-size:12px">(pharmacies with a recent price for every item)</span></p>`
      +table(d.basket.all,[['name','Pharmacy'],['total','Total (GHS)',r=>n2(r.total)]]);
    h+=d.items.map(it=>`<p style="margin:12px 0 4px"><b>${esc(it.query)}</b>${it.reference?` <span class="muted" style="font-size:12px">NHIS reference GHS ${n2(it.reference.price)}</span>`:''}</p>`
      +table(it.pharmacies,[['name','Pharmacy'],['price','Price (GHS)',r=>n2(r.price)],['priceSource','Based on',r=>r.priceSource==='quoted'?'pharmacy quotation':'recent bills'],['lastSeen','Updated',r=>String(r.lastSeen||'').slice(0,10)]])).join('');
    if(d.notFound.length)h+=`<p class="muted" style="font-size:13px;margin-top:10px">No recent prices found for: ${d.notFound.map(esc).join(', ')}</p>`;
    return h+`<p class="muted" style="font-size:12px;margin-top:8px">Based on what pharmacies charged in the last ${d.sinceDays} days. Prices change — confirm before paying.</p>`;
  }
  function render(mod,d){
    if(mod==='pharmacy_compare')return pharmacy(d);
    if(mod==='auth_threshold')return `<p>Claims up to <b>GHS ${n2(d.thresholdMaxAmount)}</b> are ${d.enabled?'authorized automatically':'<b>not</b> auto-authorized'}.</p>`
      +(d.check?`<p>GHS ${n2(d.check.amount)} → <b>${d.check.autoAuthorized?'approved automatically':'goes to manual review'}</b></p>`:'');
    if(mod==='auto_adjudication')return `<p>Active rules: <b>${d.activeRules.length}</b></p>`+table(d.activeRules,[['diagnosisKeyword','Diagnosis'],['requiredItemCodes','Needs',r=>(r.requiredItemCodes||[]).join(', ')],['maxAmount','Cap (GHS)']])
      +(d.whatIf?`<p style="margin-top:8px">Result: <b>${d.whatIf.autoClear?'clears automatically':'manual review'}</b></p>`:'');
    if(mod==='claim_expiry')return `<p>Open claims revert to the standard RX queue after <b>${d.windowDays}</b> days · <b>${d.atRisk}</b> at risk.</p>`
      +table(d.openClaims,[['claimId','Claim'],['amount','Amount'],['ageDays','Age (days)'],['daysLeft','Days left']]);
    if(mod==='settlement_cycle'||mod==='daily_billing')return (d.effectiveCycle?`<p>Settlement cycle: <b>${esc(d.effectiveCycle)}</b></p>`:'')
      +'<p class="muted" style="font-size:13px;margin:6px 0">Queued for the next batch</p>'+table(d.queue,[['tenantName','Provider'],['claimCount','Claims'],['amount','Amount'],['due','Due now',r=>r.due?'yes':'no']])
      +(d.batches?'<p class="muted" style="font-size:13px;margin:10px 0 6px">Recent batches</p>'+table(d.batches,[['id','Batch'],['status','Status'],['amount','Amount']]):'');
    if(mod==='multi_funder')return `<p>Funder: <b>${esc(d.funder.name)}</b></p><p>Administered by: ${d.administeredBy.map(p=>esc(p.name)).join(', ')||'—'}</p>`;
    if(mod==='reconciliation')return `<p>Settled by HNN: <b>${d.hnnSettled.count}</b> · GHS ${n2(d.hnnSettled.total)}</p>`
      +table(d.hnnSettled.rows,[['claimId','Claim'],['amount','Amount'],['settledAt','Settled'],['settlementMethod','Method']])
      +`<p style="margin-top:10px">Still in the RX queue: <b>${d.stillInRxQueue.count}</b> · GHS ${n2(d.stillInRxQueue.total)}</p>`;
    return `<pre style="white-space:pre-wrap">${esc(JSON.stringify(d,null,2))}</pre>`;
  }
  /** Draws title/intro/inputs/Run button/result into `el`. run(input) must resolve to the API's run response. */
  function mount(el,view,surface,run){
    const fields=(view.inputs||[]).filter(f=>!f.surface||f.surface===surface);
    el.innerHTML=`<h2 style="margin-top:0">${esc(view.title)}</h2>${view.intro?`<p class="muted" style="margin-top:0">${esc(view.intro)}</p>`:''}`
      +fields.map(f=>`<div class="field"><label>${esc(f.label)}</label>`+(f.type==='textarea'
        ?`<textarea data-k="${esc(f.key)}" rows="4" placeholder="Amoxicillin&#10;Paracetamol"></textarea>`
        :`<input data-k="${esc(f.key)}" type="${f.type==='number'?'number':'text'}"/>`)+'</div>').join('')
      +'<button class="primary">Run</button><div class="solout" style="margin-top:12px"></div>';
    const out=el.querySelector('.solout');
    el.querySelector('button').onclick=async()=>{
      const input={};el.querySelectorAll('[data-k]').forEach(e=>{if(e.value.trim())input[e.dataset.k]=e.value;});
      out.innerHTML='<p class="muted">Working…</p>';
      try{const o=await run(input);out.innerHTML=(o.dryRun?'<p class="muted" style="font-size:12px">Test mode — not live yet.</p>':'')+render(o.module,o.result);}
      catch(e){out.innerHTML=`<p style="color:var(--bad)">${esc(e.message)}</p>`;}
    };
  }
  async function call(url,opt){
    const r=await fetch(url,opt);const o=await r.json().catch(()=>null);
    if(!r.ok)throw new Error((o&&(o.message||o.error))||'Something went wrong');
    return o;
  }
  return {render,mount,call,esc};
})();
