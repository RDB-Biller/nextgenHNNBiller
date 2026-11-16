/* Shared innovations content + renderer — single source for the public pages (home, join, /innovations). */
(function () {
  window.INNOV = [
    { key: 'insurance', label: 'Insurance', tagline: 'AI that makes claims faster and fairer', items: [
      { name: 'AI Adjudication Ladder', desc: "Every claim is routed to auto-approve, assist, or escalate. The model learns on a held-out sample and shows exactly how much of your claims volume can be auto-approved safely — with the money saved and the risk of each rule — before any of it touches a real claim." },
      { name: 'Outcomes-based care', desc: "Pay providers by how their own patients do. Weight a few clinical measures into one score, set bonus and penalty bands, and see who lands where, complications avoided, and how today's fee-for-service quietly pays more when patients have complications." },
      { name: 'Plan options & hospital tiers', desc: "Let members choose — say a lower premium with lower-tier hospitals, or a few higher-tier ones. See who picks what, how soon each group reaches its cap, and the effect on your loss ratio." } ] },
    { key: 'banking', label: 'Banking', tagline: 'Rehearse credit and collections on your own data', items: [
      { name: 'Instalment premium with auto-overdraft', desc: "Customers pay in instalments by auto-debit; when the wallet is short on the debit date an overdraft is raised automatically so cover never lapses. See lapses avoided, extra customers reached, the cost to the customer and the return to you." },
      { name: 'Cash for co-payments & uncovered care', desc: "Short, automatic advances when a customer must pay a co-payment or a service the plan does not cover. See uptake, return, credit loss, and the extra care it unlocks." },
      { name: 'Campaign & audience modelling', desc: "Pick an audience from your own customer list, choose channels and an offer, and see responses, sign-ups, cost and first-year margin before you spend." } ] },
    { key: 'fintech', label: 'Fintech', tagline: 'Test new money products before you launch', items: [
      { name: 'Premium financing engine', desc: "Model instalments, loading, overdraft fees and limits, and who is eligible — then watch lapses avoided and the return, on simulated customers built to look like yours." },
      { name: 'Co-pay & cover cash', desc: "Size a micro-advance product: events per year, average amount, who can already pay, uptake and repayment — and the credit loss you would carry." },
      { name: 'Safe-by-design data', desc: "Names, phone numbers, emails and ID numbers are stripped on upload and member ids become codes, so you rehearse on the real shape of your data without holding personal details." } ] },
    { key: 'more', label: 'And more', tagline: 'One engine for every sector', items: [
      { name: 'Expedited settlement', desc: "See what happens if you pay providers earlier for a discount — which providers take it and what it nets you after the cost of paying sooner." },
      { name: 'Surveys', desc: "Ask the people you hope to serve what they want before you design for them. Anyone with the link can answer without signing in, and no names or numbers are stored." },
      { name: 'Telco, pharmacy, school, hospital, research', desc: "The same Dry Run engine adds each sector's vocabulary and data types, so any team can rehearse a product, price, claim or campaign change on its own data before going live." } ] },
  ];

  if (!document.getElementById('innov-css')) {
    var s = document.createElement('style'); s.id = 'innov-css';
    s.textContent = '.innovtabs{display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0 .2rem}'
      + '.innovtab{background:var(--paper,#f2f4f1);border:1px solid var(--line,#d6dcd8);color:var(--ink,#14222b);border-radius:999px;padding:.4rem 1rem;font-size:14px;cursor:pointer;font-family:inherit}'
      + '.innovtab.on{background:var(--ink,#14222b);color:#fff;border-color:var(--ink,#14222b)}'
      + '.innovtagline{font-family:"Iowan Old Style","Palatino Linotype",Georgia,serif;font-weight:600;margin:.8rem 0 .2rem}'
      + '.innovrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem;margin-top:.6rem}'
      + '.innovitem{border:1px solid var(--line,#d6dcd8);border-radius:10px;padding:.85rem .95rem;background:#fff}'
      + '.innovitem b{color:var(--dry,#2f6fa3);display:block;margin-bottom:.3rem}'
      + '.innovitem p{margin:0;color:var(--ink2,#4b5b66);font-size:14px;line-height:1.5}';
    document.head.appendChild(s);
  }

  window.renderInnov = function (root, opts) {
    opts = opts || {};
    var el = typeof root === 'string' ? document.querySelector(root) : root;
    if (!el) return;
    var tabs = document.createElement('div'); tabs.className = 'innovtabs';
    var tagline = document.createElement('h3'); tagline.className = 'innovtagline';
    var panel = document.createElement('div'); panel.className = 'innovrow';
    el.appendChild(tabs); el.appendChild(tagline); el.appendChild(panel);
    var cur = opts.start || (opts.hashNav ? (location.hash || '').replace('#', '') : '');
    if (!INNOV.some(function (x) { return x.key === cur; })) cur = INNOV[0].key;
    function draw() {
      var sec = INNOV.filter(function (x) { return x.key === cur; })[0] || INNOV[0]; cur = sec.key;
      tabs.innerHTML = '';
      INNOV.forEach(function (x) {
        var b = document.createElement('button'); b.type = 'button';
        b.className = 'innovtab' + (x.key === cur ? ' on' : ''); b.textContent = x.label;
        b.onclick = function () { cur = x.key; if (opts.hashNav) { try { history.replaceState(null, '', '#' + cur); } catch (e) {} } draw(); };
        tabs.appendChild(b);
      });
      tagline.textContent = sec.tagline;
      panel.innerHTML = '';
      sec.items.forEach(function (it) {
        var d = document.createElement('div'); d.className = 'innovitem';
        var b = document.createElement('b'); b.textContent = it.name;
        var p = document.createElement('p'); p.textContent = it.desc;
        d.appendChild(b); d.appendChild(p); panel.appendChild(d);
      });
    }
    draw();
  };
})();
