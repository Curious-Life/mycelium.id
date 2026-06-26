// verify:entry-guards — no entry point may use the fragile main-guard
//   if (import.meta.url === `file://${process.argv[1]}`) main()
// which SILENTLY fails when the app bundle path contains a space (e.g.
// "Mycelium Dev.app"): import.meta.url percent-encodes the space (%20) while the
// template literal keeps it raw, so the comparison is never true → main() never
// runs. That exited the server with code 0 and made the Telegram channel-daemon
// report "down — check the bot token" with a perfectly valid token (2026-06-24).
//
// The correct idiom compares decoded FS paths:
//   if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
//
// This gate scans src/ + packages/ + pipeline/ for the fragile form and fails if
// any returns, and positively proves the hazard + the fix on a spaced path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'packages', 'pipeline'];
const SKIP = /node_modules|\/reference\/|\.venv|\/target\//;
// The fragile comparison in code (not in a comment) — import.meta.url tested
// directly against a raw `file://${process.argv[1]}` template.
const FRAGILE = /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/;

let pass = 0, fail = 0;
const ok = (c, l, x = '') => {
  if (c) { pass++; console.log(`PASS  ${l}${x ? '  ' + x : ''}`); }
  else { fail++; console.log(`FAIL  ${l}${x ? '  ' + x : ''}`); }
};

function walk(dir) {
  const out = [];
  let ents;
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e);
    if (SKIP.test(p)) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const d of DIRS) {
  for (const f of walk(path.join(ROOT, d))) {
    if (FRAGILE.test(readFileSync(f, 'utf8'))) offenders.push(path.relative(ROOT, f));
  }
}
ok(offenders.length === 0, 'no fragile `file://${process.argv[1]}` entry guards',
   offenders.length ? `→ ${offenders.join(', ')} (use fileURLToPath compare)` : '');

// Positive proof: argv[1] is the absolute path with a RAW space; import.meta.url
// is percent-encoded. The fragile form must FAIL and the fileURLToPath form PASS.
{
  const spaced = '/private/tmp/has space/sub/x.mjs';
  const metaUrl = 'file://' + spaced.replace(/ /g, '%20'); // how import.meta.url renders it
  ok((metaUrl === `file://${spaced}`) === false, 'fragile form FAILS on a spaced path (the hazard)');
  ok(fileURLToPath(metaUrl) === spaced, 'fileURLToPath() form MATCHES on a spaced path (the fix)');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
