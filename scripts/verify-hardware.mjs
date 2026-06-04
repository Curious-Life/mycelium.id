// verify:hardware — the S6 "Cookbook" recommender core.
//   H1 estimateMemoryGb matches the borrowed odysseus formula (table-test)
//   H2 fitScore ratio buckets (0 / right-size 100 / tight 70 / very-tight 50)
//   H3 fitLevel badges derive from the score
//   H4 recommendModels ranks by fit, right-sizes, excludes too-tight, handles "nothing fits"
//   H5 detectHardware with INJECTED os/nvidia-smi/sysfs (NVIDIA · Apple unified · CPU-only)
//   H6 ollama client: listInstalled, isUp, pullModel NDJSON progress, model-name validation
// Pure; no network; CWD-independent. Never logs a secret.
import assert from 'node:assert';
import { estimateMemoryGb, fitScore, fitLevel, QUANT_BPP } from '../src/hardware/fit.js';
import { recommendModels, availableMemoryGb } from '../src/hardware/recommend.js';
import { detectHardware } from '../src/hardware/detect.js';
import { createOllamaClient, isValidModelName } from '../src/hardware/ollama.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── H1 — estimateMemoryGb (weights + KV-cache + 0.5 overhead) ────────────────
{
  const m8 = estimateMemoryGb(8.0, 'Q4_K_M', 8192);     // 8*0.58 + 8e-6*8*8192 + 0.5 = 5.7
  const m1 = estimateMemoryGb(1.5, 'Q4_K_M', 8192);     // 1.5*0.58 + … + 0.5 = 1.5
  const m70 = estimateMemoryGb(70.6, 'Q4_K_M', 8192);   // 46.1
  const bppOk = QUANT_BPP.Q4_K_M === 0.58 && QUANT_BPP.F16 === 2.0;
  rec('H1. estimateMemoryGb matches odysseus formula', m8 === 5.7 && m1 === 1.5 && m70 === 46.1 && bppOk, `8b=${m8} 1.5b=${m1} 70b=${m70}`);
}

// ── H2 — fitScore buckets ────────────────────────────────────────────────────
{
  const tooBig = fitScore(11, 10);   // 0
  const rightA = fitScore(5, 10);    // ratio .5 → 100
  const rightB = fitScore(7, 10);    // ratio .7 → 100
  const tiny = fitScore(2, 10);      // ratio .2 → 76
  const tight = fitScore(8.5, 10);   // ratio .85 → 70
  const vtight = fitScore(9.5, 10);  // ratio .95 → 50
  const full = fitScore(10, 10);     // ratio 1.0, not > avail → 50
  const noMem = fitScore(5, 0);      // no memory → 0
  const ok = tooBig === 0 && rightA === 100 && rightB === 100 && tiny === 76 && tight === 70 && vtight === 50 && full === 50 && noMem === 0;
  rec('H2. fitScore ratio buckets', ok, `big=${tooBig} .5=${rightA} .7=${rightB} .2=${tiny} .85=${tight} .95=${vtight} full=${full} noMem=${noMem}`);
}

// ── H3 — fitLevel badges ─────────────────────────────────────────────────────
{
  const perfect = fitLevel(5, 10);    // score 100
  const good = fitLevel(8.5, 10);     // score 70
  const marginal = fitLevel(9.5, 10); // score 50
  const tooTight = fitLevel(11, 10);  // score 0
  const goodTiny = fitLevel(2, 10);   // score 76 → good
  const ok = perfect === 'perfect' && good === 'good' && marginal === 'marginal' && tooTight === 'too_tight' && goodTiny === 'good';
  rec('H3. fitLevel derives from score', ok, `${perfect}/${good}/${marginal}/${tooTight}/${goodTiny}`);
}

// ── H4 — recommendModels ─────────────────────────────────────────────────────
{
  // 8GB discrete GPU → right-size to the largest model that still fits well.
  const r8 = recommendModels({ hasGpu: true, gpuVramGb: 8, totalRamGb: 16, backend: 'cuda' });
  const top8 = r8.recommendations[0];
  const no70in8 = !r8.recommendations.find((m) => m.name === 'llama3.3:70b');
  const allFit8 = r8.recommendations.every((m) => m.fitScore > 0);
  rec('H4a. 8GB GPU → right-sized pick, too-big excluded', r8.available === 8 && top8.fitScore === 100 && top8.name === 'gemma2:9b' && no70in8 && allFit8, `top=${top8.name}@${top8.fitScore} n=${r8.recommendations.length}`);

  // 80GB GPU → the frontier 70B is the best fit.
  const r80 = recommendModels({ hasGpu: true, gpuVramGb: 80, totalRamGb: 128, backend: 'cuda' });
  rec('H4b. 80GB GPU → 70B is the top fit', r80.recommendations[0].name === 'llama3.3:70b' && r80.recommendations[0].fitScore === 100, `top=${r80.recommendations[0].name}@${r80.recommendations[0].fitScore}`);

  // 4GB laptop, no GPU → available 2.4GB → only the tiny model fits.
  const r4 = recommendModels({ hasGpu: false, totalRamGb: 4, backend: 'cpu' });
  rec('H4c. 4GB CPU → only tiny fits, no warning', r4.available === 2.4 && r4.recommendations[0].name === 'qwen2.5:1.5b' && r4.note === null, `top=${r4.recommendations[0].name} avail=${r4.available} note=${r4.note}`);

  // 1GB → nothing fits → smallest shown + a note.
  const r1 = recommendModels({ hasGpu: false, totalRamGb: 1, backend: 'cpu' });
  rec('H4d. nothing fits → smallest + note', r1.recommendations.length === 1 && r1.recommendations[0].name === 'qwen2.5:1.5b' && typeof r1.note === 'string', `n=${r1.recommendations.length} note=${r1.note ? 'set' : 'null'}`);

  rec('H4e. availableMemoryGb prefers VRAM then 60% RAM', availableMemoryGb({ hasGpu: true, gpuVramGb: 12 }) === 12 && availableMemoryGb({ hasGpu: false, totalRamGb: 16 }) === 9.6, '');
}

// ── H5 — detectHardware (injected probes) ────────────────────────────────────
{
  const mkOs = ({ total, free, arch, platform, cores = 8 }) => ({
    totalmem: () => total, freemem: () => free, arch: () => arch, platform: () => platform,
    cpus: () => Array.from({ length: cores }, () => ({ model: 'Test CPU @ 3.0GHz' })),
  });
  const GB = 1024 ** 3;

  const nvidia = await detectHardware({
    osMod: mkOs({ total: 16 * GB, free: 8 * GB, arch: 'x64', platform: 'linux' }),
    runCmd: async () => '8192, NVIDIA GeForce RTX 3070\n',
    listDrm: () => [],
  });
  rec('H5a. NVIDIA via nvidia-smi', nvidia.hasGpu && nvidia.backend === 'cuda' && nvidia.gpuVramGb === 8 && nvidia.gpuName === 'NVIDIA GeForce RTX 3070' && nvidia.totalRamGb === 16, `vram=${nvidia.gpuVramGb} name=${nvidia.gpuName}`);

  const apple = await detectHardware({
    osMod: mkOs({ total: 32 * GB, free: 16 * GB, arch: 'arm64', platform: 'darwin' }),
    runCmd: async () => { throw new Error('no nvidia-smi'); },
  });
  rec('H5b. Apple Silicon unified memory (32GB→0.75)', apple.hasGpu && apple.unifiedMemory && apple.backend === 'metal' && apple.gpuVramGb === 24, `vram=${apple.gpuVramGb}`);

  const cpu = await detectHardware({
    osMod: mkOs({ total: 8 * GB, free: 4 * GB, arch: 'x64', platform: 'linux' }),
    runCmd: async () => { throw new Error('ENOENT'); },
    listDrm: () => [],
  });
  rec('H5c. CPU-only fallback (no GPU)', !cpu.hasGpu && cpu.backend === 'cpu' && cpu.gpuVramGb === 0 && cpu.cpuCores === 8, `backend=${cpu.backend}`);
}

// ── H6 — ollama client ───────────────────────────────────────────────────────
{
  rec('H6a. isValidModelName allowlist', isValidModelName('llama3.1:8b') && isValidModelName('library/qwen2.5:7b') && !isValidModelName('foo; rm -rf /') && !isValidModelName(''), '');

  const tagsFetch = async (url) => {
    assert.match(url, /\/api\/tags$/);
    return { ok: true, async json() { return { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] }; } };
  };
  const installed = await createOllamaClient({ fetch: tagsFetch }).listInstalled();
  rec('H6b. listInstalled parses /api/tags', installed.length === 2 && installed[0] === 'llama3.1:8b', installed.join(','));

  const up = await createOllamaClient({ fetch: async () => ({ ok: true }) }).isUp();
  const down = await createOllamaClient({ fetch: async () => { throw new Error('refused'); } }).isUp();
  rec('H6c. isUp true when reachable, false when not', up === true && down === false, `up=${up} down=${down}`);

  // pullModel: NDJSON stream of progress lines → onProgress events, returns true.
  const ndjson = ['{"status":"pulling manifest"}', '{"status":"downloading","completed":50,"total":100}', '{"status":"success"}'].join('\n') + '\n';
  const pullFetch = async (url, opts) => {
    assert.match(url, /\/api\/pull$/);
    assert.equal(JSON.parse(opts.body).name, 'llama3.2:3b');
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ndjson)); c.close(); } });
    return { ok: true, body };
  };
  const events = [];
  const pulled = await createOllamaClient({ fetch: pullFetch }).pullModel('llama3.2:3b', (e) => events.push(e));
  rec('H6d. pullModel streams NDJSON progress', pulled === true && events.length === 3 && events[1].completed === 50, `events=${events.length}`);

  // pull error line → throws.
  let threw = false;
  const errFetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":"file does not exist"}\n')); c.close(); } }) });
  try { await createOllamaClient({ fetch: errFetch }).pullModel('llama3.2:3b'); } catch { threw = true; }
  rec('H6e. pull error line rejects', threw, '');

  // invalid name never reaches fetch.
  let blocked = false; let touched = false;
  try { await createOllamaClient({ fetch: async () => { touched = true; return { ok: true, body: null }; } }).pullModel('bad name; evil'); } catch { blocked = true; }
  rec('H6f. invalid model name blocked before fetch', blocked && !touched, '');
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — fit math · ranking · detection · ollama client all verified' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
