// Mounts the REAL (demoted) AISettings.svelte — the A3 evidence: after the Intelligence
// restructure, NO component other than IntelligenceScreen may carry a task-model control in
// the Intelligence pane. A source grep can be satisfied by a comment (proven twice in this
// repo); only the mounted DOM tells the truth. The stubbed api RECORDS every write, so the
// gate can also assert the component never touches /portal/providers/task-models.
//
// Run with: node --conditions browser portal-app/test/mount-ai-settings.mjs (cwd=portal-app)
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-aisettings';
const SRC = 'src/lib/components/settings/AISettings.svelte';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── D-074 probes: the subscription model picker ──────────────────────────────────────────────
// The default probe has NO subscription, so the picker does not render (F11 asserts exactly
// that). These two mount it with one connected and pin the picker's source of truth:
//
//   PROBE=sub        the provider answered — the options must BE that answer. The fixture
//                    deliberately contains an id no roster in this repo has ever held
//                    ('claude-opus-5') and OMITS every id the deleted CLAUDE_SUB_MODELS array
//                    carried, so a component that still merges a literal list is visible.
//   PROBE=sub-stale  the provider could NOT be listed (auth_rejected) and the server fell back
//                    to the dated MODEL_REGISTRY floor. The picker must still work AND must say
//                    the list is not current — a stale list rendered as live is the defect.
const SUB = process.env.PROBE === 'sub' || process.env.PROBE === 'sub-stale';
const SUB_STALE = process.env.PROBE === 'sub-stale';
const SUB_ID = 9;
// `defaultModel` is what the SERVER says runs when model_preference is empty (the route reads
// src/agent/harness.js). The picker's "default" option must NAME it rather than assert a
// plan-derived default it cannot know — see F25e.
const LIVE_MODELS = { ok: true, models: ['claude-opus-5', 'claude-sonnet-4-6'], source: 'live', stale: false, fetchedAt: 1, error: null, defaultModel: 'claude-opus-4-8' };
const STALE_MODELS = { ok: false, models: ['claude-opus-4-8', 'claude-haiku-4-5'], source: 'fallback', stale: true, fetchedAt: null, error: 'auth_rejected', defaultModel: 'claude-opus-4-8' };

const calls = [];   // EVERY api call — reads and writes
globalThis.__apiStub = async (path, options = {}) => {
  calls.push({ path, method: options.method || 'GET' });
  if (SUB && /^\/portal\/providers\/\d+\/models/.test(path)) {
    return { ok: true, json: async () => (SUB_STALE ? STALE_MODELS : LIVE_MODELS) };
  }
  if (path.startsWith('/portal/providers/presets')) {
    return { ok: true, json: async () => ({ presets: [
      { id: 'regolo', label: 'Regolo', kind: 'openai', baseUrl: 'https://api.regolo.ai/v1', jurisdiction: 'eu-zdr', defaultModel: 'llama' },
      { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', jurisdiction: 'us-standard', defaultModel: 'gpt' },
    ], roleRecommendations: { labeling: { model: 'qwen3.5:4b' }, descriptions: { presetId: 'regolo' } } }) };
  }
  if (path.startsWith('/portal/providers/sensitive-subscription')) return { ok: true, json: async () => ({ ok: true, allowed: false }) };
  if (path.startsWith('/portal/providers/web-search')) return { ok: true, json: async () => ({ ok: true, enabled: true }) };
  if (path.startsWith('/portal/auth/claude/status')) {
    return { ok: true, json: async () => (SUB
      ? { ok: true, authenticated: true, providerId: SUB_ID, health: 'connected', account: { email: 'owner@example.test' }, source: 'keychain' }
      : { ok: true, authenticated: false, providerId: null }) };
  }
  if (path.startsWith('/portal/providers')) {
    return { ok: true, json: async () => ({ providers: [
      { id: 1, provider: 'custom', label: 'Regolo (EU)', base_url: 'https://api.regolo.ai/v1', model_preference: 'llama', is_active: 1, status: 'ok', last_used_at: null, on_this_device: false, jurisdiction: 'eu-zdr' },
      ...(SUB ? [{ id: SUB_ID, provider: 'anthropic', auth_type: 'oauth', label: 'Claude subscription', base_url: null, model_preference: null, is_active: 1, status: 'ok', last_used_at: null, on_this_device: false, jurisdiction: 'us-standard' }] : []),
    ] }) };
  }
  return { ok: true, json: async () => ({}) };
};

mkdirSync(GEN, { recursive: true });
const storeSrc = readFileSync('src/lib/stores/sensitive-exempt.svelte.ts', 'utf8')
  .replace(/:\s*boolean/g, '').replace(/export function setSensitiveExempt\(allowed\)/, 'export function setSensitiveExempt(allowed)');
writeFileSync(`${GEN}/sensitive-exempt.gen.js`, compileModule(storeSrc, { generate: 'client', filename: 'sensitive-exempt.svelte.ts' }).js.code);
const out = compile(readFileSync(SRC, 'utf8'), { generate: 'client', name: 'AISettings', css: 'injected' });
writeFileSync(`${GEN}/AISettings.gen.js`, out.js.code
  .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);')
  // D-010 (U5): AISettings imports openExternal for the Claude sign-in "open a browser"
  // path. This harness proves the DEMOTED surface, not the browser open — rewrite the
  // specifier to an inert no-op (inline, matching the $lib/api rewrite above) so the
  // compiled AISettings.gen.js has no unresolvable $lib import.
  .replace(/import\s+\{\s*openExternal\s*\}\s+from\s+['"]\$lib\/open-external['"];?/, 'const openExternal = async () => false;')
  .replace(/from\s+['"]\$lib\/stores\/sensitive-exempt\.svelte['"]/, `from './sensitive-exempt.gen.js'`));

const emit = (o) => console.log(JSON.stringify(o));
try {
  const { default: AISettings } = await import(pathToFileURL(resolve(GEN, 'AISettings.gen.js')).href);
  const { mount, flushSync } = await import('svelte');
  mount(AISettings, { target: dom.window.document.getElementById('host') });
  flushSync();
  await new Promise((r) => setTimeout(r, 80));
  flushSync();

  const D = dom.window.document;
  const text = D.body.textContent.replace(/\s+/g, ' ');

  // ── D-074: the subscription model picker, as RENDERED, plus what Refresh actually asks for ──
  let subPicker = null;
  if (SUB) {
    const sel = [...D.querySelectorAll('select')].find((x) => x.closest('.sub-model-ctl'));
    const before = calls.length;
    const refresh = sel?.closest('.sub-model-ctl')?.querySelector('button');
    if (refresh) {
      refresh.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      flushSync();
      await new Promise((r) => setTimeout(r, 40));
    }
    subPicker = {
      present: !!sel,
      optionValues: sel ? [...sel.options].map((o) => o.value) : [],
      optionLabels: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
      note: D.querySelector('.sub-model-note')?.textContent?.trim() ?? null,
      // The Refresh click must bypass the server's TTL, or "Refresh" cannot surface a model
      // released since the last visit — the exact staleness this defect is about.
      refreshPaths: calls.slice(before).map((c) => c.path),
      // Every model path this component requested, so the gate can pin it asked at all.
      modelPaths: calls.filter((c) => /\/models/.test(c.path)).map((c) => c.path),
    };
  }

  emit({
    ok: true,
    subPicker,
    // A3: no assignment machinery in the mounted DOM.
    taskModelCalls: calls.filter((c) => c.path.includes('/providers/task-models')),
    readinessCalls: calls.filter((c) => c.path.includes('/portal/readiness')),
    transcriptionCalls: calls.filter((c) => c.path.includes('/portal/transcription')),
    identityCalls: calls.filter((c) => c.path.includes('/portal/agent-identity')),
    saysPerTask: /Models per task|per task/i.test(text),
    saysWhisper: /Whisper|transcrib/i.test(text),
    hasAssistantNameInput: !!D.querySelector('input[aria-label="Assistant name"]'),
    heroPresent: /Using .*·|No intelligence connected yet/.test(text),
    // …and the surface it KEEPS still stands (P3: demoted, not deleted).
    hasLocalLane: /Recommend a model for my hardware|Detecting hardware/.test(text),
    hasCloudPresets: /Regolo/.test(text),
    hasSubscriptionCard: /Claude login|Claude subscription/i.test(text),
    hasWebAccess: /Web access/.test(text),
    hasConnectedList: /Connected/.test(text),
    selectCount: D.querySelectorAll('select').length,
  });
  process.exit(0);
} catch (e) {
  emit({ ok: false, error: String(e?.stack || e) });
  process.exit(0);
}
