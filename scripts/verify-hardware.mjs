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
import { CATALOG } from '../src/hardware/catalog.js';
import { detectHardware } from '../src/hardware/detect.js';
import { createOllamaClient, isValidModelName } from '../src/hardware/ollama.js';
import { createOllamaDaemon, findOllamaBinary } from '../src/hardware/ollama-daemon.js';
import { installOllama, resolveAsset, OLLAMA_VERSION } from '../src/hardware/ollama-install.js';

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

// ── H4 — recommendModels (v3: DYNAMIC catalog, invariants + anchors) ──────────
// The catalog is now generated (catalog.json, ~300 models) so tests assert
// INVARIANTS that survive catalog growth + a few stable ANCHORS, not a fixed
// size or exact ordering. Full list returned, best-first, two bands — Band A
// (fits) by rankScore=quality×fitWeight desc, then Band B (won't fit) by paramsB.
{
  const N = CATALOG.length; // dynamic — the recommender returns the full catalog
  const anchor = (recs, name) => recs.find((m) => m.name === name);
  const bandsOrdered = (recs) => {
    const lastFit = recs.reduce((acc, m, i) => (m.fitScore > 0 ? i : acc), -1);
    const firstUnfit = recs.findIndex((m) => m.fitScore === 0);
    return firstUnfit === -1 || lastFit < firstUnfit;
  };

  // 8GB GPU → full list, bands ordered, top fits; the 70B is SHOWN as won't-fit.
  const r8 = recommendModels({ hasGpu: true, gpuVramGb: 8, totalRamGb: 16, backend: 'cuda' });
  const l70 = anchor(r8.recommendations, 'llama3.3:70b');
  const ok8 = r8.available === 8 && r8.recommendations.length === N && r8.recommendations[0].fitScore > 0
    && l70 && l70.fitScore === 0 && l70.fitLevel === 'too_tight' && bandsOrdered(r8.recommendations);
  rec('H4a. 8GB GPU → full list, bands ordered, 70B won\'t-fit', ok8, `top=${r8.recommendations[0].name}@${r8.recommendations[0].fitScore} 70b.fit=${l70?.fitScore} n=${N}`);

  // 80GB GPU → a right-sized large model leads (fitScore 100, not under-using).
  const r80 = recommendModels({ hasGpu: true, gpuVramGb: 80, totalRamGb: 128, backend: 'cuda' });
  rec('H4b. 80GB GPU → top is a right-sized fit (100)', r80.recommendations[0].fitScore === 100 && bandsOrdered(r80.recommendations), `top=${r80.recommendations[0].name}@${r80.recommendations[0].fitScore}`);

  // 16GB Apple (avail ~10.7) → COMPANION PROOF: the warm anchor gemma3:12b fits
  // and out-ranks a comparable cooler qwen (warmth wins at similar fit).
  const rA = recommendModels({ hasGpu: true, unifiedMemory: true, gpuVramGb: 10.7, totalRamGb: 16, backend: 'metal' });
  const g12 = anchor(rA.recommendations, 'gemma3:12b');
  const q14 = anchor(rA.recommendations, 'qwen3:14b');
  const warmTop = ['gemma', 'mistral-nemo', 'nemo', 'command-r', 'command', 'hermes', 'mistral-small', 'llama'].includes(rA.recommendations[0].family);
  const okA = g12 && g12.fitScore > 0 && warmTop && (!q14 || g12.rankScore >= q14.rankScore);
  rec('H4b2. 16GB Mac → warm anchor fits + leads cooler peers', okA, `top=${rA.recommendations[0].name}(${rA.recommendations[0].family}) gemma3:12b.rank=${g12?.rankScore} qwen3:14b.rank=${q14?.rankScore}`);

  // 4GB CPU (avail 2.4) → something small fits, no warning; full list returned.
  const r4 = recommendModels({ hasGpu: false, totalRamGb: 4, backend: 'cpu' });
  const ok4 = r4.available === 2.4 && r4.recommendations.length === N && r4.recommendations[0].fitScore > 0
    && r4.note === null && r4.recommendations.some((m) => m.fitScore === 0);
  rec('H4c. 4GB CPU → small fits, big won\'t-fit, no warning', ok4, `top=${r4.recommendations[0].name} avail=${r4.available}`);

  // Tiny box (avail < the smallest model) → nothing fits → full list, smallest
  // first, note set. (The full catalog has sub-GB models, so the budget must be
  // genuinely tiny to exercise the "nothing fits" path.)
  const r1 = recommendModels({ hasGpu: false, totalRamGb: 0.5, backend: 'cpu' });
  const minParams = Math.min(...r1.recommendations.map((m) => m.paramsB));
  const ok1 = r1.recommendations.length === N && r1.recommendations.every((m) => m.fitScore === 0)
    && r1.recommendations[0].paramsB === minParams && typeof r1.note === 'string';
  rec('H4d. nothing fits → full list, smallest first, note', ok1, `n=${N} top=${r1.recommendations[0].name} note=${r1.note ? 'set' : 'null'}`);

  rec('H4e. availableMemoryGb prefers VRAM then 60% RAM', availableMemoryGb({ hasGpu: true, gpuVramGb: 12 }) === 12 && availableMemoryGb({ hasGpu: false, totalRamGb: 16 }) === 9.6, '');

  // Every item carries the fields the runtime/UI need.
  const fields = recommendModels({ hasGpu: true, gpuVramGb: 16, totalRamGb: 32, backend: 'cuda' }).recommendations
    .every((m) => Number.isFinite(m.quality) && typeof m.bestFor === 'string' && m.bestFor && Number.isFinite(m.rankScore) && typeof m.family === 'string' && m.namespace);
  rec('H4f. items carry quality·bestFor·rankScore·family·namespace', fields, `N=${N}`);
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

// ── H7 — ollama-daemon (lazy adopt-or-spawn; injected isUp/findBinary/spawn) ──
{
  // A fake spawn that records calls and returns a controllable child.
  const mkSpawn = () => {
    const calls = [];
    const fn = (bin, args, opts) => {
      const child = { killed: false, _exit: null,
        stderr: { on() {} }, on(ev, cb) { if (ev === 'exit') this._exit = cb; }, kill() { this.killed = true; } };
      calls.push({ bin, args, opts, child });
      return child;
    };
    fn.calls = calls;
    return fn;
  };
  // isUp that returns the values in `seq` in order (last value sticks).
  const mkIsUp = (seq) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };

  // H7a — already up → adopt, never spawn.
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({ isUp: mkIsUp([true]), findBinary: () => '/usr/local/bin/ollama', spawn, pollMs: 1 });
    const r = await d.ensureUp();
    rec('H7a. ensureUp adopts a running daemon (no spawn)', r.ok === true && r.adopted === true && spawn.calls.length === 0, `adopted=${r.adopted} spawns=${spawn.calls.length}`);
  }

  // H7b — not installed + auto-install OFF → fail closed, no spawn.
  // (The auto-install ON path is H9a/H9c.)
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({ isUp: mkIsUp([false]), findBinary: () => null, autoInstall: false, spawn, pollMs: 1 });
    const r = await d.ensureUp();
    rec('H7b. not installed (auto-install off) → not_installed, no spawn', r.ok === false && r.reason === 'not_installed' && spawn.calls.length === 0, `reason=${r.reason} spawns=${spawn.calls.length}`);
  }

  // H7c — installed + down → spawn `ollama serve`, poll, come up.
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({ isUp: mkIsUp([false, true]), findBinary: () => '/opt/homebrew/bin/ollama', spawn, pollMs: 1, startTimeoutMs: 1000 });
    const r = await d.ensureUp();
    const c = spawn.calls[0];
    const noSecrets = c && !('USER_MASTER' in (c.opts.env || {})) && !('SYSTEM_KEY' in (c.opts.env || {}));
    rec('H7c. installed+down → spawn serve, poll up', r.ok === true && r.adopted === false && spawn.calls.length === 1 && c.bin === '/opt/homebrew/bin/ollama' && c.args.join(' ') === 'serve' && c.opts.detached === false && noSecrets, `bin=${c?.bin} args=${c?.args} adopted=${r.adopted}`);
  }

  // H7d — never comes up → start_timeout.
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({ isUp: mkIsUp([false]), findBinary: () => '/opt/homebrew/bin/ollama', spawn, pollMs: 1, startTimeoutMs: 8 });
    const r = await d.ensureUp();
    rec('H7d. never binds → start_timeout', r.ok === false && r.reason === 'start_timeout' && spawn.calls.length === 1, `reason=${r.reason}`);
  }

  // H7e — single-flight: two concurrent ensureUp() → ONE spawn.
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({ isUp: mkIsUp([false, true]), findBinary: () => '/opt/homebrew/bin/ollama', spawn, pollMs: 2, startTimeoutMs: 1000 });
    const [r1, r2] = await Promise.all([d.ensureUp(), d.ensureUp()]);
    rec('H7e. single-flight → one spawn for concurrent calls', r1.ok && r2.ok && spawn.calls.length === 1, `spawns=${spawn.calls.length}`);
  }

  // H7f — findOllamaBinary resolution order (injected existsSync + env).
  {
    const override = findOllamaBinary({ env: { MYCELIUM_OLLAMA: '/custom/ollama', PATH: '' }, existsSync: (p) => p === '/custom/ollama' });
    const brew = findOllamaBinary({ env: { PATH: '' }, existsSync: (p) => p === '/opt/homebrew/bin/ollama' });
    const onPath = findOllamaBinary({ env: { PATH: '/x:/y' }, existsSync: (p) => p === '/y/ollama' });
    const none = findOllamaBinary({ env: { PATH: '/x' }, existsSync: () => false });
    rec('H7f. findOllamaBinary: env override > absolute > PATH > null', override === '/custom/ollama' && brew === '/opt/homebrew/bin/ollama' && onPath === '/y/ollama' && none === null, `${override}|${brew}|${onPath}|${none}`);
  }

  // H7g — stop() kills only a daemon WE spawned, never an adopted one.
  {
    const spawnA = mkSpawn();
    const dSpawned = createOllamaDaemon({ isUp: mkIsUp([false, true]), findBinary: () => '/opt/homebrew/bin/ollama', spawn: spawnA, pollMs: 1, startTimeoutMs: 1000 });
    await dSpawned.ensureUp();
    dSpawned.stop();
    const killedOurs = spawnA.calls[0]?.child.killed === true;

    const spawnB = mkSpawn();
    const dAdopted = createOllamaDaemon({ isUp: mkIsUp([true]), findBinary: () => '/opt/homebrew/bin/ollama', spawn: spawnB, pollMs: 1 });
    await dAdopted.ensureUp();
    dAdopted.stop();
    const noKillAdopted = spawnB.calls.length === 0;
    rec('H7g. stop() kills only spawnedByUs', killedOurs && noKillAdopted, `killedOurs=${killedOurs} adoptedSpawns=${spawnB.calls.length}`);
  }
}

// ── H8 — ollama-install (download → verify → extract; all injected) ───────────
{
  // H8a — resolveAsset platform/arch → pinned asset + sha; unsupported → null.
  const mac = resolveAsset({ platform: 'darwin', arch: 'arm64' });
  const lx = resolveAsset({ platform: 'linux', arch: 'x64' });
  const la = resolveAsset({ platform: 'linux', arch: 'arm64' });
  const none = resolveAsset({ platform: 'sunos', arch: 'sparc' });
  const okA = mac?.asset === 'ollama-darwin.tgz' && /^[0-9a-f]{64}$/.test(mac.sha256) && mac.url.includes(OLLAMA_VERSION)
    && lx?.asset === 'ollama-linux-amd64.tar.zst' && la?.asset === 'ollama-linux-arm64.tar.zst' && none === null;
  rec('H8a. resolveAsset maps platform→pinned asset+sha', okA, `mac=${mac?.asset} lx=${lx?.asset} none=${none}`);

  // Shared injected fs + spies.
  const mkFs = (binExists = true) => {
    const calls = { rm: [], chmod: [], mkdir: [] };
    return { calls, mkdir: async (p) => { calls.mkdir.push(p); }, rm: async (p) => { calls.rm.push(p); }, chmod: async (p) => { calls.chmod.push(p); }, existsSync: (p) => binExists && /\/ollama\/ollama$/.test(p) };
  };

  // H8b — happy path: sha matches the pinned darwin hash → extract + chmod + binPath.
  {
    const fs = mkFs(true);
    let extracted = false, downloaded = false, progress = 0;
    const r = await installOllama({
      dataDir: '/data', platform: 'darwin', arch: 'arm64',
      download: async (_url, _dest, onP) => { downloaded = true; onP?.(50, 50, 100); progress = 50; },
      sha256: async () => resolveAsset({ platform: 'darwin' }).sha256, // matches
      extract: async () => { extracted = true; },
      fs, onProgress: () => {},
    });
    rec('H8b. install happy path → verify, extract, chmod, binPath', r.ok === true && downloaded && extracted && /\/ollama\/ollama$/.test(r.binPath || '') && fs.calls.chmod.length === 1 && progress === 50, `ok=${r.ok} bin=${r.binPath}`);
  }

  // H8c — CHECKSUM MISMATCH → delete + abort BEFORE extract (the security assertion).
  {
    const fs = mkFs(true);
    let extracted = false;
    const r = await installOllama({
      dataDir: '/data', platform: 'darwin', arch: 'arm64',
      download: async () => {},
      sha256: async () => 'deadbeef'.repeat(8), // 64 hex, wrong
      extract: async () => { extracted = true; },
      fs,
    });
    rec('H8c. checksum mismatch → abort before extract, file deleted', r.ok === false && r.reason === 'checksum_mismatch' && extracted === false && fs.calls.rm.length >= 1, `reason=${r.reason} extracted=${extracted} rm=${fs.calls.rm.length}`);
  }

  // H8d — unsupported platform → no download.
  {
    const fs = mkFs(true);
    let downloaded = false;
    const r = await installOllama({ dataDir: '/data', platform: 'sunos', arch: 'sparc', download: async () => { downloaded = true; }, sha256: async () => '', extract: async () => {}, fs });
    rec('H8d. unsupported platform → no download', r.ok === false && r.reason === 'unsupported_platform' && downloaded === false, `reason=${r.reason}`);
  }
}

// ── H9 — daemon auto-install rung (download-then-spawn) ───────────────────────
{
  const mkSpawn = () => { const calls = []; const fn = (bin, args, opts) => { const c = { stderr: { on() {} }, on() {}, kill() {} }; calls.push({ bin, args, opts, child: c }); return c; }; fn.calls = calls; return fn; };
  const mkIsUp = (seq) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };

  // H9a — not installed + autoInstall → provision() then spawn the downloaded bin.
  {
    const spawn = mkSpawn();
    let installs = 0;
    const d = createOllamaDaemon({
      isUp: mkIsUp([false, true]), findBinary: () => null, dataDir: '/data', autoInstall: true,
      install: async () => { installs++; return { ok: true, binPath: '/data/ollama/ollama' }; },
      spawn, pollMs: 1, startTimeoutMs: 1000,
    });
    const r = await d.ensureUp();
    const c = spawn.calls[0];
    const modelsEnv = c?.opts?.env?.OLLAMA_MODELS;
    rec('H9a. auto-install → download then spawn downloaded bin', r.ok === true && installs === 1 && c?.bin === '/data/ollama/ollama' && c.args.join(' ') === 'serve' && /\/data\/ollama\/models$/.test(modelsEnv || ''), `installs=${installs} bin=${c?.bin} models=${modelsEnv}`);
  }

  // H9b — install fails → ensureUp returns the reason, never spawns.
  {
    const spawn = mkSpawn();
    const d = createOllamaDaemon({
      isUp: mkIsUp([false]), findBinary: () => null, dataDir: '/data', autoInstall: true,
      install: async () => ({ ok: false, reason: 'download_failed' }), spawn, pollMs: 1,
    });
    const r = await d.ensureUp();
    rec('H9b. install fails → reason surfaced, no spawn', r.ok === false && r.reason === 'download_failed' && spawn.calls.length === 0, `reason=${r.reason} spawns=${spawn.calls.length}`);
  }

  // H9c — autoInstall OFF + not installed → not_installed, never downloads.
  {
    const spawn = mkSpawn();
    let installs = 0;
    const d = createOllamaDaemon({ isUp: mkIsUp([false]), findBinary: () => null, dataDir: '/data', autoInstall: false, install: async () => { installs++; return { ok: true, binPath: 'x' }; }, spawn, pollMs: 1 });
    const r = await d.ensureUp();
    rec('H9c. autoInstall off → not_installed, no download', r.ok === false && r.reason === 'not_installed' && installs === 0, `reason=${r.reason} installs=${installs}`);
  }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — fit math · ranking · detection · ollama client · daemon · auto-install all verified' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
