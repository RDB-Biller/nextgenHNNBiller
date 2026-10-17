/* Unobtrusive "Know someone who should explore this platform?" invite tab. One script, any page:
     <script src="https://HOST/o/widget.js" defer></script>
   Options (data attributes on the script tag): data-title, data-prompt, data-position="left|right", data-off="1".
   The visitor identifies themselves once (name + email); their personal referral code is kept in this browser so every
   invitation is traceable to them. Nothing is sent to anyone without the visitor's confirmation that they know the person. */
(function () {
  'use strict';
  var s = document.currentScript; if (!s || s.getAttribute('data-off')) return;
  if (/^\/o\/lab\//.test(location.pathname)) return;
  var API; try { API = new URL(s.src).origin + '/o/api'; } catch (e) { API = '/o/api'; }
  var HOME = API.replace(/\/api$/, '');
  var KEY = 'hnn_referrer_v1', store = {
    get: function () { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  var me = store.get();
  var side = s.getAttribute('data-position') === 'right' ? 'right' : 'left';
  var css = '.hnr-t{position:fixed;bottom:14px;' + side + ':14px;z-index:2147483000;font:13px/1.3 system-ui,sans-serif}' +
    '.hnr-b{background:#fff;color:#17202b;border:1px solid #cfd6df;border-radius:20px;padding:7px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);opacity:.88}.hnr-b:hover,.hnr-b:focus{opacity:1;outline:2px solid #0b6e4f}' +
    '.hnr-p{display:none;width:min(320px,calc(100vw - 28px));max-height:80vh;overflow:auto;background:#fff;color:#17202b;border:1px solid #cfd6df;border-radius:12px;padding:12px;box-shadow:0 8px 28px rgba(0,0,0,.2);margin-bottom:8px}' +
    '.hnr-p input,.hnr-p select{width:100%;box-sizing:border-box;padding:7px;margin:3px 0 8px;border:1px solid #cfd6df;border-radius:6px;font:inherit}' +
    '.hnr-p button{background:#0b6e4f;color:#fff;border:0;border-radius:6px;padding:8px 12px;font:inherit;cursor:pointer;margin:2px 4px 2px 0}.hnr-p a{color:#0b6e4f}.hnr-m{color:#5b6675;font-size:12px}.hnr-x{float:right;background:none!important;color:#5b6675!important;padding:0!important}' +
    '@media print{.hnr-t{display:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var root = document.createElement('div'); root.className = 'hnr-t'; root.setAttribute('role', 'complementary');
  var title = s.getAttribute('data-title') || 'Know someone who should see this?';
  var prompt = s.getAttribute('data-prompt') || 'Do you know someone (a product manager, a claims lead, a hospital or bank team) who should explore this platform? Enter their details and we will send an invitation naming you.';
  root.innerHTML = '<div class="hnr-p" id="hnr-p" role="dialog" aria-label="Invite someone"></div><button class="hnr-b" id="hnr-b" aria-expanded="false" aria-controls="hnr-p">' + title.replace(/</g, '&lt;') + '</button>';
  document.body.appendChild(root);
  var p = root.querySelector('#hnr-p'), b = root.querySelector('#hnr-b');
  function e(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function post(path, body) { return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (o) { if (!r.ok) throw new Error(o && o.error || 'Something went wrong'); return o; }); }); }
  function form() {
    p.innerHTML = '<button class="hnr-x" aria-label="Close" id="hnr-c">✕</button><p style="margin:0 0 8px">' + e(prompt) + '</p>' +
      (me ? '<p class="hnr-m">Sending as <b>' + e(me.name) + '</b> · <a href="#" id="hnr-sw">not you?</a></p>' :
        '<label>Your name<input id="hnr-yn" autocomplete="name"></label><label>Your email (so we can credit you, never shown)<input id="hnr-ye" type="email" autocomplete="email"></label>') +
      '<label>Their name<input id="hnr-n"></label><label>Their role (for example product manager)<input id="hnr-r"></label><label>Their organisation<input id="hnr-o"></label>' +
      '<label>Their work email<input id="hnr-e" type="email"></label><label>Their mobile (optional, to send it from your own phone)<input id="hnr-ph" type="tel" placeholder="+233..."></label>' +
      '<label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" id="hnr-a" style="width:auto;margin-top:3px"> <span>I know this person and a short business invitation from me is welcome.</span></label>' +
      '<button id="hnr-s">Send invitation</button><p class="hnr-m" id="hnr-msg" aria-live="polite"></p>' +
      '<p class="hnr-m"><a href="' + HOME + '/contribute" target="_blank" rel="noopener">Help us fill a gap</a> · <a href="' + (me ? HOME + '/refer/' + e(me.code) : HOME + '/refer') + '" target="_blank" rel="noopener">My referral page</a></p>';
    p.querySelector('#hnr-c').onclick = close;
    var sw = p.querySelector('#hnr-sw'); if (sw) sw.onclick = function (ev) { ev.preventDefault(); me = null; store.set(null); form(); };
    p.querySelector('#hnr-s').onclick = send;
  }
  function v(id) { var el = p.querySelector('#' + id); return el ? el.value.trim() : ''; }
  function msg(t) { p.querySelector('#hnr-msg').textContent = t; }
  function send() {
    if (!p.querySelector('#hnr-a').checked) return msg('Please confirm that you know this person.');
    if (!v('hnr-n')) return msg('Their name, please.');
    if (!v('hnr-e') && !v('hnr-ph')) return msg('Add their work email or mobile.');
    msg('Sending...');
    var ident = me ? Promise.resolve(me) : (!v('hnr-yn') || !v('hnr-ye') ? Promise.reject(new Error('Your name and email, please.')) : post('/me', { name: v('hnr-yn'), email: v('hnr-ye') }).then(function (o) { me = { code: o.code, name: o.name }; store.set(me); return me; }));
    ident.then(function (m) {
      return post('/invite', { code: m.code, name: v('hnr-n'), role: v('hnr-r'), org: v('hnr-o'), email: v('hnr-e'), phone: v('hnr-ph'), attest: 'yes' });
    }).then(function (o) {
      var sh = o.share || {}; var btns = '';
      if (sh.mailto && v('hnr-e')) btns += '<a href="' + e(sh.mailto) + '"><button type="button">Email it myself</button></a>';
      if (v('hnr-ph')) { btns += '<a href="' + e(sh.whatsapp) + '" target="_blank" rel="noopener"><button type="button">WhatsApp</button></a>'; if (sh.sms) btns += '<a href="' + e(sh.sms) + '"><button type="button">SMS</button></a>'; }
      p.innerHTML = '<button class="hnr-x" aria-label="Close" id="hnr-c">✕</button>' +
        (o.mode === 'invited' ? '<p><b>Thank you.</b> ' + (o.already ? 'They are already in touch with us.' : 'Your invitation is queued and names you.') + '</p>' : '<p><b>Thank you.</b> ' + e(o.reason || '') + '</p>') +
        (btns ? '<p class="hnr-m">Prefer to send it yourself from your own account?</p><p>' + btns + '</p>' : '') + '<p><button id="hnr-again">Invite another</button></p>';
      p.querySelector('#hnr-c').onclick = close; p.querySelector('#hnr-again').onclick = form;
    }).catch(function (er) { msg(er.message || 'Could not send'); });
  }
  function open() { form(); p.style.display = 'block'; b.setAttribute('aria-expanded', 'true'); }
  function close() { p.style.display = 'none'; b.setAttribute('aria-expanded', 'false'); b.focus(); }
  b.onclick = function () { p.style.display === 'block' ? close() : open(); };
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && p.style.display === 'block') close(); });
})();
