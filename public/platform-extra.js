/* Master Control extras: SMS Dashboard (Messaging tab) and the Solutions builder/runner (Product Lab).
   Loaded after platform.html's inline script, which provides $, H, esc, toast, n2, PRODUCTS, CLIENTS, loadProducts. */
'use strict';

// ======================= SMS Dashboard =======================
let SMS_DEB=null;
const smsDebounce=(fn)=>{clearTimeout(SMS_DEB);SMS_DEB=setTimeout(fn,300);};
const smsApi=async(path,opt={})=>{
  const r=await fetch('/api/platform/sms'+path,{headers:H(),...opt});
  const o=await r.json().catch(()=>null);
  if(!r.ok)throw new Error((o&&(o.message||o.error))||('HTTP '+r.status));
  return o;
};

function smsTab(name,btn){
  document.querySelectorAll('.smsp').forEach(p=>p.style.display='none');
  $('smsp-'+name).style.display='';
  btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');
  if(name==='logs')smsLogs(1);if(name==='inbox')smsInbox(1);if(name==='analytics')smsAnalytics();if(name==='settings')smsSettings();
}

async function smsBoot(){
  try{
    const o=await smsApi('/overview');
    $('sms_mode').innerHTML=o.messagingSandbox
      ?'<span class="pill sandbox">SANDBOX — messages are logged, not delivered</span>'
      :`<span class="pill live">LIVE${o.provider?' · '+esc(o.provider):''} — messages are really sent</span>`;
  }catch(e){}
}

function smsChars(){
  const n=$('sms_message').value.length;
  $('sms_chars').textContent=`${n} chars · ${n<=160?1:Math.ceil(n/153)} SMS part${n>160?'s':''} each`;
}
let SMS_PARSE_T=null;
function smsCount(){
  clearTimeout(SMS_PARSE_T);
  SMS_PARSE_T=setTimeout(async()=>{
    const v=$('sms_numbers').value;
    if(!v.trim()){$('sms_count').textContent='';return;}
    try{
      const p=await smsApi('/parse',{method:'POST',body:JSON.stringify({numbers:v})});
      $('sms_count').innerHTML=`<b>${p.valid}</b> valid`+(p.duplicates?` · ${p.duplicates} duplicate${p.duplicates>1?'s':''} removed`:'')
        +(p.invalid.length?` · <span style="color:var(--bad)">${p.invalid.length} invalid</span> (${esc(p.invalid.slice(0,3).join(', '))}${p.invalid.length>3?'…':''})`:'');
    }catch(e){$('sms_count').textContent=e.message;}
  },250);
}

// --- file upload: CSV/TXT as text, XLSX via a zero-dependency zip reader ---
async function smsFile(inp){
  const f=inp.files&&inp.files[0];if(!f)return;
  try{
    let text;
    if(/\.xlsx$/i.test(f.name))text=(await xlsxCells(await f.arrayBuffer())).join('\n');
    else text=await f.text();
    const cur=$('sms_numbers').value.trim();
    $('sms_numbers').value=(cur?cur+'\n':'')+text.replace(/\r/g,'').split('\n').map(l=>l.replace(/[,;\t]+/g,'\n')).join('\n');
    smsCount();toast(`Loaded ${f.name}`);
  }catch(e){toast('Could not read file: '+e.message);}
  inp.value='';
}
async function inflateRaw(bytes){
  if(typeof DecompressionStream==='undefined')throw new Error('this browser cannot read .xlsx — save as CSV instead');
  const ds=new DecompressionStream('deflate-raw');
  const out=new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
async function unzip(buf){
  const dv=new DataView(buf),u8=new Uint8Array(buf);let e=-1;
  for(let i=u8.length-22;i>=Math.max(0,u8.length-65558);i--){if(dv.getUint32(i,true)===0x06054b50){e=i;break;}}
  if(e<0)throw new Error('not a valid .xlsx file');
  const n=dv.getUint16(e+10,true);let p=dv.getUint32(e+16,true);const files={};
  for(let k=0;k<n;k++){
    if(dv.getUint32(p,true)!==0x02014b50)break;
    const method=dv.getUint16(p+10,true),csz=dv.getUint32(p+20,true),nl=dv.getUint16(p+28,true),xl=dv.getUint16(p+30,true),cl=dv.getUint16(p+32,true),off=dv.getUint32(p+42,true);
    const name=new TextDecoder().decode(u8.subarray(p+46,p+46+nl));
    const ln=dv.getUint16(off+26,true),lx=dv.getUint16(off+28,true),start=off+30+ln+lx;
    files[name]={method,data:u8.subarray(start,start+csz)};
    p+=46+nl+xl+cl;
  }
  return files;
}
async function zipText(files,name){
  const f=files[name];if(!f)return null;
  const bytes=f.method===0?f.data:await inflateRaw(f.data);
  return new TextDecoder().decode(bytes);
}
async function xlsxCells(buf){
  const files=await unzip(buf);
  const dec=(s)=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const ssXml=await zipText(files,'xl/sharedStrings.xml');
  const shared=ssXml?[...ssXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map(m=>dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join(''))):[];
  const sheets=Object.keys(files).filter(k=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  if(!sheets.length)throw new Error('no worksheet found');
  const out=[];
  for(const sh of sheets){
    const xml=await zipText(files,sh);
    for(const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const attrs=m[1],body=m[2]||'';const t=(attrs.match(/\bt="(\w+)"/)||[])[1];
      let v;
      if(t==='s'){const i=(body.match(/<v>(\d+)<\/v>/)||[])[1];v=i!=null?shared[+i]:null;}
      else if(t==='inlineStr'){v=dec([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join(''));}
      else{const x=(body.match(/<v>([^<]*)<\/v>/)||[])[1];v=x==null?null:(/e/i.test(x)&&!isNaN(+x)?String(BigInt(Math.round(+x))):x);}
      if(v!=null&&String(v).trim())out.push(String(v).trim());
    }
  }
  return out;
}

async function smsSend(){
  const numbers=$('sms_numbers').value,message=$('sms_message').value;
  if(!numbers.trim())return toast('Add at least one number');
  if(!message.trim())return toast('Write a message');
  const btn=$('sms_send_btn');btn.disabled=true;$('sms_send_status').textContent='Sending…';
  try{
    const r=await smsApi('/send',{method:'POST',body:JSON.stringify({numbers,message})});
    $('sms_send_status').innerHTML=`${r.mode==='sandbox'?'<b>Sandbox</b> — logged, not delivered. ':''}Accepted <b>${r.accepted}</b> of ${r.requested}`
      +(r.failed?` · <span style="color:var(--bad)">${r.failed} failed</span>`:'')+(r.skippedOptOut?` · ${r.skippedOptOut} skipped (opted out)`:'')
      +(r.invalid.length?` · ${r.invalid.length} invalid ignored`:'')+(r.error?` · <span style="color:var(--bad)">${esc(r.error)}</span>`:'');
    toast('Done');
  }catch(e){$('sms_send_status').textContent=e.message;toast('Send failed');}
  btn.disabled=false;
}

const smsPill=(s)=>({delivered:'<span class="pill settled">delivered</span>',sent:'<span class="pill">sent</span>',sandbox:'<span class="pill sandbox">sandbox</span>',failed:'<span class="pill live">failed</span>',skipped_optout:'<span class="pill open">opted out</span>'}[s]||esc(s));
const smsPager=(el,o,fn)=>{el.innerHTML=`<span class="muted" style="font-size:13px">${o.total} message${o.total===1?'':'s'} · page ${o.page}/${o.pages}</span> `
  +`<button class="ghost mini" ${o.page<=1?'disabled':''} onclick="${fn}(${o.page-1})">Prev</button> <button class="ghost mini" ${o.page>=o.pages?'disabled':''} onclick="${fn}(${o.page+1})">Next</button>`;};
let SMS_LOG_PAGE=1,SMS_IN_PAGE=1;
async function smsLogs(page){
  SMS_LOG_PAGE=page||SMS_LOG_PAGE;
  try{
    const q=new URLSearchParams({q:$('sms_q').value,status:$('sms_status').value,page:SMS_LOG_PAGE,pageSize:20});
    const o=await smsApi('/logs?'+q);
    $('sms_logs').innerHTML=o.data.length?`<table><thead><tr><th>Time</th><th>To</th><th>Message</th><th>Status</th><th>Detail</th></tr></thead><tbody>`
      +o.data.map(r=>`<tr><td style="white-space:nowrap">${new Date(r.createdAt).toLocaleString()}</td><td>${esc(r.to)}</td><td style="max-width:320px">${esc(r.message)}</td><td>${smsPill(r.status)}</td><td class="muted" style="font-size:12px">${esc(r.error||r.providerStatus||'')}${r.cost?' · '+esc(r.cost):''}</td></tr>`).join('')+'</tbody></table>'
      :'<p class="muted">No messages yet.</p>';
    smsPager($('sms_logs_pager'),o,'smsLogs');
  }catch(e){$('sms_logs').innerHTML=`<p class="muted">${esc(e.message)}</p>`;}
}
async function smsExport(){
  const q=new URLSearchParams({q:$('sms_q').value,status:$('sms_status').value});
  const r=await fetch('/api/platform/sms/logs.csv?'+q,{headers:H()});
  if(!r.ok)return toast('Export failed');
  const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='sms-log.csv';a.click();URL.revokeObjectURL(a.href);
}
async function smsInbox(page){
  SMS_IN_PAGE=page||SMS_IN_PAGE;
  try{
    const o=await smsApi('/inbox?'+new URLSearchParams({q:$('sms_iq').value,page:SMS_IN_PAGE,pageSize:20}));
    $('sms_inbox').innerHTML=o.data.length?`<table><thead><tr><th>Received</th><th>From</th><th>To</th><th>Text</th><th>Handled as</th></tr></thead><tbody>`
      +o.data.map(r=>`<tr><td style="white-space:nowrap">${esc(r.receivedAt)}</td><td>${esc(r.from)}</td><td>${esc(r.to||'')}</td><td style="max-width:320px">${esc(r.text)}</td><td class="muted" style="font-size:12px">${esc(r.outcome||'—')}</td></tr>`).join('')+'</tbody></table>'
      :'<p class="muted">No inbound messages yet. Set the Inbox callback URL under “Callbacks &amp; opt-outs”.</p>';
    smsPager($('sms_inbox_pager'),o,'smsInbox');
  }catch(e){$('sms_inbox').innerHTML=`<p class="muted">${esc(e.message)}</p>`;}
}
async function smsAnalytics(){
  try{
    const a=await smsApi('/analytics');
    const k=(l,v)=>`<div class="kpi"><div class="l">${l}</div><div class="bignum" style="font-size:22px">${v}</div></div>`;
    $('sms_kpis').innerHTML=k('Outbound',a.totalOutbound)+k('Delivery rate',a.deliveryRate==null?'—':a.deliveryRate+'%')+k('Inbound',a.inbound)
      +k('Failed',a.byStatus.failed||0)+k('Cost (as reported)',n2(a.totalCost))+k('Opt-outs',a.optOuts);
    const max=Math.max(1,...a.daily.map(d=>d.sent+d.failed+d.inbound));
    $('sms_daily').innerHTML='<p class="muted" style="font-size:13px;margin:6px 0">Last 14 days — sent / failed / inbound</p>'+a.daily.map(d=>
      `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0"><span style="width:78px">${esc(d.date.slice(5))}</span>`
      +`<div style="flex:1;display:flex;height:12px;background:#f1f5f4;border-radius:6px;overflow:hidden"><div style="width:${d.sent/max*100}%;background:var(--brand)"></div><div style="width:${d.failed/max*100}%;background:var(--bad)"></div><div style="width:${d.inbound/max*100}%;background:#94a3b8"></div></div>`
      +`<span style="width:70px;text-align:right">${d.sent} / ${d.failed} / ${d.inbound}</span></div>`).join('');
  }catch(e){$('sms_kpis').innerHTML=`<p class="muted">${esc(e.message)}</p>`;}
}
function smsHookRows(h){
  const row=(l,u,d)=>`<div style="margin:8px 0"><b>${l}</b> <span class="muted" style="font-size:12px">${d}</span><br><span class="key" id="hk_${l}">${esc(u)}</span> <button class="ghost mini" onclick="navigator.clipboard.writeText('${esc(u)}').then(()=>toast('Copied'))">Copy</button></div>`;
  $('sms_hooks').innerHTML=row('Delivery reports',h.delivery,'→ AT “Delivery Reports”')+row('Inbox',h.inbox,'→ AT “Incoming Messages” (replies to your shortcode/sender)')+row('Opt-out',h.optout,'→ AT “Bulk SMS Opt Out”');
}
async function smsSettings(){
  try{const o=await smsApi('/overview');smsHookRows(o.hookUrls);}catch(e){$('sms_hooks').innerHTML=`<p class="muted">${esc(e.message)}</p>`;}
  smsOptList();
}
async function smsRotate(){
  if(!confirm('Rotate the callback secret? Existing callback URLs stop working until you paste the new ones into Africa\'s Talking.'))return;
  try{const o=await smsApi('/rotate-secret',{method:'POST',body:'{}'});smsHookRows(o.hookUrls);toast('Secret rotated');}catch(e){toast(e.message);}
}
async function smsOptList(){
  try{const o=await smsApi('/optouts');
    $('sms_optouts').innerHTML=o.data.length?o.data.map(n=>`<span class="pill" style="margin:2px">${esc(n)} <a href="#" onclick="smsOptDel('${esc(n)}');return false" style="margin-left:4px">✕</a></span>`).join(''):'<p class="muted" style="font-size:13px">None.</p>';
  }catch(e){}
}
async function smsOptAdd(){
  try{await smsApi('/optouts',{method:'POST',body:JSON.stringify({phoneNumber:$('sms_oo').value})});$('sms_oo').value='';smsOptList();}catch(e){toast(e.message);}
}
async function smsOptDel(n){try{await smsApi('/optouts/'+encodeURIComponent(n),{method:'DELETE'});smsOptList();}catch(e){toast(e.message);}}

// ======================= Solutions (Product Lab) =======================
let SOL_MODULES=[],SOL_FUNDERS=[],PD_EDIT=null;
const solMod=()=>SOL_MODULES.find(m=>m.key===$('pd_sol_module').value);

async function pdSolInit(){
  if(!SOL_MODULES.length){
    const o=await (await fetch('/api/platform/solutions/modules',{headers:H()})).json().catch(()=>null);
    SOL_MODULES=(o&&o.modules)||[];SOL_FUNDERS=(o&&o.funders)||[];
    $('pd_sol_module').innerHTML=SOL_MODULES.map(m=>`<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
  }
  pdSolModuleChanged();
}
function pdSolModuleChanged(preset){
  const m=solMod();if(!m)return;
  $('pd_sol_desc').textContent=m.description+(m.scope==='platform'?' (Applies platform-wide, not just to this payer.)':m.scope==='none'?' (Read-only: nothing is changed when it goes live.)':'');
  $('pd_sol_surfaces').innerHTML=m.surfaces.map(s=>`<label style="font-weight:400;display:flex;gap:6px;align-items:center"><input type="checkbox" class="solSurf" value="${s}" style="width:auto" ${(preset&&preset.surfaces?preset.surfaces.includes(s):true)?'checked':''}/> ${s==='patient'?'Patients':s==='hospital'?'Hospitals':'Payer team'}</label>`).join('');
  const vals=(preset&&preset.params)||{};
  $('pd_sol_params').innerHTML=m.params.map(p=>{
    const v=vals[p.key]!==undefined?vals[p.key]:p.default;let inp;
    if(p.type==='boolean')inp=`<select class="solParam" data-k="${p.key}"><option value="true" ${v===true||v==='true'?'selected':''}>Yes</option><option value="false" ${v===false||v==='false'?'selected':''}>No</option></select>`;
    else if(p.type==='select'){const opts=p.optionsFrom==='funders'?SOL_FUNDERS.map(f=>[f.id,f.name]):(p.options||[]).map(o=>[o,o]);
      inp=`<select class="solParam" data-k="${p.key}">${opts.map(o=>`<option value="${esc(o[0])}" ${o[0]===v?'selected':''}>${esc(o[1])}</option>`).join('')}</select>`;}
    else inp=`<input class="solParam" data-k="${p.key}" type="${p.type==='number'?'number':'text'}" ${p.min!=null?`min="${p.min}"`:''} ${p.max!=null?`max="${p.max}"`:''} value="${esc(v??'')}"/>`;
    return `<div class="field"><label>${esc(p.label)}</label>${inp}${p.help?`<span class="muted" style="font-size:11px">${esc(p.help)}</span>`:''}</div>`;
  }).join('');
}
function pdSolConfig(){
  const params={};document.querySelectorAll('.solParam').forEach(e=>{params[e.dataset.k]=e.value;});
  return {module:$('pd_sol_module').value,title:$('pd_sol_title').value.trim()||undefined,intro:$('pd_sol_intro').value,
    surfaces:[...document.querySelectorAll('.solSurf')].filter(c=>c.checked).map(c=>c.value),params,tenantIds:pdSelectedProviders()};
}
async function pdSaveSolution(){
  const name=$('pd_name').value.trim();if(!name)return toast('Name required');
  const config=pdSolConfig();
  let r;
  if(PD_EDIT){
    r=await fetch(`/api/platform/products/${encodeURIComponent(PD_EDIT)}`,{method:'PUT',headers:H(),body:JSON.stringify({name,description:$('pd_desc').value,config})});
  }else{
    const payerId=$('pd_payer').value;if(!payerId)return toast('Pick a sponsoring payer');
    r=await fetch('/api/platform/products',{method:'POST',headers:H(),body:JSON.stringify({payerId,type:'solution',name,description:$('pd_desc').value,config})});
  }
  const o=await r.json().catch(()=>null);
  if(r.ok){toast(PD_EDIT?`${o.name} updated`:`${o.name} created as draft`);pdCancelEdit();loadProducts();}
  else{$('pd_create_status').textContent=`${(o&&(o.message||o.error))||'Failed'}${o&&o.detail?': '+o.detail:''}`;toast('Could not save — see note below the button');}
}
async function pdEditSolution(id){
  const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
  PD_EDIT=id;$('pd_type').value='solution';pdTypeChanged();await pdSolInit();
  $('pd_payer').value=p.payerId;$('pd_payer').disabled=true;$('pd_type').disabled=true;
  $('pd_name').value=p.name;$('pd_desc').value=p.description||'';
  $('pd_sol_module').value=p.config.module;$('pd_sol_module').disabled=true;
  pdSolModuleChanged(p.config);
  $('pd_sol_title').value=p.config.title||'';$('pd_sol_intro').value=p.config.intro||'';
  document.querySelectorAll('.pdProv').forEach(c=>{c.checked=(p.config.tenantIds||[]).includes(c.dataset.id);});
  $('pd_sol_link').textContent=`${location.origin}/solutions/?p=${id}`;
  $('pd_create_btn').textContent='Save changes'+(p.status==='live'?' (re-applies live)':'');$('pd_cancel_edit').style.display='';
  $('pd_name').scrollIntoView({behavior:'smooth',block:'center'});
}
function pdCancelEdit(){
  PD_EDIT=null;$('pd_payer').disabled=false;$('pd_type').disabled=false;if($('pd_sol_module'))$('pd_sol_module').disabled=false;
  $('pd_name').value='';$('pd_desc').value='';$('pd_create_status').textContent='';
  $('pd_create_btn').textContent='Create as draft';$('pd_cancel_edit').style.display='none';
  $('pd_sol_link').textContent='/solutions/?p=<product id>';
}

// --- runner
const SOL_INPUTS={
  auth_threshold:[['amount','Claim amount (GHS)','number']],
  auto_adjudication:[['diagnosis','Diagnosis','text'],['itemCodes','Item codes (comma-separated)','text'],['amount','Amount (GHS)','number']],
  claim_expiry:[],settlement_cycle:[['tenantId','Provider id (optional)','text']],daily_billing:[['tenantId','Provider id','text']],multi_funder:[],
  pharmacy_compare:[['items','Medicines (one per line)','textarea']],reconciliation:[['tenantId','Provider id','text'],['since','From (YYYY-MM-DD)','text']],
};
function pdAfterProducts(){
  const sols=PRODUCTS.filter(p=>p.type==='solution');
  $('pd_run_card').style.display=sols.length?'':'none';
  const cur=$('pd_run_sol').value;
  $('pd_run_sol').innerHTML=sols.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.status)})</option>`).join('');
  if(cur&&sols.some(p=>p.id===cur))$('pd_run_sol').value=cur;
  pdRunFields();
}
function pdRunFields(){
  const p=PRODUCTS.find(x=>x.id===$('pd_run_sol').value);if(!p){$('pd_run_inputs').innerHTML='';return;}
  $('pd_run_inputs').innerHTML=(SOL_INPUTS[p.config.module]||[]).map(f=>`<div class="field"><label>${esc(f[1])}</label>`
    +(f[2]==='textarea'?`<textarea class="solIn" data-k="${f[0]}" rows="4" placeholder="Amoxicillin&#10;Paracetamol"></textarea>`:`<input class="solIn" data-k="${f[0]}" type="${f[2]}"/>`)+'</div>').join('');
}
function pdTrySolution(id){$('pd_run_sol').value=id;pdRunFields();$('pd_run_card').scrollIntoView({behavior:'smooth'});}
function solTable(rows,cols){
  if(!rows||!rows.length)return '<p class="muted" style="font-size:13px">None.</p>';
  return `<table><thead><tr>${cols.map(c=>`<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>`+rows.map(r=>`<tr>${cols.map(c=>`<td>${esc(typeof c[2]==='function'?c[2](r):r[c[0]])}</td>`).join('')}</tr>`).join('')+'</tbody></table>';
}
function solRender(mod,d){
  if(mod==='pharmacy_compare')return solPharmacy(d);
  if(mod==='auth_threshold')return `<p>Auto-authorize ${d.enabled?'<b>on</b>':'off'} up to <b>GHS ${n2(d.thresholdMaxAmount)}</b>.</p>`+(d.check?`<p>GHS ${n2(d.check.amount)} → <b>${d.check.autoAuthorized?'authorized automatically':'goes to manual review'}</b></p>`:'');
  if(mod==='auto_adjudication')return `<p>Rules active: <b>${d.activeRules.length}</b> (master switch ${d.masterEnabled?'on':'OFF'}).</p>`+solTable(d.activeRules,[['diagnosisKeyword','Diagnosis'],['requiredItemCodes','Needs',r=>(r.requiredItemCodes||[]).join(', ')],['maxAmount','Cap']])+(d.whatIf?`<p style="margin-top:8px">What-if: <b>${d.whatIf.autoClear?'auto-clears ('+esc(d.whatIf.method)+')':'manual review'}</b></p>`:'');
  if(mod==='claim_expiry')return `<p>Open claims revert to RX after <b>${d.windowDays}</b> days${d.enabled?'':' (expiry is OFF)'} · <b>${d.atRisk}</b> at risk.</p>`+solTable(d.openClaims,[['claimId','Claim'],['amount','Amount'],['ageDays','Age (d)'],['daysLeft','Days left']]);
  if(mod==='settlement_cycle'||mod==='daily_billing')return `${d.effectiveCycle?`<p>Effective cycle: <b>${esc(d.effectiveCycle)}</b></p>`:''}<p class="muted" style="font-size:13px;margin:6px 0">Queued for the next batch</p>`+solTable(d.queue,[['tenantName','Provider'],['payerName','Payer'],['claimCount','Claims'],['amount','Amount'],['due','Due',r=>r.due?'yes':'no']])+(d.batches?`<p class="muted" style="font-size:13px;margin:10px 0 6px">Recent batches</p>`+solTable(d.batches,[['id','Batch'],['status','Status'],['amount','Amount'],['createdAt','Created']]):'');
  if(mod==='multi_funder')return `<p>Funder: <b>${esc(d.funder.name)}</b> (${esc(d.funder.kind)}) · own account: ${d.funder.hasOwnAccount?'yes':'no — attribution only'}</p><p>Administered by: ${d.administeredBy.map(p=>esc(p.name)).join(', ')||'—'}</p>`;
  if(mod==='reconciliation')return `<p>Settled by HNN: <b>${d.hnnSettled.count}</b> claims · GHS ${n2(d.hnnSettled.total)}</p>`+solTable(d.hnnSettled.rows,[['claimId','Claim'],['amount','Amount'],['settledAt','Settled'],['settlementMethod','Method']])+`<p style="margin-top:10px">Still in the RX queue: <b>${d.stillInRxQueue.count}</b> · GHS ${n2(d.stillInRxQueue.total)}</p>`;
  return `<pre style="white-space:pre-wrap">${esc(JSON.stringify(d,null,2))}</pre>`;
}
function solPharmacy(d){
  let h=d.advice?`<p style="background:var(--brand-soft);padding:10px;border-radius:8px">${esc(d.advice)}</p>`:'';
  if(d.basket)h+=`<p style="margin:8px 0 4px"><b>Basket total</b> (pharmacies pricing every item)</p>`+solTable(d.basket.all,[['name','Pharmacy'],['total','Total (GHS)',r=>n2(r.total)]]);
  h+=d.items.map(it=>`<p style="margin:12px 0 4px"><b>${esc(it.query)}</b>${it.reference?` <span class="muted" style="font-size:12px">NHIS ref. GHS ${n2(it.reference.price)}</span>`:''}${it.spreadPercent!=null?` <span class="muted" style="font-size:12px">· spread ${it.spreadPercent}%</span>`:''}</p>`
    +solTable(it.pharmacies,[['name','Pharmacy'],['price','Price (GHS)',r=>n2(r.price)],['observations','Seen'],['lastSeen','Last seen',r=>String(r.lastSeen||'').slice(0,10)]])).join('');
  if(d.notFound.length)h+=`<p class="muted" style="font-size:13px;margin-top:10px">No recent prices for: ${d.notFound.map(esc).join(', ')}</p>`;
  h+=`<p class="muted" style="font-size:12px;margin-top:8px">Analytics: ${d.analytics.withPrices}/${d.analytics.medicines} medicines priced · widest spread ${d.analytics.widestSpreadPercent}% · window ${d.sinceDays} days</p>`;
  return h;
}
async function pdRunSolution(){
  const id=$('pd_run_sol').value;if(!id)return;
  const input={};document.querySelectorAll('.solIn').forEach(e=>{if(e.value.trim())input[e.dataset.k]=e.value;});
  try{
    const r=await fetch(`/api/platform/solutions/${encodeURIComponent(id)}/run`,{method:'POST',headers:H(),body:JSON.stringify({input})});
    const o=await r.json();if(!r.ok)throw new Error(o.message||o.error||'Failed');
    $('pd_run_out').innerHTML=`<p class="muted" style="font-size:12px">${esc(o.title)} · ${o.dryRun?'dry-run (not live)':'live'}</p>`+solRender(o.module,o.result);
  }catch(e){$('pd_run_out').innerHTML=`<p style="color:var(--bad)">${esc(e.message)}</p>`;}
}
