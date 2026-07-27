// Mutation harness for verify:mindscape-rail — the /gate-teeth discipline, executable.
//
// A gate is not evidence until you have WATCHED IT FAIL on the specific thing it claims to catch.
// Every mutation below is either the real shipped v0.1.13 behaviour or a plausible later "tidy-up"
// that would silently restore it. The harness applies one, runs the gate, prints which checks
// RED, and restores from an in-memory snapshot — always, including on error.
//
//   node scripts/mutate-mindscape-rail.mjs        # every mutation
//   node scripts/mutate-mindscape-rail.mjs M3     # one
//
// Its verdicts are what the `// MUTATION-TESTED:` lines in scripts/verify-mindscape-rail.mjs
// record. Never edit those lines without re-running this and reading the output.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VIEW = 'portal-app/src/lib/views/MindscapeView.svelte';
const DETAIL = 'portal-app/src/lib/components/mindscape/MindscapeDetail.svelte';
const PIPE = 'portal-app/src/lib/components/mindscape/PipelineStatus.svelte';
const HEADER = 'portal-app/src/lib/components/mindscape/CollapsibleHeader.svelte';
const SCENE = 'portal-app/src/lib/components/mindscape/Mindscape3D.svelte';
const FILES = [VIEW, DETAIL, PIPE, HEADER, SCENE];

const snap = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const restore = () => { for (const f of FILES) writeFileSync(f, snap[f]); };

/** Exact-substring edit that REFUSES to no-op — a mutation that did not apply is a false green. */
function edit(file, find, replace) {
  const s = readFileSync(file, 'utf8');
  if (!s.includes(find)) throw new Error(`anchor not found in ${file}: ${JSON.stringify(find.slice(0, 90))}`);
  writeFileSync(file, s.replace(find, replace));
}

const MUTATIONS = {
  M1: {
    what: '.nav-rail loses `min-height: 0` — the exact #350-class flex trap, one level out',
    apply: () => edit(VIEW, '\t\tmin-height: 0;\n\t\toverflow-y: auto;', '\t\toverflow-y: auto;'),
  },
  M2: {
    what: '.nav-rail `overflow-y: auto` → `hidden` (the pre-fix .nav-panel behaviour, moved inward)',
    apply: () => edit(VIEW, '\t\toverflow-y: auto;\n\t\t/* A rail that has run out', '\t\toverflow-y: hidden;\n\t\t/* A rail that has run out'),
  },
  M3: {
    what: '.nav-panel reverted to the shipped v0.1.13 rule — plain block, min-height:auto',
    apply: () => {
      const s = readFileSync(VIEW, 'utf8');
      const start = s.indexOf('\t.nav-panel {');
      const end = s.indexOf('\n\t}', start) + 3;
      if (start === -1 || end < 3) throw new Error('.nav-panel rule not found');
      writeFileSync(VIEW, s.slice(0, start) +
        '\t.nav-panel {\n\t\tflex-shrink: 0;\n\t\theight: 100%;\n\t\toverflow: hidden;\n\t\tborder-right: 1px solid var(--color-border);\n\t\tbackground: var(--color-surface);\n\t\tz-index: 10;\n\t\tposition: relative;\n\t}' +
        s.slice(end));
    },
  },
  M4: {
    what: 'the rail loses its bottom padding — the "text cuts off at the bottom" half of the report',
    apply: () => edit(VIEW, 'padding: 0.6rem 0.6rem 4rem;', 'padding: 0.6rem;'),
  },
  M4b: {
    what: 'the bottom space expressed as a MARGIN (collapses out of scrollHeight — a silent cut-off)',
    apply: () => edit(VIEW, 'padding: 0.6rem 0.6rem 4rem;', 'padding: 0.6rem;\n\t\tmargin-bottom: 4rem;'),
  },
  M5: {
    what: '.mindscape-nav reclaims the whole rail (height:100% + overflow:hidden) — the precise pre-fix shape',
    apply: () => edit(DETAIL, '\t.mindscape-nav {\n', '\t.mindscape-nav {\n\t\theight: 100%;\n\t\toverflow: hidden;\n'),
  },
  M5b: {
    what: '.nav-content restored as a nested scroll port — two scrollers in one rail',
    apply: () => edit(DETAIL, '\t.nav-content {\n\t\tdisplay: block;', '\t.nav-content {\n\t\tflex: 1;\n\t\toverflow-y: auto;\n\t\tmin-height: 0;'),
  },
  M6: {
    what: 'the .nav-rail wrapper removed — the five sections are direct children of .nav-panel again',
    apply: () => {
      edit(VIEW, '\t\t<div class="nav-rail" data-testid="nav-rail">\n', '');
      edit(VIEW, '\t\t\t<NarrateControl />\n\t\t</div>\n', '\t\t<NarrateControl />\n');
    },
  },
  M7: {
    what: 'the resize handle moved INSIDE the scroll port — it would scroll away with the content',
    apply: () => edit(VIEW, '\t\t\t<NarrateControl />\n\t\t</div>',
      '\t\t\t<NarrateControl />\n\t\t\t<div class="resize-handle"></div>\n\t\t</div>'),
  },
  M8: {
    what: 'PipelineStatus reverted to the shipped LONE-CARET disclosure — the D-067 defect itself',
    apply: () => {
      const s = readFileSync(PIPE, 'utf8');
      const start = s.indexOf('\t{#if settled}\n\t\t<CollapsibleHeader');
      const marker = '\t\t<div class="pipe-overall">{@render overallLine()}</div>\n\t{/if}';
      const end = s.indexOf(marker);
      if (start === -1 || end === -1) throw new Error('disclosure block not found');
      const shipped =
        '\t<div class="pipe-overall">\n' +
        '\t\t{@render overallLine()}\n' +
        '\t\t{#if settled}\n' +
        '\t\t\t<button type="button" class="pipe-toggle" data-testid="pipe-toggle"\n' +
        '\t\t\t\taria-expanded={userExpanded}\n' +
        '\t\t\t\taria-label={userExpanded ? \'Hide pipeline stages\' : \'Show pipeline stages\'}\n' +
        '\t\t\t\tonclick={() => (userExpanded = !userExpanded)}\n' +
        '\t\t\t>{userExpanded ? \'\\u25b4\' : \'\\u25be\'}</button>\n' +
        '\t\t{/if}\n' +
        '\t</div>';
      writeFileSync(PIPE, s.slice(0, start) + shipped + s.slice(end + marker.length));
    },
  },
  M9: {
    what: 'the caret loses aria-hidden — a decorative glyph becomes an announced target',
    apply: () => edit(HEADER, '<span class="ch-caret" aria-hidden="true">', '<span class="ch-caret">'),
  },
  M10: {
    what: 'MindscapeDetail stops using the shared header — a forked second implementation',
    apply: () => edit(DETAIL, "\timport CollapsibleHeader from './CollapsibleHeader.svelte';", ''),
  },
  // ── The four evasions the independent adversarial review found (H-1). Every one of these is
  // the SAME defect class as M3/M5/M5b wearing a different property or unit, and every one of
  // them passed the first version of S4/S6. They are permanent members of the suite now.
  M5c: {
    what: 'H-1: `.mindscape-nav { height: 100vh }` — the identical defect in a viewport unit',
    apply: () => edit(DETAIL, '\t.mindscape-nav {\n', '\t.mindscape-nav {\n\t\theight: 100vh;\n'),
  },
  M5d: {
    what: 'H-1: `.mindscape-nav { overflow-y: hidden }` — a nested clip on ONE axis (also silently kills the sticky breadcrumb)',
    apply: () => edit(DETAIL, '\t.mindscape-nav {\n', '\t.mindscape-nav {\n\t\toverflow-y: hidden;\n'),
  },
  M5e: {
    what: 'H-1: `.nav-content { max-height: 400px; overflow: auto }` — the nested scroller wearing a different hat',
    apply: () => edit(DETAIL, '\t.nav-content {\n\t\tdisplay: block;', '\t.nav-content {\n\t\tdisplay: block;\n\t\tmax-height: 400px;\n\t\toverflow: auto;'),
  },
  M3b: {
    what: 'H-1: `.nav-panel { overflow: hidden; overflow-y: auto }` — the PANEL becomes the scroller and takes the resize handle with it',
    apply: () => edit(VIEW, '\t\toverflow: hidden;\n\t\tborder-right: 1px solid var(--color-border);',
      '\t\toverflow: hidden;\n\t\toverflow-y: auto;\n\t\tborder-right: 1px solid var(--color-border);'),
  },
  // ── The two defects the review found in the CHANGE itself (M-2, M-3) ────────────────────────
  M14: {
    what: 'M-2: an `aria-label` put back on the shared header — AT loses the status sentence the control now wraps',
    apply: () => edit(HEADER, '\ttitle={expanded ? `Hide ${label}` : `Show ${label}`}',
      '\taria-label={expanded ? `Hide ${label}` : `Show ${label}`}'),
  },
  M15: {
    what: 'M-3: `expanded` reverted to a plain stored boolean — a collapsed rail answers the user\'s own drill-down with an empty panel',
    apply: () => {
      edit(DETAIL, '\tconst sectionExpanded = $derived(collapsedAtNavKey !== navKey);', '\tlet sectionExpanded = $state(true);');
      edit(DETAIL, '\t\tbind:expanded={() => sectionExpanded, (v) => (collapsedAtNavKey = v ? null : navKey)}', '\t\tbind:expanded={sectionExpanded}');
    },
  },
  M15b: {
    what: 'M-3: the territory coordinate dropped from the nav key — drilling into a territory no longer re-opens',
    apply: () => edit(DETAIL, '`${navLevel}:${msState.selectedRealmId}:${msState.selectedSemanticThemeId}:${msState.selectedTerritoryId}`',
      '`${navLevel}:${msState.selectedRealmId}:${msState.selectedSemanticThemeId}`'),
  },
  M11: {
    what: 'D-072: the mount-time framing call deleted — camera back at (80,50,80) looking at (0,0,0)',
    apply: () => edit(SCENE, '\t\tframeCameraOnData();\n\t\trenderLoop();', '\t\trenderLoop();'),
  },
  M12: {
    what: 'D-072: the pivot assignment neutered — controls.target stays at the world origin',
    apply: () => edit(SCENE, '\t\tcontrols.target.copy(sceneCenter);', '\t\t/* pivot left at the world origin */'),
  },
  M13: {
    what: 'D-072: the intro-cancel path strands the pivot instead of snapping it to the centroid',
    apply: () => edit(SCENE,
      '\t\t\t\tconst camOffset = camera.position.clone().sub(controls.target);\n\t\t\t\tcontrols.target.copy(endTarget);\n\t\t\t\tcamera.position.copy(endTarget).add(camOffset);\n',
      ''),
  },
  M13b: {
    what: 'D-072: the cancel path snaps the pivot but NOT the camera — the abort teleports the view instead of settling',
    apply: () => edit(SCENE, '\t\t\t\tcamera.position.copy(endTarget).add(camOffset);\n', ''),
  },
};

function runGate() {
  try {
    // maxBuffer is explicit: Node's 1 MiB default makes execFileSync throw ENOBUFS once the
    // gate's ledger grows past it, and the catch below would misread that as `green: false`
    // — a FALSE RED that aborts the run at the "BASELINE IS NOT GREEN" check below for a
    // reason that has nothing to do with the mutation under test.
    execFileSync('node', ['scripts/verify-mindscape-rail.mjs'], {
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { green: true, fails: [] };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    return { green: false, fails: out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(0, 150)) };
  }
}

const only = process.argv[2];
const keys = only ? [only] : Object.keys(MUTATIONS);
let uncaught = 0;
try {
  // Sanity: the gate must be GREEN before any mutation, or every "RED" below is meaningless.
  const base = runGate();
  if (!base.green) {
    console.log('BASELINE IS NOT GREEN — fix the gate before mutation-testing:\n' + base.fails.join('\n'));
    process.exit(1);
  }
  console.log('baseline: GREEN\n');

  for (const k of keys) {
    const m = MUTATIONS[k];
    if (!m) { console.log(`unknown mutation ${k}`); continue; }
    restore();
    m.apply();
    const r = runGate();
    console.log('─'.repeat(78));
    console.log(`${k}  ${m.what}`);
    if (r.green) { console.log('  ⚠️  GATE STAYED GREEN — NOT caught. Do not record this as mutation-tested.'); uncaught++; }
    else for (const f of r.fails) console.log(`  RED  ${f}`);
  }
} finally {
  restore();
  console.log('\nrestored.');
}
process.exit(uncaught === 0 ? 0 : 1);
