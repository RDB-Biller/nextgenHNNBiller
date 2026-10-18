/* No dead ends. Whenever something fails on any HNN Biller page (a request is refused, a link has expired, the network drops), this
   shows what to do next as clickable links: try again, go back to where the action is taken, sign up, or get help.
   - Failed requests made after a person's action (or during page load) raise the "What to do next" bar automatically.
   - NextStep.dead(message) returns the same links as HTML, for pages that print their own error in place.
   Links the pages cannot know in advance (support address, the TrimesterSave sign-up) come from /app/links.json. */
'use strict';
(function () {
  if (window.NextStep) return;
  const path = location.pathname;
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let CFG = { support: 'ekforson@hnnworld.com', trimestersave: '', erheat: 'https://erheat-app-production.up.railway.app' };
  const cfgReady = (window.fetch ? window.fetch('/app/links.json', { cache: 'no-store' }) : Promise.reject()).then((r) => r.json()).then((j) => { CFG = Object.assign(CFG, j || {}); }).catch(() => {});

  // Where each page's own action starts, and where a person with nothing yet should begin.
  const STAFF = { who: 'staff', start: null, signup: () => ['Ask for your own account', '/app/register.html'], demo: true };
  const PROFILES = [
    [/^\/savings/, { who: 'patient', start: ['Open your plan again', '/savings/'], signup: () => (CFG.trimestersave ? ['Start a savings plan', CFG.trimestersave] : ['Ask your clinic to enrol you', 'mailto:' + CFG.support + '?subject=Savings%20plan']), hint: 'Use the plan number and phone number from your text message. If you have not signed up yet, start a plan first.' }],
    [/^\/pay/, { who: 'patient', start: null, hint: 'Ask the clinic to send the payment link again, or pay at the cashier.' }],
    [/^\/claim/, { who: 'patient', start: null, hint: 'Ask whoever sent you the link to send a new one.' }],
    [/^\/verify/, { who: 'patient', start: null, hint: 'Ask the clinic to send the verification link again.' }],
    [/^\/credit/, { who: 'patient', start: null, hint: 'Ask the hospital or your insurer to send a new InsureCredit link.', signup: () => ['See how InsureCredit works', '/solutions/'] }],
    [/^\/clinical/, { who: 'patient', start: ['Start the check-in again', '/clinical/'], hint: 'You can start again with your phone number.' }],
    [/^\/report/, { who: 'patient', start: null, hint: 'Ask the sender for a fresh report link.' }],
    [/^\/solutions/, { who: 'patient', start: ['Back to health tools', '/solutions/'], hint: 'Go back and choose a tool again.' }],
    [/^\/register/, { who: 'visitor', start: ['Start the sign-up again', '/register/'], demo: true, hint: 'Check the details and send the form again.' }],
    [/^\/erheat/, { who: 'patient', start: null, signup: () => ['Open the ER HEAT app', CFG.erheat], hint: 'Voucher codes and request links work once. Open the app to see your requests.' }],
    [/^\/chat/, { who: 'visitor', start: ['Start a new chat', '/chat/'], demo: true }],
    [/^\/app\/platform/, { who: 'staff', start: ['Back to the sign-in', location.pathname], signup: () => ['Ask for your own account', '/app/register.html'], demo: true }],
    [/^\/app\/apis/, { who: 'visitor', start: ['API downloads', '/app/apis.html'], demo: true }],
    [/^\/app\//, STAFF],
  ];
  const profile = (PROFILES.find((p) => p[0].test(path)) || [null, { who: 'visitor', start: null, demo: true }])[1];

  const MSG = {
    offline: ['We could not reach the service.', 'Check your connection, then try again.'],
    access: ['You need to sign in, or this needs access you do not have yet.', 'Sign in again, or ask for your own account.'],
    missing: ['We could not find that. The link may have expired or been typed wrongly.', ''],
    busy: ['Too many tries in a short time.', 'Wait a minute, then try again.'],
    server: ['Something went wrong on our side.', 'Try again in a moment. If it keeps happening, tell us.'],
    input: ['Something needs another look.', 'Check what you entered and try again, or ask for help.'],
  };
  const kindOf = (status) => (status === 0 ? 'offline' : status === 401 || status === 403 ? 'access' : status === 404 || status === 410 ? 'missing' : status === 429 ? 'busy' : status >= 500 ? 'server' : 'input');

  function actions(kind) {
    const a = [];
    if (kind === 'offline' || kind === 'server' || kind === 'busy') a.push(['Try again', '#reload']);
    if (profile.start) a.push(profile.start);
    if (kind === 'access' && profile.who === 'staff') a.push(['Sign in with another key', '#top']);
    if (profile.signup) a.push(profile.signup());
    if (profile.demo) a.push(['Try the demo', '/app/platform.html']);
    a.push(['Get help', 'mailto:' + CFG.support + '?subject=' + encodeURIComponent('Help with ' + path)]);
    if (a.length < 3) a.push(['Home', '/app/dashboard.html']);
    const seen = new Set(); return a.filter((x) => (seen.has(x[1]) ? false : seen.add(x[1]))).slice(0, 4);
  }
  const linkHtml = (l) => l[1] === '#reload' ? `<a href="#" data-ns="reload">${esc(l[0])}</a>` : l[1] === '#top' ? `<a href="#" data-ns="top">${esc(l[0])}</a>` : `<a href="${esc(l[1])}">${esc(l[0])}</a>`;
  const wire = (root) => root.querySelectorAll('[data-ns]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); if (a.dataset.ns === 'reload') location.reload(); else { window.scrollTo(0, 0); const i = document.querySelector('input'); if (i) i.focus(); } }; });
  function block(message, kind) {
    kind = kind || 'missing'; const m = MSG[kind] || MSG.missing;
    return `<div class="ns-block" role="alert"><p class="ns-msg">${esc(message || m[0])}</p>${profile.hint || m[1] ? `<p class="ns-hint">${esc(kind === 'access' || kind === 'input' || kind === 'busy' || kind === 'offline' || kind === 'server' ? m[1] : profile.hint || m[1])}</p>` : ''}<p class="ns-links"><b>What to do next:</b> ${actions(kind).map(linkHtml).join('<span aria-hidden="true"> · </span>')}</p></div>`;
  }

  // ---- styles + bar -----------------------------------------------------
  const css = document.createElement('style');
  css.textContent = '.ns-block{border:1px solid #e3b8b1;background:#fdf1ef;border-radius:10px;padding:12px 14px;margin:12px 0;font-size:14px;line-height:1.5;color:#1b2a23}.ns-block p{margin:0 0 6px}.ns-hint{color:#52625a}.ns-links{margin:0!important}.ns-links a{color:#0f5c47;font-weight:600;text-decoration:underline;margin:0 2px}.ns-links span{color:#8a968f}' +
    '#ns-bar{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);width:min(560px,calc(100vw - 24px));z-index:99999;display:none}#ns-bar.show{display:block}#ns-bar .ns-block{background:#fff;box-shadow:0 12px 36px -12px rgba(0,0,0,.45);margin:0;padding-right:36px;position:relative}#ns-x{position:absolute;right:8px;top:6px;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#52625a}';
  (document.head || document.documentElement).appendChild(css);
  let bar, timer;
  function showBar(kind) {
    cfgReady.then(() => {
      if (!document.body) return;
      if (!bar) { bar = document.createElement('div'); bar.id = 'ns-bar'; document.body.appendChild(bar); }
      const m = MSG[kind]; bar.innerHTML = block(m[0], kind) + '<button id="ns-x" type="button" aria-label="Close">×</button>';
      bar.querySelector('.ns-block').appendChild(bar.querySelector('#ns-x')); bar.querySelector('#ns-x').onclick = () => bar.classList.remove('show');
      wire(bar); bar.classList.add('show'); clearTimeout(timer); timer = setTimeout(() => bar.classList.remove('show'), 30000);
    });
  }

  // ---- failure detection --------------------------------------------------
  const IGNORE = /(\/i18n|\/o\/|widget|links\.json|\/health|manifest|\/demo(\?|$)|\/currency\/api|favicon|\.(png|svg|ico|css|woff2?)(\?|$))/;
  let lastAction = 0; const born = Date.now();
  ['click', 'submit', 'change', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastAction = Date.now(); }, true));
  const eligible = () => Date.now() - lastAction < 6000 || Date.now() - born < 9000;
  const orig = window.fetch && window.fetch.bind(window);
  if (orig) window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let same = true; try { same = new URL(url, location.href).origin === location.origin; } catch (e) { /* relative */ }
    const watch = same && !IGNORE.test(url);
    return orig(input, init).then((res) => { if (watch && !res.ok && eligible()) showBar(kindOf(res.status)); return res; }, (err) => { if (watch && eligible()) showBar('offline'); throw err; });
  };

  window.NextStep = { block, dead: (message, kind) => { const out = block(message, kind); return out; }, wire, actions, bar: showBar,
    // for pages that print the error in place: NextStep.mount(element, message, kind)
    mount: (el, message, kind) => { cfgReady.then(() => { el.innerHTML = block(message, kind); wire(el); }); el.innerHTML = block(message, kind); wire(el); } };
})();
