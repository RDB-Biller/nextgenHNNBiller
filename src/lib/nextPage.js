'use strict';
// "No dead ends": every failure a person can land on shows where to go next.
const NEXT = [
  { label: 'Try the demo', href: '/app/platform.html' },
  { label: 'Sign up', href: '/app/register.html' },
  { label: 'Open the dashboard', href: '/app/dashboard.html' },
  { label: 'API downloads', href: '/app/apis.html' },
];
const support = () => process.env.SUPPORT_EMAIL || 'ekforson@hnnworld.com';
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wantsHtml = (req) => req.method === 'GET' && (req.headers.accept || '').includes('text/html');

function html(title, message) {
  const li = NEXT.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/app/app.css"></head><body><div class="wrap" style="max-width:560px"><div class="card"><h1 style="margin-top:0">${esc(title)}</h1><p class="muted">${esc(message)} Here is where you can go next:</p><ul style="line-height:2;font-size:16px">${li}<li><a href="mailto:${esc(support())}?subject=${encodeURIComponent('Help: ' + title)}">Get help</a></li></ul></div></div></body></html>`;
}

function notFound(req, res) {
  if (!wantsHtml(req)) return res.status(404).json({ error: 'not_found', message: 'That address does not exist.', next: NEXT, help: support() });
  return res.status(404).type('html').send(html('We could not find that page', 'The link may have expired, or the address was typed a little differently.'));
}
module.exports = { NEXT, wantsHtml, html, notFound, support };
