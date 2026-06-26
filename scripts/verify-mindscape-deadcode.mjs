// verify:mindscape-deadcode — locks the pure static dead-code prune of the
// per-period "Illuminate" cruft in the Mindscape3D timeline dial.
//
// Proof this code was dead (assignment audit): `illuminatingPeriod` was declared
// $state(null) and the ONLY assignment to it anywhere in the file was `= null`
// inside the very effect that guards on `if (!illuminatingPeriod) return;`. It was
// never set to a truthy value, so the 10s polling effect never started, the
// `{#if illuminatingPeriod === currentMonth}` template branch was `null === string`
// = always false, and the `.dial-illuminating` / `.illuminating-pulse` /
// `@keyframes illuminate-pulse` CSS was referenced only by that dead markup.
//
// This component has no node-importable runtime entrypoint, so a SOURCE-ASSERTION
// gate is the correct falsifiable form (mirrors the repo's grep-style guards).
// Pre-prune this gate MUST fail (illuminatingPeriod present) — that is the
// falsifiability proof. Post-prune every ledger row passes AND svelte-check
// (svelte-kit sync && svelte-check --fail-on-warnings) exits 0.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const COMPONENT = 'portal-app/src/lib/components/mindscape/Mindscape3D.svelte';
const src = readFileSync(new URL(`../${COMPONENT}`, import.meta.url), 'utf8');

const ledger = [];
const rec = (n, pass, d = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[—]'}  ${n}${d ? ` — ${d}` : ''}`); };

const count = (re) => (src.match(re) || []).length;

// ── REMOVED — must be ABSENT (these FAIL pre-prune, GO post-prune) ───────────
rec('REMOVED: no `illuminatingPeriod` identifier anywhere (0 occurrences)',
  count(/illuminatingPeriod/g) === 0, `${count(/illuminatingPeriod/g)} found`);
rec('REMOVED: no `dial-illuminating` token (class or CSS rule)',
  count(/dial-illuminating/g) === 0, `${count(/dial-illuminating/g)} found`);
rec('REMOVED: no `illuminating-pulse` token',
  count(/illuminating-pulse/g) === 0, `${count(/illuminating-pulse/g)} found`);
rec('REMOVED: no `@keyframes illuminate-pulse`',
  count(/@keyframes\s+illuminate-pulse/g) === 0, `${count(/@keyframes\s+illuminate-pulse/g)} found`);

// ── SURVIVED — must be PRESENT (guards against over-deletion) ────────────────
rec('SURVIVED: `currentMonth` still present',
  /currentMonth/.test(src));
rec('SURVIVED: `isIlluminated` still present',
  /isIlluminated/.test(src));
rec('SURVIVED: `.dial-illuminate` class still present',
  /\.dial-illuminate\s*\{/.test(src));
rec('SURVIVED: the `coming soon` span at the dial still present',
  /class="dial-illuminate"[^>]*>coming soon</.test(src));
rec('SURVIVED: `class:illuminated={tick.illuminated}` still present',
  /class:illuminated=\{tick\.illuminated\}/.test(src));
rec('SURVIVED: `.dial-tick.illuminated` rule still present',
  /\.dial-tick\.illuminated/.test(src));

// ── STRUCTURAL — the collapse produced exactly one plain {#if !isIlluminated} ─
rec('STRUCTURAL: exactly one `{#if !isIlluminated}` (the collapsed branch)',
  count(/\{#if !isIlluminated\}/g) === 1, `${count(/\{#if !isIlluminated\}/g)} found`);
rec('STRUCTURAL: zero `{:else if !isIlluminated}`',
  count(/\{:else if !isIlluminated\}/g) === 0, `${count(/\{:else if !isIlluminated\}/g)} found`);

// ── STRUCTURAL — the file still parses (svelte-kit sync && svelte-check) ──────
// Catches orphaned {:else}/{/if} from the collapse and any newly-unused-variable
// warning (--fail-on-warnings). Exit 0 required.
let checkPass = false;
let checkDetail = '';
try {
  execFileSync('npm', ['--prefix', 'portal-app', 'run', 'check'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  });
  checkPass = true;
  checkDetail = 'svelte-check exit 0';
} catch (err) {
  checkPass = false;
  checkDetail = `svelte-check exit ${err?.status ?? 'non-zero'}`;
}
rec('STRUCTURAL: `npm --prefix portal-app run check` exits 0 (svelte-kit sync && svelte-check --fail-on-warnings)',
  checkPass, checkDetail);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(70));
console.log(`VERDICT: ${allPass
  ? 'GO — per-period Illuminate dead code is pruned; live timeline/dial features survive; component still type-checks'
  : 'NO-GO — see [—] rows (dead code remains, a live symbol was over-deleted, or svelte-check failed)'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
