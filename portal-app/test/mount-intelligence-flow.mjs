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

// ── The REAL server composition over a fixture DAL (zero wire drift) ─────────────────────
const { composeBundle } = await import('../../src/portal-intelligence.js');
const { INTELLIGENCE_FUNCTIONS } = await import('../../src/inference/role-models.js');

const EU_ROW = { id: 1, provider: 'custom', label: 'Regolo (EU)', base_url: 'https://api.regolo.ai/v1', is_active: 1, jurisdiction: 'eu-zdr' };
const SUB_ROW = { id: 5, provider: 'anthropic', label: 'Claude subscription', auth_type: 'oauth', base_url: null, is_active: 0, jurisdiction: 'us-standard' };
const RETURNING = PROBE === 'returning' || PROBE === 'fault';
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
  if (path.startsWith('/portal/settings/tts')) return { ok: true, json: async () => ({ enabled: false, provider: null, qwen: { model: { phase: 'absent', progress: 0 } } }) };
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
    .replace(/from\s+['"]\$lib\/stores\/sensitive-exempt\.svelte['"]/, `from './sensitive-exempt.gen.js'`);
  writeFileSync(`${GEN}/${name}.gen.js`, rewired);
};
for (const stub of ['AISettings', 'VoiceSection', 'EngineSelector']) {
  genSvelte(`Stub${stub}`, `<div data-stub="${stub}"></div>`);
}
genSvelte('OnboxTaskSelect', readFileSync(SELECT, 'utf8'));
genSvelte('TranscriptionSetup', readFileSync(TRANS, 'utf8'));
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
    assignmentMounted: !!D.querySelector('#assignment'),
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
  };

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

  // Drive Customize open (A10's second half: the machinery appears on demand).
  let customize = null;
  const custBtn = [...D.querySelectorAll('button')].find((b) => /Customize/.test(b.textContent));
  if (custBtn) {
    custBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await wait(80);
    flushSync();
    customize = {
      aiSettingsMounted: !!D.querySelector('[data-stub="AISettings"]'),
      voiceMounted: !!D.querySelector('[data-stub="VoiceSection"]'),
      engineMounted: !!D.querySelector('[data-stub="EngineSelector"]'),
      assignmentMounted: !!D.querySelector('#assignment'),
      screenRendered: !!D.querySelector('#assignment .intel'),
      order: [...D.querySelectorAll('.cust-sec')].map((s) => s.id),
      liveSameElement: liveRegions()[0] === liveEl,
    };
  }

  emit({ ok: true, probe: PROBE || 'cold', before, afterConfirm, gapClick, customize });
  process.exit(0);   // the flow's 4s models poll would otherwise keep node alive forever
} catch (e) {
  emit({ ok: false, probe: PROBE || 'cold', error: String(e?.stack || e) });
  process.exit(0);
}
