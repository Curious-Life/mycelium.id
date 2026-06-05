// src/hardware/catalog.js — the local-model catalog the S6 recommender ranks
// against the detected hardware.
//
// GENERATED + COMMITTED, not hand-typed: the data lives in catalog.json, built
// from the Ollama library by scripts/generate-ollama-catalog.mjs (scrape the
// library + registry for real sizes/params, filter to companion-relevant chat
// models, score companion-quality). Committing the JSON keeps it:
//   • the FULL (filtered) catalog — hundreds of models, not a hand-list,
//   • the reviewed PULL ALLOWLIST — every entry shows up in PR diffs (an
//     unverified/dangerous tag can't enter it silently), AND
//   • offline-safe — the app reads the bundled file, never scrapes at runtime.
// To refresh: `npm run catalog:refresh` (network), review the diff, commit.
// Validate tags resolve with `npm run verify:catalog-tags`.
//
// `quality` = COMPANION-suitability (warmth/EQ for personal growth — NOT generic
// capability), from the curated family-prior in catalog-meta.js. See
// docs/DYNAMIC-CATALOG-DESIGN-2026-06-05.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const data = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));

// Map the generated shape to the per-item shape consumers expect. `defaultQuant`
// mirrors the JSON `quant`; `sizeGb`/`family`/`namespace`/`pulls` are new and
// additive (recommend.js uses the real `sizeGb` for fit when present).
export const CATALOG = Object.freeze(
  (data.models || []).map((m) => Object.freeze({
    name: m.name,
    paramsB: m.paramsB,
    ...(m.kvParamsB ? { kvParamsB: m.kvParamsB } : {}),
    defaultQuant: m.quant || 'Q4_K_M',
    ctx: m.ctx || 8192,
    sizeGb: m.sizeGb || 0,
    quality: m.quality,
    bestFor: m.bestFor,
    family: m.family,
    namespace: m.namespace || 'library',
    pulls: m.pulls || 0,
    blurb: m.blurb || `${m.family} · ${m.bestFor} (≈${m.sizeGb}GB).`,
  })),
);

// Catalog provenance, for the UI / diagnostics.
export const CATALOG_META = Object.freeze({ generatedAt: data.generatedAt || 'unknown', source: data.source || '', count: CATALOG.length });

export default CATALOG;
