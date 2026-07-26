// Mounts the REAL StatusPopover.svelte (§3.8 — increment G) and reports what a user can
// actually read. Run: node --conditions browser portal-app/test/mount-status-popover.mjs
// (cwd = portal-app). Without --conditions browser, svelte resolves its server exports map
// and mount() throws lifecycle_function_unavailable (see mount-onbox-select.mjs:15).
//
// WHY A MOUNT AND NOT A REGEX: `{#if false && …}` keeps every asserted string in the
// source while the user sees nothing — the documented #194 failure. Only rendering proves
// rendering (render-must-be-mounted-not-grepped). This harness emits OBSERVATIONS; the
// assertions live in scripts/verify-readiness.mjs (G-gates), each validated against a
// CONTROL scenario so a check that reds ALL renders (the -webkit-text-fill-color trap)
// cannot ship.
//
// Scenario knobs (env):
//   PAUSED=1               processing starts paused (waiting 12431)
//   UNKNOWN_AFTER_FIRST=1  every readiness poll AFTER the first returns unknown-degraded
//                          slices (§3.2a: the render must HOLD, never regress to zeros)
//   MODELPULL=1            the activity feed carries a model-pull row (bytes) AND the
//                          labeler health reports 'downloading' with a pct (R4: the feed
//                          row owns the percent; the status row must NOT repeat it)
//   KEEPAWAKE=1 / ONBATT=1 the keep-awake probe reports active / on battery
//   CLICK_RESUME=1         click the Processing row's Resume button and re-observe
import { compile } from 'svelte/compiler';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ENV = (k) => process.env[k] === '1';
// ⚠️ PER-PROCESS temp dir — never a FIXED path. verify:readiness runs under both the top-level
// `verify` chain AND `verify:core`, and CI runs those groups concurrently on one checkout ⇒ two
// of these children live in the same portal-app cwd at once. The old fixed `.gen-mount-status-
// popover` let one child's rmSync/writeFileSync race another's esbuild read → the child crashed
// OUTSIDE the try/catch (setup phase) with ENOENT / esbuild "Cannot read file" / ENOTEMPTY, which
// surfaced as execFileSync "Command failed" (a nonzero-exit CHILD CRASH, not a clean {ok:false})
// and reded G4b/G-family/ON-3 at random under load. mkdtempSync hands each process its OWN
// collision-proof dir. It MUST stay INSIDE portal-app: the compiled Popover.js imports bare
// specifiers ('svelte', 'svelte/internal/…') that Node resolves by walking up to
// portal-app/node_modules — an os.tmpdir() location has no node_modules above it. `exit` cleanup
// covers the setup-phase crash path (before the try) so no orphan dir is left in the tree.
const GEN = mkdtempSync('.gen-mount-status-popover-');
const cleanupGen = () => { try { rmSync(GEN, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanupGen);
// SIGTERM/SIGINT skip the 'exit' handler — execFileSync sends SIGTERM on its timeout, so without
// this a hard-killed child would orphan its unique dir in portal-app. Clean up, then exit.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { cleanupGen(); process.exit(1); });

// ON-3 — the `pipeline` slice fixture the vault-health pill reads. PIPELINE=<done|working|error>
// picks the collapsed-pill scenario; the shapes are byte-for-byte what readiness.js pipeline()
// emits (mirrors mount-pipeline-status.mjs's SLICES), so a server enum change surfaces here too.
const PIPELINE_FIXTURE = (() => {
  const st = process.env.PIPELINE || 'done';
  if (st === 'working') return {
    overall: 'running', blockedOn: null,
    stages: [
      { key: 'import', state: 'done', count: { done: 1204 } },
      { key: 'embed', state: 'running', count: { done: 812, total: 1204 }, etaSeconds: 90, paused: false },
      { key: 'categorize', state: 'pending', paused: false },
      { key: 'cluster', state: 'pending', reason: 'waiting_embed' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
  };
  if (st === 'error') return {
    overall: 'blocked', blockedOn: 'no_model',
    stages: [
      { key: 'import', state: 'done', count: { done: 12431 } },
      { key: 'embed', state: 'done', count: { done: 12431, total: 12431 }, paused: false },
      { key: 'categorize', state: 'blocked', reason: 'no_model', action: { label: 'Approve a labeling model', target: 'intelligence' }, paused: false },
      { key: 'cluster', state: 'pending', reason: 'waiting_embed' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
  };
  // done — every stage settled ⇒ the calm "all green" pill (no counts, ON-3's quiet state).
  return {
    overall: 'done', blockedOn: null,
    stages: [
      { key: 'import', state: 'done', count: { done: 12431 } },
      { key: 'embed', state: 'done', count: { done: 12431, total: 12431 } },
      { key: 'categorize', state: 'done', count: { done: 12431, total: 12431 } },
      { key: 'cluster', state: 'done', count: { done: 73520 } },
      { key: 'describe', state: 'done' },
      { key: 'measure', state: 'done' },
    ],
  };
})();

// ── The api stub: fixture responses + a full fetch ledger ─────────────────────
// The ledger is the COST half of the proof: the gate asserts which slices the poll
// buys (they must equal C1's popover set), that `evidence` and `keep-awake` are
// bought ONCE per open (never per tick), and that the poll genuinely ticked.
writeFileSync(`${GEN}/api-stub.js`, `
const S = ${JSON.stringify({
  paused: ENV('PAUSED'),
  unknownAfterFirst: ENV('UNKNOWN_AFTER_FIRST'),
  unknownAlways: ENV('UNKNOWN_ALWAYS'),
  modelPull: ENV('MODELPULL'),
  modelPullFailed: ENV('MODELPULL_FAILED'),
  keepAwake: ENV('KEEPAWAKE'),
  onBatt: ENV('ONBATT'),
})};
const PIPELINE_FIXTURE = ${JSON.stringify(PIPELINE_FIXTURE)};
globalThis.__fetches = [];
globalThis.__posts = [];
let readinessReads = 0;
let resumed = false;

const HEALTHY = {
  data: { total: 12431, embedded: 8120, pending: 4311, unprocessable: 210 },
  canGenerate: { ok: true, reason: null },
  tags: { total: 12431, tagged: 6002, pending: 6429 },
  models: {
    embedder: { status: 'ok', message: 'Embedding service is running.', detail: null, model: null, progress: null },
    labeler: S.modelPull
      ? { status: 'downloading', message: 'Downloading qwen3.5:4b…', detail: null, model: 'qwen3.5:4b', progress: { pct: 35 } }
      : { status: 'ok', message: 'Labeling with qwen3.5:4b.', detail: null, model: 'qwen3.5:4b', progress: null },
    enricher: { status: 'no_model', message: 'No enrichment model approved — messages keep their entities and gist unextracted.', detail: null, model: null, progress: null },
    transcriber: { status: 'unknown', message: 'Transcription is not set up.', detail: null, model: null, progress: null },
  },
  ai: { connected: true, activeProvider: 'Claude' },
  mindscape: { generated: true, pointCount: 73520 },
};
// §3.2a degraded shape: every count FAILED. waiting:0 + unknown:true is exactly what the
// server sends (readiness.js processing catch); rendering that 0 is the lie under test.
const DEGRADED = {
  data: { total: 0, embedded: 0, pending: 0, unprocessable: 0 },
  canGenerate: { ok: false, reason: 'unknown' },
  tags: { total: 0, tagged: 0, pending: 0, unknown: true },
  models: HEALTHY.models,
  ai: { connected: false, activeProvider: null, unknown: true },
  mindscape: { generated: false, pointCount: 0, unknown: true },
};

function readinessPayload() {
  readinessReads++;
  const degraded = S.unknownAlways || (S.unknownAfterFirst && readinessReads > 1);
  const base = degraded ? DEGRADED : HEALTHY;
  const paused = S.paused && !resumed;
  return {
    ...base,
    // ON-3: the pipeline slice the vault-health pill reads. A degraded (unknown) poll sends a
    // slice-wide unknown — ingestReadiness HOLDS the last good stages (§3.2a), it must not blank.
    pipeline: degraded ? { unknown: true } : PIPELINE_FIXTURE,
    processing: degraded
      ? { paused, pausedAt: paused ? '2026-07-17T08:30:00.000Z' : null, waiting: 0, unknown: true }
      : { paused, pausedAt: paused ? '2026-07-17T08:30:00.000Z' : null, waiting: 12431 },
  };
}

export async function api(path) {
  const p = String(path);
  globalThis.__fetches.push(p);
  if (p.includes('/portal/readiness') && p.includes('evidence')) {
    return { ok: true, json: async () => ({ evidence: {
      sources: [{ source: 'chatgpt', count: 500 }, { source: 'claude', count: 347 }],
      dateRange: { earliest: '2019-03-04T00:00:00Z', latest: '2026-11-02T00:00:00Z', yearStart: 2019, yearEnd: 2026 },
      conversationCount: 61, peopleCount: 12,
    } }) };
  }
  if (p.includes('/portal/readiness')) return { ok: true, json: async () => readinessPayload() };
  if (p.includes('/system/keep-awake')) {
    return { ok: true, json: async () => ({ ok: true, enabled: true, active: S.keepAwake, onAC: S.onBatt ? false : null, supported: true }) };
  }
  return { ok: true, json: async () => ({}) };
}

export async function apiGet(path) {
  const p = String(path);
  globalThis.__fetches.push(p);
  if (p.includes('/portal/activity')) {
    // A FAILED model-pull sits in recent with status error. The affordance under test:
    // that row alone gets a see-the-model-status pointer, because a content-free feed can only
    // say Failed. A CONTROL non-model-pull error (import) shares the error status but is NOT a
    // dead end (its own surface reports it), so it must get NO pointer.
    const recent = S.modelPullFailed ? [
      { id: 'mp-err', kind: 'model-pull', stage: 'Downloading the labeling model', model: 'qwen3.5:4b',
        process: 'downloading', done: 0, total: 0, remaining: 0, etaSeconds: null, status: 'error',
        stalled: false, startedAt: null, finishedAt: '2026-07-18 12:00:00' },
      { id: 'imp-err', kind: 'import', stage: 'Importing messages', model: null,
        process: null, done: 0, total: 0, remaining: 0, etaSeconds: null, status: 'error',
        stalled: false, startedAt: null, finishedAt: '2026-07-18 12:00:00' },
    ] : [];
    return { active: S.modelPull ? [{
      id: 'mp-1', kind: 'model-pull', stage: 'Downloading the labeling model', model: 'qwen3.5:4b',
      process: 'downloading', done: 1200000000, total: 3400000000, remaining: 2200000000,
      etaSeconds: 600, status: 'running', stalled: false, startedAt: null, finishedAt: null,
    }] : [], recent };
  }
  return {};
}

export async function apiPost(path, body) {
  globalThis.__posts.push(String(path));
  if (String(path).includes('/processing/resume')) resumed = true;
  return {};
}
`);

// ── The REAL activity store (esbuild strips the TS; only $lib/api is rewired) ─
await build({
  entryPoints: ['src/lib/stores/activity.ts'],
  outfile: `${GEN}/activity.js`,
  bundle: false,
  format: 'esm',
  platform: 'browser',
});
let storeJs = readFileSync(`${GEN}/activity.js`, 'utf8')
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`);
writeFileSync(`${GEN}/activity.js`, storeJs);

// ── ON-3: the REAL pipeline store (StatusPopover feeds it via ingestReadiness; the expanded
// <PipelineStatus/> subscribes to it — the SAME singleton, so both must import this ONE built
// file). esbuild strips the TS; only `./api` is redirected. Mirrors mount-pipeline-status.mjs. ─
await build({
  entryPoints: ['src/lib/pipeline.ts'],
  outfile: `${GEN}/pipeline.js`,
  bundle: true, format: 'esm', platform: 'neutral', external: ['svelte/store'],
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') })); } }],
  logLevel: 'silent',
});
// The REAL generate store, for PipelineStatus's REAL fmtSeconds ETA formatting.
await build({
  entryPoints: ['src/lib/generate.ts'],
  outfile: `${GEN}/generate.js`,
  bundle: true, format: 'esm', platform: 'neutral', external: ['svelte/store'],
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') })); } }],
  logLevel: 'silent',
});
// Spies for PipelineStatus's remedy wiring (goto/apiPost/start) — inert here (we don't click the
// expanded detail's buttons; verify:pipeline-status-render owns that), but they must RESOLVE.
writeFileSync(`${GEN}/nav-spy.js`, `export async function goto(u){ globalThis.__posts?.push('goto:'+u); }\n`);
writeFileSync(`${GEN}/generate-spy.js`, `export { fmtSeconds } from './generate.js';\nexport async function start(){}\n`);

// ── PipelineStatus.svelte — the shipped expanded detail, compiled + its four specifiers rewired
// (pipeline → the shared store above; generate/api/navigation → real fmtSeconds + inert spies). ─
// QA9/D-067: PipelineStatus's disclosure is the shared <CollapsibleHeader> — the same pattern this
// very component (the vault-pill) is the origin of. Compiled for REAL, not stubbed: PipelineStatus
// binds to it, and Svelte 5 requires the child to declare that prop `$bindable`.
writeFileSync(
  `${GEN}/CollapsibleHeader.svelte.js`,
  compile(readFileSync(resolve('src/lib/components/mindscape/CollapsibleHeader.svelte'), 'utf8'),
    { generate: 'client', name: 'CollapsibleHeader', css: 'injected' }).js.code,
);

const psSrc = readFileSync('src/lib/components/mindscape/PipelineStatus.svelte', 'utf8');
const psJs = compile(psSrc, { generate: 'client', name: 'PipelineStatus', css: 'injected' }).js.code
  .replace(/from\s+['"]\.\/CollapsibleHeader\.svelte['"]/g, `from './CollapsibleHeader.svelte.js'`)
  .replace(/from\s+['"]\$lib\/pipeline['"]/g, `from './pipeline.js'`)
  .replace(/from\s+['"]\$lib\/generate['"]/g, `from './generate-spy.js'`)
  .replace(/from\s+['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from\s+['"]\$app\/navigation['"]/g, `from './nav-spy.js'`);
writeFileSync(`${GEN}/PipelineStatus.js`, psJs);

// ── The component under test: REAL source, only leaf specifiers rewired ───────
const src = readFileSync('src/lib/components/shell/StatusPopover.svelte', 'utf8');
const out = compile(src, { generate: 'client', name: 'StatusPopover', css: 'injected' });
const js = out.js.code
  .replace(/from ['"]\$lib\/stores\/activity['"]/g, `from './activity.js'`)
  .replace(/from\s+['"]\$lib\/pipeline['"]/g, `from './pipeline.js'`)
  .replace(/from\s+['"]\$lib\/components\/mindscape\/PipelineStatus\.svelte['"]/g, `from './PipelineStatus.js'`)
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`);
// Guard: any $lib/$app specifier we forgot to rewire would silently import an app path in jsdom.
const unresolved = [...js.matchAll(/from\s+['"](\$(?:lib|app)\/[^'"]+)['"]/g)].map((m) => m[1]);
if (unresolved.length) { console.log(JSON.stringify({ ok: false, error: `unrewired specifiers: ${[...new Set(unresolved)].join(', ')}` })); process.exit(0); }
writeFileSync(`${GEN}/Popover.js`, js);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://loopvoid.invalid/' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}

const { mount, unmount, flushSync } = await import('svelte');
const Popover = (await import(pathToFileURL(resolve(GEN, 'Popover.js')).href)).default;

// visible(): the NAMED-AND-INCOMPLETE hiding-mechanism list from mount-generate-render.mjs.
// jsdom does no layout; a pass means "none of these mechanisms hides it", not "a human can
// read it". ⚠️ Deliberately NO -webkit-text-fill-color check — with unresolved CSS vars
// jsdom computes it rgba(0,0,0,0) for EVERY element, redding all good code (the documented
// trap; caught only by running the control).
const D = dom.window.document;
const visible = (el) => {
  const transparent = (c) => /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test((c || '').trim());
  for (let n = el; n && n !== D.body.parentElement; n = n.parentElement) {
    const cs = dom.window.getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    if (cs.fontSize && parseFloat(cs.fontSize) === 0) return false;
    if (n === el && transparent(cs.color)) return false;
  }
  return true;
};
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
// The deepest element carrying the needle — then the visibility walk covers its ancestors.
const carrier = (root, needle) => {
  let best = null;
  for (const el of root.querySelectorAll('*')) {
    if (norm(el.textContent).includes(needle)) best = el; // querySelectorAll is doc order ⇒ last match is deepest-ish
  }
  return best && norm(best.textContent).includes(needle) ? best : null;
};
const seen = (root, needle) => {
  const el = root ? carrier(root, needle) : null;
  return { present: !!el, visible: el ? visible(el) : false };
};

const result = { ok: false };
try {
  const app = mount(Popover, { target: D.getElementById('host'), props: { pollMs: 60 } });
  flushSync();
  await new Promise((r) => setTimeout(r, 40)); // first refresh + evidence + power land
  flushSync();

  const statusEl = () => D.querySelector('[data-testid="status-rows"]');
  const bodyMinusStatus = () => {
    const clone = D.body.cloneNode(true);
    clone.querySelector('[data-testid="status-rows"]')?.remove();
    return norm(clone.textContent);
  };

  result.statusTextAtMount = norm(statusEl()?.textContent);
  result.workingTextAtMount = bodyMinusStatus();
  result.pausedRow = seen(statusEl(), 'Paused by you');
  result.waitingCount = seen(statusEl(), '12,431 messages waiting');
  result.dataRow = seen(statusEl(), '12,431 messages · 2 sources · 2019–2026');
  result.labelingRow = seen(statusEl(), 'Sorting · 6,002 / 12,431 · qwen3.5:4b');
  result.aiRow = seen(statusEl(), 'Claude · connected');
  result.mindscapeRow = seen(statusEl(), 'Generated · 73,520 points');
  result.vaultRow = seen(statusEl(), 'Encrypted · open');
  result.unprocessableRow = seen(statusEl(), "210 couldn’t be processed");
  result.keepAwakeLine = seen(statusEl(), 'Keeping your Mac awake');
  result.onBattLine = seen(statusEl(), 'On battery');
  result.wontUpdateLine = seen(statusEl(), 'Won’t update while processing is paused');
  result.statusButtons = statusEl()
    ? [...statusEl().querySelectorAll('button')].map((b) => norm(b.textContent))
    : [];
  // R4: the pull PERCENT must not appear in the status rows (the feed row owns it) …
  result.statusHasPct = /\d+\s*%/.test(result.statusTextAtMount) || result.statusTextAtMount.includes('35');
  result.downloadingState = seen(statusEl(), 'Downloading qwen3.5:4b');
  // … while the feed row renders the bytes as SIZES.
  result.pullBytes = seen(D.body, '1.2 GB / 3.4 GB');
  result.pullRawBytes = result.workingTextAtMount.includes('1200000000');

  // The failed-model-pull affordance (issue #2): a content-free "Failed" row is a dead end, so
  // the classified reason lives on the model status rows above — the pointer says where. It must
  // render for the model-pull error row and NOT for the CONTROL import error row (which has its
  // own surface). Count the hints: exactly one (the model-pull row), never two.
  result.pullFailedAffordance = seen(D.body, 'See the model status above');
  result.affordanceCount = D.querySelectorAll('[data-testid="modelpull-fault-hint"]').length;
  result.recentErrorRows = norm(bodyMinusStatus()).includes('Failed');

  // ── ON-3: the adaptive vault-health pill (collapsed) ────────────────────────
  const pillEl = () => D.querySelector('[data-testid="vault-pill"]');
  result.pillPresent = !!pillEl();
  result.pillState = pillEl()?.getAttribute('data-state') || null;
  result.pillText = norm(pillEl()?.textContent);
  result.pillVisible = pillEl() ? visible(pillEl()) : false;
  // The pill is the SUMMARY, above and outside the per-service status rows.
  result.pillOutsideStatusRows = !!pillEl() && !statusEl()?.contains(pillEl());
  // Healthy = quiet: NO digits in the pill (ON-3: no persistent stage count when fine).
  result.pillHasDigits = /\d/.test(result.pillText || '');
  // Collapsed until clicked — the detail must not be mounted yet.
  result.pillDetailBeforeClick = !!D.querySelector('[data-testid="vault-pill-detail"]');

  // Let the poll tick a few times (pollMs=60 ⇒ ≥3 ticks in 250ms).
  await new Promise((r) => setTimeout(r, 250));
  flushSync();
  result.statusTextAfterTicks = norm(statusEl()?.textContent);
  result.waitingCountAfter = seen(statusEl(), '12,431 messages waiting');
  result.aiRowAfter = seen(statusEl(), 'Claude · connected');
  result.mindscapeRowAfter = seen(statusEl(), 'Generated · 73,520 points');
  result.dataRowAfter = seen(statusEl(), '12,431 messages');
  result.zeroWaiting = norm(statusEl()?.textContent || '').includes('0 messages waiting');

  if (ENV('CLICK_RESUME')) {
    const btn = statusEl() && [...statusEl().querySelectorAll('button')].find((b) => norm(b.textContent) === 'Resume');
    result.resumeFound = !!btn;
    if (btn) {
      btn.click();
      flushSync();
      await new Promise((r) => setTimeout(r, 40));
      flushSync();
      result.resumePosts = globalThis.__posts.filter((p) => p.includes('/processing/resume')).length;
      result.pausedRowAfterResume = seen(statusEl(), 'Paused by you');
    }
  }

  // The fetch ledger — the client half of the cost contract.
  const F = globalThis.__fetches;
  result.readinessPollUrls = F.filter((p) => p.includes('/portal/readiness') && !p.includes('evidence'));
  result.evidenceFetches = F.filter((p) => p.includes('/portal/readiness') && p.includes('evidence')).length;
  result.keepAwakeFetches = F.filter((p) => p.includes('/system/keep-awake')).length;

  // ── ON-3: clicking the pill expands the SHIPPED PipelineStatus (its .pipe root + ordered
  // stages + inline remedy) — proven by MOUNTING it, not grepping. Done AFTER the fetch ledger
  // read so it cannot perturb the cost assertions; PipelineStatus is a pure subscriber (no fetch).
  const pill = pillEl();
  if (pill) {
    // ⭐ ON-3c COST measurement — count ONLY the fetches the expand itself triggers, deterministic
    // under CI contention. Background async here (the setInterval(refresh, pollMs) poll, the
    // activity-store poll, an in-flight refresh's continuation) all push to __fetches when they run
    // — but a JS timer callback or promise continuation fires ONLY when we yield to the event loop.
    // A measurement window that contains NO `await` therefore cannot admit a background poll tick,
    // so nothing unrelated can be miscounted (the flake: the old window straddled a setTimeout, and
    // under load a 60ms poll tick landed inside it → expandAddedFetches spuriously 1+).
    //
    // The api stub pushes to __fetches SYNCHRONOUSLY at fetch initiation (api-stub.js first line), so
    // a fetch the expand genuinely fires — in the click handler or in a flushSync-driven mount effect
    // (e.g. a regression where PipelineStatus fetches its own data in onMount instead of subscribing)
    // — still lands in __fetches during the synchronous click+flushSync. Teeth intact: measure across
    // the synchronous expand work ONLY, THEN yield for the detail's render assertions.
    const fetchesBefore = globalThis.__fetches.length;
    pill.click();
    flushSync();
    // Expanding must not fire a network read — the detail rides the already-fed store. Snapshot the
    // delta HERE, before any await, so only expand-caused fetches are in scope.
    result.expandAddedFetches = globalThis.__fetches.length - fetchesBefore;
    // Now it is safe to yield: a background poll tick after this point cannot perturb the count above.
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    const detail = D.querySelector('[data-testid="vault-pill-detail"]');
    result.pillDetailAfterClick = !!detail;
    result.pillDetailHasPipeRoot = !!detail?.querySelector('.pipe');
    result.pillDetailStageKeys = detail ? [...detail.querySelectorAll('.pipe-stage')].map((li) => li.getAttribute('data-key')) : [];
    result.pillDetailText = norm(detail?.textContent);
    result.pillDetailHasRemedy = !!detail?.querySelector('button.pipe-action');
  }

  unmount(app);
  result.ok = true;
} catch (e) {
  result.error = String(e?.stack || e);
}
console.log(JSON.stringify(result));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
