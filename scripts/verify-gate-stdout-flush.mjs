#!/usr/bin/env node
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
/**
 * verify:gate-stdout-flush — a gate's VERDICT must survive a piped stdout.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * `process.exit()` does not flush a pipe-backed stdout. Node's own docs: writes to
 * process.stdout are "asynchronous ... Pipes (and sockets): synchronous on Windows and
 * Linux, asynchronous on macOS". Every gate in this repo ends by printing
 * `VERDICT: GO` / `VERDICT: NO-GO` and then calling process.exit(). If the ledger exceeds
 * the pipe buffer (64 KiB) and the reader is not draining, the queued tail is DISCARDED:
 * the report truncates mid-line and the VERDICT line is swallowed.
 *
 * A caller that greps stdout for the verdict then matches NOTHING — and "no match" can
 * read as success. That is the M-001 "green for the wrong reason" class at suite scale.
 * Measured here (Node v22 / Darwin), a 1.8 MB ledger through a stalled reader lost the
 * VERDICT 10/10 trials via `| tail -1` and 2/10 via `$(command substitution)` — i.e.
 * INTERMITTENTLY, which is worse than a deterministic failure because it survives review.
 *
 * The remedy is scripts/lib/gate-stdout.mjs: clear O_NONBLOCK on fd 1/2 so writes complete
 * synchronously as issued and nothing is ever left queued for process.exit() to drop. See
 * that file for why this is preferred over rewriting 506 `process.exit()` call sites to
 * `process.exitCode` (fall-through verdicts, and hangs on gates holding an open handle).
 *
 * WHAT A GREEN VERDICT CLAIMS — exactly this:
 *   T1   every REGISTERED Node gate imports scripts/lib/gate-stdout.mjs        (DERIVED)
 *   T2   that import is the FIRST LINE OF CODE in the file                     (DERIVED)
 *   T3   the remedy module still actually calls setBlocking                    (DERIVED)
 *   T4   a real gate-shaped child, emitting a >64 KiB ledger into a STALLED pipe and then
 *        calling process.exit(), still delivers its VERDICT line               (BEHAVIOURAL)
 *   T4b  that stall genuinely reproduced the hazard, so T4 is not vacuous      (BEHAVIOURAL)
 *
 * WHAT IT DOES NOT CLAIM: that every gate's output is small enough to be safe anyway (it
 * does not measure output), nor anything about the 7 registered gates that are not Node
 * scripts (4 python, 3 `node --test`) — those are excluded with reasons at the derivation
 * below, not silently skipped.
 *
 * T1/T2 are derived from the filesystem UNIONED with the package.json gate registry — there
 * is no hand-maintained list to rot (meta-defect M-002). The registry arm is load-bearing:
 * nine registered gates are not named scripts/verify-*.mjs and a filename-only scan
 * exempted all nine while reporting "every gate".
 *
 * T2 is not pedantry: setBlocking only affects writes issued AFTER it. Measured — set at the
 * top of the file: 0/10 loss; set immediately before process.exit(): 10/10 loss. Position IS
 * the fix. It asserts "first line of CODE" rather than "first import" because an INDENTED
 * import is valid ESM but invisible to a `/^import/` anchor, and would evaluate first.
 *
 * T1/T2/T3 read source through scripts/lib/strip-comments.mjs — THE ONE comment stripper —
 * never a regex chain. See the derivation block below for the three ways an independent
 * review defeated the first draft, each of which was a false GREEN.
 *
 * T4 exists because T1-T3 only prove the text is present. `_handle.setBlocking` is an
 * internal Node API; if it is ever removed, every derived check stays green while the
 * defect silently returns. T4 does not trust the source at all — it spawns a child and
 * reads what actually comes out of the pipe.
 *
 * T4b exists because T4's positive arm is satisfied just as well by "the hazard never
 * happened" as by "the remedy worked" — with a draining reader even the unremedied fixture
 * delivers everything. T4b asserts the control arm ON DARWIN ONLY: on Linux and Windows pipe
 * writes are synchronous, so the hazard is genuinely not reproducible there and demanding it
 * would fail the gate for the wrong reason. Off darwin, T4 is explicitly a weaker claim and
 * the VERDICT line says so.
 */
// MUTATION-TESTED: `import './lib/gate-stdout.mjs'` deleted from scripts/verify-anchors.mjs → T1 REDs
//   (1 gate missing the flush import), and T4 stayed GREEN — proving T1 is the check that
//   catches a gate opting out, and that T4 alone would not have caught it.
// MUTATION-TESTED: the import moved BELOW the other imports in scripts/verify-anchors.mjs → T2 REDs
//   (T1 stayed green, confirming T2 catches the ordering-only regression that still loses output).
// MUTATION-TESTED: the setBlocking loop in scripts/lib/gate-stdout.mjs replaced with a no-op
//   (body emptied, import lines left intact everywhere) → T3 AND T4 both RED — T4 observed the
//   VERDICT line actually vanish from the stalled-pipe child (1980022 bytes written, 65439
//   captured — hard-capped at the 64 KiB pipe buffer), i.e. the defect itself reproduced
//   through the gate rather than merely asserted about the source text.
// MUTATION-TESTED: the import stripped from scripts/db-health.mjs — a REGISTRY-ONLY gate, i.e.
//   one not named scripts/verify-*.mjs → T1 REDs naming it and the specifier it needs. This is
//   the arm that matters: the first draft of this gate derived its list from filenames alone and
//   scored 382/382 green while silently exempting all 9 gates whose script is not verify-*.mjs —
//   two of which (scripts/db-health.mjs:174, pipeline/lib/gravity-core.test.mjs:91) had the
//   defect. A green VERDICT claiming "every gate" while skipping nine is M-001 in miniature.
//
// The next four were run against the HARDENED checks, and each one scored a FALSE GREEN on
// the draft an independent review defeated. They are the reason T1/T2/T3 strip comments
// lexically and T2 asserts "first line of code":
// MUTATION-TESTED: the flush import in scripts/verify-anchors.mjs hidden at column 0 INSIDE a
//   `/* … */` block → T1 REDs. On the draft's `/^import/`-on-raw-source scan this was GREEN
//   while the module never loaded and the gate lost its VERDICT for real.
// MUTATION-TESTED: an INDENTED `  import './lib/reap.mjs';` inserted ABOVE the flush import in
//   scripts/verify-anchors.mjs → T2 REDs, naming line 19 as the first code line. Valid ESM that
//   evaluates first, yet invisible to a `/^import/` anchor — GREEN on the draft.
// MUTATION-TESTED: scripts/lib/gate-stdout.mjs gutted to `const noop = 0; // was: setBlocking(true)
//   on process.stdout and process.stderr` → T3 REDs (and T4 REDs). The draft filtered only lines
//   BEGINNING with a comment marker, so that single trailing comment satisfied all three of its
//   regexes on a module that did nothing. This is the mutation that matters off darwin, where T4
//   cannot reproduce the hazard and T3 is the only line of defence.
// MUTATION-TESTED: runStalled's `| { sleep N; cat; }` replaced with a DRAINING `| cat` → T4b REDs
//   ("the fixture did NOT stall, so T4 proved nothing this run") while T4 itself stayed GREEN on
//   1980022 bytes. That is precisely the vacuous pass T4b exists to catch.
// All eight restored afterwards; this gate returns GREEN on the restored tree.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { stripCommentsFor } from './lib/strip-comments.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const REMEDY = resolve(SCRIPTS, 'lib/gate-stdout.mjs');

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// DERIVED: the gate set comes from TWO independent sources, unioned. There is no
// hand-maintained list to rot (meta-defect M-002).
//
//   (a) the FILESYSTEM — every scripts/verify-*.mjs
//   (b) the REGISTRY   — every `verify:*` entry in package.json whose command is a
//                        bare `node <file>` invocation
//
// (b) is not redundant. Nine registered gates are NOT named scripts/verify-*.mjs, and a
// filename-only scan would have silently exempted them while the VERDICT line claimed
// "every gate". Two of those are Node scripts with exactly this defect —
// scripts/db-health.mjs:174 and pipeline/lib/gravity-core.test.mjs:91 both print VERDICT
// and then call process.exit().
//
// DOCUMENTED EXCLUSIONS, each with a reason (not a convenience list):
//   • `pipeline/.venv/bin/python3 …` (4 gates) — CPython flushes its stdio buffers during
//     interpreter shutdown, including under sys.exit(). This defect is specific to Node's
//     asynchronous pipe writes; there is nothing to fix on the Python side.
//   • `node --test …` (3 gates) — the built-in test runner owns stdout and terminates by
//     setting process.exitCode, not by calling process.exit() after its report.
// ---------------------------------------------------------------------------
const relSpec = (absFile) => {
  let s = relative(dirname(absFile), REMEDY);
  if (!s.startsWith('.')) s = `./${s}`;
  return s.split(sep).join('/');
};

const gateFiles = new Set(
  readdirSync(SCRIPTS)
    .filter((f) => /^verify-.*\.mjs$/.test(f))
    .map((f) => resolve(SCRIPTS, f))
);

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const registryOnly = [];
const excludedGates = [];
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  if (!/^verify:/.test(name)) continue;
  if (/npm run verify:/.test(cmd)) continue; // a chain, not a leaf
  // `node <file.mjs|js> [args…]`. `node --test …` is excluded on purpose (see above), as is
  // anything not launching a Node script (the python gates).
  const m = /^\s*node\s+(?!--)([\w./-]+\.(?:mjs|js))(?:\s|$)/.exec(cmd);
  if (!m) { excludedGates.push(`${name} → ${cmd}`); continue; }
  const abs = resolve(ROOT, m[1]);
  if (!existsSync(abs)) continue; // verify:chains owns "gate script exists"
  if (!gateFiles.has(abs)) registryOnly.push(abs);
  gateFiles.add(abs);
}

// Source is read through scripts/lib/strip-comments.mjs — THE ONE comment stripper — NOT a
// regex chain. #344 landed that module precisely because a regex cannot tell a comment from
// the middle of a string, and is wrong in both directions with each direction a false GREEN.
// This gate would have inherited that bug verbatim: an independent review defeated the first
// draft three ways, all of which scored GREEN while the gate lost its VERDICT for real —
//   (1) the import line at column 0 INSIDE a /* … */ block (module never loads);
//   (2) the import line at column 0 inside a TEMPLATE LITERAL — reachable here, because
//       several gates build child driver scripts as template literals (e.g.
//       verify-bridge-bearer.mjs:41), and that driver's own import would have satisfied the
//       check on the parent's behalf;
//   (3) an INDENTED `  import './side-effect.mjs'` above the flush import — valid ESM, but
//       invisible to a `/^import/` anchor, so it evaluated first while the check saw nothing.
// Stripping kills (1). (2) and (3) die to the positional rule below: the binding assertion is
// not "an import line matching X exists somewhere" but "the FIRST line of CODE in this file
// is the flush import". Comment bytes are blanked (not deleted) by the stripper, so line
// numbers below still point at the real line.
const FLUSH_IMPORT = /^import\s+['"][^'"]*gate-stdout\.mjs['"]\s*;?$/;

const gates = [...gateFiles].sort();
const missing = [];
const misordered = [];
for (const abs of gates) {
  const stripped = stripCommentsFor(abs, readFileSync(abs, 'utf8'));
  const codeLines = stripped
    .split('\n')
    .map((l, i) => ({ t: l.trim(), i }))
    .filter(({ t }) => t !== '');
  const show = relative(ROOT, abs);

  if (!codeLines.some(({ t }) => /gate-stdout\.mjs/.test(t))) {
    missing.push(`${show} (expected: import '${relSpec(abs)}')`);
    continue;
  }
  // First line of real code, skipping a shebang.
  let first = codeLines[0];
  if (first && first.t.startsWith('#!')) first = codeLines[1];
  if (!first || !FLUSH_IMPORT.test(first.t)) {
    misordered.push(`${show}: first code line is ${first ? `${first.i + 1}: ${first.t.slice(0, 70)}` : '<none>'} — the flush import must come first`);
  }
}

rec(
  `T1. every registered gate imports the flush module (${gates.length} gates: ${gates.length - registryOnly.length} from scripts/verify-*.mjs + ${registryOnly.length} registry-only)`,
  missing.length === 0,
  missing.length
    ? `${missing.length} gate(s) can lose their VERDICT on a piped stdout:\n      ${missing.join('\n      ')}`
    : `all ${gates.length} gates carry the flush import` +
      (registryOnly.length
        ? `; registry-only: ${registryOnly.map((f) => relative(ROOT, f)).join(', ')}`
        : '') +
      `\n      not applicable (${excludedGates.length}): python gates flush at interpreter exit; \`node --test\` sets exitCode instead of calling exit()`
);

rec(
  'T2. the flush import is the FIRST line of CODE in every gate (setBlocking only affects LATER writes)',
  misordered.length === 0,
  misordered.length
    ? `${misordered.length} gate(s) import it too late:\n      ${misordered.join('\n      ')}`
    : 'first-code-line position holds in every gate (comments stripped lexically, not by regex)'
);

// T3 — the remedy module must still DO something. Guards against the import lines
// surviving while the body is gutted.
// Comments stripped LEXICALLY here too. The first draft filtered out lines that *begin* with
// `//`, which left trailing comments in the "code" — so a module whose entire body was
// `const noop = 0; // was: setBlocking(true) on process.stdout and process.stderr` scored
// PASS while doing nothing. That matters most on Linux, where T4's hazard is not
// reproducible and T3 is the only line of defence.
let remedySrc = '';
try { remedySrc = readFileSync(REMEDY, 'utf8'); } catch { /* handled below */ }
const remedyCode = remedySrc ? stripCommentsFor(REMEDY, remedySrc) : '';
rec(
  'T3. scripts/lib/gate-stdout.mjs still calls setBlocking on stdout and stderr',
  /setBlocking\s*\(\s*true\s*\)/.test(remedyCode) &&
    /process\.stdout/.test(remedyCode) &&
    /process\.stderr/.test(remedyCode),
  remedySrc ? 'setBlocking(true) applied to both streams' : 'remedy module missing or unreadable'
);

// ---------------------------------------------------------------------------
// BEHAVIOURAL: spawn a gate-shaped child into a pipe we deliberately do NOT drain.
// ---------------------------------------------------------------------------
const LINES = 20000; // ~1.8 MB — far past the 64 KiB pipe buffer
const STALL_MS = 400;

const fixture = (withRemedy) => `${withRemedy ? `import ${JSON.stringify(REMEDY)};\n` : ''}
for (let i = 0; i < ${LINES}; i++) console.log('ledger row ' + String(i).padStart(6, '0') + ' ' + 'x'.repeat(80));
console.log('VERDICT: GO — fixture');
process.exit(0);
`;

// The reader is stalled by a real shell pipeline — `node fixture | { sleep N; cat; }`.
// The inner pipe is the one that fills and drops; the OUTER capture is execFileSync,
// which drains its own pipe in the libuv loop and never loses data (verified: 18 MB
// intact), so anything missing here was dropped by the fixture's process.exit().
const runStalled = (file) => {
  const pipeline = `${JSON.stringify(process.execPath)} ${JSON.stringify(file)} | { sleep ${STALL_MS / 1000}; cat; }`;
  try {
    return execFileSync('/bin/sh', ['-c', pipeline], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return String(e?.stdout ?? '');
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'gate-stdout-flush-'));
try {
  const withPath = join(tmp, 'with-remedy.mjs');
  const withoutPath = join(tmp, 'without-remedy.mjs');
  writeFileSync(withPath, fixture(true));
  writeFileSync(withoutPath, fixture(false));

  const withOut = runStalled(withPath);
  const withoutOut = runStalled(withoutPath);

  rec(
    'T4. gate-shaped child (>64 KiB ledger) + process.exit() into a STALLED pipe still delivers VERDICT',
    withOut.includes('VERDICT: GO — fixture'),
    `with remedy: ${withOut.length} bytes captured, VERDICT ${withOut.includes('VERDICT: GO — fixture') ? 'PRESENT' : 'SWALLOWED'}`
  );

  // T4's positive arm is satisfied just as well by "the hazard never happened" as by "the
  // remedy worked" — with a DRAINING reader the unremedied fixture also delivers everything.
  // So on the platform where the hazard IS reproducible, assert that the stall actually
  // created it. Without this, a macOS run whose fixture silently stopped stalling (sleep not
  // on PATH, a loaded box filling the buffer slower than STALL_MS, a larger pipe buffer)
  // reports GO while proving nothing. The Linux/Windows carve-out is legitimate — pipe writes
  // are synchronous there — but making it unconditional is what would be dishonest.
  const hazard = !withoutOut.includes('VERDICT: GO — fixture');
  rec(
    'T4b. the stalled pipe genuinely reproduces the hazard, so T4 is not passing vacuously (asserted on darwin only)',
    process.platform !== 'darwin' || hazard,
    process.platform === 'darwin'
      ? `control arm WITHOUT the remedy: ${withoutOut.length} bytes, VERDICT ${hazard ? 'SWALLOWED — hazard reproduced, T4 is meaningful' : 'PRESENT — the fixture did NOT stall, so T4 proved nothing this run'}`
      : `not asserted on ${process.platform}: pipe writes are synchronous, hazard not reproducible (control arm: ${withoutOut.length} bytes)`
  );
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const passed = ledger.filter(Boolean).length;
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`${passed}/${ledger.length} checks passed`);
console.log(
  `VERDICT: ${
    allPass
      ? `GO — all ${gates.length} registered Node gates carry the flush import as their FIRST line of code, the remedy still calls setBlocking, and a stalled-pipe child still delivers its VERDICT` +
        (process.platform === 'darwin' ? ' (hazard confirmed reproducible, so that last claim is load-bearing)' : ' (behavioural arm not asserted off darwin)')
      : 'NO-GO — see FAIL rows'
  }  EXIT=${allPass ? 0 : 1}`
);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
