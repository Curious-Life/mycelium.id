// verify:mindscape-rail — the mindscape LEFT RAIL's two structural contracts:
//   (1) D-034 ↻1  every level of the rail can actually scroll, to the bottom of its padding
//   (2) D-067     the collapse hit target is the whole HEADER, not a lone caret glyph
//
// ── WHY A CONTRACT GATE, AND WHAT IT CANNOT DO (read this before trusting it) ────────────────
// D-034 is a LAYOUT defect. Proving "it scrolls" requires a layout engine; jsdom has none
// (every box reports scrollHeight === clientHeight === 0), and this repo has no headless browser
// in CI. So the honest split is:
//   • the CSS/markup CONTRACT that makes scrolling possible is asserted HERE, mechanically, at
//     every level of the chain — that is S1..S6 below;
//   • the fact that it DOES scroll is measured in a real engine by
//     portal-app/test/browser-mindscape-rail.mjs — `npm run probe:mindscape-rail` builds a
//     self-contained page and prints a file:// URL; open it and call window.__probe() /
//     window.__scrollToBottom(). At ONE fixed configuration (1280×860 viewport, 320px panel,
//     realms root) the before/after is:
//         pre-fix   `.nav-panel` client 860 · scroll 1830 · overflow-y:hidden ⇒ 970px unreachable
//         post-fix  `.nav-panel` client 860 · scroll  860 ⇒ nothing clipped; one scroller
//                   (`.nav-rail`), scrolled to the end with the full 64px clearance below the
//                   last section.
//     (Independent review L-6: the earlier version of this note paired the pre-fix numbers with
//     post-fix numbers taken at a different viewport AND a different drill level, which is not a
//     comparison. Same configuration both sides, or it is not evidence.)
// This gate exists because the CONTRACT is what regressed. #350 fixed `min-height: 0` on
// `.nav-content` — one box, three levels deep — and shipped. The rail's OUTER level still had
// `min-height: auto` and `overflow: hidden`, so three of the five rail sections were unreachable
// at any scroll position. A gate that only knew about `.nav-content` would have been green
// through the entire recurrence. S1..S6 assert the chain, not one box.
//
// D-067's hit area IS behaviourally observable without layout, and is asserted that way (H1..H4)
// off the real mounted component via portal-app/test/mount-pipeline-status.mjs.
//
// ── CHECKS ───────────────────────────────────────────────────────────────────────────────────
//   S1  `.nav-panel` (the rail root) is a flex COLUMN with `min-height: 0` — the outer half of
//       the same flex trap #350 fixed inside MindscapeDetail. Without it the panel grows to its
//       content and nothing inside it can be given a definite height to overflow against.
//   S2  `.nav-rail` (the ONE scroll port) carries all THREE of `flex: 1`, `min-height: 0` and
//       `overflow-y: auto`. Any one missing makes the other two inert — that is the entire
//       mechanism of D-034 and of its ↻1.
//   S3  `.nav-rail` carries a real bottom SCROLL-CLEARANCE — the operator's "with bottom
//       padding, and must scroll all the way to the bottom of that padding". Padding on a scroll
//       container is inside scrollHeight and therefore reachable; a bottom MARGIN is not, so a
//       margin here is a FAIL, not an equivalent. It must also be ≥ 2rem and larger than the
//       rail's own inset: a symmetric `padding: 0.6rem` is non-zero and still reads exactly like
//       the defect (watched — see the M4 record below).
//   S4  no rail SECTION re-introduces a nested full-height scroll port: `.mindscape-nav` carries
//       neither `height: 100%` nor `overflow`, and `.nav-content` carries no `overflow-y`. This
//       is the exact shape of the recurrence — a section claiming the whole rail height while
//       sitting below another section.
//   S5  the markup actually puts every rail section INSIDE `.nav-rail`, and leaves the resize
//       handle OUTSIDE it (the handle is the panel's full-height edge, not scrolling content).
//   S6  `.nav-panel` keeps `overflow: hidden` — panel clips, rail scrolls. If the panel itself
//       became the scroller the resize handle would scroll away with the content.
//   H1  the element carrying `aria-expanded` CONTAINS the pipeline's status sentence — i.e. the
//       hit target is the header row. A lone caret does not contain it. THIS is the D-067 defect.
//   H2  that element's text is not a bare glyph (the pre-fix control's textContent was 1 char).
//   H3  the caret inside it is decorative (`aria-hidden`), never the target itself.
//   H4  it is the SHARED CollapsibleHeader (`data-collapsible-header="1"`), not a second forked
//       implementation — and MindscapeDetail uses the same component, so the rail has ONE
//       collapse pattern. (H4 is why "reuse the live-process-indicator pattern" is checkable.)
//   H5  the disclosure's ACCESSIBLE NAME still contains the status sentence — i.e. no aria-label,
//       which would replace the very content D-067 merged into the control. H1–H4 all pass while
//       this is broken, which is why it is its own check.
//   H6  a navigation re-opens the Mindscape section: collapse must not answer the user's own
//       drill-down with an empty rail.
//   C1  D-072: `controls.target` is initialised from the computed point-cloud centroid at mount,
//       and the intro-cancel path snaps the target home instead of stranding it mid-lerp.
//
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.nav-rail`'s `min-height: 0` deleted from
//   MindscapeView.svelte — the EXACT #350-class trap, one level out → S2 REDs ("`.nav-rail` must
//   declare min-height: 0"). S1/S3/S4 stayed green, so S2 owns this.
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.nav-rail`'s `overflow-y: auto` changed to
//   `overflow-y: hidden` (the pre-fix `.nav-panel` behaviour, moved inward) → S2 REDs
//   ("`.nav-rail` must declare overflow-y: auto|scroll").
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.nav-panel`'s `min-height: 0` + flex column removed,
//   restoring the shipped v0.1.13 rule verbatim → S1 REDs ("`.nav-panel` must be a flex column"
//   and "must declare min-height: 0").
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `padding: 0.6rem 0.6rem 4rem` on `.nav-rail` reduced to
//   the symmetric `padding: 0.6rem` — the last line sits flush against the edge, i.e. the "text
//   cuts off at the bottom" half of the report → S3 REDs ("bottom clearance must be at least
//   2rem").
//   ⚠️ FIRST ATTEMPT FAILED TO CATCH IT, and the record is kept because it is the point: S3
//   originally asserted only `padding-bottom > 0`, and 0.6rem is > 0, so the gate stayed GREEN
//   over the exact defect. S3 now requires ≥ 2rem AND strictly more than the rail's own inset.
//   Written down rather than quietly fixed — a `> 0` check on a "there must be room" requirement
//   is the same class of green-for-the-wrong-reason this repo has been bitten by three times.
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — the bottom space re-expressed as `margin-bottom: 4rem`
//   with a symmetric padding — a margin is outside scrollHeight, so the clearance would silently
//   stop being reachable → S3 REDs ("the bottom space must be PADDING, not margin").
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `height: 100%` + `overflow: hidden` restored on
//   `.mindscape-nav`, i.e. the section reclaims the whole rail — the precise pre-fix shape that
//   pushed MeasureControl/MeasurementHealth/Narrate off the bottom → S4 REDs ("`.mindscape-nav`
//   must not declare height: 100%" and "must not declare overflow").
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `<div class="nav-rail">` wrapper removed so the five
//   sections became direct children of `.nav-panel` again → S5 REDs ("every rail section must be
//   inside .nav-rail"); S2 also REDs (no `.nav-rail` rule to find).
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — the resize handle moved INSIDE `.nav-rail` → S5 REDs
//   ("the resize handle must NOT be inside the scroll port").
//   ⚠️ ALSO GREEN ON THE FIRST ATTEMPT. S5's containment test was
//   `lastIndexOf('</div>', handleIndex)`, which finds *some* close tag either way and therefore
//   tested nothing. It now walks the div nesting to the rail's MATCHING close (`railExtent`).
//   Two of this gate's nine scroll checks were green for the wrong reason until they were
//   watched failing — which is the whole argument for watching them.
// MUTATION-TESTED: D-067 (2026-07-26) — PipelineStatus reverted to the shipped lone-caret button
//   (`<button class="pipe-toggle">{caret}</button>` inside a plain `.pipe-overall` div — the
//   D-067 defect verbatim) → H1, H2, H3 and H4 all RED. H1 is the owning check ("the
//   aria-expanded element must contain the status sentence"); H3 REDs as a side effect because
//   the reverted markup has no `.ch-caret` at all, so it is a corroborating signal here, not the
//   check that owns the caret contract — M9 below is.
// MUTATION-TESTED: D-067 (2026-07-26) — CollapsibleHeader's caret `aria-hidden="true"` removed,
//   making the decorative glyph an announced, focusable-looking target → H3 REDs.
// MUTATION-TESTED: D-072 (2026-07-26) — the `frameCameraOnData()` call deleted from onMount,
//   restoring the "camera at (80,50,80) looking at (0,0,0)" first frame → C1 REDs ("onMount must
//   frame the camera on the data after createPointCloud").
// MUTATION-TESTED: D-072 (2026-07-26) — `controls.target.copy(sceneCenter)` inside
//   frameCameraOnData replaced with a no-op comment, so the pivot stays at the world origin →
//   C1 REDs ("frameCameraOnData must set controls.target from the computed centroid").
// MUTATION-TESTED: D-072 (2026-07-26) — the intro-cancel path's `controls.target.copy(endTarget)`
//   removed, stranding the pivot mid-lerp for anyone who grabs the canvas during the 2.5s intro
//   → C1 REDs ("cancelling the intro must snap controls.target to the centroid").
// MUTATION-TESTED: D-067 (2026-07-26) — MindscapeDetail's `import CollapsibleHeader` deleted (the
//   Mindscape section growing its own second collapse implementation) → H4 REDs ("MindscapeDetail
//   must import the SAME shared header").
//
//
// ── ROUND 2: what the INDEPENDENT ADVERSARIAL REVIEW found, and the mutations it added ────────
// The review's whole job was to refute this gate, and on the first pass it did: it executed four
// regressions of the exact defect class S4/S6 exist to catch and watched the gate stay GREEN,
// because both checks tested literal property names and a literal `100%`. All four are permanent
// members of the suite now, and S4/S6 read overflow as a SET (all three properties) and height by
// UNIT rather than by string.
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.mindscape-nav { height: 100vh }`: the identical
//   defect in a viewport unit → S4 REDs. (Was GREEN in round 1.)
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.mindscape-nav { overflow-y: hidden }`: a nested clip
//   on ONE axis → S4 REDs. (Was GREEN.) This is the most likely real regression of the lot: a
//   later edit re-adding clipping for the section's new `border-radius` lands exactly here, and it
//   would ALSO silently break the sticky breadcrumb by becoming its nearest scrollport.
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.nav-content { max-height: 400px; overflow: auto }`:
//   the nested scroller wearing a different hat → S4 REDs. (Was GREEN.)
// MUTATION-TESTED: D-034 ↻1 (2026-07-26) — `.nav-panel { overflow: hidden; overflow-y: auto }`:
//   the later declaration wins and the PANEL becomes the scroller, taking the absolutely-
//   positioned resize handle with it → S6 REDs. (Was GREEN — reading the shorthand alone still
//   returned `hidden`.)
// MUTATION-TESTED: D-067 (2026-07-26) — an `aria-label` put back on the shared header → H5 REDs.
//   The review found this as a REAL defect in the change, not a hypothetical: `aria-label` is
//   name-from-author and replaces the contents, so labelling the button deleted "Your pipeline is
//   up to date." from the accessible name and from `.pipe`'s role="status" live text. H1–H4 all
//   passed over it, which is exactly why H5 is a separate check.
// MUTATION-TESTED: QA9 (2026-07-26) — the nav-change re-open deleted → H6 REDs; and separately
//   the territory coordinate dropped from the nav key → H6 REDs on the key composition. Also a
//   REAL defect the review found: collapsing while drilled in and then navigating from the 3D
//   canvas left an apparently empty rail.
// MUTATION-TESTED: D-072 (2026-07-26) — the cancel path snaps the pivot but NOT the camera, so an
//   abort teleports the view instead of settling → C1 REDs.
//
// All twenty mutations are executable: `node scripts/mutate-mindscape-rail.mjs [Mn]` applies each,
// runs this gate, prints the REDs, and restores. It exits non-zero if any mutation is NOT caught,
// so this record cannot silently rot — and its edits refuse to no-op, so a mutation whose anchor
// has drifted fails loudly instead of passing as "caught".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

const VIEW = 'portal-app/src/lib/views/MindscapeView.svelte';
const DETAIL = 'portal-app/src/lib/components/mindscape/MindscapeDetail.svelte';
const HEADER = 'portal-app/src/lib/components/mindscape/CollapsibleHeader.svelte';
const PIPE = 'portal-app/src/lib/components/mindscape/PipelineStatus.svelte';
const SCENE = 'portal-app/src/lib/components/mindscape/Mindscape3D.svelte';

const src = Object.fromEntries(
  [['view', VIEW], ['detail', DETAIL], ['header', HEADER], ['pipe', PIPE], ['scene', SCENE]]
    .map(([k, f]) => [k, readFileSync(f, 'utf8')]),
);

// ── A real (small) CSS rule reader, not a line grep ───────────────────────────────────────────
// Comments are stripped FIRST and lexically: this repo has already been bitten by a regex chain
// that stripped comments both ways wrongly (#344), and every rule below is quoted verbatim in a
// comment somewhere in these files — a grep would read the prose as the rule and go green on a
// file with the CSS deleted. `strip()` walks the string, so a `/* … */` can never be a match.
function strip(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    out += css[i];
  }
  return out;
}

/**
 * Drop every at-rule BLOCK (`@media`, `@supports`, `@keyframes`, …) with its full balanced body.
 * ⚠️ Not cosmetic. `.nav-panel { display: none }` lives inside `@media (max-width: 767px)` — the
 * deliberate mobile hide. A flat rule regex happily matches that inner rule with the selector
 * `.nav-panel` and no `@` in sight, so S1 would read the BASE layout as `display: none` and fail
 * on correct code. This gate asserts the DESKTOP base rules; responsive overrides are out of
 * scope and are removed here rather than silently mixed in.
 */
function stripAtRules(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] !== '@') { out += css[i]; continue; }
    // walk to this at-rule's opening brace (or its `;` for a statement at-rule like @import)
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
    if (j >= css.length || css[j] === ';') { i = j; continue; }
    let depth = 0;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j; // skip the whole block
  }
  return out;
}

/** Every top-level declaration block whose selector list mentions `sel` (as a whole class token). */
function rulesFor(file, sel) {
  const styleStart = file.indexOf('<style>');
  if (styleStart === -1) throw new Error('no <style> block');
  const css = stripAtRules(strip(file.slice(styleStart + 7, file.lastIndexOf('</style>'))));
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    // whole-token match: `.nav-rail` must not be satisfied by `.nav-rail-inner`
    if (new RegExp(`\\${sel}(?![\\w-])`).test(selector)) out.push({ selector, body: m[2] });
  }
  return out;
}
/** The value of `prop` in the LAST rule for `sel` that declares it (cascade order), or null. */
function decl(file, sel, prop) {
  let v = null;
  for (const r of rulesFor(file, sel)) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(r.body);
    if (m) v = m[1].trim();
  }
  return v;
}
const has = (file, sel) => rulesFor(file, sel).length > 0;

// ── S1..S6: the scroll chain ─────────────────────────────────────────────────────────────────
t('S1. ⭐ D-034 ↻1: `.nav-panel` (the rail root) is a flex COLUMN with min-height: 0 — the OUTER half of the trap #350 fixed three levels deeper', () => {
  assert.ok(has(src.view, '.nav-panel'), '.nav-panel must have a rule in MindscapeView.svelte');
  assert.equal(decl(src.view, '.nav-panel', 'display'), 'flex',
    '`.nav-panel` must be a flex column — without it `.nav-rail` has no definite height to be flex:1 of, and overflow-y is inert');
  assert.equal(decl(src.view, '.nav-panel', 'flex-direction'), 'column',
    '`.nav-panel` must be a flex COLUMN (the five rail sections stack vertically)');
  assert.equal(decl(src.view, '.nav-panel', 'min-height'), '0',
    '`.nav-panel` must declare min-height: 0 — a flex item defaults to min-height:auto and grows to its content, which is exactly how the rail came to clip 970px of itself');
});

t('S2. ⭐ D-034 ↻1: `.nav-rail` is the ONE scroll port and declares ALL of flex:1 + min-height:0 + overflow-y:auto (any one missing makes the others inert)', () => {
  assert.ok(has(src.view, '.nav-rail'), '`.nav-rail` must exist — it is the rail\'s single scroll port');
  assert.equal(decl(src.view, '.nav-rail', 'flex'), '1', '`.nav-rail` must declare flex: 1 so it takes the panel\'s remaining height');
  assert.equal(decl(src.view, '.nav-rail', 'min-height'), '0', '`.nav-rail` must declare min-height: 0');
  const ov = decl(src.view, '.nav-rail', 'overflow-y');
  assert.ok(ov === 'auto' || ov === 'scroll', `\`.nav-rail\` must declare overflow-y: auto|scroll (got ${JSON.stringify(ov)})`);
});

/** CSS length → px. Only the units this rail uses; anything else is a deliberate FAIL. */
function px(v) {
  if (!v) return null;
  const m = /^(-?[\d.]+)(px|rem|em)$/.exec(v.trim());
  if (!m) return null;
  return m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
}

t('S3. ⭐ the operator\'s other half: `.nav-rail` carries a real bottom SCROLL-CLEARANCE — padding (inside scrollHeight, therefore reachable), not a margin, and not merely the generic inset', () => {
  const shorthand = decl(src.view, '.nav-rail', 'padding');
  const explicit = decl(src.view, '.nav-rail', 'padding-bottom');
  let bottom = explicit;
  let inset = null;
  if (!bottom && shorthand) {
    const parts = shorthand.trim().split(/\s+/);
    // CSS shorthand: 1 → all · 2 → v h · 3 → t h b · 4 → t r b l
    bottom = parts.length >= 3 ? parts[2] : parts[0];
    inset = parts[0];
  }
  assert.ok(bottom, '`.nav-rail` must carry a padding-bottom — the operator: "with bottom padding, and must scroll all the way to the bottom of that padding"');
  const b = px(bottom);
  assert.ok(b !== null, `\`.nav-rail\`'s padding-bottom must be a px/rem/em length (got ${JSON.stringify(bottom)})`);
  // ⚠️ THRESHOLD, and it is load-bearing. A symmetric `padding: 0.6rem` is a non-zero bottom
  // value that still reads exactly like the defect: the last line sits flush against the edge and
  // "cuts off at the bottom". A bare `> 0` test passed that mutation (watched, M4). What the
  // operator asked for is CLEARANCE — space you can scroll the final content clear of — so the
  // bottom must be a deliberate value, both ≥ 2rem and strictly larger than the rail's own inset.
  assert.ok(b >= 32,
    `\`.nav-rail\`'s bottom clearance must be at least 2rem (got ${bottom}). A token inset is what "text cuts off at the bottom" looks like`);
  if (inset !== null) {
    assert.ok(b > px(inset),
      `the bottom padding (${bottom}) must exceed the rail's generic inset (${inset}) — a symmetric padding is an inset, not a scroll clearance`);
  }
  assert.equal(decl(src.view, '.nav-rail', 'margin-bottom'), null,
    'the bottom space must be PADDING, not margin — a bottom margin on a scroll container collapses out of scrollHeight and silently restores the cut-off');
});

/**
 * EVERY overflow declaration on `sel` that is not `visible`, across all three properties.
 * ⚠️ Written this way because testing the literal property `overflow` was green for the wrong
 * reason (independent review H-1, watched): `.mindscape-nav { overflow-y: hidden }` and
 * `.nav-content { overflow: auto }` are the SAME defect and both slipped through. `overflow-x`
 * counts too — `overflow-x: hidden` computes `overflow-y` to `auto`, so it silently creates a
 * scroll port on the other axis.
 */
function clippingDecls(file, sel) {
  const found = [];
  for (const prop of ['overflow', 'overflow-x', 'overflow-y']) {
    const v = decl(file, sel, prop);
    if (v && !/^visible$/i.test(v.trim())) found.push(`${prop}: ${v}`);
  }
  return found;
}

/** Any height declaration on `sel` that is relative to the VIEWPORT or the PARENT. */
function relativeHeights(file, sel) {
  const found = [];
  for (const prop of ['height', 'max-height', 'min-height']) {
    const v = decl(file, sel, prop);
    // `min-height: 0` is the *cure*, never the disease — and a bare 0 has no unit.
    if (v && /(%|vh|vw|vmin|vmax|dvh|svh|lvh)\s*$/i.test(v.trim())) found.push(`${prop}: ${v}`);
  }
  return found;
}

t('S4. ⭐ the recurrence shape: no rail SECTION reclaims the rail height or clips/scrolls on ANY axis', () => {
  // Height: any viewport- or parent-relative height makes the section claim space it has not
  // earned. Tested by UNIT, not by the literal string "100%" — `height: 100vh` is the identical
  // defect and passed the first version of this check (review H-1).
  assert.deepEqual(relativeHeights(src.detail, '.mindscape-nav'), [],
    '`.mindscape-nav` must not declare a viewport-/parent-relative height — as one of five stacked sections it would claim the whole rail, push the sections after it off the bottom, and put its own bottom edge below the clip line (the exact ↻1 report)');

  // Clipping: ANY non-visible overflow on the section, on ANY axis.
  // ⚠️ TWO failures for the price of one, which is why this is a set and not one property:
  //   1. it re-creates the nested clip/scroll that made the rail "only partially scrollable";
  //   2. it silently BREAKS THE STICKY BREADCRUMB — a sticky element sticks within its nearest
  //      scrollport, so any overflow here makes `.mindscape-nav` that scrollport instead of
  //      `.nav-rail`, and the breadcrumb stops pinning to the rail. The plausible regression is
  //      someone re-adding `overflow: hidden` to clip the section's new `border-radius`.
  assert.deepEqual(clippingDecls(src.detail, '.mindscape-nav'), [],
    '`.mindscape-nav` must not clip or scroll on any axis — the rail owns both, and any overflow here also captures the sticky breadcrumb');

  assert.deepEqual(clippingDecls(src.detail, '.nav-content'), [],
    '`.nav-content` must not be a nested scroll port — two scrollers in one rail is the "only partially scrollable" feel the operator reported');
  assert.deepEqual(relativeHeights(src.detail, '.nav-content'), [],
    '`.nav-content` must not be height-capped either — a `max-height` + overflow pair is the same nested scroller wearing a different hat');
});

/**
 * The index just past `<div class="nav-rail" …>`'s MATCHING `</div>`, found by counting div
 * tags. An "is it before the closing tag" test done with lastIndexOf('</div>') is not a
 * containment test at all — it finds *some* close and passes either way (watched: mutation M7
 * moved the resize handle inside the scroller and the gate stayed green).
 */
function railExtent(markup) {
  const open = markup.indexOf('<div class="nav-rail"');
  if (open === -1) return null;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  let depth = 0, m;
  while ((m = tag.exec(markup)) !== null) {
    if (m[0] === '</div>') { if (--depth === 0) return { open, close: m.index }; }
    else depth++;
  }
  return null;
}

t('S5. ⭐ the markup matches the contract: every rail section is INSIDE `.nav-rail`, and the resize handle is OUTSIDE it', () => {
  const ext = railExtent(src.view);
  assert.ok(ext, 'MindscapeView must render a `.nav-rail` element with a matching close tag');
  const handle = src.view.indexOf('class="resize-handle"');
  assert.ok(handle !== -1, 'the resize handle must still exist');
  for (const section of ['<PipelineStatus', '<MindscapeDetail', '<MeasureControl', '<MeasurementHealthSection', '<NarrateControl']) {
    const at = src.view.indexOf(section);
    assert.ok(at !== -1, `${section} must still be mounted in the rail`);
    assert.ok(at > ext.open && at < ext.close,
      `${section} must be inside .nav-rail — a section outside the scroll port is unreachable content, which is D-034 itself`);
  }
  assert.ok(handle > ext.close,
    'the resize handle must NOT be inside the scroll port — it is the panel\'s full-height edge affordance, absolutely positioned against .nav-panel, and would scroll away with the content');
});

t('S6. `.nav-panel` CLIPS and never SCROLLS — panel clips, rail scrolls; two boxes, two jobs', () => {
  assert.equal(decl(src.view, '.nav-panel', 'overflow'), 'hidden',
    'the panel must declare overflow: hidden — it is the clip');
  // ⚠️ `overflow: hidden` alone is not the assertion. A later `overflow-y: auto` on the same
  // selector overrides the shorthand's y-axis and makes the PANEL the scroller — at which point
  // the absolutely-positioned resize handle scrolls away with the content. Reading only the
  // shorthand still returned `hidden` and passed (review H-1, watched).
  for (const prop of ['overflow', 'overflow-x', 'overflow-y']) {
    const v = decl(src.view, '.nav-panel', prop);
    assert.ok(!v || !/auto|scroll/i.test(v),
      `\`.nav-panel\` must not scroll on any axis (found ${prop}: ${v}) — the scroll port is .nav-rail, and a scrolling panel takes the resize handle with it`);
  }
});

// ── H1..H4: the D-067 hit area, read off the REAL mounted component ──────────────────────────
function mount(probe, opts = {}) {
  const env = { ...process.env, PROBE: probe, MYCELIUM_SKIP_WRITER_LOCK: '1' };
  if (opts.expand) env.EXPAND = '1';
  const line = execFileSync('node', ['--conditions', 'browser', 'test/mount-pipeline-status.mjs'],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env })
    .trim().split('\n').pop();
  const o = JSON.parse(line);
  if (!o.ok) throw new Error(`probe ${probe} did not mount: ${String(o.error).slice(0, 400)}`);
  return o;
}

let settledCard = null;
try {
  settledCard = mount('caughtup');
  rec('H0. PipelineStatus mounts with the shared disclosure', true);
} catch (e) {
  rec('H0. PipelineStatus mounts with the shared disclosure', false, String(e?.message || e).slice(0, 300));
}

t('H1. ⭐ D-067: the element carrying `aria-expanded` CONTAINS the pipeline\'s status sentence — the hit target is the whole header row, not a caret beside it', () => {
  assert.ok(settledCard, 'the settled card must have mounted');
  assert.equal(settledCard.toggleTag, 'BUTTON', 'the disclosure must be a real <button> (keyboard + AT reachable)');
  assert.equal(settledCard.toggleOwnsSummary, true,
    'the aria-expanded element must contain the status sentence (.pipe-overall-text). The shipped v0.1.13 control was a caret NEXT TO the sentence — that is the defect: "only a small dot is clickable to collapse the pipeline status"');
});

t('H2. ⭐ D-067: the disclosure is not a bare glyph — the pre-fix control\'s entire textContent was one caret character', () => {
  assert.ok(settledCard.toggleTextLen > 5,
    `the disclosure's text must be the header line, not a glyph (got ${settledCard.toggleTextLen} chars)`);
});

t('H3. the caret inside the header is DECORATIVE (aria-hidden) — a hint, never the hit target', () => {
  assert.equal(settledCard.toggleCaretHidden, true,
    'the caret must be aria-hidden="true"; the accessible name comes from the header button itself');
});

t('H4. ⭐ ONE implementation: the disclosure is the shared CollapsibleHeader, and MindscapeDetail uses the SAME component (no fork)', () => {
  assert.equal(settledCard.toggleIsShared, true,
    'the disclosure must be the shared CollapsibleHeader (data-collapsible-header="1"), i.e. the live-process-indicator pattern reused rather than re-implemented');
  assert.match(src.pipe, /import\s+CollapsibleHeader\s+from\s+'\.\/CollapsibleHeader\.svelte'/,
    'PipelineStatus must import the shared header');
  assert.match(src.detail, /import\s+CollapsibleHeader\s+from\s+'\.\/CollapsibleHeader\.svelte'/,
    'MindscapeDetail must import the SAME shared header — the Mindscape section gets the same whole-section collapse');
  // `bind:expanded=` in either form — a plain binding or the function binding H6 pins down. H4
  // owns "it goes through the shared component at all"; H6 owns the exact shape.
  assert.match(src.detail, /<CollapsibleHeader[\s\S]{0,600}?bind:expanded=\{/,
    'MindscapeDetail must drive its section state through the shared header');
  assert.match(src.detail, /\{#if sectionExpanded\}/,
    'and its content must actually be gated on that state (a toggle that hides nothing is a dead control)');
  // The shared header is full-width by construction — that is what makes the row the target.
  assert.equal(decl(src.header, '.collapsible-header', 'width'), '100%',
    'the shared header button must span the full row; a shrink-to-fit button would be a bigger dot, not a header');
  // …and it must not swallow the section's own controls: the button wraps the HEADER only.
  assert.ok(!/<slot|children\(\)[\s\S]{0,80}pipe-stage/.test(src.header),
    'the shared header must not wrap a section body containing controls (nested interactive elements)');
});

t('H5. ⭐ the disclosure\'s ACCESSIBLE NAME still contains the status sentence — no aria-label overriding the content it now wraps', () => {
  assert.equal(settledCard.toggleAriaLabel, null,
    'the disclosure must carry NO aria-label. aria-label is name-from-author: it REPLACES the contents, so labelling this button deletes "Your pipeline is up to date." from what a screen reader announces — and from `.pipe`\'s role="status" live text. The precedent (StatusPopover\'s .vault-pill) has no aria-label either; its name IS its content. Use `title` for the Show/Hide hint');
  assert.match(settledCard.toggleAccName, /up to date/i,
    `the accessible name must include the pipeline's status sentence. Got: "${settledCard.toggleAccName}"`);
});

t('H6. ⭐ a NAVIGATION re-opens the Mindscape section — a collapsed rail must not answer a drill-down with an empty panel', () => {
  // Structural, and said so plainly: the behavioural half is measured in the browser probe
  // (collapse → drillIntoRealm() from outside the rail → the section must re-open), because
  // MindscapeDetail's drill state lives in a store this gate does not mount.
  //
  // What is asserted here is the SHAPE that makes the behaviour hold without an effect:
  // `expanded` is DERIVED from "is the current nav position the one you collapsed at". The first
  // implementation was an $effect comparing the nav key against a plain `let`, and it silently
  // never fired — a structural check that only looked for "an effect that sets it true" would
  // have passed over that. So the check is on the derivation, not on the existence of a hook.
  assert.match(src.detail, /const navKey = \$derived\(/,
    'MindscapeDetail must derive a nav key from the drill coordinates');
  for (const coord of ['navLevel', 'selectedRealmId', 'selectedSemanticThemeId', 'selectedTerritoryId']) {
    assert.ok(new RegExp(`navKey = \\$derived\\([\\s\\S]{0,300}?${coord}`).test(src.detail),
      `the nav key must include ${coord} — a level change that is not in the key leaves the rail collapsed over the user's own selection`);
  }
  assert.match(src.detail, /const sectionExpanded = \$derived\(collapsedAtNavKey !== navKey\)/,
    '`sectionExpanded` must be DERIVED as "you are not where you collapsed" — that is what makes any navigation re-open the section by construction. A stored boolean needs an effect to keep it honest, and the effect version was measured not firing');
  assert.match(src.detail, /bind:expanded=\{\(\) => sectionExpanded, \(v\) => \(collapsedAtNavKey = v \? null : navKey\)\}/,
    'the header must write through a function binding: collapse records WHERE it happened, expand clears it');
});

// ── C1: D-072 ────────────────────────────────────────────────────────────────────────────────
t('C1. ⭐ D-072: the camera is framed on the point-cloud CENTROID at mount, and cancelling the intro snaps the pivot home instead of stranding it mid-lerp', () => {
  assert.match(src.scene, /function frameCameraOnData\s*\(/,
    'Mindscape3D must define frameCameraOnData()');
  assert.match(src.scene, /frameCameraOnData\s*\([\s\S]{0,40}\)\s*;/,
    'frameCameraOnData must be called');
  assert.match(src.scene, /controls\.target\.copy\(sceneCenter\)/,
    'frameCameraOnData must set controls.target from the computed centroid — OrbitControls orbits its target, so an unset target (the three.js default 0,0,0) is BOTH the off-centre first frame and the skewed rotation');
  assert.match(src.scene, /sceneCenter\.set\(/,
    'the centroid must be COMPUTED from the rendered points (in scene space, after the x,z,y swap), not assumed');
  // onMount must frame AFTER the cloud exists — sceneCenter is only meaningful once createPointCloud ran.
  const mountBlock = /onMount\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/.exec(src.scene);
  assert.ok(mountBlock, 'Mindscape3D must have an onMount block');
  const iCloud = mountBlock[1].indexOf('createPointCloud()');
  const iFrame = mountBlock[1].indexOf('frameCameraOnData()');
  assert.ok(iCloud !== -1, 'onMount must build the point cloud');
  assert.ok(iFrame !== -1, 'onMount must frame the camera on the data after createPointCloud — without it the first frame depends on winning the animateIntro race, which is why the operator sees it only sometimes');
  assert.ok(iFrame > iCloud, 'frameCameraOnData must run AFTER createPointCloud (sceneCenter is computed there)');
  // The invariant: whenever the intro STOPS, for any reason, the pivot is the centroid. On the
  // normal path frameCameraOnData() has already made start === end so the lerp cannot strand
  // anything (review L-5) — the case this covers is a second streamed batch moving `sceneCenter`
  // inside the 100ms before the intro starts, which makes start ≠ end again.
  assert.match(src.scene, /if \(introCancelled\) \{[\s\S]{0,1600}?controls\.target\.copy\(endTarget\)/,
    'the intro-cancel path must snap controls.target to the centroid — the invariant is that the pivot is the centroid whenever the intro stops');
  assert.match(src.scene, /if \(introCancelled\) \{[\s\S]{0,1800}?camera\.position\.copy\(endTarget\)\.add\(camOffset\)/,
    'and it must move the camera with the target, so an abort settles instead of teleporting the view');
});

const failed = ledger.filter((p) => !p).length;
console.log('\n================================================================');
if (failed === 0) {
  console.log('VERDICT: GO — the rail has ONE scroll port with reachable bottom padding at every level, no section reclaims the rail, the collapse hit target is the whole header (shared with the live process indicator), and the 3D camera is framed on the data  EXIT=0');
} else {
  console.log(`VERDICT: NO-GO — ${failed} check(s) failed  EXIT=1`);
}
console.log('================================================================');
process.exit(failed === 0 ? 0 : 1);
