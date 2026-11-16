'use strict';
/**
 * Lab Coach: a built-in assistant for the Product Lab Library. It gives deterministic, sector-aware guidance,
 * so it needs no external AI key and cannot leak data. Swap in a hosted model later behind the same reply() shape if wanted.
 */
const has = (m, words) => words.some((w) => m.includes(w));
const greeting = (list) =>
  "Hi — I'm your Lab Coach. I can help you move around the Product Lab Library: build a product, run and compare versions, gather views with surveys, upload data safely, use the in-run Coach, or send work to partners. " +
  (list ? 'Your scenarios: ' + list + '. ' : '') +
  'Ask me something like "How do I build a product?"';
const scenarioLine = (s) =>
  `${s.label}: ${s.summary}\nTo try it, open "Build a product", choose "${s.label}", set the numbers and press Create and run.`;

function reply({ message, pack } = {}) {
  const m = String(message || '').toLowerCase().trim();
  const scen = (pack && pack.scenarios) || [];
  const list = scen.map((s) => s.label).join(', ');
  const find = (keys) => scen.find((s) => keys.some((k) => s.key.includes(k) || (s.label || '').toLowerCase().includes(k)));

  if (!m || has(m, ['hi ', 'hello', 'hey', 'what can you do', 'who are you', 'what is this', 'start here']) || m === 'hi') return greeting(list);

  if (has(m, ['scratch', 'blank', 'new product', 'create a product', 'build a product', 'get started', 'begin', 'how do i start', 'how to start']))
    return 'Two ways to begin:\n1) Build a product — pick a product type, enter a few numbers, and press Create and run. You get a complete draft and a first result in one step.\n2) Create from scratch — start empty when you want full control.\nThen change the numbers and compare versions.' + (list ? ' Product types available: ' + list + '.' : '');

  if (has(m, ['idea', 'brainstorm', 'ideas board']))
    return 'Use the Ideas board to capture and shape ideas first. When one is ready, turn it into a product with Build a product, set the numbers, and run it to see how it behaves.';

  if (has(m, ['run', 'simulate', 'simulation', 'see result', 'generate', 'try it']))
    return 'To run something: choose a product type under Build a product, fill in the numbers, and press Create and run — it saves a draft and runs it once. Open the result for the headline figures, then change a number and run again to compare.';

  if (has(m, ['compare', 'version', 'difference', 'what changed']))
    return 'Every save makes a new version and the earlier one stays. Open a product in the Library, pick two versions and Compare to see exactly what each change did. Nothing goes live until you promote it.';

  if (has(m, ['coach', 'improve', 'optimis', 'optimiz', 'make it better', 'suggest']))
    return 'Inside a run, press "Ask the Coach". It searches within your own guardrails and drafts a safer or stronger version — it never changes anything by itself. Review the suggestion and save it as a draft version if you like it.';

  if (has(m, ['survey', 'ask customers', 'ask members', 'feedback', 'what people want', 'what customers want']))
    return 'Use Surveys to ask the people you hope to serve before you design. Anyone with the link can answer without signing in, and no names or numbers are stored. A survey result can even fill in the settings for the Plan options scenario.';

  if (has(m, ['upload', 'csv', 'import', 'price book', 'my data', 'claims data', 'spreadsheet']))
    return 'Upload from the Library. Names, phone numbers, emails and ID numbers are stripped on upload — member ids become codes. Claims need claim_id, provider, diagnosis, service_code and amount; a price book needs a code and a price.';

  if (has(m, ['promote', 'approve', 'go live', 'gate', 'launch', 'sign off', 'regulator']))
    return 'A draft moves up through gates: draft → approved → live. A builder cannot self-approve; an approver signs it off, and sensitive changes can need a regulator reference. This keeps a safe trail before anything goes live.';

  if (has(m, ['proposal', 'partner', 'sell', 'offer to', 'share with']))
    return 'Built something worth sharing? Use Proposals to send terms to another organisation, or Partners to work with a fintech or a researcher. They accept on their side, and statements track any fees.';

  if (has(m, ['team', 'invite', 'colleague', 'add person', 'seat']))
    return 'Open the Team tab. Add a person with their name and mobile number to text their sign-in details, or use Quick Invite to text the join link to up to five people at once. Your trial includes five seats.';

  // Scenario-specific shortcuts
  let s;
  if (has(m, ['claim', 'adjudicat', 'auto approve', 'auto-approve', 'escalate']) && (s = find(['adjudication']))) return scenarioLine(s);
  if (has(m, ['settle', 'pay provider', 'early payment', 'discount for paying']) && (s = find(['expedited', 'settlement']))) return scenarioLine(s);
  if (has(m, ['premium', 'instal', 'overdraft', 'lapse', 'financing']) && (s = find(['premium_financing', 'financing']))) return scenarioLine(s);
  if (has(m, ['copay', 'co-pay', 'advance', 'uncovered']) && (s = find(['copay']))) return scenarioLine(s);
  if (has(m, ['plan option', 'hospital', 'tier', 'loss ratio']) && (s = find(['plan_options', 'plan options']))) return scenarioLine(s);
  if (has(m, ['campaign', 'marketing', 'audience', 'sign-up', 'signup']) && (s = find(['campaign']))) return scenarioLine(s);
  if (has(m, ['outcome', 'complication', 'value-based', 'value based', 'pay for performance']) && (s = find(['outcomes']))) return scenarioLine(s);

  // Loose match against any scenario name/summary
  const words = m.split(/\W+/).filter((w) => w.length > 3);
  const byName = scen.find((x) => words.some((w) => x.key.includes(w) || (x.label || '').toLowerCase().includes(w) || (x.summary || '').toLowerCase().includes(w)));
  if (byName) return scenarioLine(byName);

  if (has(m, ['help', 'lost', 'stuck', 'how does this work', 'guide me'])) return greeting(list);

  return 'I can help with building a product, running and comparing versions, surveys, uploading data, the in-run Coach, and sending work to partners. Try "How do I build a product?", "How do I compare versions?"' + (list ? ', or ask about one of your scenarios: ' + list + '.' : '.');
}

module.exports = { reply };
