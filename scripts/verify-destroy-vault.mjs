// verify:destroy-vault — the node-side factory-reset wipe engine
// (src/account/destroy.js, design docs/DATA-DESTROY-VAULT-DESIGN-2026-07-03.md).
//
//   D1  verifyRecoveryKey: correct→true, wrong/short/non-string→false (constant-time)
//   D2  destroyTargets illustrative list names key artifacts incl. snapshots
//   D3  RECURSIVE wipe removes EVERYTHING under dataDir — incl. an UNLISTED file,
//       a snapshots/ full-vault copy, a *.corrupt-* copy, a *.bak-* companion —
//       the external agentRoot (mind files) too; the SHARED ~/.ollama is UNTOUCHED
//   D4  KEYS-LAST: Keychain deleted only AFTER all fs content is gone
//   D5  best-effort hooks that THROW are recorded in failed[] but never abort
//   D6  fail-closed: no dataDir → throws; unsafe dataDir ('/') → throws
//   D7  shared-Ollama pulled tags passed to deleteOllamaModels; result reflects removed
//   D8  unsafe extraRoot ('/') is skipped + recorded, never recursed
//
// Pure fs against an ABSOLUTE temp dir; no vault boot; no network.
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRecoveryKey, destroyTargets, destroyVault } from '../src/account/destroy.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Absolute paths (the engine refuses a non-absolute dataDir as fail-closed).
const ROOT = join(process.cwd(), 'data', 'verify-destroy-vault');
const DATA = join(ROOT, 'appdata');
const AGENT_ROOT = join(ROOT, 'bundle-agent-mind'); // stands in for agentRoot OUTSIDE dataDir
const SHARED_OLLAMA = join(ROOT, 'home-dot-ollama'); // stands in for ~/.ollama (OUTSIDE everything)
rmSync(ROOT, { recursive: true, force: true });

// ── D1 recovery-key gate ────────────────────────────────────────────────────────
const MASTER = 'a'.repeat(64);
rec('D1 verifyRecoveryKey: correct / wrong / short / non-string',
  verifyRecoveryKey(MASTER, MASTER) === true &&
  verifyRecoveryKey('b'.repeat(64), MASTER) === false &&
  verifyRecoveryKey('abc', MASTER) === false &&
  verifyRecoveryKey(null, MASTER) === false &&
  verifyRecoveryKey(MASTER, undefined) === false);

// ── D2 illustrative target list ───────────────────────────────────────────────────
const names = destroyTargets(DATA).illustrative.map((p) => p.replace(DATA + '/', ''));
rec('D2 destroyTargets illustrative names key artifacts incl. snapshots',
  ['mycelium.db', 'kcv.json', 'uploads', 'snapshots'].every((n) => names.includes(n)), names.join(', '));

// ── seed a REALISTIC data dir (incl. full-vault leftovers) + external roots ────────
function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  // standard artifacts
  for (const n of ['mycelium.db', 'mycelium.db-wal', 'mycelium.search.db', 'auth.db', 'kcv.json', 'Caddyfile', 'frpc.toml', 'remote.json']) writeFileSync(join(DATA, n), 'x');
  for (const d of ['uploads', 'ollama']) { mkdirSync(join(DATA, d), { recursive: true }); writeFileSync(join(DATA, d, 'inner.bin'), 'y'); }
  // the DANGEROUS leftovers an allowlist would miss — full-vault copies under the SAME key
  mkdirSync(join(DATA, 'snapshots'), { recursive: true }); writeFileSync(join(DATA, 'snapshots', 'pre-migrate-123.db'), 'FULLVAULT');
  writeFileSync(join(DATA, 'mycelium.db.corrupt-1735900000'), 'FULLVAULT');
  writeFileSync(join(DATA, 'mycelium.db-wal.bak-1248'), 'WAL');
  writeFileSync(join(DATA, 'some-future-sidecar.db'), 'UNLISTED'); // never in any allowlist
  // external agent root (mind files live here, NOT under dataDir)
  mkdirSync(AGENT_ROOT, { recursive: true }); writeFileSync(join(AGENT_ROOT, 'reflections.md'), 'ENC');
  // the user's own shared ollama — MUST survive
  mkdirSync(SHARED_OLLAMA, { recursive: true }); writeFileSync(join(SHARED_OLLAMA, 'user-model.bin'), 'keep-me');
}

// ── D3/D4 recursive wipe + keys-last ──────────────────────────────────────────────
seed();
let keychainAfterContentGone = false, keychainCalls = 0;
const fakeDeleteKeychain = () => {
  keychainCalls += 1;
  keychainAfterContentGone = !existsSync(DATA) || readdirSync(DATA).length === 0;
};
const r1 = await destroyVault({ dataDir: DATA, extraRoots: [AGENT_ROOT], deleteKeychain: fakeDeleteKeychain });
const dataEmpty = existsSync(DATA) && readdirSync(DATA).length === 0; // dir kept, contents gone
const leftoversGone = !existsSync(join(DATA, 'snapshots')) && !existsSync(join(DATA, 'mycelium.db.corrupt-1735900000')) &&
  !existsSync(join(DATA, 'mycelium.db-wal.bak-1248')) && !existsSync(join(DATA, 'some-future-sidecar.db'));
const agentGone = !existsSync(AGENT_ROOT);
const sharedSafe = existsSync(join(SHARED_OLLAMA, 'user-model.bin'));
rec('D3 recursive wipe: all contents incl. snapshots/corrupt/bak/unlisted + agentRoot gone; shared ~/.ollama safe',
  dataEmpty && leftoversGone && agentGone && sharedSafe && r1.keychainDeleted && r1.failed.length === 0,
  `dataEmpty=${dataEmpty} leftoversGone=${leftoversGone} agentGone=${agentGone} sharedSafe=${sharedSafe} failed=${JSON.stringify(r1.failed)}`);
rec('D4 KEYS-LAST: keychain deleted only after all fs content gone', keychainAfterContentGone && keychainCalls === 1);

// ── D5 throwing hooks don't abort ──────────────────────────────────────────────────
seed();
const r2 = await destroyVault({
  dataDir: DATA, extraRoots: [AGENT_ROOT],
  quiesce: async () => { throw new Error('quiesce boom'); },
  revokeRelay: async () => { throw new Error('relay boom'); },
  deleteOllamaModels: async () => { throw new Error('ollama boom'); },
  pulledOllamaTags: ['llama3:8b'],
  deleteKeychain: () => {},
});
const contentGoneDespiteThrows = existsSync(DATA) && readdirSync(DATA).length === 0 && r2.keychainDeleted === true;
const recordedThrows = r2.failed.filter((f) => ['quiesce', 'relay-revoke', 'ollama-shared'].includes(f.target)).length;
rec('D5 throwing hooks recorded but wipe still completes', contentGoneDespiteThrows && recordedThrows === 3, `failed=${JSON.stringify(r2.failed)}`);

// ── D6 fail-closed ──────────────────────────────────────────────────────────────────
let noDir = false, unsafeDir = false;
try { await destroyVault({ deleteKeychain: () => {} }); } catch { noDir = true; }
try { await destroyVault({ dataDir: '/', deleteKeychain: () => {} }); } catch { unsafeDir = true; }
rec('D6 fail-closed: missing dataDir + unsafe "/" both throw', noDir && unsafeDir);

// ── D7 shared-Ollama pulled tags flow ───────────────────────────────────────────────
seed();
let seenTags = null;
const r3 = await destroyVault({
  dataDir: DATA, pulledOllamaTags: ['llama3:8b', 'nomic-embed'],
  deleteOllamaModels: async (tags) => { seenTags = tags; return { removed: tags, failed: [] }; },
  deleteKeychain: () => {},
});
rec('D7 shared-Ollama pulled tags passed + recorded',
  JSON.stringify(seenTags) === JSON.stringify(['llama3:8b', 'nomic-embed']) &&
  JSON.stringify(r3.ollama.removed) === JSON.stringify(['llama3:8b', 'nomic-embed']));

// ── D8 unsafe extraRoot skipped, never recursed ─────────────────────────────────────
seed();
const r4 = await destroyVault({ dataDir: DATA, extraRoots: ['/', '', 'relative/path'], deleteKeychain: () => {} });
const skipped = r4.failed.filter((f) => f.error === 'unsafe-extra-root-skipped').length;
rec('D8 unsafe extraRoot ("/", "", relative) skipped + recorded, never recursed',
  skipped === 3 && existsSync(SHARED_OLLAMA), `skipped=${skipped}`);

rmSync(ROOT, { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — destroy wipe: gated, RECURSIVE (no allowlist drift), keys-last, external-root + shared-data safe');
