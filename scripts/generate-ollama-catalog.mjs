// scripts/generate-ollama-catalog.mjs — refresh src/hardware/catalog.json from
// Ollama (maintainer/build-time, NOT the user's runtime). Network orchestration
// only; all decision logic is the pure, hermetically-tested code in
// src/hardware/catalog-gen.js + catalog-meta.js. See
// docs/DYNAMIC-CATALOG-DESIGN-2026-06-05.md.
//
//   1. GET ollama.com/library          → parse x-test-* → official models
//   2. filter (exclude embed/coder/r1/nsfw…) BEFORE any registry call
//   3. + curated COMMUNITY_SEED (warm finetunes; community needs the pull floor)
//   4. per model: /tags → bare size tags; per tag: registry manifest → size
//   5. fetch EQ-Bench leaderboard JSON (gz) → family bonus  (fail-soft → none)
//   6. buildCatalog() → write src/hardware/catalog.json (review the diff, commit)
//
// Fail-soft: any model/tag that errors is skipped; a totally failed run leaves
// the committed catalog.json untouched (we only write on success with N>0).
// Bound with MAX_MODELS=20 for a quick smoke; CONCURRENCY tunes the pool.

import { writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLibrary, buildCatalog } from '../src/hardware/catalog-gen.js';
import { isExcluded } from '../src/hardware/catalog-meta.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/hardware/catalog.json');
const REGISTRY = 'https://registry.ollama.ai/v2';
const LIBRARY = 'https://ollama.com';
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
const MAX_MODELS = Number(process.env.MAX_MODELS) || 0; // 0 = all
const EQ_GZ = 'https://raw.githubusercontent.com/EQ-bench/eqbench3/main/data/canonical_leaderboard_elo_results.json.gz';

// Curated community warm finetunes (reviewed names). The whole community
// pipeline is built + hermetically tested (filter + MIN_COMMUNITY_PULLS floor +
// explicit variants), but a seed entry must RESOLVE on registry.ollama.ai/v2/
// <ns>/<model>/manifests/<tag> or it fail-softs out. Add entries here as
// {name:'ns/model', namespace:'ns', pulls, updated, capabilities:['completion'],
//  variants:[{tag, paramsB, quant}]} once verified live.
// (The previously-considered `vanilj/gemma-2-ataraxy-9b` now 404s on the
//  registry — removed upstream — so it is NOT seeded.)
const COMMUNITY_SEED = [];

const log = (...a) => console.error('[catalog-gen]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry transient failures so a flaky network never silently drops a model from
// the COMMITTED catalog (determinism matters for a reviewed artifact).
const sigGet = async (url, type = 'text', tries = 3) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return type === 'json' ? r.json() : type === 'buf' ? Buffer.from(await r.arrayBuffer()) : r.text();
    } catch (e) { lastErr = e; await sleep(400 * (i + 1)); }
  }
  throw lastErr;
};

// Key models that MUST be present, else the run is incomplete → don't overwrite
// the committed catalog with a partial scrape.
const REQUIRED_ANCHORS = ['gemma3:12b', 'gemma3:4b', 'gemma4:12b', 'qwen3:8b', 'llama3.3:70b', 'phi4:14b', 'mistral-nemo:12b'];

// Run async fn over items with a bounded pool.
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } }
  }));
  return out;
}

// Tag label → {paramsB, kvParamsB?}. "12b"→12, "270m"→0.27, "8x7b"→56 (MoE),
// "35b-a3b"→{35, active 3}, "e4b"→4 (gemma effective).
function paramsFromTag(tag) {
  const t = String(tag).toLowerCase();
  const moe = t.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)b/); // 8x7b
  if (moe) return { paramsB: Math.round(Number(moe[1]) * Number(moe[2]) * 10) / 10 };
  const active = t.match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/); // 35b-a3b
  if (active) return { paramsB: Number(active[1]), kvParamsB: Number(active[2]) };
  const b = t.match(/(?:^|[^a-z])e?(\d+(?:\.\d+)?)b/); // 12b / e4b
  if (b) return { paramsB: Number(b[1]) };
  const mm = t.match(/(\d+(?:\.\d+)?)m/); // 270m
  if (mm) return { paramsB: Math.round((Number(mm[1]) / 1000) * 100) / 100 };
  return null;
}

// Bare size tags from a model's /tags page (drop quant/format variants).
function bareSizeTags(html, model) {
  const re = new RegExp(`/(?:library/)?${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([a-z0-9._-]+)`, 'gi');
  const tags = new Set(); let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    // keep bare size tags only: 12b, 270m, e4b, 8x7b, 35b-a3b, latest
    if (/^(latest|e?\d+(?:\.\d+)?b(?:-a\d+(?:\.\d+)?b)?|\d+(?:\.\d+)?m|\d+x\d+b)$/.test(tag)) tags.add(tag);
  }
  return [...tags];
}

async function manifestSizeGb(path, tag) {
  const mani = await sigGet(`${REGISTRY}/${path}/manifests/${tag}`, 'json');
  const layer = (mani.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
  return layer ? Math.round((layer.size / 1e9) * 10) / 10 : 0;
}

async function main() {
  // 1–2: official library, filtered.
  log('fetching library…');
  let models = parseLibrary(await sigGet(`${LIBRARY}/library`));
  log(`library models: ${models.length}`);
  models = models.filter((m) => !isExcluded(m.name, m));
  if (MAX_MODELS) models = models.slice(0, MAX_MODELS);
  log(`after exclude: ${models.length}`);

  // 3: + community seed.
  models = [...models, ...COMMUNITY_SEED];

  // 4: enrich each surviving model with its bare size tags → sizes.
  const enriched = {};
  await pool(models, CONCURRENCY, async (m) => {
    const path = m.name.includes('/') ? m.name : `library/${m.name}`;
    // Community seeds carry explicit curated variants; official models scrape /tags.
    let tagSpecs;
    if (m.variants) {
      tagSpecs = m.variants.map((v) => ({ tag: v.tag, params: { paramsB: v.paramsB, ...(v.kvParamsB ? { kvParamsB: v.kvParamsB } : {}) } }));
    } else {
      let tags = [];
      try { tags = bareSizeTags(await sigGet(`${LIBRARY}/library/${m.name}/tags`), m.name.split('/').pop()); } catch { /* skip */ }
      tagSpecs = tags.filter((t) => t !== 'latest').map((t) => ({ tag: t, params: paramsFromTag(t) }))
        .filter((s) => s.params && s.params.paramsB > 0);
    }
    const variants = [];
    for (const { tag, params } of tagSpecs) {
      let sizeGb = 0;
      try { sizeGb = await manifestSizeGb(path, tag); } catch { /* skip tag */ }
      if (sizeGb > 0) variants.push({ tag, quant: 'Q4_K_M', sizeGb, ...params });
    }
    if (variants.length) enriched[m.name] = variants;
  });
  log(`enriched models: ${Object.keys(enriched).length}`);

  // 5: EQ-Bench bonus — DEFERRED. The published artifact
  //    (canonical_leaderboard_elo_results.json.gz) is a 26MB RAW pairwise-
  //    comparison dump keyed by HF model name, NOT a ready elo table; deriving a
  //    normalized score means computing Elo from pairwise data. The pathway
  //    (buildCatalog eqData + EQ_FAMILY_ALIASES + hermetic P3d) is built and
  //    tested; wiring a real elo source is a follow-up. For now: family-prior
  //    ranking (the dominant 0.62 weight) with eqData empty.
  const eqData = {};
  void EQ_GZ; void gunzipSync;
  log('EQ-Bench bonus deferred (raw-pairwise source) — family-prior ranking');

  // 6: assemble + write (only on success).
  const cat = buildCatalog({ models, enriched, eqData, generatedAt: process.env.GEN_TS || 'unknown' });
  if (!cat.count) { log('NO models assembled — leaving catalog.json untouched'); process.exit(1); }
  // Completeness gate: never commit a partial scrape that dropped a key model.
  const names = new Set(cat.models.map((m) => m.name));
  const missing = REQUIRED_ANCHORS.filter((a) => !names.has(a));
  if (missing.length) { log(`INCOMPLETE — missing required anchors: ${missing.join(', ')} — leaving catalog.json untouched`); process.exit(1); }
  writeFileSync(OUT, JSON.stringify(cat, null, 2) + '\n');
  log(`WROTE ${OUT} — ${cat.count} models`);
  // Quick top-10 preview for the reviewer.
  cat.models.slice(0, 10).forEach((m) => log(`  ${m.name.padEnd(30)} q=${m.quality} ${m.sizeGb}GB ${m.bestFor}`));
}

main().catch((e) => { log('FAILED:', e.message); process.exit(1); });
