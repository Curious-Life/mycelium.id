#!/usr/bin/env node
// verify:chains — the meta-gate. Every OTHER gate asserts something about the
// product; this one asserts something about the gates themselves: that none of
// them is silently gating nothing.
//
// It exists because the two chains drifted apart unnoticed for months. On
// 2026-07-16 `npm run verify` (238 gates) and `npm run verify:core` (28) were
// DISJOINT IN BOTH DIRECTIONS — 12 gates lived only in `core`, which CI never
// runs (.github/workflows/verify.yml runs `verify` only), so the Claude connect
// ladder (claude-pkce / claude-sources / model-honesty) and destroy-vault, an
// irreversible-data-destruction surface, had been gating NOTHING in CI. A
// further 46 registered gates sat in neither chain — including channel-egress,
// a CLAUDE.md §11 chokepoint — and 2 scripts were referenced by no npm script
// at all. Two of those unrun gates had been RED for weeks (see C2 below).
//
// The contract this enforces:
//   C1  verify:core is a strict SUBSET of verify   (core = fast pre-flight)
//   C2  every registered leaf verify:* gate is in `verify`, unless explicitly
//       excluded in verify-chains.exclusions.json WITH a reason
//   C3  every scripts/verify-*.mjs is EXECUTED by `npm run verify`
//   C4  the exclusions file has no stale entries (nothing excluded that is
//       actually wired, nothing naming a script that no longer exists)
//   C5  only the DECLARED chains compose verify:* gates
//   C6  `verify` is &&-chained, so a red gate actually fails the build
//
// C3/C5/C6 exist because an independent review DEFEATED the first draft of this
// gate three ways, each of which shipped an unrun gate under a green build:
//   - a gate script run only by a script NOT named `verify:*` (`qa:sneaky`) —
//     C2 never looked at it and the old C3 counted it as "referenced";
//   - a leaf that mentioned `npm run verify:…` in an echo, which the old
//     substring-based chain-sniffing misread as "this is a chain" and exempted;
//   - a filename appearing only inside an echo/TODO, which the old C3's
//     `body.includes(f)` accepted as a reference.
// Hence: chains are DECLARED not sniffed, and reachability means EXECUTED.
//
//   C7  every tests/*.test.js is EXECUTED by `npm run verify`  — added 2026-07-27
//       after this gate was found blind to 11 of the repo's 16 test files. See C7's
//       own block below for what was hiding in them.
//
// An unrun gate is worse than no gate: it reads as coverage. This gate is the
// reason that can no longer happen quietly — it runs FIRST in `verify`, so the
// suite goes red on divergence before spending 10 minutes on the real gates.
//
// MUTATION-TESTED (C7, 2026-07-27): removed `npm run verify:federation-ssrf` from the chain while
//   leaving the gate registered → C7 REDs naming the orphaned file (C2 REDs alongside it, which is
//   the registered-gate half of the same fact).
// MUTATION-TESTED (C7, 2026-07-27): deleted the `verify:vault-integrity` script entirely so the
//   test file is referenced by nothing at all → C7 REDs. This is the case C2 CANNOT see — there is
//   no registered gate to be orphaned — and it is exactly the state all eleven files were in.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const EXCLUSIONS_PATH = resolve(ROOT, 'scripts/verify-chains.exclusions.json');
const exclusions = existsSync(EXCLUSIONS_PATH)
  ? JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf8'))
  : { excluded: {} };
const excluded = exclusions.excluded || {};

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const gatesIn = (chain) => new Set([...(scripts[chain] || '').matchAll(/npm run (verify:[\w-]+)/g)].map((m) => m[1]));

// The chains are DECLARED, not sniffed. An earlier draft inferred "is this a chain?"
// from whether the body contained the substring `npm run verify:` — which a leaf could
// satisfy with a stray mention (e.g. an `|| echo 'also run npm run verify:chains'`
// in its failure path), thereby exempting itself from C2 and dropping out of the
// contract silently. That is the very bug class this gate exists to prevent, so
// chain-hood is now an explicit list and C5 fails if anything else composes gates.
const DECLARED_CHAINS = new Set(['verify', 'verify:core', 'test']);
const composesGates = (name) => /npm run verify:/.test(scripts[name] || '');

const leaves = Object.keys(scripts).filter((n) => n.startsWith('verify:') && !DECLARED_CHAINS.has(n));

// Which verify-*.mjs does this script actually EXECUTE? Split on shell separators and
// only accept a command that IS a node invocation — a substring match would count a
// filename merely NAMED in an `echo`/comment as "referenced", so a gate could be
// documented-but-unreachable and still pass.
const executedMjs = (body) => {
  const out = new Set();
  for (const cmd of String(body || '').split(/&&|\|\||;/)) {
    const m = cmd.trim().match(/^node\s+(?:--\S+\s+)*(?:\.\/)?scripts\/(verify-[\w-]+\.mjs)/);
    if (m) out.add(m[1]);
  }
  return out;
};

const inVerify = gatesIn('verify');
const inCore = gatesIn('verify:core');

// Every .mjs reachable by actually running `npm run verify`.
const reachableMjs = new Set();
for (const g of inVerify) for (const f of executedMjs(scripts[g])) reachableMjs.add(f);

// ── C1. verify:core ⊂ verify ────────────────────────────────────────────────
// The whole point of `core` is to be a fast subset you can run before pushing.
// A gate that is in core but NOT in verify is a gate CI never sees.
{
  const coreOnly = [...inCore].filter((g) => !inVerify.has(g)).sort();
  rec('C1. verify:core is a strict subset of verify (no core-only gate escapes CI)',
    coreOnly.length === 0,
    coreOnly.length ? `${coreOnly.length} gate(s) in core but NOT in verify — CI runs \`verify\` only, so these gate nothing:\n      ${coreOnly.join('\n      ')}` : `core=${inCore.size} ⊆ verify=${inVerify.size}`);
}

// ── C2. every leaf gate is wired into `verify` ──────────────────────────────
{
  const orphans = leaves.filter((g) => !inVerify.has(g) && !(g in excluded)).sort();
  rec('C2. every registered verify:* gate runs in `verify` (or is explicitly excluded)',
    orphans.length === 0,
    orphans.length
      ? `${orphans.length} registered gate(s) in NO chain — they read as coverage but run never.\n      Add to \`verify\`, or add to scripts/verify-chains.exclusions.json with a reason:\n      ${orphans.join('\n      ')}`
      : `${leaves.length} leaf gates · ${Object.keys(excluded).length} explicitly excluded`);
}

// ── C3. every gate script on disk is REACHED by `npm run verify` ────────────
// Not "is it mentioned somewhere" — is it actually EXECUTED when CI runs the suite.
// The weaker phrasing let two things through: a gate script run only by a script
// whose name doesn't start with `verify:` (so C2 never looked at it), and a script
// whose name appeared only inside an echo/TODO. Both are unrun gates that read as
// coverage — exactly what this file exists to make impossible.
{
  const files = readdirSync(resolve(ROOT, 'scripts')).filter((f) => /^verify-.*\.mjs$/.test(f));
  // A deliberately-excluded gate's script is allowed to be unreached — that IS the exclusion.
  const excusedMjs = new Set();
  for (const g of Object.keys(excluded)) for (const f of executedMjs(scripts[g])) excusedMjs.add(f);
  const unreached = files.filter((f) => !reachableMjs.has(f) && !excusedMjs.has(f)).sort();
  rec('C3. every scripts/verify-*.mjs is EXECUTED by `npm run verify`',
    unreached.length === 0,
    unreached.length
      ? `${unreached.length} gate script(s) NOT executed by the suite — they read as coverage but run never:\n      ${unreached.map((f) => `scripts/${f}`).join('\n      ')}`
      : `${files.length} gate scripts, all reached by the chain`);
}

// ── C7. every tests/*.test.js is EXECUTED by `npm run verify` ───────────────
// ⚠️ THE BLIND SPOT THIS GATE HAD, FOUND 2026-07-27. C3 audits `scripts/verify-*.mjs` and nothing
// else. A bare `tests/*.test.js` — run by `node --test`, wired through an npm script or not — was
// entirely outside this file's view, so the gate whose whole claim is "no gate is silently unrun"
// could not see eleven of the sixteen test files in the repo. It said GO while they ran never.
//
// What was actually sitting in there, invisible:
//   · `federation-ssrf.test.js` — the SSRF guard's own tests, 1 RED. And it was red the DANGEROUS
//     way: it asserted `assertResolvesPublic` ALLOWS an unresolvable host, which was true of an
//     earlier, permissive guard. The guard has since been hardened to fail closed. So the file
//     asserted a WEAKER security property than the code enforced, and the obvious way to "fix" that
//     red — make the guard permissive again — would have re-opened the hole while turning the suite
//     green.
//   · `federation-did.test.js` (4 RED) and `federation-integration.test.js` (2 RED) — same
//     hardening, same staleness.
//   · `vault-integrity`, `vault-safe-copy`, `vault-disk-guard` — green, but unrun on the exact
//     surface D-080 destroyed 80,000 datapoints on.
//
// This is worse than C3's failure mode. An unrun `verify-*.mjs` at least *looks* like a gate nobody
// wired. An unrun test file looks like coverage AND can quietly disagree with the product about
// what the security contract is. Absence of a red is not evidence of a green if nothing ran.
{
  const files = readdirSync(resolve(ROOT, 'tests')).filter((f) => /\.test\.js$/.test(f));
  // Reached = executed by the suite, on the same EXECUTED-not-mentioned standard C3 uses.
  const reachedTests = new Set();
  for (const g of gatesIn('verify')) {
    for (const m of (scripts[g.replace(/^npm run /, '')] || scripts[g] || '').matchAll(/tests\/([\w.-]+\.test\.js)/g)) {
      reachedTests.add(m[1]);
    }
  }
  const excusedTests = new Set();
  for (const g of Object.keys(excluded)) {
    for (const m of (scripts[g] || '').matchAll(/tests\/([\w.-]+\.test\.js)/g)) excusedTests.add(m[1]);
  }
  const unreached = files.filter((f) => !reachedTests.has(f) && !excusedTests.has(f)).sort();
  rec('C7. every tests/*.test.js is EXECUTED by `npm run verify`',
    unreached.length === 0,
    unreached.length
      ? `${unreached.length} test file(s) NOT executed by the suite — they read as coverage but run never:\n      ${unreached.map((f) => `tests/${f}`).join('\n      ')}`
      : `${files.length} test files, all executed by the chain`);
}

// ── C5. only the declared chains may compose gates ──────────────────────────
// Chain-hood is a declared fact (DECLARED_CHAINS). If some other script starts
// composing `npm run verify:*`, it is either a new chain that must be declared and
// reasoned about here, or a leaf smuggling a mention that would corrupt C2's view.
{
  const undeclared = Object.keys(scripts).filter((n) => !DECLARED_CHAINS.has(n) && composesGates(n)).sort();
  rec('C5. no undeclared chain composes verify:* gates',
    undeclared.length === 0,
    undeclared.length
      ? `${undeclared.length} script(s) compose gates but aren't declared chains — declare them in DECLARED_CHAINS or drop the reference:\n      ${undeclared.join('\n      ')}`
      : `declared chains: ${[...DECLARED_CHAINS].join(', ')}`);
}

// ── C6. `verify` fails on the first red gate ────────────────────────────────
// A chain joined by `||` (or `;`) runs every gate and still exits 0 — gates present,
// gating nothing. Presence is not enforcement, so assert the separator too.
{
  const body = scripts.verify || '';
  const bad = /\|\||;/.test(body);
  rec('C6. `verify` is &&-chained (no || / ; that would swallow a red gate)',
    !bad,
    bad ? 'found `||` or `;` in the verify chain — a failing gate would not fail the build' : `${inVerify.size} gates, all && -joined`);
}

// ── C4. exclusions stay honest ──────────────────────────────────────────────
// An exclusion is a deliberate, reviewed hole. It must name a real gate, carry a
// reason, and disappear once the gate is actually wired — otherwise the
// exclusions file becomes its own quiet graveyard.
{
  const problems = [];
  for (const [gate, reason] of Object.entries(excluded)) {
    if (!(gate in scripts)) problems.push(`${gate}: excluded but no such npm script (stale entry)`);
    else if (inVerify.has(gate)) problems.push(`${gate}: excluded but IS in \`verify\` — drop the exclusion`);
    else if (typeof reason !== 'string' || reason.trim().length < 12) problems.push(`${gate}: exclusion needs a real reason (got ${JSON.stringify(reason)})`);
  }
  rec('C4. exclusions.json has no stale or unjustified entries',
    problems.length === 0,
    problems.length ? problems.join('\n      ') : `${Object.keys(excluded).length} exclusion(s), all justified`);
}

const passed = ledger.filter(Boolean).length;
console.log('\n' + '='.repeat(64));
console.log(`${passed}/${ledger.length} checks passed`);
const allPass = ledger.every(Boolean);
console.log(`VERDICT: ${allPass ? 'GO — no gate is silently unrun: core ⊆ verify · every gate wired · every gate script EXECUTED by the suite · chains declared · && -chained · exclusions justified' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
