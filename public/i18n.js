/* HNN Biller language runtime. Add to any page:
     <script src="/app/i18n.js" data-audience="patient" data-auto="true"></script>
   - data-i18n="key" / data-i18n-placeholder / data-i18n-title : reviewed catalog strings (English fills gaps)
   - data-auto="true" : text on the page that has no data-i18n is machine-translated (LibreTranslate, cached) when
     the server has it; otherwise the page simply stays in English. Only static text at load time (or after
     HNNi18n.refresh(root)) is translated -- dynamic data (names, amounts, records) is never sent for translation.
   - Arabic switches the page to right-to-left. The choice is remembered in localStorage (hnn_lang). */
(function () {
  'use strict';
  var SCRIPT = document.currentScript;
  var AUDIENCE = (SCRIPT && SCRIPT.getAttribute('data-audience')) || 'patient';
  var AUTO = SCRIPT && SCRIPT.getAttribute('data-auto') === 'true';
  var API = ((SCRIPT && SCRIPT.getAttribute('data-api')) || '') + '/i18n/api';
  var KEY = 'hnn_lang';
  var state = { lang: 'en', strings: {}, rtl: false, reviewed: true, languages: [], mt: false, listeners: [] };
  var originals = new WeakMap(); var origAttr = new WeakMap();

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function pick(langs) {
    var want = store(KEY) || (navigator.language || 'en');
    var c = String(want).toLowerCase().replace('_', '-'); var base = c.split('-')[0];
    var codes = langs.map(function (l) { return l.code; });
    return codes.indexOf(c) >= 0 ? c : codes.indexOf(base) >= 0 ? base : 'en';
  }
  function get(url, opt) { return fetch(url, opt).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  function t(key, vars) {
    var s = state.strings[key] || key;
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? '' : vars[k]; }) : s;
  }
  function applyCatalog(root) {
    root = root || document;
    [].forEach.call(root.querySelectorAll('[data-i18n]'), function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    [].forEach.call(root.querySelectorAll('[data-i18n-placeholder]'), function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    [].forEach.call(root.querySelectorAll('[data-i18n-title]'), function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, NOSCRIPT: 1, SVG: 1 };
  function collect(root) {
    var out = []; var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      var p = n.parentNode; if (!p || SKIP[(p.nodeName || '').toUpperCase()]) continue;
      if (p.closest && p.closest('[translate="no"],[data-notranslate],[data-i18n],#hnn-lang-wrap,.notranslate')) continue;
      var raw = originals.has(n) ? originals.get(n) : n.nodeValue;
      var s = (raw || '').trim();
      if (s.length < 2 || s.length > 400 || !/[A-Za-z]{2}/.test(s) || /^[\w.+-]+@[\w.-]+$/.test(s) || /^https?:\/\//.test(s)) continue;
      out.push({ node: n, text: s, raw: raw });
    }
    return out;
  }
  function restore(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); var n;
    while ((n = w.nextNode())) if (originals.has(n)) { n.nodeValue = originals.get(n); originals.delete(n); }
  }
  function autoTranslate(root) {
    root = root || document.body;
    if (!AUTO) return Promise.resolve();
    if (state.lang === 'en') { restore(root); return Promise.resolve(); }
    if (!state.mt) return Promise.resolve();
    var items = collect(root); if (!items.length) return Promise.resolve();
    var uniq = []; var seen = {};
    items.forEach(function (i) { if (!seen[i.text]) { seen[i.text] = 1; uniq.push(i.text); } });
    var map = {}; var jobs = [];
    for (var k = 0; k < uniq.length; k += 40) (function (chunk) {
      jobs.push(get(API + '/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: chunk, from: 'en', to: state.lang }) })
        .then(function (r) { r.results.forEach(function (x, i) { if (x.translated) map[chunk[i]] = x.text; }); }).catch(function () {}));
    })(uniq.slice(k, k + 40));
    var lang = state.lang;
    return Promise.all(jobs).then(function () {
      if (lang !== state.lang) return;
      items.forEach(function (i) {
        var tr = map[i.text]; if (!tr) return;
        if (!originals.has(i.node)) originals.set(i.node, i.raw);
        var lead = i.raw.match(/^\s*/)[0]; var trail = i.raw.match(/\s*$/)[0];
        i.node.nodeValue = lead + tr + trail;
      });
    });
  }

  function setDir() {
    var h = document.documentElement; h.setAttribute('lang', state.lang); h.setAttribute('dir', state.rtl ? 'rtl' : 'ltr');
  }
  function notice() {
    var el = document.getElementById('hnn-lang-note');
    if (!state.reviewed && state.lang !== 'en') {
      if (!el) { el = document.createElement('div'); el.id = 'hnn-lang-note'; el.setAttribute('translate', 'no'); el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99998;background:#fff6d6;color:#5a4500;font:13px system-ui,sans-serif;padding:6px 12px;text-align:center'; document.body.appendChild(el); }
      el.textContent = t('review.notice');
    } else if (el) el.remove();
  }
  // Put the language picker beside the page title (the brand mark, else the first heading) so nobody has to scroll for it.
  function autoHost() {
    var t = document.querySelector('.brandmark') || document.querySelector('h1');
    if (!t || !t.parentNode) return null;
    var row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
    t.parentNode.insertBefore(row, t); row.appendChild(t);
    var h = document.createElement('span'); h.setAttribute('data-lang-switch', ''); h.style.cssText = 'display:inline-block'; row.appendChild(h); return h;
  }
  function switcher() {
    var host = document.querySelector('[data-lang-switch]'); var wrap = document.getElementById('hnn-lang-wrap');
    if (!wrap && !host) host = autoHost();
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'hnn-lang-wrap'; wrap.setAttribute('translate', 'no');
      if (host) wrap.style.cssText = 'display:inline-block;background:#fff;border:1px solid #cfd6df;border-radius:8px;padding:3px 8px;font:13px system-ui,sans-serif;vertical-align:middle';
      else wrap.style.cssText = 'position:fixed;top:10px;inset-inline-end:12px;z-index:99999;background:#fff;border:1px solid #cfd6df;border-radius:8px;padding:4px 6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font:13px system-ui,sans-serif';
      var sel = document.createElement('select'); sel.id = 'hnn-lang'; sel.setAttribute('aria-label', 'Language'); sel.style.cssText = 'font:inherit;border:0;background:transparent;color:inherit;cursor:pointer;width:auto;min-width:0;padding:2px 4px;margin:0;height:auto;box-shadow:none';
      sel.onchange = function () { set(sel.value); };
      wrap.appendChild(sel); (host || document.body).appendChild(wrap);
    }
    var s = document.getElementById('hnn-lang'); s.innerHTML = '';
    state.languages.forEach(function (l) { var o = document.createElement('option'); o.value = l.code; o.textContent = l.native + (l.native !== l.name ? ' · ' + l.name : ''); if (l.code === state.lang) o.selected = true; s.appendChild(o); });
    s.setAttribute('aria-label', t('lang.label'));
  }

  function load(code) {
    return get(API + '/catalog/' + code).then(function (c) {
      state.lang = c.lang; state.strings = c.strings; state.rtl = c.rtl; state.reviewed = c.reviewed;
      store(KEY, c.lang); setDir(); applyCatalog(); switcher(); notice();
      return autoTranslate().then(function () { state.listeners.forEach(function (f) { try { f(state.lang); } catch (e) {} }); });
    });
  }
  function set(code) { return load(code).catch(function () {}); }

  function init() {
    Promise.all([
      get(API + '/languages?audience=' + AUDIENCE),
      get(API + '/status').catch(function () { return { machineTranslation: false }; }),
    ]).then(function (r) {
      state.languages = r[0].languages; state.mt = !!r[1].machineTranslation;
      return load(pick(state.languages));
    }).catch(function () { /* API unreachable: page stays as authored */ });
  }

  window.HNNi18n = {
    get lang() { return state.lang; }, get rtl() { return state.rtl; }, t: t, set: set,
    refresh: function (root) { applyCatalog(root); return autoTranslate(root); },
    onChange: function (f) { state.listeners.push(f); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
