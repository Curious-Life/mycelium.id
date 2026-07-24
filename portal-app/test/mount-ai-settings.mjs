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

const calls = [];   // EVERY api call — reads and writes
globalThis.__apiStub = async (path, options = {}) => {
  calls.push({ path, method: options.method || 'GET' });
  if (path.startsWith('/portal/providers/presets')) {
    return { ok: true, json: async () => ({ presets: [
      { id: 'regolo', label: 'Regolo', kind: 'openai', baseUrl: 'https://api.regolo.ai/v1', jurisdiction: 'eu-zdr', defaultModel: 'llama' },
      { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', jurisdiction: 'us-standard', defaultModel: 'gpt' },
    ], roleRecommendations: { labeling: { model: 'qwen3.5:4b' }, descriptions: { presetId: 'regolo' } } }) };
  }
  if (path.startsWith('/portal/providers/sensitive-subscription')) return { ok: true, json: async () => ({ ok: true, allowed: false }) };
  if (path.startsWith('/portal/providers/web-search')) return { ok: true, json: async () => ({ ok: true, enabled: true }) };
  if (path.startsWith('/portal/auth/claude/status')) return { ok: true, json: async () => ({ ok: true, authenticated: false, providerId: null }) };
  if (path.startsWith('/portal/providers')) {
    return { ok: true, json: async () => ({ providers: [
      { id: 1, provider: 'custom', label: 'Regolo (EU)', base_url: 'https://api.regolo.ai/v1', model_preference: 'llama', is_active: 1, status: 'ok', last_used_at: null, on_this_device: false, jurisdiction: 'eu-zdr' },
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
  emit({
    ok: true,
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
