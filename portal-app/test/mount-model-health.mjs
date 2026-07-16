// Mounts ModelHealth.svelte for REAL — compiled by the real Svelte compiler, rendered into
// a real DOM (jsdom) — and prints one JSON line for scripts/verify-model-consent.mjs (M10)
// to assert on.
//
// WHY MOUNTED, NOT GREPPED. Its sibling M6b was a regex over component SOURCE and an
// independent review defeated it by commenting the option out and watching it still pass
// (2026-07-16). The claims this component makes are about what the OWNER SEES — "declining
// is not an error", "a 3.4GB pull shows a percentage" — and source text cannot witness a
// rendered colour or a bar's width. So: render it, read the DOM back.
//
// Run with: node --conditions browser portal-app/test/mount-model-health.mjs   (cwd=portal-app)
// The `browser` condition is REQUIRED: without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable.
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPONENT = 'src/lib/components/settings/ModelHealth.svelte';
const GEN = '.gen-mount-health';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
// Svelte's client runtime reads DOM globals at module init (Text.prototype etc.), so they must
// exist BEFORE svelte/internal/client is imported. `navigator` is getter-only in Node 22 —
// hence the try/catch rather than a curated list that would silently miss one.
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const out = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'ModelHealth', css: 'injected' });
mkdirSync(GEN, { recursive: true });
writeFileSync(`${GEN}/ModelHealth.gen.js`, out.js.code);

try {
  const { default: Component } = await import(pathToFileURL(resolve(GEN, 'ModelHealth.gen.js')).href);
  const { mount, flushSync } = await import('svelte');

  // Render one case and report what the OWNER would actually see: the text, whether anything
  // is painted in the alarm colour, whether a progress track exists and how far it is filled,
  // and whether an approvable control was offered.
  const render = (props) => {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    mount(Component, { target: host, props });
    flushSync();
    const bar = host.querySelector('.mh-fill');
    return {
      text: host.textContent.replace(/\s+/g, ' ').trim(),
      // The alarm colour is carried by these classes ALONE — a state is rendered as a fault
      // if and only if one of them is present. Asserting on classes rather than on a colour
      // string keeps the test honest if the palette changes.
      isFault: Boolean(host.querySelector('.bad-text, .mh-dot.bad')),
      isWarn: Boolean(host.querySelector('.warn-text, .mh-dot.warn')),
      // ⚠️ The GREEN dot is the component's only affirmative claim of health, so it needs its
      // own witness. Two independent reviews (2026-07-16) found the `included` lane painting it
      // from NO DATA — and the earlier assertions here (`!isFault` + /included/i) were satisfied
      // by that fabrication, because "not red" and "says included" are both true of a lie.
      okDot: Boolean(host.querySelector('.mh-dot.ok')),
      busyDot: Boolean(host.querySelector('.mh-dot.busy')),
      hasBar: Boolean(host.querySelector('.mh-bar')),
      barWidth: bar ? (bar.getAttribute('style') || '') : null,
      barIndeterminate: bar ? bar.classList.contains('indeterminate') : null,
      // An "approvable choice" is a control the owner can operate. The embedder must never
      // offer one — presenting a non-choice as consent is the dishonesty §3.10 removes.
      controls: host.querySelectorAll('select, button, input').length,
      aria: (() => { const p = host.querySelector('[role=progressbar]'); return p ? p.getAttribute('aria-valuenow') : null; })(),
    };
  };

  const H = (status, extra = {}) => ({ status, message: null, detail: null, model: null, progress: null, ...extra });

  console.log(JSON.stringify({
    // ── the CHOICES — must never read as faults ──
    no_model:    render({ health: H('no_model'), kind: 'consented' }),
    paused:      render({ health: H('paused', { model: 'qwen3.5:4b' }), kind: 'consented' }),
    // ── the honest ABSENCE — a caught-up vault and a crashing cycle both land here today ──
    unknown:     render({ health: H('unknown', { message: 'Enrichment has not started.' }), kind: 'consented' }),
    missing:     render({ health: null, kind: 'consented' }),
    // ── the genuine FAULTS — these MUST be red, or the "not red" cases above prove nothing ──
    error:       render({ health: H('error', { detail: 'ollama exited 1' }), kind: 'consented' }),
    down:        render({ health: H('down', { message: 'Not running.' }), kind: 'consented' }),
    deps_missing:render({ health: H('deps_missing', { message: 'Missing dependencies.' }), kind: 'consented' }),
    // ── the WORK ──
    ok:          render({ health: H('ok', { message: 'Enriching with qwen3.5:4b.', model: 'qwen3.5:4b' }), kind: 'consented' }),
    downloading: render({ health: H('downloading', { model: 'qwen3.5:4b', progress: { pct: 37 } }), kind: 'consented' }),
    // A pull whose stream has not yielded a number yet: an empty 0% bar reads as "stuck",
    // which is the one question a multi-GB download must answer.
    dl_nopct:    render({ health: H('downloading', { model: 'qwen3.5:4b', progress: null }), kind: 'consented' }),
    // A bad number must not paint the bar off its track.
    dl_over:     render({ health: H('downloading', { model: 'q', progress: { pct: 480 } }), kind: 'consented' }),
    // ── the EMBEDDER — bundled: "included", never approvable, never "Off" ──
    inc_ok:      render({ health: H('ok'), kind: 'included' }),
    inc_unknown: render({ health: H('unknown', { message: 'Embedding engine not started yet.' }), kind: 'included' }),
    // The host passes `models?.embedder`, which is null until the readiness fetch resolves —
    // and FOREVER if that fetch fails (the catch is silent). So "no data at all" is a real,
    // every-page-load state, not a race. It must not render as health.
    inc_missing: render({ health: null, kind: 'included' }),
    inc_down:    render({ health: H('down', { message: 'Search indexing is not running.' }), kind: 'included' }),
    // The embedder's DOCUMENTED, most likely real fault (embed/supervisor.js: "actionable —
    // run setup.sh"). It used to fall through to the busy branch and pulse blue: a permanent
    // setup step dressed as work in progress.
    inc_deps:    render({ health: H('deps_missing', { message: 'Python deps missing; run pipeline/setup.sh' }), kind: 'included' }),
  }));
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
