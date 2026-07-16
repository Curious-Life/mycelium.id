// Mounts OnboxTaskSelect.svelte for REAL — compiled by the real Svelte compiler, rendered
// into a real DOM (jsdom), driven with a real change event — and prints one JSON line for
// scripts/verify-model-consent.mjs (M6b) to assert on.
//
// WHY THIS EXISTS. M6b was a regex over the component SOURCE, and an independent review
// proved it passed with the option COMMENTED OUT (2026-07-16). The bug it guards is subtle
// and shipped once already: the on-box picker's "Recommended · qwen3.5:4b" option carried
// value="", and "" now means UN-APPROVE (§3.10c) — so the UI labelled the disable button
// "Recommended", and the one model the app recommends was the one model it could not store.
// The route accepted the value the whole time (M6 passes against the broken UI), so only
// driving the actual control can catch it.
//
// Run with: node --conditions browser portal-app/test/mount-onbox-select.mjs   (cwd=portal-app)
// The `browser` condition is REQUIRED: without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable.
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPONENT = 'src/lib/components/settings/OnboxTaskSelect.svelte';
const GEN = '.gen-mount';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
// Svelte's client runtime reads DOM globals at module init (Text.prototype etc.), so they
// must exist BEFORE svelte/internal/client is imported. `navigator` is getter-only in Node
// 22 — hence the try/catch rather than a curated list that would silently miss one.
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const out = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'OnboxTaskSelect', css: 'injected' });
mkdirSync(GEN, { recursive: true });
writeFileSync(`${GEN}/OnboxTaskSelect.gen.js`, out.js.code);

try {
  // Absolute URL: a bare relative specifier resolves against THIS FILE (test/), not cwd.
  const { default: Component } = await import(pathToFileURL(resolve(GEN, 'OnboxTaskSelect.gen.js')).href);
  const { mount, flushSync } = await import('svelte');

  const picks = [];
  mount(Component, {
    target: dom.window.document.getElementById('host'),
    props: { value: '', recModel: 'qwen3.5:4b', options: ['llama3.1:latest'], onpick: (m) => picks.push(m) },
  });
  flushSync();

  const sel = dom.window.document.querySelector('select');
  const options = [...sel.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));

  // Drive the real control: pick the RECOMMENDED option.
  sel.value = 'qwen3.5:4b';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  flushSync();
  const pickedRecommended = picks.at(-1);

  // …and pick OFF.
  sel.value = '';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  flushSync();
  const pickedOff = picks.at(-1);

  // A vault already approved on the recommendation must SHOW it selected — not blank, and
  // not snapped to Off (which would misreport an approved vault as declined).
  const host2 = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host2);
  mount(Component, { target: host2, props: { value: 'qwen3.5:4b', recModel: 'qwen3.5:4b', options: [], onpick: () => {} } });
  flushSync();
  const selectedWhenApproved = host2.querySelector('select').value;

  console.log(JSON.stringify({ options, pickedRecommended, pickedOff, selectedWhenApproved }));
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
