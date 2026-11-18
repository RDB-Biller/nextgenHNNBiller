/* Dry Run page script. Host it yourself (save it as /dryrun/dryrun.js) and add:
 *   <script src="/dryrun/dryrun.js" data-dryrun-origin="https://your-dry-run-address" defer></script>
 * Inside the Dry Run Workroom preview it lets Dry Run show your iterations as overlays. It only answers the origins you list.
 * On a normal visit it does nothing, unless you add data-pack="/dryrun/pack.json" to apply a pack you approved.
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
