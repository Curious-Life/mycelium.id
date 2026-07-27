// verify:pipeline-preflight — the pipeline refuses to start on an interpreter it cannot run on,
// and says so in a line a human can act on.
//
// THE DEFECT (measured end-to-end, 2026-07-27, the pipeline-sprint design Part 0b).
// pipeline/cluster.py:176 annotates `tuple[list[str], np.ndarray | None]`. PEP 604's `X | None` in
// an annotation is evaluated AT DEF TIME, so the module needs Python >= 3.10. That requirement was
// stated only in a comment (pipeline/setup.sh:16) and enforced nowhere.
//
// The existing imports probe CANNOT catch it: numpy, dotenv, cryptography, faiss, igraph,
// leidenalg, scipy, sklearn and umap all import perfectly well on 3.9. So a 3.9 host passed the
// entire preflight, ran Step 1 to completion (720 messages synced), and died in Step 2 with
//     TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
// — a message that names neither Python nor the version — and `set -e` took Steps 3-16 with it.
// Stock macOS ships Python 3.9.6, so this is the default state of a dev checkout.
//
// WHAT THIS GATE ASSERTS — exactly this: the version probe EXISTS, runs BEFORE the imports probe
// (order is the whole point: on 3.9 both would fail, and the imports message would send the user
// to reinstall dependencies that are already correctly installed), exits with a DISTINCT code so
// the two causes are not conflated, and names both the required and the found version.
//
// NOT PROVEN: that the bundled interpreter is >= 3.10, or that any given host has one. This gate
// proves the REFUSAL is wired, not that the environment is good.
//
// MUTATION-TESTED: deleted the version-probe block from run-clustering.sh → P1 REDs.
// MUTATION-TESTED: moved the version probe AFTER the imports probe → P2 REDs.
// MUTATION-TESTED: changed the version probe's `exit 5` to `exit 3` (the imports code) → P3 REDs.
// MUTATION-TESTED: dropped ${PY_FOUND} from the message → P4 REDs.
// MUTATION-TESTED (BEHAVIOURAL, the one that matters): ran the real run-clustering.sh with
//   PYTHON=/usr/bin/python3 (3.9.6, stock macOS) against a real fixture vault. BEFORE the fix it
//   reached "Step 2/16" and died on the TypeError; AFTER the fix it exits 5 before Step 1 with
//   "Python 3.10+ required, found 3.9.6". Re-run with the 3.12 venv → full 20/20 pass, so the
//   guard does not refuse a healthy interpreter.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const SH = 'pipeline/run-clustering.sh';
const sh = readFileSync(SH, 'utf8');

// The two probes, located by their own distinctive shell.
const iVersion = sh.indexOf('sys.version_info >=');
const iImports = sh.indexOf('import numpy,dotenv,cryptography');
const iStep1 = sh.indexOf('Step 1/16');

// P1 — the version probe exists at all.
rec('P1. a Python VERSION probe exists (the imports probe cannot catch a too-old interpreter)',
  iVersion > 0,
  iVersion > 0 ? `found at offset ${iVersion}` : 'no `sys.version_info >=` check in ' + SH);

// P2 — ORDER. On a 3.9 host BOTH probes would fail; whichever runs first owns the message the user
// acts on. The imports message says "install the clustering dependencies" — which on a 3.9 box with
// a correctly-populated venv is precisely wrong advice, and unfalsifiable from the user's side.
rec('P2. the version probe runs BEFORE the imports probe, and before Step 1',
  iVersion > 0 && iImports > 0 && iVersion < iImports && (iStep1 < 0 || iVersion < iStep1),
  `version@${iVersion} imports@${iImports} step1@${iStep1}`);

// P3 — a DISTINCT exit code. jobs.js surfaces the last stderr line, but the exit code is what any
// automation branches on; sharing code 3 with "deps missing" makes the two indistinguishable.
const versionBlock = iVersion > 0 ? sh.slice(iVersion, iImports > iVersion ? iImports : iVersion + 1200) : '';
const importsBlock = iImports > 0 ? sh.slice(iImports, iImports + 800) : '';
const vExit = /exit (\d+)/.exec(versionBlock)?.[1] ?? null;
const iExit = /exit (\d+)/.exec(importsBlock)?.[1] ?? null;
rec('P3. the version failure exits with its OWN code, distinct from the deps failure',
  vExit != null && iExit != null && vExit !== iExit,
  `version exit=${vExit} · deps exit=${iExit}`);

// P4 — the message is ACTIONABLE: it must state the version REQUIRED and the version FOUND.
// "Python 3.10+ required" alone leaves the user unable to tell whether they are the affected case.
const saysRequired = /3\.\}?\$?\{?PY_MIN_MINOR\}?|\$\{PY_MIN_MAJOR\}\.\$\{PY_MIN_MINOR\}/.test(versionBlock)
  || /Python \$\{?PY_MIN/.test(versionBlock);
const saysFound = /PY_FOUND/.test(versionBlock);
rec('P4. the refusal names BOTH the required version and the version actually found',
  saysRequired && saysFound,
  `required=${saysRequired} found=${saysFound}`);

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — the pipeline refuses an interpreter it cannot run on, before it does any work,\n'
    + '        with its own exit code and a message naming the required and the found version.\n'
    + '        NOT PROVEN: that any given host HAS a supported interpreter — only that the refusal is wired.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);
