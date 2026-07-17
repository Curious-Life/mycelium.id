// Mounts VoiceSection.svelte for REAL — real Svelte compiler, real DOM (jsdom), a stubbed
// `api` serving EXACTLY the shape src/portal-settings.js emits for the "model ready, voice
// sample pending" state — and prints one JSON line for scripts/verify-tts-voice.mjs.
//
// WHY A MOUNT AND NOT A REGEX: a source grep passes with the branch commented out or dead
// behind `{#if false}` (this repo proved it twice — see mount-intelligence-screen.mjs and the
// render-must-be-mounted memory). Only rendering the real component pins the TOP LINE.
//
// THE CLAIM UNDER TEST (adversarial review of #209, MED-1): with the qwen model READY and the
// user opted in but NO frozen voice sample (the character page isn't built), the status line
// must render the honest pending copy — NEVER "TTS active" — because every render 501s until
// a per-agent sample exists (design §2.2/§5).
//
// Run with: node --conditions browser portal-app/test/mount-voice-section.mjs  (cwd=portal-app)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-voice';
const FILE = 'src/lib/components/settings/VoiceSection.svelte';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// The fixture — the REAL server shape for "ready + opted-in + sample pending"
// (mirrors src/portal-settings.js GET /settings/tts with hasVoiceSample() false).
const payload = {
  enabled: false,                                   // the server refuses to say "active" without a sample
  provider: 'qwen',
  qwen: {
    enabled: true,
    samplePending: true,
    variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit',
    variants: [
      { id: 'Qwen3-TTS-12Hz-1.7B-Base-8bit', label: 'Qwen3-TTS 1.7B (8-bit)', description: 'Recommended — won the live listening test (2026-07-15).', sizeMB: 2900, recommended: true },
      { id: 'Qwen3-TTS-12Hz-0.6B-Base-bf16', label: 'Qwen3-TTS 0.6B (bf16)', description: 'Smaller download, but NOT faster.', sizeMB: 2400, recommended: false },
    ],
    model: { phase: 'ready', progress: 100, error: null, variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit', sizeMB: 2900 },
  },
  openai: { hasKey: false, voice: 'onyx', model: 'tts-1-hd', voices: [], models: [] },
  elevenlabs: { hasKey: false, voiceId: null, model: 'eleven_turbo_v2_5', models: [] },
};
globalThis.__apiStub = async () => ({ ok: true, json: async () => payload });

mkdirSync(GEN, { recursive: true });
const out = compile(readFileSync(FILE, 'utf8'), { generate: 'client', name: 'VoiceSection', css: 'injected' });
const rewired = out.js.code
  .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);');
writeFileSync(`${GEN}/VoiceSection.gen.js`, rewired);

const emit = (o) => console.log(JSON.stringify(o));
try {
  const { default: Section } = await import(pathToFileURL(resolve(GEN, 'VoiceSection.gen.js')).href);
  const { mount, flushSync } = await import('svelte');
  mount(Section, { target: dom.window.document.getElementById('host') });
  flushSync();
  await new Promise((r) => setTimeout(r, 60));   // onMount's async loadState()
  flushSync();
  const text = dom.window.document.body.textContent.replace(/\s+/g, ' ').trim();
  emit({ mounted: true, text });
} catch (e) {
  emit({ mounted: false, error: String(e?.message || e).slice(0, 300) });
  process.exit(1);
}
