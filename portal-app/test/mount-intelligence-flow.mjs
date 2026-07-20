// Mounts IntelligenceFlow.svelte for REAL — real compiler, real jsdom, real clicks — and
// prints one JSON line for scripts/verify-intelligence-flow.mjs.
//
// The bundle the stub serves is produced by the REAL composeBundle (src/portal-intelligence.js)
// over a fixture DAL — never a hand-shaped mirror of the wire: a mirror is how a fixture pins
// yesterday's shape while the route moves on (the drift class the repo's gate notes name).
//
// CHILDREN: IntelligenceScreen + OnboxTaskSelect + TranscriptionSetup compile REAL (they are
// the assignment surface — A10 asserts on the genuine article). AISettings / VoiceSection /
// EngineSelector compile as MARKER STUBS: this harness asserts WHERE they mount (behind the
// closed disclosure), not what they do — their own behaviour is gated elsewhere
// (verify-model-consent, verify-tts-voice, mount-ai-settings.mjs for A3).
//
// Probes (env PROBE):
//   (default)   cold vault → STATE A; drive the confirm end-to-end → flips to B
//   returning   configured vault → STATE B summary + gap-fill (2 functions missing)
//   fault       a member is DOWN → the needs-you line carries a control (A8)
//   disklow     the bundle cannot fit → confirm disabled + "free up N GB" (W4)
//   readfail    the providers read FAILS on a cold vault → NO first-run card (emptiness must
//               be a verified fact, never a failed read — the onboarding-status lesson)
//
// Run with: node --conditions browser portal-app/test/mount-intelligence-flow.mjs (cwd=portal-app)
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-flow';
const FLOW = 'src/lib/components/settings/IntelligenceFlow.svelte';
const SCREEN = 'src/lib/components/settings/IntelligenceScreen.svelte';
const SELECT = 'src/lib/components/settings/OnboxTaskSelect.svelte';
const TRANS = 'src/lib/components/settings/TranscriptionSetup.svelte';

const PROBE = process.env.PROBE || '';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Auto-open canary: status/refresh logic must NEVER open a browser window (a live bug
// elsewhere is ~5 unprompted sign-in windows; this pane must not be able to contribute).
let windowOpens = 0;
dom.window.open = () => { windowOpens++; return null; };

// ── The REAL server composition over a fixture DAL (zero wire drift) ─────────────────────
const { composeBundle } = await import('../../src/portal-intelligence.js');
const { INTELLIGENCE_FUNCTIONS } = await import('../../src/inference/role-models.js');

const EU_ROW = { id: 1, provider: 'custom', label: 'Regolo (EU)', base_url: 'https://api.regolo.ai/v1', is_active: 1, jurisdiction: 'eu-zdr' };
const SUB_ROW = { id: 5, provider: 'anthropic', label: 'Claude subscription', auth_type: 'oauth', base_url: null, is_active: 0, jurisdiction: 'us-standard' };
// ── subscription auth-VALIDITY probes (the "connected must mean VALID" fix, 2026-07-18) ──
// Each mounts the RETURNING vault (subscription connected + assigned to chat) with a fixed
// per-surface validity from the status stub:
//   sub-split    native dead, cli alive — the LIVE mismatch ("token shows dead, chat works"):
//                the row must say BOTH truths, and the needs-line must carry Refresh now +
//                Reconnect (and never auto-open anything).
//   sub-ok       positive native evidence — the one state allowed to render green.
//   sub-unknown  zero evidence — MUTED, no green claim, no scare copy (fail-closed neutral).
const SUBV = {
  'sub-split': { native: 'needs_reconnect', cli: 'ok' },
  'sub-ok': { native: 'ok', cli: 'unknown' },
  'sub-unknown': { native: 'unknown', cli: 'unknown' },
}[PROBE] || null;
const RETURNING = PROBE === 'returning' || PROBE === 'fault' || PROBE === 'voice-sample' || PROBE === 'voice-error' || PROBE === 'voice-needs-runtime' || PROBE === 'embedder-absent' || Boolean(SUBV);
// The returning vault: Understanding + Conversation set; transcription + descriptions NOT —
// the exact ≥2-gap shape W6's gap-fill exists for.
const SETTINGS = RETURNING
  ? { taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' }, chat: { providerId: 5 } } }
  : {};
const PROVIDERS = RETURNING ? [SUB_ROW] : [];
const fixtureDb = {
  users: { getSettings: async () => structuredClone(SETTINGS) },
  providers: { list: async () => PROVIDERS, get: async (id) => PROVIDERS.find((p) => p.id === id) || null },
};
const HW = async () => ({ cpuName: 'Apple M1', arch: 'arm64', platform: 'darwin', totalRamGb: 16, hasGpu: true, backend: 'metal' });
const DISK = PROBE === 'disklow'
  ? () => ({ ok: true, freeBytes: 4 * 2 ** 30, needBytes: 3 * 2 ** 30, vaultBytes: 0, freeGb: 4, needGb: 3 })
  : () => ({ ok: true, freeBytes: 48 * 2 ** 30, needBytes: 3 * 2 ** 30, vaultBytes: 0, freeGb: 48, needGb: 3 });
const bundleWire = async () => ({
  ok: true,
  ...(await composeBundle({ db: fixtureDb, userId: 'u', detect: HW, listInstalled: async () => (RETURNING ? ['qwen3.5:4b'] : []), dbPath: '/x/vault.db', headroom: DISK })),
});

// ── the recording api stub ────────────────────────────────────────────────────────────────
const sent = [];    // every POST/PUT the flow makes
let applied = false; // flips the fixture to "configured" after the confirm — the A→B fact
globalThis.__apiStub = async (path, options = {}) => {
  const method = options.method || 'GET';
  if (method !== 'GET') sent.push({ path, method, body: options.body ? JSON.parse(options.body) : null });

  if (path.startsWith('/portal/intelligence/bundle/apply')) {
    applied = true;
    return { ok: true, json: async () => ({ ok: true,
      results: { understanding: 'approved', transcription: 'download-required', descriptions: 'skipped:no-provider' },
      downloads: [
        { key: 'understanding', model: 'qwen3.5:4b', route: '/portal/hardware/pull' },
        { key: 'transcription', model: 'large-v3-turbo', route: '/portal/transcription/download' },
      ] }) };
  }
  if (path.startsWith('/portal/intelligence/bundle')) return { ok: true, json: async () => bundleWire() };
  if (path.startsWith('/portal/hardware/pull')) {
    // A minimal real SSE body: one progress tick, then done — enough to prove the flow READS
    // the stream it opened (the tap must deliver, not merely fire-and-forget).
    const enc = new TextEncoder();
    const chunks = ['data: {"status":"downloading","completed":50,"total":100}\n', 'data: {"done":true,"ok":true}\n', 'data: [DONE]\n'];
    let i = 0;
    return { ok: true, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) } };
  }
  if (path.startsWith('/portal/transcription/download')) return { ok: true, json: async () => ({ ok: true }) };
  if (path.startsWith('/portal/transcription/status')) {
    return { ok: true, json: async () => ({ ok: true, health: { status: 'no_model', message: null, progress: null }, model: null, catalog: [
      { model: 'large-v3-turbo', label: 'Whisper large-v3 turbo', sizeMB: 1620, blurb: 'Best quality', recommended: true },
      { model: 'small', label: 'Whisper small', sizeMB: 480, blurb: 'Light and fast', recommended: false },
    ] }) };
  }
  if (path.startsWith('/portal/settings/tts/qwen/download')) return { ok: true, json: async () => ({ phase: 'downloading', progress: 1 }) };
  if (path.startsWith('/portal/settings/tts')) {
    // voice-sample: the model is DOWNLOADED but has no reference sample, so it cannot speak
    // (§2.2/§5). The panel must read this as an actionable warning, never a false "ready".
    const qwen = PROBE === 'voice-sample'
      ? { enabled: true, samplePending: true, model: { phase: 'ready', progress: 100 } }
      : PROBE === 'voice-error'
      ? { model: { phase: 'error', progress: 0, error: 'download failed' } }   // a FAILED download → retry
      : PROBE === 'voice-needs-runtime'
      // Model files downloaded, but the on-device runtime (mlx-audio) isn't installed yet. A
      // DIFFERENT blocker from a missing sample — recording a sample cannot fix it. The panel
      // must offer "Finish install" (the tts download route), NOT route to the character page.
      ? { model: { phase: 'needs-runtime', progress: 100 } }
      : { model: { phase: 'absent', progress: 0 } };
    return { ok: true, json: async () => ({ enabled: false, provider: null, qwen }) };
  }
  // Specific auth/claude paths (distinct prefixes; status must never claim validity the
  // probe did not configure — the default {} leaves subValidity null = no claim).
  if (path.startsWith('/portal/auth/claude/refresh')) {
    // The driven refresh FAILS: outcome 'unavailable', validity unchanged — the UI must
    // escalate to the reconnect ladder, never claim success, never open a window.
    return { ok: true, json: async () => ({ ok: true, outcome: 'unavailable', validity: SUBV || { native: 'needs_reconnect', cli: 'unknown' } }) };
  }
  if (path.startsWith('/portal/auth/claude/status')) {
    if (SUBV) return { ok: true, json: async () => ({ ok: true, authenticated: true, health: 'connected', providerId: 5, account: null, model: null, validity: SUBV }) };
    return { ok: true, json: async () => ({ ok: true }) };   // no validity ⇒ the UI holds null (no green claim)
  }
  if (path.startsWith('/portal/providers/sensitive-subscription')) return { ok: true, json: async () => ({ allowed: false }) };
  if (path.startsWith('/portal/providers/presets')) return { ok: true, json: async () => ({ functions: INTELLIGENCE_FUNCTIONS, presets: [], roleRecommendations: {} }) };
  if (path.startsWith('/portal/providers/task-models')) {
    const tm = applied
      ? { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } }
      : (SETTINGS.taskModels || {});
    return { ok: true, json: async () => ({ taskModels: tm }) };
  }
  if (path.startsWith('/portal/providers')) {
    if (PROBE === 'readfail') return { ok: false, status: 500, json: async () => ({ ok: false }) };
    return { ok: true, json: async () => ({ providers: PROVIDERS }) };
  }
  if (path.startsWith('/portal/readiness')) {
    const models = PROBE === 'fault'
      ? { labeler: { status: 'down', message: 'The labeling engine keeps stopping.', model: 'qwen3.5:4b', progress: null }, enricher: { status: 'ok', message: 'Ready.', model: 'qwen3.5:4b', progress: null }, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null }, transcriber: { status: 'no_model', message: null, model: null, progress: null } }
      // embedder-absent: the readiness poll has not resolved the embedder (or an outage holds {}).
      // The panel must NOT fabricate a green "Included" — it renders the honest idle absence.
      : PROBE === 'embedder-absent'
      ? { labeler: { status: 'ok', message: 'Labeling with qwen3.5:4b.', model: 'qwen3.5:4b', progress: null }, enricher: { status: 'ok', message: 'Ready.', model: 'qwen3.5:4b', progress: null }, transcriber: { status: 'no_model', message: null, model: null, progress: null } }
      : RETURNING
        ? { labeler: { status: 'ok', message: 'Labeling with qwen3.5:4b.', model: 'qwen3.5:4b', progress: null }, enricher: { status: 'ok', message: 'Ready.', model: 'qwen3.5:4b', progress: null }, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null }, transcriber: { status: 'no_model', message: null, model: null, progress: null } }
        : { labeler: { status: 'no_model', message: null, model: null, progress: null }, enricher: { status: 'no_model', message: null, model: null, progress: null }, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null }, transcriber: { status: 'no_model', message: null, model: null, progress: null } };
    return { ok: true, json: async () => ({ models }) };
  }
  return { ok: true, json: async () => ({}) };
};

// ── compile the tree ──────────────────────────────────────────────────────────────────────
mkdirSync(GEN, { recursive: true });
const storeSrc = readFileSync('src/lib/stores/sensitive-exempt.svelte.ts', 'utf8')
  .replace(/:\s*boolean/g, '').replace(/export function setSensitiveExempt\(allowed\)/, 'export function setSensitiveExempt(allowed)');
const storeOut = compileModule(storeSrc, { generate: 'client', filename: 'sensitive-exempt.svelte.ts' });
writeFileSync(`${GEN}/sensitive-exempt.gen.js`, storeOut.js.code);

// A lightweight workspace-store stub: IntelligenceFlow only uses workspace.openFromRoute (the
// 'add-sample' voice routing, R2-VOICEBTN). Record each call so the verifier can prove the
// button ROUTES to the character page (and doesn't drag in the real store's dependency tree).
globalThis.__wsRoutes = [];
writeFileSync(`${GEN}/workspace-store.gen.js`,
  'export const workspace = { openFromRoute: (viewId, params) => { (globalThis.__wsRoutes ||= []).push({ viewId, params }); } };\n');

const genSvelte = (name, source) => {
  const out = compile(source, { generate: 'client', name, css: 'injected' });
  const rewired = out.js.code
    .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);')
    .replace(/from\s+['"]\.\/OnboxTaskSelect\.svelte['"]/, `from './OnboxTaskSelect.gen.js'`)
    .replace(/from\s+['"]\.\/TranscriptionSetup\.svelte['"]/, `from './TranscriptionSetup.gen.js'`)
    .replace(/from\s+['"]\.\/IntelligenceScreen\.svelte['"]/, `from './IntelligenceScreen.gen.js'`)
    .replace(/from\s+['"]\.\/AISettings\.svelte['"]/, `from './StubAISettings.gen.js'`)
    .replace(/from\s+['"]\.\/VoiceSection\.svelte['"]/, `from './StubVoiceSection.gen.js'`)
    .replace(/from\s+['"]\.\/EngineSelector\.svelte['"]/, `from './StubEngineSelector.gen.js'`)
    // The unified On-device models panel + its ModelHealth renderer compile REAL — the panel is
    // the operator's "one place" surface, asserted on the genuine article (odmRows below).
    .replace(/from\s+['"]\.\/OnDeviceModels\.svelte['"]/, `from './OnDeviceModels.gen.js'`)
    .replace(/from\s+['"]\.\/ModelHealth\.svelte['"]/, `from './ModelHealth.gen.js'`)
    .replace(/from\s+['"]\$lib\/stores\/sensitive-exempt\.svelte['"]/, `from './sensitive-exempt.gen.js'`)
    .replace(/from\s+['"]\$lib\/workspace\/store['"]/, `from './workspace-store.gen.js'`);
  writeFileSync(`${GEN}/${name}.gen.js`, rewired);
};
for (const stub of ['AISettings', 'VoiceSection', 'EngineSelector']) {
  genSvelte(`Stub${stub}`, `<div data-stub="${stub}"></div>`);
}
genSvelte('OnboxTaskSelect', readFileSync(SELECT, 'utf8'));
genSvelte('TranscriptionSetup', readFileSync(TRANS, 'utf8'));
genSvelte('ModelHealth', readFileSync('src/lib/components/settings/ModelHealth.svelte', 'utf8'));
genSvelte('OnDeviceModels', readFileSync('src/lib/components/settings/OnDeviceModels.svelte', 'utf8'));
genSvelte('IntelligenceScreen', readFileSync(SCREEN, 'utf8'));
genSvelte('IntelligenceFlow', readFileSync(FLOW, 'utf8'));

const emit = (o) => console.log(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const { default: Flow } = await import(pathToFileURL(resolve(GEN, 'IntelligenceFlow.gen.js')).href);
  const { mount, flushSync } = await import('svelte');
  mount(Flow, { target: dom.window.document.getElementById('host') });
  flushSync();
  await wait(80);
  flushSync();

  const D = dom.window.document;
  const text = () => D.body.textContent.replace(/\s+/g, ' ');
  const stateEl = () => D.querySelector('section[data-state]');
  const liveRegions = () => [...D.querySelectorAll('[aria-live]')];

  // The persistent live region — captured by IDENTITY before any state change (A9).
  const liveBefore = liveRegions();
  const liveEl = liveBefore[0] || null;

  const before = {
    state: stateEl()?.getAttribute('data-state') ?? null,
    statesRendered: [...D.querySelectorAll('section[data-state]')].map((s) => s.getAttribute('data-state')),
    text: text(),
    liveRegionCount: liveBefore.length,
    liveText: liveEl?.textContent ?? null,
    // A10: the machinery must NOT be simultaneously visible.
    aiSettingsMounted: !!D.querySelector('[data-stub="AISettings"]'),
    engineMounted: !!D.querySelector('[data-stub="EngineSelector"]'),
    assignmentMounted: !!D.querySelector('.cust-panel .intel'),
    // W5: no pre-consent checkmarks inside the STATE A card.
    cardHasCheckmark: /✓/.test(stateEl()?.textContent || ''),
    confirmLabel: [...D.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => /Set everything up/.test(t)) ?? null,
    confirmDisabled: [...D.querySelectorAll('button')].find((b) => /Set everything up/.test(b.textContent))?.disabled ?? null,
    hasConnectChip: /Converse — connect your Claude account/.test(text()),
    hasVoiceLater: /Give it a voice — after setup, on the character page/.test(text()),
    voiceIsBundleRow: /Speak.*2\.9|Qwen3-TTS.*GB/.test(stateEl()?.querySelector('.rows')?.textContent || ''),
    freeDiskLine: (text().match(/You have ([\d.]+) GB free/) || [])[1] ?? null,
    diskWarn: (text().match(/free up ([\d.]+) GB/i) || [])[1] ?? null,
    rowsText: stateEl()?.querySelector('.rows')?.textContent.replace(/\s+/g, ' ') ?? '',
    needsLine: (text().match(/1 thing needs you[^.]*\./) || [])[0] ?? null,
    gapButton: [...D.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => /Finish setting up/.test(t)) ?? null,
    faultHasControl: !!(D.querySelector('.needs .quiet, .needs.bad-line .quiet')),
    dotClasses: [...D.querySelectorAll('.srow')].map((r) => ({ label: r.querySelector('.slabel')?.textContent, cls: [...(r.querySelector('.dot')?.classList || [])].filter((c) => c !== 'dot')[0] ?? null })),
    // The unified On-device models panel — one row per local model (the operator's "one place").
    // Read the REAL rendered rows: key, its ModelHealth status text, whether a Download button is
    // offered, and any 'blocked' note. This is the genuine article (real ModelHealth mounted).
    odmRows: [...D.querySelectorAll('[data-testid="odm-row"]')].map((r) => ({
      key: r.getAttribute('data-key'),
      label: r.querySelector('.odm-label')?.textContent?.trim() ?? null,
      statusText: r.querySelector('.odm-status')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      okDot: !!r.querySelector('.mh-dot.ok'),
      warnDot: !!r.querySelector('.mh-dot.warn'),
      badDot: !!r.querySelector('.mh-dot.bad'),
      size: r.querySelector('.odm-size')?.textContent?.trim() ?? null,
      hasDownload: !!r.querySelector('[data-testid="odm-download"]'),
      downloadText: r.querySelector('[data-testid="odm-download"]')?.textContent?.trim() ?? null,
      hasAddSample: !!r.querySelector('[data-testid="odm-add-sample"]'),
      addSampleText: r.querySelector('[data-testid="odm-add-sample"]')?.textContent?.trim() ?? null,
      blocked: r.querySelector('[data-testid="odm-blocked"]')?.textContent?.trim() ?? null,
    })),
    odmPresent: !!D.querySelector('section.odm'),
  };

  // ── the validity probes: read the Conversation row's rendered truth, drive Refresh now ──
  let subProbe = null;
  if (SUBV) {
    const convRow = () => [...D.querySelectorAll('.srow')].find((r) => /Conversation/.test(r.querySelector('.slabel')?.textContent || ''));
    const conv = convRow();
    const refreshBtn = [...D.querySelectorAll('button')].find((b) => /Refresh now/.test(b.textContent));
    const reconnectBtn = [...D.querySelectorAll('button')].find((b) => /^Reconnect\b/.test(b.textContent.trim()));
    const snapshot = {
      what: conv?.querySelector('.swhat')?.textContent.trim() ?? null,
      dot: [...(conv?.querySelector('.dot')?.classList || [])].filter((c) => c !== 'dot')[0] ?? null,
      needsLine: (text().match(/1 thing needs you[^.]*\./) || [])[0] ?? null,
      hasRefreshBtn: !!refreshBtn,
      hasReconnectBtn: !!reconnectBtn,
    };
    let afterRefresh = null;
    if (refreshBtn) {
      const beforeSent = sent.length;
      refreshBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      flushSync();
      await wait(80);
      flushSync();
      afterRefresh = {
        escalation: /Refresh didn’t help/.test(text()),
        refreshPosts: sent.slice(beforeSent).filter((s) => s.path.startsWith('/portal/auth/claude/refresh')).map((s) => s.method),
        stillBad: [...(convRow()?.querySelector('.dot')?.classList || [])].includes('bad'),
      };
    }
    subProbe = { ...snapshot, afterRefresh, windowOpens };
  }

  let afterConfirm = null;
  const confirmBtn = [...D.querySelectorAll('button')].find((b) => /Set everything up/.test(b.textContent));
  if (confirmBtn && !confirmBtn.disabled && !PROBE) {
    confirmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await wait(120);
    flushSync();
    afterConfirm = {
      state: stateEl()?.getAttribute('data-state') ?? null,
      statesRendered: [...D.querySelectorAll('section[data-state]')].map((s) => s.getAttribute('data-state')),
      sent: sent.map((s) => ({ path: s.path, body: s.body })),
      // A9: SAME element (never re-inserted), text now non-empty.
      liveSameElement: liveRegions()[0] === liveEl,
      liveRegionCount: liveRegions().length,
      liveText: liveEl?.textContent ?? null,
    };
  }

  let gapClick = null;
  const gapBtn = [...D.querySelectorAll('button')].find((b) => /Finish setting up/.test(b.textContent));
  if (gapBtn && PROBE === 'returning') {
    const beforeLen = sent.length;
    gapBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await wait(120);
    flushSync();
    gapClick = { sent: sent.slice(beforeLen).map((s) => ({ path: s.path, body: s.body })) };
  }

  // The panel's per-model Download action routes to the model's own download path. Drive the
  // VOICE row's button (absent in the returning fixture ⇒ a Download is offered) and confirm it
  // POSTs the tts route — never a new/forked download path.
  let odmDownload = null;
  if (PROBE === 'returning') {
    const voiceRow = [...D.querySelectorAll('[data-testid="odm-row"]')].find((r) => r.getAttribute('data-key') === 'voice');
    const btn = voiceRow?.querySelector('[data-testid="odm-download"]');
    if (btn) {
      const beforeLen = sent.length;
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      flushSync();
      await wait(80);
      flushSync();
      odmDownload = { sent: sent.slice(beforeLen).map((s) => ({ path: s.path, method: s.method })) };
    }
  }

  // R2-VOICEBTN: on the voice-sample probe (downloaded-but-mute), the voice row must offer a
  // CLICKABLE 'Add a voice sample' button that ROUTES to the character page — not a dead note.
  // Drive it and capture the recorded openFromRoute call.
  let odmSample = null;
  if (PROBE === 'voice-sample') {
    globalThis.__wsRoutes = [];
    const voiceRow = [...D.querySelectorAll('[data-testid="odm-row"]')].find((r) => r.getAttribute('data-key') === 'voice');
    const btn = voiceRow?.querySelector('[data-testid="odm-add-sample"]');
    if (btn) {
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      flushSync();
      await wait(20);
    }
    odmSample = { hadButton: !!btn, routes: (globalThis.__wsRoutes || []).slice() };
  }

  // R2-VOICEBTN review: a needs-runtime voice (files downloaded, mlx-audio not installed) is a
  // DIFFERENT blocker — it must offer "Finish install" (the tts download route), NEVER route to
  // the character page (which has no runtime-install path). Drive the voice button and confirm it
  // POSTs the tts route AND records ZERO character routes.
  let odmRuntime = null;
  if (PROBE === 'voice-needs-runtime') {
    globalThis.__wsRoutes = [];
    const voiceRow = [...D.querySelectorAll('[data-testid="odm-row"]')].find((r) => r.getAttribute('data-key') === 'voice');
    const dlBtn = voiceRow?.querySelector('[data-testid="odm-download"]');
    const sampleBtn = voiceRow?.querySelector('[data-testid="odm-add-sample"]');
    const beforeLen = sent.length;
    if (dlBtn) {
      dlBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      flushSync();
      await wait(80);
      flushSync();
    }
    odmRuntime = {
      hadDownload: !!dlBtn, hadAddSample: !!sampleBtn,
      sent: sent.slice(beforeLen).map((s) => ({ path: s.path, method: s.method })),
      routes: (globalThis.__wsRoutes || []).slice(),
    };
  }

  // Drive Customize open (A10's second half: the machinery appears on demand). It is a SEGMENTED
  // nav now — TWO tabs (2026-07-19): Functions and Providers. Voice + Engine folded INTO the
  // Functions surface (IntelligenceScreen owns them), so on the default Functions tab the real
  // screen (`.intel`) AND the Voice/Engine stubs are present; Providers is behind its own tab.
  let customize = null;
  const clickTab = (label) => {
    const b = [...D.querySelectorAll('.cust-nav .cust-tab')].find((x) => x.textContent.trim() === label);
    if (b) { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); flushSync(); }
    return !!b;
  };
  const custBtn = [...D.querySelectorAll('button')].find((b) => /Customize/.test(b.textContent));
  if (custBtn) {
    custBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await wait(80);
    flushSync();
    // Default tab = Functions: the REAL IntelligenceScreen (`.intel`) mounts, WITH Voice + Engine
    // folded in (their stubs present), and Providers (AISettings) does NOT.
    const defaultTab = {
      assignment: !!D.querySelector('.cust-panel .intel'),
      voice: !!D.querySelector('[data-stub="VoiceSection"]'),     // folded into the Voice row
      engine: !!D.querySelector('[data-stub="EngineSelector"]'),  // folded into the Conversation row
      aiSettings: !!D.querySelector('[data-stub="AISettings"]'),
    };
    clickTab('Providers');
    await wait(20); flushSync();
    const providersTab = {
      aiSettings: !!D.querySelector('[data-stub="AISettings"]'),
      assignment: !!D.querySelector('.cust-panel .intel'),   // the Functions panel is GONE
    };
    customize = {
      navTabs: [...D.querySelectorAll('.cust-nav .cust-tab')].map((b) => b.textContent.trim()),
      screenRendered: defaultTab.assignment,
      defaultTab, providersTab,
      liveSameElement: liveRegions()[0] === liveEl,
    };
  }

  emit({ ok: true, probe: PROBE || 'cold', before, afterConfirm, gapClick, customize, subProbe, odmDownload, odmSample, odmRuntime, windowOpens });
  process.exit(0);   // the flow's 4s models poll would otherwise keep node alive forever
} catch (e) {
  emit({ ok: false, probe: PROBE || 'cold', error: String(e?.stack || e) });
  process.exit(0);
}
