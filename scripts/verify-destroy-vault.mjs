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
//   D8  unsafe extraRoot is skipped + recorded, never recursed; the PREDICATE
//       refuses '/', $HOME (+trailing slash) and one-segment roots
//   D11 content-first/keys-last holds INSIDE extraRoots too (kcv + passphrase
//       seal ordered after every content root)
//   D9  HANDLE-RELEASE HONESTY (QA P0.7): the hook's RETURN VALUE is the outcome.
//       A hook that returns {released:false} must NOT report success, and must
//       carry the reason; an undefined return fails CLOSED (unknown ≠ succeeded);
//       {applicable:false} ("no managed handle") is never rendered as released.
//   D10 CONNECTOR REVOKE (QA P0.9): attempted before the wipe, outcome reported
//       truthfully — a provider we could not reach lands in failed[], never in
//       revoked[]; a throwing hook is recorded and never blocks the wipe.
//
// Pure fs against an ABSOLUTE temp dir; no vault boot; no network.
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { verifyRecoveryKey, destroyTargets, destroyVault, isSafeDestroyRoot, orderKeyMaterialLast } from '../src/account/destroy.js';

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
// The ENGINE is only ever handed values that stay harmless even under a mutation
// (nothing that exists); the dangerous values ($HOME, '/Users', '/', and their
// trailing-slash forms) are asserted against the PREDICATE directly — review F9:
// D8's old fixtures were all caught by the residual clause, so it stayed GO when
// the home/depth guards were removed.
seed();
const r4 = await destroyVault({
  dataDir: DATA,
  extraRoots: ['/mycelium-verify-nonexistent', '', 'relative/path'],
  deleteKeychain: () => {},
});
const skipped = r4.failed.filter((f) => f.error === 'unsafe-extra-root-skipped').length;
const HOME = os.homedir();
const predicateRefuses = ['/', '//', '', 'relative/path', HOME, `${HOME}/`, '/Users', '/Users/', '/tmp']
  .every((p) => isSafeDestroyRoot(p) === false);
const predicateAllows = [join(ROOT, 'x'), '/tmp/mycelium', '/Users/me/vault'].every((p) => isSafeDestroyRoot(p) === true);
rec('D8 predicate refuses "/", "//", $HOME (+trailing slash), one-segment roots, relative; allows a real deep root; engine RECORDS every refusal',
  skipped === 3 && existsSync(SHARED_OLLAMA) && predicateRefuses && predicateAllows,
  `skipped=${skipped} refuses=${predicateRefuses} allows=${predicateAllows}`);

// ── D11 content-first / keys-last WITHIN extraRoots (review F4) ─────────────────
// The Keychain already runs last; this tightens the fs pass so a crash mid-loop
// can leave "key material present, content gone" but never the inverse.
//
// OBSERVE THE REAL WIPE ORDER, not the helper: asserting orderKeyMaterialLast()
// alone is a PROJECTION — deleting its call site left the pure function correct
// and the gate GREEN while the engine wiped in the raw order. So drive
// destroyVault with an injected fs that RECORDS the actual rm sequence.
{
  const rmOrder = [];
  const recordingFs = {
    readdir: async () => [],                       // dataDir already empty; isolate extraRoots
    rm: async (p) => { rmOrder.push(p); },
  };
  const roots = ['/v/kcv.json', '/v/mycelium.db', '/v/vault-lock.json', '/v/uploads', '/v/mind'];
  await destroyVault({ dataDir: DATA, extraRoots: roots, fs: recordingFs, deleteKeychain: () => {} });
  const at = (p) => rmOrder.indexOf(p);
  const lastContentAt = Math.max(at('/v/mycelium.db'), at('/v/uploads'), at('/v/mind'));
  const appliedOrder = at('/v/kcv.json') > lastContentAt && at('/v/vault-lock.json') > lastContentAt;
  // …every root still gets wiped (ordering must not DROP anything) …
  const noneDropped = roots.every((p) => rmOrder.includes(p)) && rmOrder.length === roots.length;
  // …and the content roots keep their given relative order (stable partition).
  const stable = JSON.stringify(rmOrder.filter((p) => !p.endsWith('kcv.json') && !p.endsWith('vault-lock.json')))
    === JSON.stringify(['/v/mycelium.db', '/v/uploads', '/v/mind']);
  rec('D11 the ENGINE wipes extraRoots content-first/keys-last (kcv + passphrase seal after every content root), nothing dropped, stable otherwise',
    appliedOrder && noneDropped && stable, JSON.stringify(rmOrder));
}

// ── D9 handle-release HONESTY ───────────────────────────────────────────────────
// releaseManagedHandle NEVER THROWS by contract, so "did not throw" was reported
// as success for every failure mode: the user was told their handle was freed
// while it was still squatted on the control plane.
{
  seed();
  const rFail = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeRelay: async () => ({ applicable: true, released: false, reason: 'release-503' }),
  });
  seed();
  const rUndef = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeRelay: async () => undefined, // legacy hook shape — must fail CLOSED
  });
  seed();
  const rNA = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeRelay: async () => ({ applicable: false, released: false, reason: 'not-managed' }),
  });
  seed();
  const rOk = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeRelay: async () => ({ applicable: true, released: true }),
  });
  const failHonest = rFail.relayRevoked === false && rFail.relayRelease.released === false
    && rFail.relayRelease.applicable === true && rFail.relayRelease.reason === 'release-503';
  const undefClosed = rUndef.relayRevoked === false && rUndef.relayRelease.released === false
    && rUndef.relayRelease.reason === 'no-outcome-reported';
  const naHonest = rNA.relayRevoked === false && rNA.relayRelease.applicable === false;
  const okHonest = rOk.relayRevoked === true && rOk.relayRelease.released === true;
  rec('D9 handle release: {released:false} → NOT reported as success (+reason); undefined fails CLOSED; not-applicable ≠ released; true → true',
    failHonest && undefClosed && naHonest && okHonest,
    `fail=${JSON.stringify(rFail.relayRelease)} undef=${JSON.stringify(rUndef.relayRelease)} na=${JSON.stringify(rNA.relayRelease)} ok=${JSON.stringify(rOk.relayRelease)} revokedFlags=${rFail.relayRevoked}/${rUndef.relayRevoked}/${rNA.relayRevoked}/${rOk.relayRevoked}`);
}

// ── D10 connector OAuth revoke, honestly reported ──────────────────────────────
{
  seed();
  let revokedBeforeWipe = null;
  const rMixed = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeConnectors: async () => {
      // Must run while the vault (which holds the tokens) is still on disk.
      revokedBeforeWipe = readdirSync(DATA).length > 0;
      return { attempted: 2, revoked: ['gmail'], failed: [{ id: 'notion', reason: 'ETIMEDOUT' }] };
    },
  });
  seed();
  const rThrow = await destroyVault({
    dataDir: DATA, deleteKeychain: () => {},
    revokeConnectors: async () => { throw new Error('connector boom'); },
  });
  const mixedHonest = rMixed.connectors.attempted === 2
    && JSON.stringify(rMixed.connectors.revoked) === JSON.stringify(['gmail'])
    && rMixed.connectors.failed.length === 1 && rMixed.connectors.failed[0].id === 'notion';
  const throwHonest = rThrow.connectors.failed.length === 1
    && rThrow.connectors.revoked.length === 0
    && rThrow.failed.some((f) => f.target === 'connector-revoke')
    && existsSync(DATA) && readdirSync(DATA).length === 0 && rThrow.keychainDeleted === true;
  rec('D10 connector revoke runs BEFORE the wipe; unreachable provider reported failed (not revoked); a throw is recorded and never blocks',
    mixedHonest && throwHonest && revokedBeforeWipe === true,
    `beforeWipe=${revokedBeforeWipe} mixed=${JSON.stringify(rMixed.connectors)} throw=${JSON.stringify(rThrow.connectors)}`);
}

rmSync(ROOT, { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — destroy wipe: gated, RECURSIVE (no allowlist drift), keys-last, external-root + shared-data safe');
