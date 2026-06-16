// verify:no-destructive-truncation — locks the data-integrity fix: derived user
// text (document extraction, text-file decode, audio transcript, image caption)
// is PERSISTED IN FULL, never silently clipped to a tiny cap. Guards against a
// regression of the 6000/8000/600/4000-char clamps that scrambled stored data.
//
// Principle under test: persistence ≠ model-context budget. The storage path
// stores the full value (bounded only by a generous ~200k DoS ceiling); budgets
// belong at READ time, not at write time.
import { readFileSync } from 'node:fs';
import { DERIVED_TEXT_MAX_CHARS, CAPTION_MAX_CHARS, clampStored } from '../src/enrich/text-limits.js';

const ledger = [];
const rec = (n, pass, d = '') => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── 1) the ceilings are GENEROUS (DoS guards, not content limits) ────────────
rec('T1. DERIVED_TEXT_MAX_CHARS is a generous ceiling (>= 100k)', DERIVED_TEXT_MAX_CHARS >= 100_000, String(DERIVED_TEXT_MAX_CHARS));
rec('T2. CAPTION_MAX_CHARS is generous (>= 2k)', CAPTION_MAX_CHARS >= 2_000, String(CAPTION_MAX_CHARS));

// ── 2) clampStored preserves real content, only cuts pathological payloads ───
rec('T3. clampStored keeps a 6001-char doc intact (the exact old-bug boundary)', clampStored('x'.repeat(6001)).length === 6001);
rec('T4. clampStored keeps a 50k-char doc intact', clampStored('x'.repeat(50_000)).length === 50_000);
rec('T5. clampStored only clips ABOVE the ceiling, with a self-describing marker', (() => {
  const out = clampStored('x'.repeat(DERIVED_TEXT_MAX_CHARS + 10));
  return out.length === DERIVED_TEXT_MAX_CHARS + '\n[… truncated at '.length + String(DERIVED_TEXT_MAX_CHARS).length + ' chars — DoS ceiling, not a content limit]'.length && out.includes('DoS ceiling');
})());

// ── 3) the fixed storage sites no longer carry the destructive small caps ────
const sites = [
  ['src/enrich/extract-document.worker.js', /slice\(0,\s*6000\)|MAX_EXTRACT_CHARS\s*=\s*6000/, 'clampStored'],
  ['src/internal-router.js', /slice\(0,\s*MAX_INLINE_TEXT\)|MAX_INLINE_TEXT\s*=\s*6000/, 'clampStored'],
  ['src/enrich/transcribe-audio.js', /slice\(0,\s*8000\)/, 'clampStored'],
  ['src/enrich/describe-image.js', /slice\(0,\s*600\)/, 'CAPTION_MAX_CHARS'],
  ['src/portal-attachments.js', /\.slice\(0,\s*4000\)/, 'clampStored'],
];
for (const [file, badRe, mustHave] of sites) {
  const src = read(file);
  rec(`T6. ${file}: destructive small-cap is GONE`, !badRe.test(src), badRe.source);
  rec(`T7. ${file}: routes through the shared limit (${mustHave})`, src.includes(mustHave));
}

// ── 4) the marker string is single-sourced (no stray re-introductions) ───────
// The pre-fix marker '\n[… truncated]' must not reappear as an inline storage clamp.
for (const [file] of sites) {
  const src = read(file);
  rec(`T8. ${file}: no inline "[… truncated]" storage marker`, !/\[… truncated\]/.test(src));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(70));
console.log(`VERDICT: ${allPass ? 'GO — derived user text is persisted in full; storage caps are generous DoS ceilings, not content limits' : 'NO-GO — see FAIL rows (a destructive truncation regressed)'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
