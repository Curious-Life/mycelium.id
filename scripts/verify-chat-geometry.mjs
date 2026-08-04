#!/usr/bin/env node
// verify:chat-geometry — the floating chat can always be reached, resized and read.
//
// Covers two QA defects that both live in ChatFloat.svelte:
//
// ── D-065 "Elio's bug" ────────────────────────────────────────────────────────────────────────
// Operator report: "resizing the window WIDTH also changes the chat HEIGHT; when the height jumps
// up it can't be reduced and moves off-screen; continued resizing sometimes crashes and
// disappears the chat."
//
// All three are one mechanism, found by measuring the real component in a real browser. The
// resize drag wrote `el.style.width/left/bottom/transform` and the messages-box `style.height`
// imperatively, then CLEARED them on mouseup and trusted Svelte to re-apply its reactive
// `style={…}` attribute. Svelte 5 routes that attribute through `set_style`
// (svelte/src/internal/client/dom/elements/style.js) — NOT `set_attribute` — which caches the last
// value on `dom[STYLE_CACHE]` and returns without touching the DOM when the newly-derived string is
// identical; clearing inline properties mutates the attribute behind that cache. (And when it does
// write, it assigns `dom.style.cssText` wholesale, so a Svelte style write also wipes any
// imperative property absent from the reactive string.)
// A width-only drag never changes `chatHeight`, so the messages-box
// string was unchanged, the write was skipped, and the element was left with NO inline style —
// its 550px height collapsing to a 204px content height. Pre-fix measurement, Chromium, viewport
// 1280x800: ONE right-edge drag took the chat from 720x624 (messages 550) to 402x278 (messages
// 204), with the container's style attribute reduced to exactly `z-index: 9999;` — width, left,
// bottom and transform gone, the chat flung to (-201, 0). That stripped attribute IS the
// "disappears" report; the collapsed messages box IS the "width changes height" report.
//
// Secondly the bounds were wrong even when the render held: the height was capped against
// `innerHeight - 100` — the bare viewport rather than the room above the chat's own input bar —
// so a top-edge drag could put the top, the header and the `.resize-top` grip off-screen where
// they could no longer be grabbed and reduced; the bottom-edge branch clamped its anchor not at
// all and could drive the whole chat off the top; and the persisted size and position were
// validated independently, so a legal height and a legal y could combine into an unreachable
// chat that survived every reload.
//
// ── D-073 "the first message shows only the chat input field" ─────────────────────────────────
// Operator report: the onboarding agent auto-sends an introduction, but only the INPUT field is
// visible — the message needs a click to discover. Root cause: ChatFloat auto-expands its message
// area only when the thread is EMPTY, and the greeting path (OnboardingFlow.svelte) pulls the
// just-persisted greeting into the store with `loadHistory` BEFORE it opens the chat. By then the
// thread is not empty, so the chat opens collapsed over the message it was opened to show.
//
// ── What this gate asserts ────────────────────────────────────────────────────────────────────
//   P1  the pure clamp decides WIDTH and HEIGHT independently — no width input can move the
//       returned height, and no height input can move the returned width.
//   P2  the clamp is TOTAL: NaN / Infinity / strings / negatives / absurd values — anything a
//       corrupted localStorage can hold — come back as a REACHABLE geometry.
//   P3  the clamp is idempotent (clamping a clamped geometry changes nothing).
//   P4  it still yields a reachable geometry on a viewport far too small for the defaults.
//   R1  ⭐ a WIDTH-ONLY drag on the mounted component leaves the height untouched — the rendered
//       messages height, the committed `--chat-h`, and the persisted height — and leaves the
//       container's style attribute carrying all four geometry properties. This is the exact
//       regression: pre-fix, the attribute became `z-index: 9999;` and the height collapsed.
//   R2  the messages box carries NO inline geometry of its own, so no drag can clear it away.
//   R3  a top-edge drag past the viewport keeps the top ON-SCREEN, and the chat is then REDUCIBLE
//       (dragging the same grip back down shrinks it) — "can't be reduced" is the operator's
//       word, so reducibility is asserted, not just the bound.
//   R4  a bottom-edge drag cannot squeeze the messages box to nothing, nor carry the chat off the
//       top of the screen.
//   R5  120 randomized drags across all ten grips never destroy the chat, never strip its style
//       attribute, and never leave it out of the viewport.
//   R6  a POISONED persisted geometry is sanitized at mount AND written back, so it cannot
//       outlive one load.
//   R7  a window resize re-clamps the SIZE as well as the position.
//   R8  ⭐ D-073: on the onboarding path the whole chat opens — the messages box renders and the
//       greeting is readable with no click.
//   R9  NON-VACUITY for R8: plain `setChatOpen(true)` on the same non-empty thread does NOT
//       expand. If R8 were passing because the component always expands, R9 would fail.
//   R10 the auto-expand does not fight the user: after they collapse the chat, a later message
//       leaves it collapsed.
//   R11 ⭐ EXPANDING is itself a size change, and is clamped like one. Found by adversarial review
//       of the first version of this fix: while COLLAPSED there is no messages box to leave room
//       for, so the anchor may legally sit at the very top; re-expanding then had to place a
//       550px box above it, and measured the chat's top at -546px — the same unrecoverable state,
//       reached without touching a resize grip.
//   R12 ⭐ the COLLAPSED chat's bottom grip cannot commit or persist an invalid height. Also from
//       review: the input bar's grips render on desktop whether or not the chat is expanded, and
//       the collapsed branch of the clamp bounded nothing, so dragging that grip up wrote
//       `--chat-h: -1450px` and persisted `{"height":-1450}`. A negative length is a declaration
//       the browser DROPS, so the box falls back to its content height — D-065 by another route.
//   R13 ⭐ a TRANSIENT viewport narrowing (a phone visit, a rotation, one Ctrl+ zoom) renders the
//       chat smaller but does not overwrite or persist away the size the user chose. Also from
//       review: 1280 → 390 → 1280 left the chat permanently stuck at 358px wide.
//   W1  both greeting call sites use openChatExpanded(), not the bare setChatOpen(true).
//
// The pure checks run across all FOUR modes the product actually uses (`expanded` × `prefer`), and
// their reachability oracle is re-derived from the VIEWPORT ALONE — see `reachable()` for why
// borrowing the module's own bound helpers made P2/P4 tautological in the first version.
//
// ── MUTATION RECORD (2026-07-26) ──────────────────────────────────────────────────────────────
// Sixteen mutations were run, each restored from a `cp` snapshot afterwards (never
// `git checkout --`), and the suite confirmed GREEN on the restored tree. THREE of them initially
// left the gate GREEN; they are recorded below as the HOLES they were, together with the checks
// added to close them, because that is the whole point of running the mutations before writing the
// record. One (M15) stays green for a reason that is documented rather than patched.
//
// MUTATION-TESTED: [D-065, M1] ChatFloat.svelte `onMouseMove`'s right-edge branch also assigned
//   `curHeight = startHeight + (e.clientX - startX)` — the operator's exact symptom, a width drag
//   moving the height → R1 REDs ("committed --chat-h moved 550 → 688 on a width-only drag").
// MUTATION-TESTED: [D-065, M2] chat-geometry.ts `maxChatHeight` returned `vp.vh - 100` — the old
//   viewport-only bound that ignored where the input bar sits → P2 REDs ("clamped garbage must be
//   reachable"), R4 REDs ("the chat's top is at -64px") and R6 REDs ("the restored chat's top is
//   at -564px"). R3 stayed green: at the default anchor that bound happens to leave the top 4px
//   on-screen, which is why R4/R6 (not R3) are the checks that own this bound.
// MUTATION-TESTED: [D-065, M3] `clampChatGeometry`'s width clamp made to depend on the height
//   input → P1 REDs ("width moved when only the HEIGHT changed"), P3 REDs (idempotence) and R1
//   REDs on its non-vacuity guard ("the width never actually moved").
// MUTATION-TESTED: [D-065, M4] the mount-time restore assigned the persisted values WITHOUT
//   clamping (the pre-fix independent per-field validation) → R6 REDs ("the restored chat's top is
//   at -740px").
// MUTATION-TESTED: [D-065, M7] the pre-fix render split restored — the messages box owns its own
//   inline `height: min(…)` again and the drag clears it on mouseup → R2 REDs ("the messages box
//   grew an inline style"). This is the mechanism that measured 550px → 204px in Chromium.
// MUTATION-TESTED: [D-065, M8] `CHAT_MIN_H_HARD` lowered from 120 to 0 → R4 REDs ("the messages
//   box collapsed to 0px (floor is 100)") and R6 REDs ("restored at 12px").
//   ⚠️ HOLE FOUND AND CLOSED: on the first run this mutation left the gate GREEN, because R4/R5/R6
//   asserted against the product's own imported `CHAT_MIN_H_HARD` — lowering the constant made the
//   assertion vacuously true. The floors are now literals owned by this gate (MIN_MESSAGES_PX,
//   MAX_WIDTH_PX, MIN_VISIBLE_PX), so moving the product constant is a visible diff in both places.
// MUTATION-TESTED: [D-065, M9] the window `resize` handler replaced with a no-op → R7 REDs ("the
//   height survived the viewport shrinking 800 → 420").
// MUTATION-TESTED: [D-065, M10] the container's reactive style string stopped carrying `--chat-h`
//   → R1, R4, R5, R6 and R7 all RED, R1 naming it exactly ("the container lost --chat-h — style
//   attr is now …"), which is the same shape of evidence as the pre-fix `z-index: 9999;`.
// MUTATION-TESTED: [D-073, M5] `navigationState.openChatExpanded()` in OnboardingFlow.svelte
//   reverted to the pre-fix `setChatOpen(true)` → W1 REDs ("the onboarding greeting does not call
//   openChatExpanded()").
//   ⚠️ HOLE FOUND AND CLOSED: on the first run this left the gate GREEN — R8 drives the store
//   directly, so it never touched the call site. W1 was added for exactly this, and the first
//   draft of W1 then failed on its OWN comment (which names `setChatOpen(true)` as the
//   insufficient call), so it reads through scripts/lib/strip-comments.mjs.
// MUTATION-TESTED: [D-065, M11] the re-clamp-on-expand effect neutered (`if (false && expanded …)`)
//   → R11 REDs with the measured pre-fix number ("re-expanding put the chat's top at -546px —
//   header and .resize-top grip off-screen, unrecoverable"). Every other check stayed green, which
//   is why R11 had to exist: adversarial review of the first version of this fix found the state,
//   and none of R1-R10 could see it.
// MUTATION-TESTED: [D-065, M12] the collapsed branch of `clampChatGeometry` stopped bounding the
//   height (the pre-review state) → R12 REDs with the measured number ("committed --chat-h is
//   -1450px") and P2 REDs ("negative height (-99999) … expanded=false").
// MUTATION-TESTED: [D-065, M13] `clampToViewport` made to overwrite AND persist the desired size
//   again → R13 REDs ("the narrow viewport overwrote the persisted width (720 → 358)").
// MUTATION-TESTED: [D-065, M14] `maxInputBarTop` widened to `vp.vh + 500`, putting the input bar
//   below the fold — the mutant an independent reviewer used to DEFEAT the first version of this
//   gate → P2 REDs ("input bar bottom below the fold (1360 > 800)"), P4 REDs, and R4/R5/R7/R12 RED.
//   ⚠️ HOLE FOUND AND CLOSED: P2/P4 originally used `isChatReachable` as their oracle, which bounds
//   x and y with the SAME helpers the clamp uses, so this mutation left both GREEN with the chat
//   560px below the fold. `reachable()` now re-derives the rule from the viewport alone.
// MUTATION-TESTED: [D-134, M17] the mount restore reverted to `desiredWidth = g.width;
//   desiredHeight = g.height;` (persisting the viewport-clamped render — the pre-fix D-134 state)
//   → R13b REDs ("mount overwrote the desired width with the viewport-clamped render (1000 →
//   358)") while R6 and R13 stay GREEN — which is exactly why R13b had to exist: the poisoned-
//   entry check and the resize-path check both survive the mount-path overwrite. Restored → GO.
// MUTATION-TESTED: [D-065, M16] the reactive `containerStyle()` stopped emitting
//   `--chat-translate`, so the property existed nowhere → R1 REDs naming it ("the container lost
//   --chat-translate"), R5 and R6 RED too.
// MUTATION-TESTED: [D-065, M17] `--chat-translate: -50%` kept alongside a px `--chat-left`, i.e.
//   left and transform DISAGREEING — the exact class of failure D-065 was → R5 REDs ("the chat
//   ended out of the viewport {left:-420 … right:-100}") and R6 REDs.
//   ⚠️ HOLE FOUND AND CLOSED: `--chat-translate` was absent from GEOM_PROPS and the harness's rect
//   model ignored the transform entirely, so both mutations were invisible. The model now resolves
//   `translateX(var(--chat-translate))` the way the stylesheet does.
// NOT MUTATION-KILLABLE, DELIBERATELY [M15]: removing the IMPERATIVE `--chat-translate` write from
//   `applyImperative` leaves the gate GREEN — and correctly so. A resize always materialises
//   `position`, which triggers a Svelte render that writes the property from `containerStyle()` on
//   the same tick, so the imperative write is redundant belt-and-braces rather than load-bearing.
//   Recorded rather than papered over: M16 covers the path that DOES own the property.
// MUTATION-TESTED: [D-073, M6] ChatFloat's expand-ticket effect made unconditional (`isExpanded =
//   true` whenever the thread is non-empty, instead of once per ticket increment) → R10 REDs ("the
//   user's collapse click did not collapse the chat") and R9 REDs ("the chat expanded WITHOUT the
//   explicit request"). R8 stayed green, which is precisely R9's job.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCode } from './lib/strip-comments.mjs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// ── Load the REAL pure module (chat-geometry.ts), compiled with portal-app's own esbuild. ───────
const require_ = createRequire(pathToFileURL(resolve('portal-app/package.json')).href);
const esbuild = await import(pathToFileURL(require_.resolve('esbuild')).href);
const GEN = 'portal-app/.gen-verify-chat-geometry';
mkdirSync(GEN, { recursive: true });
await esbuild.build({
  entryPoints: ['portal-app/src/lib/chat-geometry.ts'],
  outfile: `${GEN}/chat-geometry.mjs`,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent',
});
const G = await import(pathToFileURL(resolve(`${GEN}/chat-geometry.mjs`)).href);
const { clampChatGeometry } = G;

// ⚠️ `isChatReachable` is DELIBERATELY not used as the oracle here.
// The first version of this gate asserted `isChatReachable(clampChatGeometry(junk))`, and
// independent review defeated it: the predicate bounds x and y with the SAME `minInputBarTop` /
// `maxInputBarTop` / `renderedChatWidth` / `visibleStrip` helpers the clamp uses, so widening
// `maxInputBarTop` to `vp.vh + 500` put the input bar 560px below the fold with both checks still
// GREEN. An oracle built from the code under test is a tautology on every axis where they share a
// helper. So reachability is re-derived below from the VIEWPORT ALONE.
const CHROME = { inputBar: 60, gap: 12 };
/**
 * Reachable, judged only against the viewport rectangle. No product helper participates.
 *
 * The fit rules apply only where the viewport can physically satisfy them: a 1px-tall window
 * cannot contain a 60px input bar, and asserting it could would make the predicate permanently
 * false rather than useful. The unconditional rules (finite, non-negative height) hold everywhere,
 * and the fit rules cover every viewport a user can actually have — including the 1280x800 case
 * that catches a widened `maxInputBarTop`.
 */
function reachable(g, vp, expanded = true) {
  if (![g.width, g.height, g.x, g.y].every(Number.isFinite)) return 'a non-finite value';
  // A negative length is not a small chat — it is a CSS declaration the browser drops.
  if (g.height < 0) return `negative height (${g.height})`;
  if (g.width < 0) return `negative width (${g.width})`;
  const canFitVertically = vp.vh >= CHROME.inputBar + CHROME.gap + 2 * 16;
  if (canFitVertically) {
    // The input bar (y .. y+60) must be fully on screen: it carries the drag handle and the grips.
    if (g.y < 0) return `input bar top above the viewport (${g.y})`;
    if (g.y + CHROME.inputBar > vp.vh) return `input bar bottom below the fold (${g.y + CHROME.inputBar} > ${vp.vh})`;
    // The chat's own top edge must be on screen, or it can never be grabbed and reduced.
    if (expanded && g.y - CHROME.gap - g.height < 0) return `top edge off screen (${g.y - CHROME.gap - g.height})`;
  }
  if (vp.vw >= 60) {
    // Some of the chat must be horizontally on screen.
    const renderedW = Math.min(g.width, vp.vw);
    if (g.x + renderedW <= 0) return `entirely left of the viewport (right edge ${g.x + renderedW})`;
    if (g.x >= vp.vw) return `entirely right of the viewport (left edge ${g.x})`;
  }
  return null;
}

// The product's own constants are DELIBERATELY not imported for the assertions below. A gate that
// asserts `height >= CHAT_MIN_H_HARD` passes by construction the moment someone lowers
// CHAT_MIN_H_HARD — which is exactly what happened when this gate was mutation-tested: setting the
// floor to 0 left the check green while the messages box collapsed to nothing. These are the
// numbers a HUMAN decided the chat must respect, written down here so moving the product constant
// is a visible, reviewable diff in both places.
const MIN_MESSAGES_PX = 100;   // the messages box must never be squeezed below this
const MAX_WIDTH_PX = 1200;     // the widest the chat may ever be
const MIN_VISIBLE_PX = 60;     // grabbable horizontal strip

const VP = { vw: 1280, vh: 800 };

// Every MODE the product actually calls the clamp with. Independent review found that P1-P4 only
// ever exercised the defaults, while ChatFloat passes `expanded: isExpanded` on three paths and
// `prefer: 'size'` on two — and the collapsed mode is exactly where an unbounded (negative) height
// was hiding. Every pure check below runs across all four.
const MODES = [
  { expanded: true, prefer: 'position' },
  { expanded: true, prefer: 'size' },
  { expanded: false, prefer: 'position' },
  { expanded: false, prefer: 'size' },
];
const modeName = (m) => `expanded=${m.expanded} prefer=${m.prefer}`;

// ── P1 ── width and height are decided independently ────────────────────────────────────────────
t('P1. ⭐ the clamp decides WIDTH and HEIGHT independently (the operator\'s "width resize changes the height")', () => {
  const ys = [40, 200, 400, 716, 900];
  const hs = [0, 120, 200, 550, 900, 5000];
  const ws = [0, 100, 320, 720, 1200, 4000];
  for (const mode of MODES) {
    for (const y of ys) {
      for (const h of hs) {
        const heights = new Set(ws.map((w) => clampChatGeometry({ width: w, height: h, x: 100, y }, VP, mode).height));
        assert.equal(heights.size, 1,
          `height moved when only the WIDTH changed (${modeName(mode)} y=${y} h=${h}): ${[...heights].join(', ')}`);
      }
      for (const w of ws) {
        const widths = new Set(hs.map((h) => clampChatGeometry({ width: w, height: h, x: 100, y }, VP, mode).width));
        assert.equal(widths.size, 1,
          `width moved when only the HEIGHT changed (${modeName(mode)} y=${y} w=${w}): ${[...widths].join(', ')}`);
      }
    }
  }
});

// ── P2 ── total on garbage ──────────────────────────────────────────────────────────────────────
t('P2. the clamp is TOTAL — NaN / Infinity / strings / negatives / absurd values come back REACHABLE', () => {
  const junk = [undefined, null, NaN, Infinity, -Infinity, 'abc', '', {}, [], -99999, 1e12, 0, -0.5];
  const vps = [VP, { vw: 320, vh: 480 }, { vw: 3840, vh: 2160 }, { vw: 0, vh: 0 }, { vw: NaN, vh: NaN }];
  let n = 0;
  for (const mode of MODES) {
    for (const vp of vps) {
      for (const w of junk) for (const h of junk) for (const x of junk) for (const y of junk) {
        const g = clampChatGeometry({ width: w, height: h, x, y }, vp, mode);
        for (const [k, v] of Object.entries(g)) {
          assert.ok(Number.isFinite(v), `${k} is not finite for {${w},${h},${x},${y}} ${modeName(mode)} @ ${vp.vw}x${vp.vh}: ${v}`);
        }
        // The top-edge rule only applies while EXPANDED (a collapsed chat has no box on screen —
        // R11 owns the moment it gains one). The height rules apply in BOTH modes, because a
        // collapsed chat's height is still committed to `--chat-h` and persisted.
        const safeVp = {
          vw: Math.max(1, Number.isFinite(vp.vw) ? vp.vw : 1024),
          vh: Math.max(1, Number.isFinite(vp.vh) ? vp.vh : 768),
        };
        const why = reachable(g, safeVp, mode.expanded);
        assert.equal(why, null, `${why} — ${JSON.stringify(g)} ${modeName(mode)} @ ${vp.vw}x${vp.vh}`);
        assert.ok(g.height >= 0, `negative height committed in ${modeName(mode)}: ${g.height}`);
        assert.ok(g.width <= MAX_WIDTH_PX, `width above the ceiling: ${g.width}`);
        n++;
      }
    }
  }
  assert.ok(n > 40000, `expected a broad sweep across all four modes, ran ${n}`);
});

// ── P3 ── idempotence ───────────────────────────────────────────────────────────────────────────
t('P3. the clamp is idempotent — clamping a clamped geometry changes nothing', () => {
  for (const mode of MODES) {
    for (const vp of [VP, { vw: 400, vh: 600 }, { vw: 2560, vh: 1440 }]) {
      for (const seed of [{ width: 4000, height: 4000, x: -9000, y: -9000 }, { width: 1, height: 1, x: 1e9, y: 1e9 }, { width: 720, height: 550, x: 100, y: 700 }]) {
        const once = clampChatGeometry(seed, vp, mode);
        const twice = clampChatGeometry(once, vp, mode);
        assert.deepEqual(twice, once, `not idempotent ${modeName(mode)} @ ${vp.vw}x${vp.vh} from ${JSON.stringify(seed)}`);
      }
    }
  }
});

// ── P4 ── tiny viewport ─────────────────────────────────────────────────────────────────────────
t('P4. a viewport far smaller than the defaults still yields a reachable geometry', () => {
  for (const mode of MODES) {
    for (const vp of [{ vw: 320, vh: 200 }, { vw: 200, vh: 150 }, { vw: 100, vh: 100 }]) {
      const g = clampChatGeometry({ width: 720, height: 550, x: 0, y: 700 }, vp, mode);
      const why = reachable(g, vp, mode.expanded);
      assert.equal(why, null, `${why} on ${vp.vw}x${vp.vh} ${modeName(mode)}: ${JSON.stringify(g)}`);
    }
  }
});

// ── The mounted component ───────────────────────────────────────────────────────────────────────
function run(probe, env = {}) {
  const line = execFileSync('node', ['--conditions', 'browser', 'test/mount-chat-geometry.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 180000,
    env: { ...process.env, PROBE: probe, MYCELIUM_SKIP_WRITER_LOCK: '1', ...env },
  }).trim().split('\n').pop();
  const o = JSON.parse(line);
  if (!o.ok) throw new Error(`probe ${probe} did not run: ${String(o.error).slice(0, 500)}`);
  return o;
}

// All FIVE properties both writers share. `--chat-translate` was missing here at first
// (independent review, finding 5) — and left/transform disagreeing is the exact class of failure
// D-065 was, so an unwritten transform must red the same checks as an unwritten width.
const GEOM_PROPS = ['--chat-w', '--chat-h', '--chat-left', '--chat-bottom', '--chat-translate'];
const holdsGeometry = (s) => GEOM_PROPS.filter((p) => !String(s.styleAttr).includes(p));
const onScreen = (s, vh) => s.rect.top >= 0 && s.rect.bottom <= vh + 1
  && s.rect.right >= MIN_VISIBLE_PX && s.rect.left <= 1280 - MIN_VISIBLE_PX;

let widthonly, topgrip, bottomgrip, fuzz, persisted, windowresize, firstNew, firstOld, collapse, reexpand,
  collapsedGrip, shrinkgrow, narrowMount;
try {
  widthonly = run('widthonly');
  topgrip = run('topgrip');
  bottomgrip = run('bottomgrip');
  fuzz = run('fuzz');
  windowresize = run('windowresize');
  persisted = run('persisted', { LS_SIZE: '{"width":9999,"height":5000}', LS_POS: '{"x":-8000,"y":40}' });
  reexpand = run('collapsedthenexpand');
  collapsedGrip = run('collapsedbottomgrip');
  shrinkgrow = run('viewportshrinkgrow');
  narrowMount = run('persisted', { VW: '390', LS_SIZE: '{"width":1000,"height":800}', LS_POS: '{"x":100,"y":700}' });
  firstNew = run('firstmessage');
  firstOld = run('firstmessage_old');
  collapse = run('collapsehonoured');
} catch (e) {
  console.log(`FAIL  R0. the component MOUNTS and every probe runs — ${String(e?.message || e).slice(0, 500)}`);
  console.log('\nVERDICT: NO-GO — a probe failed to run  EXIT=1');
  rmSync(GEN, { recursive: true, force: true });
  process.exit(1);
}
rec('R0. ChatFloat mounts and all twelve probes run', true);

t('R1. ⭐ a WIDTH-ONLY drag leaves the HEIGHT untouched and the style attribute intact', () => {
  const [start, ...after] = widthonly.steps;
  for (const s of after) {
    assert.equal(s.chatH, start.chatH,
      `${s.label}: committed --chat-h moved ${start.chatH} → ${s.chatH} on a width-only drag`);
    assert.equal(s.messagesHeight, start.messagesHeight,
      `${s.label}: the RENDERED messages height moved ${start.messagesHeight} → ${s.messagesHeight}`);
    assert.equal(JSON.parse(s.ls.size).height, JSON.parse(start.ls.size).height,
      `${s.label}: the PERSISTED height moved on a width-only drag`);
    const missing = holdsGeometry(s);
    assert.equal(missing.length, 0,
      `${s.label}: the container lost ${missing.join(', ')} — style attr is now "${s.styleAttr}"`);
  }
  // …and the width really did change, so the assertions above are not about a no-op drag.
  const widths = new Set(widthonly.steps.map((s) => s.chatW));
  assert.ok(widths.size >= 3, `the width never actually moved: ${[...widths].join(', ')}`);
});

t('R2. the messages box carries NO inline geometry — there is nothing for a drag to clear away', () => {
  for (const s of [...widthonly.steps, ...topgrip.steps, ...fuzz.steps]) {
    assert.equal(s.messagesInlineStyle, null,
      `${s.label}: the messages box grew an inline style ("${s.messagesInlineStyle}") — the property the pre-fix drag cleared and lost`);
  }
});

t('R3. ⭐ a top-edge drag past the viewport keeps the top ON-SCREEN, and the chat stays REDUCIBLE', () => {
  const grown = topgrip.steps[1];
  const shrunk = topgrip.steps[2];
  assert.ok(grown.rect.top >= 0, `the top went off-screen at ${grown.rect.top}px — the grip cannot be grabbed there`);
  assert.ok(grown.chatH > topgrip.steps[0].chatH, 'the drag did not actually grow the chat');
  assert.ok(shrunk.chatH < grown.chatH,
    `dragging the top grip back DOWN did not reduce the chat (${grown.chatH} → ${shrunk.chatH})`);
  assert.ok(shrunk.rect.top >= 0, 'the reduced chat is still off-screen');
});

t('R4. a bottom-edge drag can neither squeeze the box to nothing nor carry the chat off the top', () => {
  for (const s of bottomgrip.steps) {
    assert.ok(s.messagesHeight >= MIN_MESSAGES_PX,
      `${s.label}: the messages box collapsed to ${s.messagesHeight}px (floor is ${MIN_MESSAGES_PX})`);
    assert.ok(s.rect.top >= 0, `${s.label}: the chat's top is at ${s.rect.top}px`);
    assert.ok(s.rect.bottom <= 800 + 1, `${s.label}: the chat's bottom is at ${s.rect.bottom}px`);
  }
});

t('R5. 120 randomized drags across all ten grips never destroy the chat', () => {
  const end = fuzz.steps[fuzz.steps.length - 1];
  assert.equal(end.gone, false, 'the chat was destroyed during the fuzz');
  const missing = holdsGeometry(end);
  assert.equal(missing.length, 0, `the container lost ${missing.join(', ')} — style attr is "${end.styleAttr}"`);
  assert.ok(onScreen(end, 800), `the chat ended out of the viewport: ${JSON.stringify(end.rect)}`);
  assert.ok(end.messagesHeight >= MIN_MESSAGES_PX, `the messages box ended at ${end.messagesHeight}px`);
  assert.deepEqual(fuzz.consoleErrors, [], `the fuzz produced console errors: ${fuzz.consoleErrors.join(' | ')}`);
});

t('R6. a POISONED persisted geometry is sanitized at mount AND written back', () => {
  const s = persisted.steps[0];
  assert.ok(s.rect.top >= 0, `the restored chat's top is at ${s.rect.top}px`);
  assert.ok(s.rect.right >= MIN_VISIBLE_PX, `the restored chat has no grabbable strip (right edge ${s.rect.right})`);
  assert.ok(s.chatW <= MAX_WIDTH_PX, `the 9999px persisted width survived as ${s.chatW}`);
  assert.ok(s.messagesHeight >= MIN_MESSAGES_PX, `the messages box restored at ${s.messagesHeight}px`);
  // The write-back is what stops a poisoned entry outliving one load.
  const size = JSON.parse(s.ls.size);
  const pos = JSON.parse(s.ls.pos);
  assert.notEqual(size.width, 9999, 'the poisoned width was left in localStorage');
  assert.notEqual(size.height, 5000, 'the poisoned height was left in localStorage');
  assert.notEqual(pos.x, -8000, 'the poisoned x was left in localStorage');
  assert.notEqual(pos.y, 40, 'the poisoned y was left in localStorage');
});

t('R7. a window resize re-clamps the SIZE, not only the position', () => {
  const grown = windowresize.steps[1];
  const after = windowresize.steps[2];
  assert.ok(after.chatH < grown.chatH,
    `the height survived the viewport shrinking 800 → 420 (${grown.chatH} → ${after.chatH})`);
  assert.ok(after.rect.top >= 0, `the chat's top is at ${after.rect.top}px after the resize`);
  assert.ok(after.rect.bottom <= 420 + 1, `the chat's bottom is at ${after.rect.bottom}px in a 420px viewport`);
});

t('R8. ⭐ D-073 — the onboarding first message opens the WHOLE chat, greeting readable, no click', () => {
  const s = firstNew.steps[0];
  assert.equal(s.messagesBoxRendered, true, 'only the input bar rendered — the message area stayed collapsed');
  assert.equal(s.greetingVisible, true, `the greeting is not in the rendered chat. Saw: "${s.visibleText}"`);
});

t('R9. NON-VACUITY for R8 — a plain setChatOpen(true) on the same thread does NOT expand', () => {
  const s = firstOld.steps[0];
  assert.equal(s.messagesBoxRendered, false,
    'the chat expanded WITHOUT the explicit request, so R8 proves nothing about the fix');
});

t('R11. ⭐ EXPANDING a collapsed chat that sits at the viewport top keeps it on-screen and reducible', () => {
  const [, collapsed, dragged, expanded] = reexpand.steps;
  // Non-vacuity: the sequence really did collapse and really did reach the top.
  assert.equal(collapsed.expanded, false, 'the chat never collapsed, so this probe proves nothing');
  assert.ok(dragged.rect.top <= 32,
    `the collapsed chat never reached the top of the viewport (top ${dragged.rect.top}) — the probe missed the setup`);
  assert.equal(expanded.expanded, true, 'the chat never re-expanded');
  assert.ok(expanded.rect.top >= 0,
    `re-expanding put the chat's top at ${expanded.rect.top}px — header and .resize-top grip off-screen, unrecoverable`);
  assert.ok(expanded.messagesHeight >= MIN_MESSAGES_PX,
    `re-expanded to a ${expanded.messagesHeight}px messages box`);
});

t('R12. ⭐ the COLLAPSED chat\'s bottom grip cannot commit or persist an invalid height', () => {
  const [start, collapsed, up, down, expanded] = collapsedGrip.steps;
  assert.equal(collapsed.expanded, false, 'the chat never collapsed, so this probe proves nothing');
  assert.notEqual(up.chatH, start.chatH, 'the collapsed bottom grip did nothing — the probe missed the grip');
  for (const s of [collapsed, up, down, expanded]) {
    // A negative length makes `height: min(var(--chat-h), …)` an INVALID declaration that a
    // browser drops, so the box falls back to its content height — D-065's collapse by another
    // route. Measured at --chat-h: -1450px before this bound existed.
    assert.ok(s.chatH >= MIN_MESSAGES_PX,
      `${s.label}: committed --chat-h is ${s.chatH}px (floor ${MIN_MESSAGES_PX})`);
    assert.ok(JSON.parse(s.ls.size).height >= MIN_MESSAGES_PX,
      `${s.label}: persisted height is ${JSON.parse(s.ls.size).height}px — a poisoned entry`);
  }
  // Re-expanding after all that still lands on screen with a real box.
  assert.ok(Number.isFinite(expanded.messagesHeight) && expanded.messagesHeight >= MIN_MESSAGES_PX,
    `re-expanded to a ${expanded.messagesHeight}px messages box`);
  assert.ok(expanded.rect.top >= 0, `re-expanded with the top at ${expanded.rect.top}px`);
});

t('R13. ⭐ a TRANSIENT viewport narrowing does not permanently shrink the size the user chose', () => {
  const [start, narrow, back] = shrinkgrow.steps;
  // It must actually fit while narrow — the clamp is doing its job.
  assert.ok(narrow.rect.width <= 390, `the chat did not fit the 390px viewport (${narrow.rect.width}px)`);
  // …but the user's choice is neither overwritten nor persisted away.
  assert.equal(JSON.parse(narrow.ls.size).width, JSON.parse(start.ls.size).width,
    `the narrow viewport overwrote the persisted width (${JSON.parse(start.ls.size).width} → ${JSON.parse(narrow.ls.size).width}) — one phone visit or Ctrl+ zoom would shrink the desktop chat forever`);
  assert.equal(back.rect.width, start.rect.width,
    `the chat did not recover when the viewport grew back (${start.rect.width} → ${back.rect.width})`);
});

t('R13b. ⭐ D-134 — MOUNTING in a small window renders clamped but PERSISTS the desired size', () => {
  // R13 covers the resize-event path; this is the MOUNT path — the D-134 residual: mount used to
  // assign the viewport-clamped geometry to desired* and then saveChatSize(), so one launch in a
  // 390px window permanently shrank the saved 1000px chat. Render clamped, persist desired.
  const s0 = narrowMount.steps[0];
  assert.ok(s0.rect.width <= 390, `the chat did not fit the 390px viewport at mount (${s0.rect.width}px)`);
  const size = JSON.parse(s0.ls.size);
  assert.equal(size.width, 1000,
    `mount overwrote the desired width with the viewport-clamped render (1000 → ${size.width}) — one small-window launch shrinks the saved size forever (D-134)`);
  assert.equal(size.height, 800,
    `mount overwrote the desired height (800 → ${size.height})`);
});

// ── W1 ── the CALL SITES, not just the mechanism ────────────────────────────────────────────────
// R8 drives navigationState directly, because mounting the whole onboarding wizard to reach the
// greeting is a different gate's job. That leaves one hole, and mutation-testing found it: reverting
// OnboardingFlow's call to the pre-fix `setChatOpen(true)` left every other check GREEN. So the two
// greeting call sites are asserted directly. This is a SOURCE assertion and is honest about it — it
// proves the wiring, while R8/R9/R10 prove the behaviour the wiring reaches.
t('W1. ⭐ both greeting call sites open the chat EXPANDED — not with the bare setChatOpen(true)', () => {
  // OnboardingFlow: the whole maybeGreetAndOpenChat function.
  // readCode(), not readFileSync — the first draft of this check FAILED on its own explanatory
  // comment, which names `setChatOpen(true)` as the thing that was not enough. Prose must never
  // satisfy or defeat a source assertion (scripts/lib/strip-comments.mjs).
  const flow = readCode('portal-app/src/lib/components/onboarding/OnboardingFlow.svelte');
  const start = flow.indexOf('async function maybeGreetAndOpenChat()');
  assert.ok(start > 0, 'maybeGreetAndOpenChat is gone from OnboardingFlow.svelte — the greeting path moved');
  const body = flow.slice(start, flow.indexOf('\n\t}', start));
  assert.ok(body.includes('openChatExpanded()'),
    'the onboarding greeting does not call openChatExpanded() — the chat will open collapsed over the message (D-073)');
  assert.ok(!/setChatOpen\(\s*true\s*\)/.test(body),
    'the onboarding greeting still calls setChatOpen(true), which only renders the input bar');

  // OnboardingGuide: the `if (data.greeting) { … }` branch after the Claude auth-code exchange.
  const guide = readCode('portal-app/src/lib/components/OnboardingGuide.svelte');
  const gStart = guide.indexOf('if (data.greeting)');
  assert.ok(gStart > 0, 'the data.greeting branch is gone from OnboardingGuide.svelte');
  const gBody = guide.slice(gStart, guide.indexOf('\n\t\t\t}', gStart));
  assert.ok(gBody.includes('openChatExpanded()'),
    'the Claude-connect greeting does not call openChatExpanded() (D-073)');
  assert.ok(!/setChatOpen\(\s*true\s*\)/.test(gBody),
    'the Claude-connect greeting still calls setChatOpen(true)');
});

t('R10. the auto-expand does not fight the user — a later message leaves a collapsed chat collapsed', () => {
  const opened = collapse.steps[0];
  const after = collapse.steps[1];
  assert.equal(opened.messagesBoxRendered, true, 'the chat never opened, so the collapse test is vacuous');
  assert.equal(after.collapsedAfterUserClick, true, 'the user\'s collapse click did not collapse the chat');
  assert.equal(after.stillCollapsed, true, 'a later message re-opened a chat the user had collapsed');
});

rmSync(GEN, { recursive: true, force: true });

const failed = ledger.filter((p) => !p).length;
console.log(`\n${ledger.length - failed}/${ledger.length} checks passed`);
if (failed) {
  console.log('VERDICT: NO-GO — the chat can still be lost, or the first message is still hidden  EXIT=1');
  process.exit(1);
}
console.log('VERDICT: GO — width and height are independent, the chat stays reachable and reducible, and the first message opens the whole chat  EXIT=0');
process.exit(0);
