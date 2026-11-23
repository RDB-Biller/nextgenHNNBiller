/* Invite by email link: the admin card, the page a link opens, and the "add your mobile number" prompt. Loaded before the main script. */
function inviteEmailCard() {
  const I = S.einv = S.einv || { emails: '', role: 'builder', note: '', res: null }; let ta, nt, rl;
  const roles = ['admin', 'builder', 'approver', 'viewer'];
  const all = I.res ? I.res.results.filter((x) => x.ok) : [];
  return h('div', { class: 'card', style: 'order:1' }, h('h3', {}, 'Invite by email link'),
    h('p', { class: 'sm' }, 'Enter email addresses. Each person gets a personal link that signs them straight in, with no username or password to type. They are then asked for their mobile number and to choose a password. A link works once and expires in 7 days.'),
    h('label', {}, 'Email addresses (one per line, or separated by commas)'), ta = h('textarea', { rows: 3, placeholder: 'ama@example.com\nkofi@example.com', oninput: (e) => { I.emails = e.target.value; } }, I.emails),
    h('div', { class: 'row' }, h('div', {}, h('label', {}, 'They join as'), rl = h('select', { onchange: (e) => { I.role = e.target.value; } }, roles.map((r) => h('option', { value: r, selected: r === I.role }, r)))), h('div', {}, h('label', {}, 'A short note (optional)'), nt = h('input', { value: I.note, placeholder: 'Welcome. Start with the BirthPrep page.', oninput: (e) => { I.note = e.target.value; } }))),
    h('p', {}, h('button', { class: 'go', onclick: () => act(async () => { I.res = await O('POST', '/team/email-invite', { emails: I.emails, role: I.role, note: I.note }); const n = I.res.results.filter((x) => x.ok).length; say(n ? `${n} link${n === 1 ? '' : 's'} ready.` : 'No links were made.'); if (n) I.emails = ''; }, async () => { TEAM = await O('GET', '/team'); }) }, 'Create links')),
    I.res && h('div', {}, !I.res.emailReady && h('p', { class: 'sm' }, 'Email sending is not set up on this service, so nothing was sent for you. Press "Email it" to open your own email app with the message ready, or copy the link and share it however you like.'),
      I.res.results.map((x) => h('div', { style: 'border-top:1px solid var(--line);padding:.6rem 0' }, x.ok ? h('div', {}, h('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap' }, h('strong', {}, x.email), x.emailed ? h('span', { class: 'chip s-active' }, 'Emailed') : h('span', { class: 'chip s-grace' }, 'Share this link'), x.emailProblem && h('span', { class: 'err', style: 'padding:.1rem .4rem' }, x.emailProblem)),
        h('div', { class: 'sm', style: 'overflow-wrap:anywhere' }, x.link), h('p', {}, copyBtn(x.link), ' ', h('a', { href: x.mailto, class: 'ghost', style: 'display:inline-block;padding:.35rem .8rem;border:1px solid var(--line);border-radius:6px;text-decoration:none;color:inherit' }, 'Email it'))) : h('div', {}, h('strong', {}, x.email), h('span', { class: 'sm' }, ' ' + x.problem)))),
      all.length > 1 && h('p', {}, copyBtn(all.map((x) => `${x.email}: ${x.link}`).join('\n')), h('span', { class: 'sm' }, ' copies every link'))));
}
function inviteLanding() {
  const v = S.invite; const box = (...k) => h('div', { class: 'login' }, h('h1', {}, 'Dry ', h('b', {}, 'Run')), ...k);
  if (v.error) return box(h('div', { class: 'err', role: 'alert' }, v.error), h('p', { class: 'sm' }, 'Ask the person who invited you for a new link, or sign in with your username and password.'), h('button', { class: 'ghost', onclick: () => { S.invite = null; render(); } }, 'Go to sign in'));
  return box(msgs(), h('p', {}, v.info.invitedBy === 'a join link' ? 'You asked to join ' : `${v.info.invitedBy} invited you to join `, h('strong', {}, v.info.organisation), ` as ${v.info.role === 'admin' ? 'an admin' : 'a ' + v.info.role}.`), h('p', { class: 'sm' }, `Signing in as ${v.info.name} (${v.info.email}). No password needed.`),
    h('button', { class: 'go', onclick: async () => { S.err = null; try { const r = await fetch(`/api/public/email-invite/${encodeURIComponent(v.token)}/accept`, { method: 'POST' }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'That did not work.'); KEY = j.key; KIND = 'member'; sessionStorage.setItem('dr_key', KEY); sessionStorage.setItem('dr_kind', KIND); history.replaceState(null, '', location.pathname); S.invite = null; S.tab = 'overview'; S.welcome = true; await boot(); } catch (e) { fail(e); } render(); } }, 'Sign in and continue'));
}
async function inviteBoot() {
  const jt = new URLSearchParams(location.search).get('join');
  if (jt) { S.joinPage = { token: jt }; KEY = ''; KIND = ''; sessionStorage.clear(); try { const r = await fetch(`/api/public/join-link/${encodeURIComponent(jt)}`); const j = await r.json(); if (!r.ok) S.joinPage.error = j.error || 'This link is not valid.'; else S.joinPage.info = j; } catch { S.joinPage.error = 'Could not reach Dry Run. Check your connection and open the link again.'; } return; }
  const t = new URLSearchParams(location.search).get('invite'); if (!t) return; S.invite = { token: t }; KEY = ''; KIND = ''; sessionStorage.clear();
  try { const r = await fetch(`/api/public/email-invite/${encodeURIComponent(t)}`); const j = await r.json(); if (!r.ok) S.invite.error = j.error || 'This link is not valid.'; else S.invite.info = j; } catch { S.invite.error = 'Could not reach Dry Run. Check your connection and open the link again.'; }
}
function welcomeCard() {
  if (KIND === 'platform' || !ME || ME.role === 'contributor' || DEMO || S.work) return null;
  const needPhone = !ME.hasPhone, needPw = !!ME.needsPassword; if (!needPhone && !needPw) return null;
  if (S.phoneLater && !needPw) return h('div', { class: 'note', style: 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap' }, 'Add your mobile number to get text alerts when teams respond.', h('button', { class: 'ghost', onclick: () => { S.phoneLater = false; render(); } }, 'Add it now'));
  let ph, pw; const refresh = async () => { ME = (await O('GET', '/')).me; };
  return h('div', { class: 'card', style: 'border:2px solid var(--accent,#d9552b)' }, h('h3', {}, S.welcome ? `Welcome, ${ME.name.split(' ')[0]}. Two quick steps` : 'Finish setting up your account'),
    needPhone && h('div', {}, h('label', {}, 'Your mobile number'), h('p', { class: 'sm' }, 'Dry Run texts you when a team responds, when you are mentioned, and if you ever need sign-in help. We confirm with one text and never share it.'), h('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap' }, ph = h('input', { type: 'tel', placeholder: '024… or +233…', style: 'max-width:16rem', 'aria-label': 'Mobile number' }), h('button', { class: 'go', onclick: () => act(async () => { const r = await O('PATCH', '/me/phone', { phone: ph.value }); say(r.texted ? `Saved ${r.phone}. We sent you a confirmation text.` : `Saved ${r.phone}.`); }, refresh) }, 'Save my number'))),
    needPw && h('div', { style: 'margin-top:.8rem' }, h('label', {}, 'Choose a password for next time'), h('p', { class: 'sm' }, `Your username is the one Dry Run made for you. A password lets you sign in later without a link. At least 8 characters.`), h('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap' }, pw = h('input', { type: 'password', autocomplete: 'new-password', style: 'max-width:16rem', 'aria-label': 'New password' }), h('button', { class: 'go', onclick: () => act(async () => { const r = await O('POST', '/me/new-password', { password: pw.value }); say(`Password saved. Your username is ${r.username}.`); }, refresh) }, 'Save password'))),
    needPhone && !needPw && h('p', {}, h('button', { class: 'ghost', onclick: () => { S.phoneLater = true; render(); } }, 'Later')));
}

/* General join link: admin card, and the page the shared link opens. */
function joinLinkCard() {
  const J = S.jl = S.jl || { d: null, role: 'builder', domains: '', max: '', days: '' };
  if (!J.d && !J.loading) { J.loading = true; O('GET', '/team/join-link').then((d) => { J.d = d; J.role = d.role; J.domains = (d.domains || []).join(', '); J.max = d.max || ''; J.loading = false; render(); }).catch(() => { J.loading = false; J.d = { on: false }; render(); }); }
  const d = J.d; const roles = ['admin', 'builder', 'approver', 'viewer'];
  const save = (extra) => act(async () => { J.d = await O('POST', '/team/join-link', { role: J.role, domains: J.domains, max: J.max, days: J.days, ...extra }); say(extra && extra.off ? 'Join link switched off.' : extra && extra.rotate ? 'New join link made. The old one no longer works.' : 'Join link saved.'); });
  return h('div', { class: 'card', style: 'order:1' }, h('h3', {}, 'One link for everyone'),
    h('p', { class: 'sm' }, 'Paste one link into an email or chat to your whole team. Each person opens it, types their own mobile number (email is optional), and Dry Run sends them their personal sign-in link by text' + (d && d.emailReady ? ' and email' : '') + '. The personal link is never shown on the page. Anyone who has this link can request to join, so share it only where you trust the readers, and set a limit or an email domain below.'),
    d && d.emailReady === false && h('p', { class: 'sm' }, 'Email sending is not set up yet, so links go out by text only.'),
    h('div', { class: 'row' }, h('div', {}, h('label', {}, 'They join as'), h('select', { onchange: (e) => { J.role = e.target.value; } }, roles.map((r) => h('option', { value: r, selected: r === J.role }, r)))),
      h('div', {}, h('label', {}, 'Only these email domains (optional)'), h('input', { value: J.domains, placeholder: 'trimestersave.com', oninput: (e) => { J.domains = e.target.value; } }))),
    h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Stop after this many people (0 = no limit)'), h('input', { type: 'number', min: 0, value: J.max, oninput: (e) => { J.max = e.target.value; } })), h('div', {}, h('label', {}, 'Expires in days (0 = never)'), h('input', { type: 'number', min: 0, value: J.days, oninput: (e) => { J.days = e.target.value; } }))),
    h('p', {}, h('button', { class: 'go', onclick: () => save({}) }, d && d.on ? 'Save changes' : 'Create the link'), ' ', d && d.on && h('button', { class: 'ghost', onclick: () => save({ rotate: true }) }, 'Make a new link'), ' ', d && d.on && h('button', { class: 'ghost', onclick: () => save({ off: true }) }, 'Switch off')),
    d && d.on && h('div', {}, h('div', { class: 'sm', style: 'overflow-wrap:anywhere' }, d.url), h('p', {}, copyBtn(d.url), ' ', h('span', { class: 'sm' }, `${d.joins} joined${d.max ? ' of ' + d.max : ''}${d.expiresAt ? ' · expires ' + d.expiresAt.slice(0, 10) : ''}${d.expired ? ' (expired)' : ''}`))));
}
function joinLanding() {
  const v = S.joinPage; const box = (...k) => h('div', { class: 'login' }, h('h1', {}, 'Dry ', h('b', {}, 'Run')), ...k);
  if (v.error) return box(h('div', { class: 'err', role: 'alert' }, v.error), h('button', { class: 'ghost', onclick: () => { S.joinPage = null; render(); } }, 'Go to sign in'));
  if (v.done) return box(h('h3', {}, 'Check your phone' + (v.info.emailReady ? ' and email' : '')), h('p', {}, 'Your personal sign-in link is on its way. Open it on this device to sign in. It works once and expires in 7 days.'), h('p', { class: 'sm' }, 'Nothing after a few minutes? Check the number you typed, or ask your admin.'), h('button', { class: 'ghost', onclick: () => { v.done = false; render(); } }, 'Use different details'));
  if (v.info.full) return box(h('div', { class: 'err' }, 'This join link has reached its limit. Ask for a new one.'));
  let em, ph, nm, hint;
  const go = async () => { if (!ph.value.trim() && !em.value.trim()) { hint.textContent = 'Type your mobile number, or your email.'; ph.focus(); return; } hint.textContent = ''; try { await fetch(`/api/public/join-link/${encodeURIComponent(v.token)}/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em.value, phone: ph.value, name: nm.value }) }); } catch { /* shown as sent either way */ } v.done = true; render(); };
  return box(h('p', {}, 'Join ', h('strong', {}, v.info.organisation), ` as ${v.info.role === 'admin' ? 'an admin' : 'a ' + v.info.role}.`),
    h('label', {}, 'Your mobile number'), ph = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '024… or +233…', 'aria-label': 'Your mobile number' }), h('p', { class: 'sm' }, 'We text your personal sign-in link here. It is the quickest way in.'),
    h('label', {}, 'Your email (optional)' + (v.info.domains.length ? ': use your ' + v.info.domains.map((d) => '@' + d).join(' or ') + ' address' : '')), em = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Your email' }),
    h('label', {}, 'Your name (optional)'), nm = h('input', { autocomplete: 'name', 'aria-label': 'Your name' }),
    hint = h('p', { class: 'sm', role: 'status' }), h('p', {}, h('button', { class: 'go', onclick: go }, 'Send me my link')));
}
