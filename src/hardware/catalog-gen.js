// src/hardware/catalog-gen.js — PURE catalog-assembly logic (no I/O), shared by
// the generator script and its hermetic test. The network orchestration lives in
// scripts/generate-ollama-catalog.mjs; everything decision-bearing lives here so
// it's unit-testable with fixtures. See docs/DYNAMIC-CATALOG-DESIGN-2026-06-05.md.

import { isExcluded, companionQuality, bestFor, familyOf, eqFamilyBonus, MIN_COMMUNITY_PULLS, clamp } from './catalog-meta.js';

const round1 = (n) => Math.round(Number(n) * 10) / 10;

/**
 * Parse the server-rendered ollama.com/library HTML into model records using the
 * stable x-test-* attributes (verified present: x-test-model, x-test-namespace,
 * x-test-capability, x-test-pull-count, x-test-updated). Tolerant: one record per
 * model card; missing fields default safely.
 * @returns {{name,namespace,capabilities:string[],pulls:number,updated:string}[]}
 */
export function parseLibrary(html) {
  const text = String(html || '');
  // Split into per-model chunks at each card (the <li>/<a> carrying x-test-model).
  const chunks = text.split(/x-test-model(?![-\w])/i).slice(1);
  const out = [];
  for (const ch of chunks) {
    const name = pick(ch, /x-test-model-title[^>]*?(?:title="([^"]+)"|>\s*([^<]+?)\s*<)/i)
      || pick(ch, /href="\/library\/([^"?#]+)"/i)
      || pick(ch, /href="\/([^"/?#]+\/[^"?#]+)"/i);
    if (!name) continue;
    const namespace = pick(ch, /x-test-namespace[^>]*>\s*([^<]+?)\s*</i) || (name.includes('/') ? name.split('/')[0] : 'library');
    const caps = [];
    const capRe = /x-test-capability[^>]*>\s*([^<]+?)\s*</gi;
    let mm; while ((mm = capRe.exec(ch))) caps.push(mm[1].trim().toLowerCase());
    const pulls = parsePulls(pick(ch, /x-test-pull-count[^>]*>\s*([^<]+?)\s*</i));
    const updated = pick(ch, /x-test-updated[^>]*>\s*([^<]+?)\s*</i) || '';
    out.push({ name: name.trim(), namespace: namespace.trim(), capabilities: caps, pulls, updated });
  }
  // De-dup by name (first wins).
  const seen = new Set();
  return out.filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)));
}

function pick(s, re) { const m = re.exec(s); return m ? (m[1] ?? m[2] ?? '').trim() : ''; }

// "115.5M" / "1.2K" / "3,456" → number.
export function parsePulls(s) {
  const t = String(s || '').trim().replace(/,/g, '');
  const m = t.match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  return Math.round(n * (u === 'B' ? 1e9 : u === 'M' ? 1e6 : u === 'K' ? 1e3 : 1));
}

/**
 * Assemble the final catalog from parsed models + per-tag enrichment + EQ data.
 * PURE: all network results are passed in.
 *
 * @param {object} a
 * @param {Array}  a.models     parsed library/community records ({name,namespace,capabilities,pulls,updated})
 * @param {object} a.enriched   name → [{ tag, paramsB, kvParamsB?, quant, sizeGb }]  (per size variant)
 * @param {object} [a.eqData]   { hfName: normElo0to1 } from EQ-Bench (optional)
 * @param {string} [a.generatedAt]
 * @returns {{generatedAt:string, source:string, count:number, models:object[]}}
 */
export function buildCatalog({ models = [], enriched = {}, eqData = {}, generatedAt = '' } = {}) {
  const eqBonusByFamily = eqFamilyBonus(eqData);
  const items = [];
  for (const m of models) {
    const variants = enriched[m.name] || [];
    for (const v of variants) {
      const fullName = m.name.includes(':') ? m.name : `${m.name}:${v.tag}`;
      const namespace = m.namespace || (fullName.includes('/') ? fullName.split('/')[0] : 'library');
      // Hard gate: excluded categories, and a popularity floor for community.
      if (isExcluded(fullName, m)) continue;
      if (namespace !== 'library' && (Number(m.pulls) || 0) < MIN_COMMUNITY_PULLS) continue;
      if (!(Number(v.paramsB) > 0) && !(Number(v.sizeGb) > 0)) continue; // need fit data
      const rec = {
        name: fullName,
        family: familyOf(fullName),
        namespace,
        paramsB: round1(v.paramsB || 0),
        ...(v.kvParamsB ? { kvParamsB: round1(v.kvParamsB) } : {}),
        quant: v.quant || 'Q4_K_M',
        sizeGb: round1(v.sizeGb || 0),
        ctx: 8192,
        pulls: Number(m.pulls) || 0,
        updated: m.updated || '',
        capabilities: m.capabilities || [],
      };
      rec.quality = companionQuality({ ...rec }, { eqBonusByFamily });
      if (rec.quality <= 0) continue; // excluded by quality (defence in depth)
      rec.bestFor = bestFor(fullName, rec.paramsB);
      items.push(rec);
    }
  }
  // De-dup by name (best quality wins) and ship quality-ranked (runtime re-ranks by fit×quality).
  const byName = new Map();
  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev || it.quality > prev.quality) byName.set(it.name, it);
  }
  const models2 = [...byName.values()].sort((a, b) => (b.quality - a.quality) || (b.paramsB - a.paramsB));
  return { generatedAt, source: 'ollama-library+community', count: models2.length, models: models2 };
}

export default buildCatalog;
