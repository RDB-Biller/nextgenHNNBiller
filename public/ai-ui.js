/* Shared rendering for AI adjudication recommendations (payer console, claim link, submissions). */
window.AiUI = (function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  function pill(ai) {
    if (!ai) return '<span class="ai-rec none">AI: not scored</span>';
    if (ai.mode === 'shadow' && !ai.recommendation) return '<span class="ai-rec none" title="AI adjudication runs silently for this payer">AI: shadow</span>';
    if (!ai.recommendation) return '<span class="ai-rec none">AI: pending</span>';
    const label = ai.action === 'auto_approved' ? 'auto-approved' : ai.recommendation;
    return `<span class="ai-rec ${esc(ai.recommendation)}" title="${esc((ai.reasons || []).join(' · '))}">AI: ${esc(label)} · ${pct(ai.confidence)}</span>`;
  }
  function card(ai, { compact = false } = {}) {
    if (!ai) return '';
    if (ai.mode === 'shadow' && !ai.recommendation) return `<div class="ai-card"><span class="l">AI review</span><p class="muted" style="margin:4px 0 0">${esc(ai.note || 'Running in shadow mode.')}</p></div>`;
    if (!ai.recommendation) return '';
    const flags = (ai.flags || []).filter((f) => f.severity === 'hard');
    return `<div class="ai-card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span class="l">AI review${ai.productName ? ' · ' + esc(ai.productName) : ''}</span>${pill(ai)}</div>
      ${ai.reviewerNote ? `<p style="margin:8px 0 0">${esc(ai.reviewerNote)}</p>` : ''}
      ${!compact && (ai.reasons || []).length ? `<ul>${ai.reasons.slice(0, 6).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${flags.length ? `<p style="margin:8px 0 0;color:var(--bad)"><b>Blocks auto-approval:</b> ${flags.map((f) => esc(f.code)).join(', ')}</p>` : ''}
      ${ai.suggestedApprovedAmount != null ? `<p style="margin:6px 0 0">Suggested payable amount: <b>GHS ${Number(ai.suggestedApprovedAmount).toFixed(2)}</b></p>` : ''}
      <p class="muted" style="margin:8px 0 0;font-size:11px">${ai.llm && ai.llm.status === 'ok' ? 'Claude (' + esc(ai.llm.model) + ')' : 'Checks + trained scorer' + (ai.llm && ai.llm.status && ai.llm.status !== 'ok' && ai.llm.status !== 'skipped' ? ' (Claude ' + esc(ai.llm.status) + ')' : '')}${ai.scorer ? ' · scorer ' + pct(ai.scorer.probability) + ' approvable' : ''}${ai.mode ? ' · mode ' + esc(ai.mode) : ''}. A reviewer makes the final decision.${ai.outcome ? ' Outcome: ' + esc(ai.outcome) + (ai.agreed === true ? ' (AI agreed)' : ai.agreed === false ? ' (AI disagreed)' : '') + '.' : ''}</p></div>`;
  }
  function benchmarkLine(b) {
    if (!b || !b.benchmark) return '';
    const bm = b.benchmark; const g = bm.gate;
    return `<div class="ai-card" style="margin:0 0 14px"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><span class="l">AI adjudication</span>
      <span>mode <b>${esc(bm.mode)}</b></span><span>agreed with your reviewers <b>${pct(bm.accuracy)}</b> of ${bm.decisive} definite recommendations</span>
      <span>false approvals <b>${pct(bm.falseApproveRate)}</b></span><div class="ai-gauge ${bm.accuracy != null && bm.accuracy < bm.requirements.requiredAccuracy ? 'bad' : ''}" title="accuracy vs required ${pct(bm.requirements.requiredAccuracy)}"><span style="width:${Math.round((bm.accuracy || 0) * 100)}%"></span></div>
      <span class="ai-rec ${g.autonomous ? 'approve' : g.passed ? 'review' : 'none'}">${g.autonomous ? 'approving on its own' : g.passed ? 'gate met' : 'gate not met'}</span></div>
      ${g.reasons.length ? `<p class="muted" style="margin:6px 0 0;font-size:12px">${g.reasons.map(esc).join(' · ')}</p>` : ''}</div>`;
  }
  return { pill, card, benchmarkLine, pct, esc };
})();
