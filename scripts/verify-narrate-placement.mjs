// verify:narrate-placement — P8d. The narration walk lives on the AGENTS page, not in the
// mindscape rail, and the move did not take the feature with it.
//
// THE DECISION (operator, QA9 sprint design): move Narrate out of the mindscape rail.
//
// WHY IT NEEDS A GATE AT ALL. Every narrate gate — all seven of them — passed BEFORE this move,
// AFTER it, and would pass just as happily if <NarrateControl/> were mounted NOWHERE. They assert
// the routes, the consent, the device attribution, the walk; not one of them asserts that a user
// can reach it. That is the same gap D-004 lived in: a working feature with no reachable control.
// A relocation is the single easiest way to create that gap by accident, so the placement itself
// is asserted here.
//
//   N1  it is MOUNTED on the Agents page (and imported there)
//   N2  it is GONE from the mindscape rail — mount and import both
//   N3  ⭐ RELOCATED, NOT DELETED: the component still exists and still drives the real routes
//   N4  ⭐ the SERVER surface is untouched — every narrate route and narration_runs survive
//   N5  exactly ONE mount site app-wide (a relocation that leaves a copy behind is two voices,
//       which is the duplication the sprint spent its whole UI budget removing)
//
// MUTATION-TESTED: removed <NarrateControl/> from AgentsView, leaving it mounted nowhere → N1 and
//   N5 RED. This is the failure that matters most — "moved it out of one place and forgot to land
//   it in the other" — and ALL SEVEN narrate gates stay green through it, which is the entire
//   reason this file exists.
// MUTATION-TESTED: moved it fully BACK (dropped from AgentsView, re-added to the mindscape rail)
//   → N1, N2 and N5 all RED.
// MUTATION-TESTED: mounted it in BOTH views at once — the half-finished move that leaves a copy
//   behind → N2 and N5 RED. N1 stays GREEN here, which is exactly why N5 is not redundant.
// MUTATION-TESTED: hollowed the component out by renaming its 'cancel' action → N3 REDs. A
//   relocation that silently drops a lifecycle verb still "exists" and still mounts.
// MUTATION-TESTED: disabled router.post('/mycelium/narrate') → N4 REDs — the relocation must never
//   become a quiet retirement of the server surface.
//
// ⚠️ N3's first version asserted literal `narrate/(pause|resume|cancel)` and REDed on CORRECT code:
// the three actions are issued through ONE templated call. The gate was wrong about the source,
// not the source wrong about the routes. Recorded because "the gate is red" and "the code is
// broken" are different claims, and reaching for the second one first is how correct code gets
// "fixed".
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, existsSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
/** Strip comments so a RATIONALE comment naming the component cannot satisfy a MARKUP assertion.
 *  Both files below deliberately EXPLAIN the move in prose that names <NarrateControl/>; without
 *  this, N2 would read its own explanation as a mount. (verify:mindscape-loading L4 shipped that
 *  exact bug.) */
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const AGENTS = 'portal-app/src/lib/views/AgentsView.svelte';
const MIND = 'portal-app/src/lib/views/MindscapeView.svelte';
const COMPONENT = 'portal-app/src/lib/components/mindscape/NarrateControl.svelte';
const ROUTES = 'src/portal-mindscape.js';

const agents = stripComments(read(AGENTS));
const mind = stripComments(read(MIND));

const MOUNT = /<NarrateControl\s*\/?>/;
const IMPORT = /import\s+NarrateControl\s+from/;

// ── N1: mounted on the Agents page ──────────────────────────────────────────
{
  const mounted = MOUNT.test(agents);
  const imported = IMPORT.test(agents);
  rec('N1. the narration walk is MOUNTED on the Agents page',
    mounted && imported, `mounted=${mounted} imported=${imported}`);
}

// ── N2: gone from the mindscape rail ────────────────────────────────────────
{
  const mounted = MOUNT.test(mind);
  const imported = IMPORT.test(mind);
  rec('N2. it is gone from the mindscape rail — mount AND import',
    !mounted && !imported, `mount=${mounted} import=${imported}`);
}

// ── N3: ⭐ relocated, not deleted ───────────────────────────────────────────
{
  const exists = existsSync(COMPONENT);
  const src = read(COMPONENT);
  // It must still drive the REAL lifecycle, not have been hollowed into a placeholder.
  // ⚠️ The three lifecycle actions are issued through ONE templated call —
  // `apiPost(\`/portal/mycelium/narrate/${action}\`)` — so matching literal
  // `narrate/pause|resume|cancel` finds nothing even though all three work. My first version did
  // exactly that and REDed on correct code: the gate was wrong about the source, not the source
  // wrong about the routes. Assert the shape that is actually there, and assert the ACTION UNION
  // separately so a component that quietly lost `cancel` still REDs.
  const start = /apiPost[^\n]*'\/portal\/mycelium\/narrate'/.test(src);
  const status = /apiGet[^\n]*'\/portal\/mycelium\/narrate\/status'/.test(src);
  const templated = /apiPost\(`\/portal\/mycelium\/narrate\/\$\{action\}`/.test(src);
  const actions = ['pause', 'resume', 'cancel'].every((a) => new RegExp(`'${a}'`).test(src));
  const drives = start && status && templated && actions;
  rec('N3. ⭐ RELOCATED, not deleted — the component exists and still drives the real routes',
    exists && drives, `exists=${exists} drivesRoutes=${drives}`);
}

// ── N4: ⭐ the server surface is untouched ──────────────────────────────────
{
  const routes = stripComments(read(ROUTES));
  const need = [
    [/router\.post\('\/mycelium\/narrate'/, 'POST /mycelium/narrate'],
    [/router\.post\('\/mycelium\/narrate\/pause'/, 'POST …/pause'],
    [/router\.post\('\/mycelium\/narrate\/resume'/, 'POST …/resume'],
    [/router\.post\('\/mycelium\/narrate\/cancel'/, 'POST …/cancel'],
    [/router\.get\('\/mycelium\/narrate\/status'/, 'GET …/status'],
  ];
  const missing = need.filter(([re]) => !re.test(routes)).map(([, n]) => n);
  // and the run table it writes
  const hasTable = existsSync('migrations/0022_narration_runs.sql')
    && /narration_runs/.test(read('src/jobs.js'));
  rec('N4. ⭐ the SERVER surface survived the move — every narrate route + narration_runs',
    missing.length === 0 && hasTable,
    missing.length ? `MISSING: ${missing.join(', ')}` : `all 5 routes · narration_runs=${hasTable}`);
}

// ── N5: exactly ONE mount site app-wide ─────────────────────────────────────
// A half-finished move that lands the new mount without removing the old one leaves the feature
// in two places — the exact duplication ("name your areas and narrate the map are duplicated")
// this sprint's UI work exists to remove. N1 and N2 pass independently in that state only if the
// old one is gone, but this counts across the WHOLE tree so a third mount somewhere else is caught.
{
  const { execSync } = await import('node:child_process');
  const out = execSync(
    `grep -rl "<NarrateControl" portal-app/src --include=*.svelte || true`,
    { encoding: 'utf8' },
  ).trim();
  // Filter to real mounts (comments stripped per file).
  const sites = out ? out.split('\n').filter((f) => MOUNT.test(stripComments(read(f)))) : [];
  rec('N5. exactly ONE mount site app-wide — a relocation left no copy behind',
    sites.length === 1 && sites[0] === AGENTS,
    sites.length ? sites.join(', ') : 'NONE — the feature is unreachable');
}

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — the narration walk lives on the Agents page, is gone from the mindscape rail,\n'
    + '        is mounted in exactly one place, and the move left every route and narration_runs\n'
    + '        intact. The seven narrate gates prove the FEATURE; this one proves a user can REACH it.\n'
    + '        NOT PROVEN: that the Agents page is the right home — that is the operator\'s call, and\n'
    + '        this gate would pass just as well for any other single host view.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);
