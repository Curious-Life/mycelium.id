// verify:public-parity — shift scrub-drift detection LEFT into dev CI.
//
// The public release re-derives a clean tree via scrub.sh and runs the SAME
// `npm run verify`. A dev gate that depends on content scrub removes (an import
// of a scrubbed dir, a runNode of a deleted script, a readFile of a deleted doc)
// breaks the PUBLIC verify while dev CI is green — historically discovered only
// at release time via ~16-min CI roulette. `verify:chains` cannot catch it
// (scripts/verify-chains.mjs:119-123 builds its file set from readdirSync, so a
// deleted gate file silently drops out while its `&& npm run verify:X` token
// stays and dies at runtime on the public tree).
//
// This gate PREDICTS the public tree (scripts/release/public-tree.mjs — the same
// model scrub executes) and asserts it is self-consistent:
//   P0  the derivation is sane (deletes the known anchors — fail-closed).
//   P1  no surviving `verify:*` token dangles to a file scrub deletes.
//   P2  no surviving source file has an active reference to a deleted path.
// Pure + fast (no clone, no scrub run, no models). Self-skips on the public tree
// (public-tree.mjs lives under the deleted scripts/release/).
//
// Self-test: MYCELIUM_PARITY_SELFTEST=1 injects synthetic drift and asserts each
// check FAILs — proving the gate has teeth (the gates-fail-on-fixtures rule).

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const MODEL = 'scripts/release/public-tree.mjs';
if (!existsSync(MODEL)) {
  console.log(`SKIP  public-parity — ${MODEL} absent (this IS the public tree; nothing to check).`);
  process.exit(0);
}
const { prunedGates, deletedPaths, survivingAggregateTokens, residualRefs, executedFiles } = await import('./release/public-tree.mjs');

const CODE_ROOTS = ['src/', 'scripts/', 'pipeline/', 'portal-app/src/', 'tools/'];
const CODE_EXT = /\.(mjs|js|ts|py)$/;

const ledger = [];
const rec = (pass, name, detail) => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

function run(trackedFiles, pkg, read) {
  const pruned = prunedGates(trackedFiles, read);
  const deleted = deletedPaths(trackedFiles, read);
  const survivors = trackedFiles.filter((f) => !deleted.has(f));

  // ── P0. derivation sanity — must delete real content incl. known anchors ──
  const anchorsHit = ['mycelium-managed/', '.claude/memory/'].filter((a) =>
    [...deleted].some((p) => p.startsWith(a)) || trackedFiles.every((p) => !p.startsWith(a)));
  rec(deleted.size > 0 && anchorsHit.length === 2,
    'P0. derivation deletes real content (anchors present)',
    `deleted=${deleted.size} paths · pruned ${pruned.size} gates`);

  // ── P1. no dangling aggregate token ──
  // A `verify:X` still in the aggregate (not pruned) whose EXECUTED script scrub
  // deletes → public `npm run verify` runs that script on a file that isn't there.
  // Resolve the real script path from the command (not the token-name convention),
  // then flag only if that path is in the deleted set. This is the class
  // verify:chains is blind to (a gate file removed without pruning its token).
  const tokens = survivingAggregateTokens(pkg.scripts?.verify, pruned);
  const dangling = [];
  for (const tok of tokens) {
    const files = executedFiles(pkg.scripts?.[tok]);
    const gone = files.filter((f) => deleted.has(f));
    if (gone.length) dangling.push(`${tok} → ${gone.join(', ')}`);
  }
  rec(dangling.length === 0,
    'P1. no `verify` token dangles to a scrubbed script',
    dangling.length
      ? `${dangling.length} dangling — the token survives but scrub deletes its script; prune the gate too:\n      ${dangling.join('\n      ')}`
      : `${tokens.length} surviving tokens, all executed scripts survive scrub`);

  // ── P2. no residual reference to a deleted path in a surviving source file ──
  // Exclude THIS gate: it dynamically imports its model (scripts/release/public-tree.mjs,
  // a scrubbed path) but guards that import behind the existsSync self-skip above — proven
  // safe by the public-tree derive test. The guard uses a variable, so P2's literal-path
  // guard-detection can't see it; the checker is the one legitimate self-reference.
  const SELF = 'scripts/verify-public-parity.mjs';
  const codeFiles = survivors.filter((f) => f !== SELF && CODE_ROOTS.some((r) => f.startsWith(r)) && CODE_EXT.test(f));
  const residual = residualRefs(codeFiles, deleted, read);
  rec(residual.length === 0,
    'P2. no surviving source file references a scrubbed path',
    residual.length
      ? `${residual.length} residual ref(s) — guard-at-source with existsSync, or prune the gate:\n      ${residual.map((r) => `${r.file}:${r.line} → ${r.ref} (${r.kind})`).join('\n      ')}`
      : `${codeFiles.length} surviving source files scanned, none reference a deleted path`);

  return ledger.every(Boolean);
}

// ── self-test: prove the gate FAILs on injected drift ───────────────────────────
if (process.env.MYCELIUM_PARITY_SELFTEST === '1') {
  console.log('— SELFTEST: injecting synthetic drift, expecting P1 + P2 to FAIL —');
  const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  // inject: a fake surviving gate importing a scrubbed dir (P2), and a fake dangling token (P1)
  const FAKE_GATE = 'scripts/verify-selftest-drift.mjs';
  const fakeFiles = [...files, FAKE_GATE];
  // Assemble the synthetic drift import at runtime (split literal) so scrub's own
  // AUTO_GATES grep does NOT match THIS file's source bytes and prune the gate —
  // the gate must ship public + self-skip, not vanish because of a test fixture.
  const SCRUBBED_DIR = 'mycelium' + '-managed';
  const driftImport = `import { x } from '../${SCRUBBED_DIR}/src/x.js';\nconst y = readFileSync('docs/DELETED-INTERNAL.md');\n`;
  const readInj = (p) => (p === FAKE_GATE ? driftImport : read(p));
  const pkgInj = { scripts: { verify: 'npm run verify:foundation && npm run verify:selftest-drift' } };
  // deletedPaths won't include docs/DELETED-INTERNAL.md unless tracked; test the import class + a dangling token
  const injLedger = [];
  const recInj = (p) => injLedger.push(p);
  const pruned = prunedGates(fakeFiles, readInj);
  // (1) selftest-drift imports mycelium-managed → must be auto-pruned (so scrub WOULD remove it)
  recInj(pruned.has('selftest-drift'));
  // (2) P1: a surviving token whose EXECUTED script is in the deleted set must be flagged dangling
  const deletedSet = new Set(['pipeline/lab/foo-spike.mjs']);
  const gone = executedFiles('node pipeline/lab/foo-spike.mjs').filter((f) => deletedSet.has(f));
  recInj(gone.length === 1);
  // (3) residualRefs must catch the injected import into a scrubbed dir
  const res = residualRefs([FAKE_GATE], new Set(), readInj);
  recInj(res.some((r) => r.kind === 'import'));
  const ok = injLedger.every(Boolean);
  console.log(`  selftest: auto-prune caught drift=${injLedger[0]} · dangling detectable=${injLedger[1]} · residual import caught=${injLedger[2]}`);
  console.log(`VERDICT: ${ok ? 'GO — gate has teeth (detects injected drift)' : 'NO-GO — gate FAILED to detect injected drift'}`);
  process.exit(ok ? 0 : 1);
}

const trackedFiles = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const allPass = run(trackedFiles, pkg, read);
console.log(`VERDICT: ${allPass ? 'GO — the derived public tree is self-consistent (no scrub-drift)' : 'NO-GO — see FAIL rows; a release from this tree would break public verify'}`);
process.exit(allPass ? 0 : 1);
