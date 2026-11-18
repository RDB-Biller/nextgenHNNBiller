/* Dry Run page script. Host it yourself (save it as /dryrun/dryrun.js) and add:
 *   <script src="/dryrun/dryrun.js" data-dryrun-origin="https://your-dry-run-address" defer></script>
 * Inside the Dry Run Workroom preview it lets Dry Run show your iterations as overlays. It only answers the origins you list.
 * On a normal visit it does nothing, unless you add data-pack="/dryrun/pack.json" to apply a pack you approved.
 * A share link from the Workroom (?dri=...) opens your real site with one iteration applied and a "Dry Run Iteration (DRI)" watermark.
 * It never reads cookies, storage or form values, and it changes nothing on your server. */
(function () {
  'use strict';
  var me = document.currentScript, allowed = String((me && me.getAttribute('data-dryrun-origin')) || '').split(',').map(function (x) { return x.trim().replace(/\/$/, ''); }).filter(Boolean);
  var SEL = /^[\w\s.#\[\]=\-:>+~*"'(),^$|]{1,200}$/, BAD = /[{}<>]|@import|url\s*\(|expression|javascript:|\\/i, ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'href', 'value'];
  var undo = [], styleEl = null, picking = false;
  window.DryRun = window.DryRun || { settings: {} };

  function q(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } }
  function clear() { while (undo.length) { try { undo.pop()(); } catch (e) {} } if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); styleEl = null; window.DryRun.settings = {}; }
  function apply(patches) {
    clear(); var rules = [], report = [], settings = {};
    (patches || []).slice(0, 100).forEach(function (p, i) {
      var r = { i: i, type: p && p.type, matched: 0, skipped: null }; report.push(r); if (!p) return;
      if (p.type === 'setting') { if (/^[\w.\-]{1,60}$/.test(String(p.key))) { settings[p.key] = p.value; r.matched = 1; } else r.skipped = 'bad name'; return; }
      var sel = String(p.selector || ''); if (!SEL.test(sel)) { r.skipped = 'bad selector'; return; } var els = q(sel); r.matched = els.length;
      if (p.type === 'text') els.forEach(function (el) { var old = el.textContent; el.textContent = String(p.value == null ? '' : p.value).slice(0, 1000); undo.push(function () { el.textContent = old; }); });
      else if (p.type === 'hide') rules.push(sel + '{display:none !important}');
      else if (p.type === 'style') { var css = String(p.css || '').slice(0, 500); if (BAD.test(css)) { r.skipped = 'unsafe style'; return; } rules.push(sel + '{' + css + '}'); }
      else if (p.type === 'attr') { var n = String(p.name), v = String(p.value == null ? '' : p.value).slice(0, 500); if (ATTRS.indexOf(n) < 0) { r.skipped = 'attribute not allowed'; return; } if (n === 'href' && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v)) { r.skipped = 'unsafe link'; return; } els.forEach(function (el) { var had = el.hasAttribute(n), old = el.getAttribute(n); el.setAttribute(n, v); undo.push(function () { if (had) el.setAttribute(n, old); else el.removeAttribute(n); }); }); }
      else r.skipped = 'unknown change';
    });
    if (rules.length) { styleEl = document.createElement('style'); styleEl.setAttribute('data-dryrun', ''); styleEl.textContent = rules.join('\n'); document.head.appendChild(styleEl); }
    window.DryRun.settings = settings; try { document.dispatchEvent(new CustomEvent('dryrun:settings', { detail: settings })); } catch (e) {}
    return report;
  }
  function outline() {
    var t = function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60); };
    var pick = function (sel, n) { return q(sel).slice(0, n).map(function (el) { return { selector: selectorOf(el), text: t(el) }; }); };
    return { headings: pick('h1,h2,h3', 15), buttons: pick('button,[role=button],input[type=submit]', 15), links: q('a[href]').length, forms: q('form').slice(0, 10).map(function (f) { return { selector: selectorOf(f), fields: q('input,select,textarea').filter(function (x) { return f.contains(x); }).slice(0, 15).map(function (x) { return x.getAttribute('name') || x.type || x.tagName.toLowerCase(); }) }; }), images: q('img').length };
  }
  function selectorOf(el) {
    if (el.id && /^[\w\-]+$/.test(el.id)) return '#' + el.id; var parts = [], n = el, d = 0;
    while (n && n.nodeType === 1 && n !== document.body && d < 4) { var s = n.tagName.toLowerCase(); var cls = String(n.className && n.className.baseVal === undefined ? n.className : '').trim().split(/\s+/).filter(function (c) { return /^[\w\-]{1,40}$/.test(c); }).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); else { var sib = n.parentNode ? Array.prototype.filter.call(n.parentNode.children, function (x) { return x.tagName === n.tagName; }) : []; if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')'; } parts.unshift(s); if (n.id && /^[\w\-]+$/.test(n.id)) { parts[0] = '#' + n.id; break; } n = n.parentNode; d++; }
    return parts.join(' > ');
  }
  function startPick(reply) {
    picking = true; var box = document.createElement('div'); box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #d9480f;background:rgba(217,72,15,.12);z-index:2147483647;display:none'; document.body.appendChild(box);
    function over(e) { var r = e.target.getBoundingClientRect(); box.style.cssText += ';display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'; }
    function stop() { picking = false; document.removeEventListener('mouseover', over, true); document.removeEventListener('click', click, true); if (box.parentNode) box.parentNode.removeChild(box); }
    function click(e) { e.preventDefault(); e.stopPropagation(); var el = e.target; stop(); reply({ type: 'dryrun:picked', selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) }); }
    document.addEventListener('mouseover', over, true); document.addEventListener('click', click, true);
  }
  /* Dry Run Iteration (DRI): opened from a share link (?dri=...), the real site runs as normal with the iteration applied and a watermark on top.
   * The link is fetched from Dry Run, which only answers this site's own address. Changes live in this browser tab only. */
  function startDRI(token) {
    var api = allowed[0]; if (!api) return;
    fetch(api + '/api/public/dri/' + encodeURIComponent(token), { credentials: 'omit', mode: 'cors' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || d.dryrunIteration !== 1) { try { sessionStorage.removeItem('dryrun.dri'); } catch (e) {} return; }
      try { sessionStorage.setItem('dryrun.dri', token); } catch (e) {}
      var rules = [], flagged = 0;
      function once() {
        (d.patches || []).forEach(function (p) {
          var sel = String(p.selector || ''); if (!SEL.test(sel)) return; var els = q(sel);
          if (p.type === 'text') els.forEach(function (el) { var v = String(p.value == null ? '' : p.value).slice(0, 1000); if (el.textContent !== v) el.textContent = v; });
          else if (p.type === 'attr' && ATTRS.indexOf(p.name) >= 0) { var v2 = String(p.value == null ? '' : p.value).slice(0, 500); if (p.name === 'href' && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v2)) return; els.forEach(function (el) { if (el.getAttribute(p.name) !== v2) el.setAttribute(p.name, v2); }); }
        });
      }
      (d.patches || []).forEach(function (p) { var sel = String(p.selector || ''); if (!SEL.test(sel)) return; if (p.type === 'hide') rules.push(sel + '{display:none !important}'); else if (p.type === 'style' && !BAD.test(String(p.css || ''))) rules.push(sel + '{' + String(p.css).slice(0, 500) + '}'); });
      if (rules.length) { var st = document.createElement('style'); st.setAttribute('data-dryrun', ''); st.textContent = rules.join('\n'); document.head.appendChild(st); }
      window.DryRun.settings = d.settings || {}; try { document.dispatchEvent(new CustomEvent('dryrun:settings', { detail: d.settings || {} })); } catch (e) {}
      var timer = null, mo = new MutationObserver(function () { if (timer) return; timer = setTimeout(function () { timer = null; mo.disconnect(); once(); watch(); }, 250); });
      function watch() { mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); }
      once(); watch();
      var base = document.title.replace(/^\[DRI\] /, ''); document.title = '[DRI] ' + base;
      // the watermark lives in a closed shadow root so the page's own styles and the iteration's changes cannot touch it
      var host = document.createElement('div'); host.setAttribute('data-dryrun-dri', ''); var root = host.attachShadow({ mode: 'closed' });
      var tile = "<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'><text x='20' y='120' font-family='Arial,sans-serif' font-size='22' font-weight='700' fill='#d9480f' fill-opacity='0.13' transform='rotate(-24 180 110)'>Dry Run Iteration (DRI)</text></svg>";
      var until = new Date(d.expiresAt).toLocaleDateString();
      root.innerHTML = '<style>:host{all:initial}.w{position:fixed;inset:0;pointer-events:none;z-index:2147483646;background-image:url("data:image/svg+xml,' + encodeURIComponent(tile) + '")}.b{position:fixed;left:12px;bottom:12px;z-index:2147483647;font:600 13px/1.3 Arial,sans-serif;color:#fff;background:#d9480f;border-radius:8px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:min(92vw,420px)}.b small{display:block;font-weight:400;opacity:.92;margin-top:2px}.b a{color:#fff;text-decoration:underline;cursor:pointer;margin-left:8px;font-weight:400}</style><div class="w"></div><div class="b" role="status">Dry Run Iteration (DRI)<small></small></div>';
      var small = root.querySelector('small'); small.textContent = 'Iteration: ' + d.title + ' · link valid until ' + until + ' · actions on this site are real';
      var ex = document.createElement('a'); ex.textContent = 'Exit'; ex.onclick = function () { try { sessionStorage.removeItem('dryrun.dri'); } catch (e) {} var u = new URL(location.href); u.searchParams.delete('dri'); location.replace(u.toString()); }; small.appendChild(ex);
      document.documentElement.appendChild(host);
      new MutationObserver(function () { if (!host.isConnected) document.documentElement.appendChild(host); }).observe(document.documentElement, { childList: true });
    }).catch(function () {});
  }
  if (window.parent === window) {
    var tok = null; try { tok = new URL(location.href).searchParams.get('dri'); } catch (e) {} if (!tok) { try { tok = sessionStorage.getItem('dryrun.dri'); } catch (e) {} }
    if (tok && /^dri\.[\w\-]+\.[\w\-]+\.[0-9a-f]{20,}$/.test(tok)) startDRI(tok);
  }

  if (window.parent !== window) {
    window.addEventListener('message', function (e) {
      if (allowed.indexOf(e.origin) < 0 || e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
      var reply = function (m) { e.source.postMessage(m, e.origin); };
      switch (e.data.type) {
        case 'dryrun:hello': reply({ type: 'dryrun:ready', url: location.href, title: document.title, outline: outline() }); break;
        case 'dryrun:apply': reply({ type: 'dryrun:applied', report: apply(e.data.patches) }); break;
        case 'dryrun:clear': clear(); reply({ type: 'dryrun:cleared' }); break;
        case 'dryrun:pick': if (!picking) startPick(reply); break;
      }
    });
    try { window.parent.postMessage({ type: 'dryrun:ready', url: location.href, title: document.title, outline: outline() }, allowed[0] || '*'); } catch (e) {}
  } else if (me && me.getAttribute('data-pack')) {
    fetch(me.getAttribute('data-pack'), { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) { if (p && p.dryrunPack === 1 && Array.isArray(p.patches)) { var s = {}; Object.keys(p.settings || {}).forEach(function (k) { s[k] = p.settings[k]; }); apply(p.patches.concat(Object.keys(s).map(function (k) { return { type: 'setting', key: k, value: s[k] }; }))); } }).catch(function () {});
  }
})();
