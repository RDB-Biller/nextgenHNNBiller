'use strict';
/** The Interpreter: a small bot in the Workroom chat. Commands start with "/" and answer only the person who typed them. */
const orgs = require('./orgs'); const tr = require('./translate');
const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const find = (q) => { const x = strip(q); if (!x) return null; return tr.LANGUAGES.find((l) => l.code === x || strip(l.name) === x || strip(l.name).startsWith(x) || strip(l.native) === x) || null; };
const HELP = ['/lang pt (or /lang Portuguese): choose the language you read and write in. Everything others write is shown to you in it, and what you write is shown to them in theirs.', '/lang: see your language and the ones available.', '/who: see who is here and the language each person reads.', '/original on or off: show the original words under each translation.', '/translate on or off: switch translation on or off just for you.'];
const names = () => tr.LANGUAGES.map((l) => `${l.code} ${l.name}`).join(', ');
async function inYourLanguage(text, code, orgId) { if (code === 'en') return text; const r = await tr.translate(text, 'en', code, { orgId }); return r.ok ? r.text + '\n\n' + text : text; }
async function command(orgId, actor, raw) {
  const m = /^\/(lang|who|original|translate|help)\b\s*(.*)$/i.exec(String(raw || '').trim()); if (!m) return null; const cmd = m[1].toLowerCase(), arg = m[2].trim();
  const me = orgs.memberRaw(orgId, actor.id); const cur = tr.lang(me.lang); let text;
  if (cmd === 'help') text = 'I am the Interpreter. I let everyone here read and write in their own language.\n' + HELP.join('\n');
  else if (cmd === 'lang') {
    if (!arg) text = `You read and write in ${cur.name} (${cur.native}). Translation is ${me.translate === false ? 'off' : 'on'} for you.\nAvailable: ${names()}.\nChange it with /lang and a code, for example /lang pt.`;
    else { const l = find(arg); if (!l) text = `I do not know "${arg}". Available: ${names()}.`; else { orgs.setLanguage(orgId, actor.id, { lang: l.code }); text = await inYourLanguage(`Done. You now read and write in ${l.name}. What others write is shown to you in ${l.name}, and what you write is shown to them in their own language.`, l.code, orgId); return { text, lang: l.code, rtl: l.rtl, changed: true }; } }
  } else if (cmd === 'who') {
    const list = Object.values(orgs.raw(orgId).members).filter((x) => x.role !== 'contributor' || x.name === 'DRI Chief').slice(0, 40); text = 'Here:\n' + list.map((x) => `${x.name}: ${tr.lang(x.lang).name}`).join('\n');
  } else if (cmd === 'original') { const on = /^(on|yes|show)$/i.test(arg), off = /^(off|no|hide)$/i.test(arg); if (!on && !off) text = `Originals are ${me.showOriginal ? 'shown' : 'hidden'}. Use /original on or /original off.`; else { orgs.setLanguage(orgId, actor.id, { showOriginal: on }); text = on ? 'The original words are now shown under each translation.' : 'Originals are hidden. You can still tap a message to see its original.'; return { text, changed: true }; } }
  else if (cmd === 'translate') { const on = /^(on|yes)$/i.test(arg), off = /^(off|no)$/i.test(arg); if (!on && !off) text = `Translation is ${me.translate === false ? 'off' : 'on'} for you. Use /translate on or /translate off.`; else { orgs.setLanguage(orgId, actor.id, { translate: on }); text = on ? 'Translation is on. You will read each message in ' + cur.name + '.' : 'Translation is off for you. You will read every message as it was written.'; return { text, changed: true }; } }
  return { text };
}
module.exports = { command, find };
