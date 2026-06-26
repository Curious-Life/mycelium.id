// build-figure-realm-asset.mjs — derive the shipped per-figure REALM centroid asset.
//
//   node scripts/build-figure-realm-asset.mjs [SRC] [OUT]
//     SRC default: /tmp/figmaps_full/figureProfiles.json  (the full 41 MB figure-embedding
//                  output: figures[].realms[].centroid[256] — NOT committed, too big)
//     OUT default: src/curious/figureRealmProfiles.json    (~1.5 MB, committed, served)
//
// The figure detail drawer matches "your territory ↔ their realm". The full asset carries a
// 256-D centroid on each figure realm; we int8-quantize (per-vector symmetric scale) + base64 so
// the realm vectors ship in ~1.5 MB instead of ~19 MB float. These are PUBLIC (derived from
// public biographies); matching runs server-side and the user's centroids never leave (CLAUDE.md §7).
//
// Regeneration: if /tmp/figmaps_full is gone, re-run the figure-embedding pipeline that produced it,
// then this script. The committed JSON is the stable artifact.
import fs from 'node:fs';

const SRC = process.argv[2] || '/tmp/figmaps_full/figureProfiles.json';
const OUT = process.argv[3] || new URL('../src/curious/figureRealmProfiles.json', import.meta.url).pathname;

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const DIM = 256;

// psychometrics live in the portal package's seed; fold the fields the drawer needs into the
// one server-side asset so the endpoint does a single self-contained read (no cross-package path).
const seedByName = new Map();
try {
  const seed = JSON.parse(fs.readFileSync(new URL('../portal-app/src/lib/curious/characterResonanceSeed.json', import.meta.url).pathname, 'utf8'));
  for (const s of seed.figures || []) seedByName.set(s.name, s);
} catch (e) { console.warn('seed not found — psychometrics will be omitted:', e.message); }
const DIMS = ['integrative_complexity', 'abstraction_level', 'epistemic_breadth', 'systematic_rigor', 'creative_latitude', 'metacognitive_awareness', 'agency', 'emotional_register'];

const quant = (v) => {
  let max = 0;
  for (const x of v) { const a = Math.abs(x); if (a > max) max = a; }
  const s = (max / 127) || 1e-9;
  const buf = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) {
    let q = Math.round(v[i] / s);
    if (q > 127) q = 127; else if (q < -127) q = -127;
    buf.writeInt8(q, i);
  }
  return { q: buf.toString('base64'), s };
};

let realmCount = 0;
const figures = [];
for (const f of raw.figures || []) {
  const realms = [];
  for (const r of f.realms || []) {
    if (!Array.isArray(r.centroid) || r.centroid.length !== DIM) continue;
    const { q, s } = quant(r.centroid);
    const territories = (r.territories || []).map((t) => t.name).filter(Boolean);
    realms.push({ name: r.name, lean: r.lean || null, essence: r.essence || '', territories, q, s });
    realmCount++;
  }
  if (!realms.length) continue;
  const sd = seedByName.get(f.name) || {};
  const cog = {};
  if (sd.cognitive_dimensions) for (const d of DIMS) if (typeof sd.cognitive_dimensions[d] === 'number') cog[d] = sd.cognitive_dimensions[d];
  figures.push({
    name: f.name,
    constellation: f.constellation || sd.constellation || null,
    domain: f.domain || sd.domain || sd.primary_domain || null,
    sourcing: f.sourcing || sd.sourcing || null,
    era: sd.era || null, region: sd.region || null, primary_domain: sd.primary_domain || null,
    birth_year: sd.birth_year ?? null, death_year: sd.death_year ?? null, gender: sd.gender || null,
    cognitive: Object.keys(cog).length ? cog : null,
    realms,
  });
}

const asset = { version: 1, dim: DIM, space: 'nomic-v1.5-256', count: figures.length, realmCount, figures };
fs.writeFileSync(OUT, JSON.stringify(asset));
const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
console.log(`wrote ${OUT} — ${figures.length} figures, ${realmCount} realm centroids, ${mb} MB`);

// round-trip sanity: dequant the first realm, report cosine vs the original float vector.
const f0 = (raw.figures || []).find((f) => (f.realms || []).some((r) => Array.isArray(r.centroid)));
if (f0) {
  const orig = f0.realms.find((r) => Array.isArray(r.centroid)).centroid;
  const out0 = asset.figures.find((f) => f.name === f0.name).realms[0];
  const buf = Buffer.from(out0.q, 'base64');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { const a = orig[i], b = buf.readInt8(i) * out0.s; dot += a * b; na += a * a; nb += b * b; }
  console.log(`round-trip cosine (${f0.name} realm0): ${(dot / (Math.sqrt(na) * Math.sqrt(nb))).toFixed(5)}`);
}
