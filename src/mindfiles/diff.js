/**
 * Minimal, dependency-free line diff for the character page's "see what
 * changed" view (design §5.6). Computes a classic LCS line alignment and
 * emits a flat op list the frontend renders verbatim — no third-party diff
 * library, no regex on the payload beyond a newline split.
 *
 * Deliberately line-granular (not word/char): self.md is prose paragraphs, and
 * a line diff is what an operator scanning "what did the agent change overnight"
 * actually wants — added/removed lines, unchanged for context.
 *
 * ── DoS BOUND ───────────────────────────────────────────────────────────────
 * The LCS table is O(lines²) memory. The mind-file write gate caps content at
 * MAX_TOKENS = 16,000 (src/mindfiles/sanitize.js) — a CHARACTER cap, not a line
 * cap, so a within-policy but degenerate file (e.g. ~64k newlines) is a legal
 * write and would blow the table to multiple GB. We therefore refuse to build
 * the table past MAX_DIFF_LINES and return a single 'omitted' op — bounded and
 * honest, never OOM. (P1 adversarial-review finding, 2026-07-18.)
 *
 * Pure: no I/O, no crypto, no clock. Safe to call anywhere and trivial to gate.
 */

// LCS is O(n·m); at 2000 the table is ≤ ~16 MB transient. self.md's realistic
// line count is « this; the cap only bites on a pathological/degenerate file.
export const MAX_DIFF_LINES = 2000;

/**
 * @param {string} oldText  previous content (e.g. a dated snapshot)
 * @param {string} newText  current content
 * @returns {{ type: 'ctx'|'add'|'del', text: string }[]}
 *   ordered ops; 'ctx' = unchanged line, 'add' = present only in newText,
 *   'del' = present only in oldText.
 */
export function lineDiff(oldText, newText) {
  const a = splitLines(String(oldText ?? ''));
  const b = splitLines(String(newText ?? ''));
  const n = a.length;
  const m = b.length;

  // Fail-closed on a degenerate line count BEFORE allocating the LCS table.
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    return [{ type: 'omitted', text: `Diff omitted — ${n}→${m} lines exceed the ${MAX_DIFF_LINES}-line inline cap.` }];
  }

  // LCS length table (rows = a, cols = b). O(n*m) — self.md is ≤~1000 tokens,
  // a few dozen lines, so this is negligible and bounded by the token cap.
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

/**
 * @param {ReturnType<typeof lineDiff>} ops
 * @returns {{ added: number, removed: number, changed: boolean }}
 */
export function diffStat(ops) {
  let added = 0;
  let removed = 0;
  let omitted = false;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
    else if (op.type === 'omitted') omitted = true;
  }
  // An 'omitted' diff is over-cap content we couldn't align — treat it as changed
  // (the honest default when we can't prove equality).
  return { added, removed, omitted, changed: added > 0 || removed > 0 || omitted };
}

function splitLines(s) {
  if (s === '') return [];
  // Normalize CRLF so a line-ending flip alone isn't reported as a change.
  return s.replace(/\r\n/g, '\n').split('\n');
}
