// src/claims/support-path.js — render a claim together with the evidence that
// supports it (PersonaTree §3.6), and select renderings under a token budget.
//
// A "support path" keeps the abstract claim and the observations that justify it
// ADJACENT in the retrieved context, at the depth the query needs:
//   depth 0 — Root only:        [Claim] …
//   depth 1 — Root + Mid:       [Claim] … + [Pattern] …            (territory-as-mid)
//   depth 2 — Root + Mid + Leaf: …       + [Evidence] <snippet> (date)
//
// renderPath is PURE FORMATTING — the caller resolves support ids → text/territory
// first (claim.supportMids / claim.supportLeaves), so this module has no I/O.
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.6.

/** Cheap token estimate (~4 chars/token). v1 heuristic; swap for a real
 *  tokenizer only if it mis-budgets in practice (deferral §8). */
export function approxTokens(text) {
  return Math.ceil((text ? String(text).length : 0) / 4);
}

function snippet(text, n = 160) {
  return (text ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, n);
}

/**
 * Render one claim as a support path at the given depth.
 * @param {{content:string, claimType?:string, confidence?:number,
 *          supportMids?:Array<{name?:string, essence?:string}>,
 *          supportLeaves?:Array<{snippet?:string, content?:string, ts?:string}>}} claim
 * @param {0|1|2} depth
 * @returns {string}
 */
export function renderPath(claim, depth = 0) {
  if (!claim?.content) return '';
  const d = Math.max(0, Math.min(2, depth | 0));
  const conf = typeof claim.confidence === 'number' ? ` (confidence ${claim.confidence.toFixed(2)})` : '';
  const type = claim.claimType ? `${claim.claimType}: ` : '';
  const lines = [`[Claim] ${type}${snippet(claim.content, 240)}${conf}`];

  if (d >= 1) {
    for (const m of (claim.supportMids || []).slice(0, 2)) {
      const label = m.name ? `${m.name}${m.essence ? ' — ' : ''}` : '';
      lines.push(`  [Pattern] ${label}${snippet(m.essence, 160)}`);
    }
  }
  if (d >= 2) {
    for (const leaf of (claim.supportLeaves || []).slice(0, 3)) {
      const when = leaf.ts ? ` (${String(leaf.ts).slice(0, 10)})` : '';
      lines.push(`  [Evidence] ${snippet(leaf.snippet ?? leaf.content)}${when}`);
    }
  }
  return lines.join('\n');
}

/**
 * Greedy budgeted selection (PersonaTree Eq. 5, simplified). Each item is a
 * candidate rendering {text, score}. Picks highest score/token first, keeping the
 * running token sum ≤ budget. Returns the chosen items in their original order.
 * @param {Array<{text:string, score:number, key?:string}>} items
 * @param {number} budgetTokens
 * @returns {Array<{text:string, score:number, key?:string, tokens:number}>}
 */
export function selectUnderBudget(items, budgetTokens) {
  const withTokens = (items || [])
    .filter((it) => it && it.text)
    .map((it, i) => ({ ...it, tokens: approxTokens(it.text), _i: i }));
  // Rank by value density (score per token); ties keep input order.
  const ranked = [...withTokens].sort((a, b) =>
    (b.score / Math.max(1, b.tokens)) - (a.score / Math.max(1, a.tokens)) || a._i - b._i);
  const chosen = [];
  let spent = 0;
  for (const it of ranked) {
    if (spent + it.tokens > budgetTokens) continue;
    chosen.push(it);
    spent += it.tokens;
  }
  // De-dup by key (a claim rendered at multiple depths → keep the one selected).
  return chosen.sort((a, b) => a._i - b._i).map(({ _i, ...rest }) => rest);
}

/**
 * Build a budgeted claims block: for each claim, render at the requested depth
 * (claims that don't fit are dropped, not truncated). Scored by confidence so the
 * most-supported claims survive a tight budget.
 * @returns {string} markdown block (may be empty)
 */
export function renderClaimsBlock(claims, { depth = 0, budgetTokens = 600 } = {}) {
  const items = (claims || [])
    .map((c) => ({ text: renderPath(c, depth), score: typeof c.confidence === 'number' ? c.confidence : 0.5, key: c.id }))
    .filter((it) => it.text);
  const selected = selectUnderBudget(items, budgetTokens);
  return selected.map((it) => it.text).join('\n\n');
}

export default { approxTokens, renderPath, selectUnderBudget, renderClaimsBlock };
