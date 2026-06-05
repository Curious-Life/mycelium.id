// verify:catalog-gen — the dynamic-catalog assembly logic, HERMETIC (fixtures,
// no network). Proves: library HTML parses; excluded categories are dropped;
// community popularity floor enforced; family-prior + EQ bonus rank warmth above
// cool/cold; required fields present. The network script (generate-ollama-
// catalog.mjs) just feeds real fetches into these same pure functions.
import assert from 'node:assert';
import { parseLibrary, buildCatalog, parsePulls } from '../src/hardware/catalog-gen.js';
import { parseParamsB, familyOf, isExcluded, companionQuality } from '../src/hardware/catalog-meta.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── fixture library HTML (mirrors ollama.com/library x-test-* structure) ──────
const card = ({ name, ns = 'library', caps = ['tools'], pulls = '5M', updated = '2 months ago' }) =>
  `<li x-test-model><a href="/library/${name}"><span x-test-model-title title="${name}">${name}</span>` +
  `<span x-test-namespace>${ns}</span>` + caps.map((c) => `<span x-test-capability>${c}</span>`).join('') +
  `<span x-test-pull-count>${pulls}</span><span x-test-updated>${updated}</span></a></li>`;

const HTML = '<ul>' + [
  card({ name: 'gemma3' }),
  card({ name: 'qwen3' }),
  card({ name: 'phi4' }),
  card({ name: 'nomic-embed-text', caps: ['embedding'] }),
  card({ name: 'qwen2.5-coder' }),
  card({ name: 'deepseek-r1' }),
  card({ name: 'warm-nemo', ns: 'gooduser', pulls: '120K' }),   // community, high pulls
  card({ name: 'warm-gemma', ns: 'tinyuser', pulls: '2K' }),    // community, below floor
  card({ name: 'lewd-rp', ns: 'nsfwuser', pulls: '500K' }),     // community, excluded by name
].join('') + '</ul>';

// ── P1 — parseLibrary ────────────────────────────────────────────────────────
{
  const models = parseLibrary(HTML);
  const g = models.find((m) => m.name === 'gemma3');
  const emb = models.find((m) => m.name === 'nomic-embed-text');
  const comm = models.find((m) => m.name === 'warm-nemo' || m.name === 'gooduser/warm-nemo');
  const ok = models.length === 9 && g && g.pulls === 5_000_000 && g.capabilities.includes('tools') && emb?.capabilities.includes('embedding') && comm;
  rec('P1. parseLibrary extracts name·pulls·caps·namespace', ok, `n=${models.length} gemmaPulls=${g?.pulls}`);
}

// ── P2 — parse helpers ───────────────────────────────────────────────────────
{
  const ok = parsePulls('115.5M') === 115_500_000 && parsePulls('1.2K') === 1200 && parsePulls('3,456') === 3456
    && parseParamsB('12.2B') === 12.2 && parseParamsB('8x7B') === 56 && parseParamsB('405B') === 405 && parseParamsB('x') === null;
  rec('P2. parsePulls + parseParamsB', ok, `pulls/params parse`);
}

// ── P3 — buildCatalog: filtering + scoring + ranking ─────────────────────────
{
  const models = parseLibrary(HTML);
  const enriched = {
    gemma3: [{ tag: '12b', paramsB: 12.2, quant: 'Q4_K_M', sizeGb: 8.1 }],
    qwen3: [{ tag: '14b', paramsB: 14.8, quant: 'Q4_K_M', sizeGb: 9.3 }],
    phi4: [{ tag: '14b', paramsB: 14.7, quant: 'Q4_K_M', sizeGb: 9 }],
    'nomic-embed-text': [{ tag: 'latest', paramsB: 0.1, sizeGb: 0.3 }],
    'qwen2.5-coder': [{ tag: '7b', paramsB: 7.6, sizeGb: 5 }],
    'deepseek-r1': [{ tag: '8b', paramsB: 8, sizeGb: 5 }],
    'warm-nemo': [{ tag: '12b', paramsB: 12, sizeGb: 7 }],
    'warm-gemma': [{ tag: '9b', paramsB: 9, sizeGb: 6 }],
    'lewd-rp': [{ tag: '13b', paramsB: 13, sizeGb: 8 }],
  };
  const eqData = { 'google/gemma-3-27b-it': 0.95, 'qwen/qwen3-32b': 0.70 };
  const cat = buildCatalog({ models, enriched, eqData, generatedAt: 'TEST' });
  const names = cat.models.map((m) => m.name);
  const has = (n) => names.includes(n);
  const q = (n) => cat.models.find((m) => m.name === n)?.quality ?? -1;

  // Exclusions: embedding / coder / reasoning-trace / nsfw-rp gone.
  const excluded = !has('nomic-embed-text:latest') && !has('qwen2.5-coder:7b') && !has('deepseek-r1:8b') && !names.some((n) => n.includes('lewd-rp'));
  rec('P3a. excludes embed·coder·r1·nsfw', excluded, names.join(', '));

  // Community floor: low-pull community model dropped; high-pull kept.
  const floor = !names.some((n) => n.includes('warm-gemma')) && names.some((n) => n.includes('warm-nemo'));
  rec('P3b. community popularity floor (drop <10k, keep ≥10k)', floor, names.filter((n) => n.includes('warm')).join(', '));

  // Warmth ranking: gemma > qwen > phi (family prior + EQ bonus).
  const ranked = q('gemma3:12b') > q('qwen3:14b') && q('qwen3:14b') > q('phi4:14b');
  rec('P3c. warmth rank gemma > qwen > phi', ranked, `gemma=${q('gemma3:12b')} qwen=${q('qwen3:14b')} phi=${q('phi4:14b')}`);

  // EQ bonus actually lifts gemma (vs no-eq build).
  const noEq = buildCatalog({ models, enriched, generatedAt: 'TEST' });
  const eqLift = (noEq.models.find((m) => m.name === 'gemma3:12b')?.quality ?? 0) < q('gemma3:12b');
  rec('P3d. EQ-Bench bonus lifts matched family', eqLift, `noEq=${noEq.models.find((m) => m.name === 'gemma3:12b')?.quality} eq=${q('gemma3:12b')}`);

  // Shape: every item carries the fields runtime needs.
  const shape = cat.models.every((m) => m.name && m.family && Number.isFinite(m.paramsB) && Number.isFinite(m.sizeGb) && Number.isFinite(m.quality) && typeof m.bestFor === 'string' && m.namespace);
  rec('P3e. every item has name·family·paramsB·sizeGb·quality·bestFor·namespace', shape, `count=${cat.count}`);

  // Sorted by quality desc, top is the warm gemma.
  const sorted = cat.models[0].name === 'gemma3:12b' && cat.models.every((m, i) => i === 0 || cat.models[i - 1].quality >= m.quality);
  rec('P3f. quality-ranked, gemma tops', sorted, `top=${cat.models[0].name}`);
}

// ── P4 — meta unit checks ────────────────────────────────────────────────────
{
  const ok = familyOf('gooduser/gemma3-tune:12b') === 'gemma' && familyOf('mistral-nemo:12b') === 'mistral-nemo'
    && isExcluded('nomic-embed-text:latest') && isExcluded('x/deepseek-r1:8b') && !isExcluded('gemma3:12b')
    && companionQuality({ name: 'gemma3:12b', pulls: 1e6, updated: '1 month ago' }) > companionQuality({ name: 'phi4:14b', pulls: 1e6, updated: '1 month ago' });
  rec('P4. familyOf·isExcluded·companionQuality', ok, '');
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — dynamic-catalog assembly: parse · filter · floor · warmth-rank · EQ-bonus · shape' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
