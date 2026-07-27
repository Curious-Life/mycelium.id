// scripts/verify-mindfile-authorship.mjs — the V12 provenance guardrail (design §5.6).
//
// The agent may rewrite self.md unprompted overnight. This gate proves the
// character page can always answer "who last changed this, you or the agent?" —
// and, crucially, that the agent CANNOT forge an 'operator' write, that an
// unknown author is refused fail-closed, and that provenance is encrypted at rest.
//
// Real encrypt round-trip: a random ENCRYPTION_MASTER_KEY is pinned so
// crypto-local.getMasterKey() resolves (single-user env fallback path).

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { createMindFiles } from '../src/mindfiles/mind-files.js';
import { createInternalDomain } from '../src/tools/internal.js';
import { createAuthorship } from '../src/mindfiles/authorship.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const root = await mkdtemp(path.join(tmpdir(), 'mindauth-'));
try {
  const mf = createMindFiles({ agentRoot: root, agentId: 'personal-agent', fs: fsp, path });
  const readMindFile  = (f) => mf.readMindFile(f);
  const writeMindFile = (f, c) => mf.writeMindFile(f, c);
  const { handlers } = createInternalDomain({ readMindFile, writeMindFile });
  const authorship = createAuthorship({ readMindFile, writeMindFile });

  // ── A1: an agent tool-path write is attributed 'agent' ─────────────────────
  await handlers.writeMindFileWhole({ filename: 'self.md', content: '# WHO YOU ARE\nWarm, direct.' });
  let a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'agent' && typeof a.at === 'string', 'A1 agent write → author=agent', JSON.stringify(a));

  // ── A2: SPOOF-PROOF — an author arg in the tool payload is IGNORED ──────────
  await handlers.writeMindFileWhole({ filename: 'self.md', content: '# WHO YOU ARE\nEdited again.', author: 'operator', authorship: 'operator' });
  a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'agent', 'A2 tool payload cannot forge operator authorship', JSON.stringify(a));

  // ── A3: the operator REST path attributes 'operator' (last-write-wins) ──────
  await authorship.recordWrite('self.md', 'operator');
  a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'operator', 'A3 operator write → author=operator', JSON.stringify(a));

  // ── A4: FAIL-CLOSED — an unknown author is refused, never recorded ──────────
  let threw = null;
  try { await authorship.recordWrite('self.md', 'root'); } catch (e) { threw = e; }
  ok(threw && /unknown author/.test(threw.message), 'A4 unknown author refused (fail-closed)');
  a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'operator', 'A4b refused write did NOT mutate provenance', JSON.stringify(a));

  // ── A5: ENCRYPTED AT REST — the dotfile sidecar is not plaintext on disk ────
  const raw = await readFile(path.join(root, 'mind', '.authorship.json'));
  ok(raw.subarray(0, 4).toString('latin1') === 'MIND', 'A5 sidecar carries MIND magic (encrypted)');
  ok(!raw.toString('latin1').includes('"operator"') && !raw.toString('latin1').includes('"author"'),
    'A5b no plaintext provenance leaks to disk');

  // ── A6: the sidecar never attributes itself; invisible to history ──────────
  await authorship.recordWrite('.authorship.json', 'agent'); // must be a no-op
  ok((await authorship.getAuthorship('.authorship.json')) === null, 'A6 sidecar not self-attributed');
  ok((await mf.listSnapshots('.authorship.json')).length === 0, 'A6b sidecar has no snapshot history');

  // ── A7: a never-written file has no provenance ─────────────────────────────
  ok((await authorship.getAuthorship('model.md')) === null, 'A7 unwritten file → null');

  // ── A8: editMindFile + removeFromMind also attribute 'agent' ───────────────
  await handlers.editMindFile({ filename: 'self.md', old_string: 'Edited again.', new_string: 'Edited thrice.' });
  a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'agent', 'A8 editMindFile attributes agent', JSON.stringify(a));

  // ── A9: ⭐ Finding-1 regression — the agent CANNOT forge provenance by writing
  //    the sidecar through its ordinary tools. The dotfile is off-limits at the
  //    tool boundary, so getAuthorship still says whoever really wrote self.md.
  await authorship.recordWrite('self.md', 'operator'); // set a known truth
  const forged = JSON.stringify({ 'self.md': { author: 'agent', at: '2000-01-01T00:00:00.000Z' } });
  const r9a = JSON.parse(await handlers.writeMindFileWhole({ filename: '.authorship.json', content: forged }));
  const r9b = JSON.parse(await handlers.editMindFile({ filename: '.authorship.json', old_string: 'operator', new_string: 'agent' }));
  const r9c = JSON.parse(await handlers.snapshotMindFile({ filename: '.authorship.json' }));
  ok(r9a.ok === false && r9b.ok === false && r9c.ok === false, 'A9 agent tools REFUSE the dotfile sidecar', `${r9a.error}/${r9b.error}/${r9c.error}`);
  a = await authorship.getAuthorship('self.md');
  ok(a && a.author === 'operator', 'A9b provenance UNFORGED after sidecar-write attempts', JSON.stringify(a));

  // ── A10: attribution carries a content HASH ⇒ staleness is detectable ──────
  await handlers.writeMindFileWhole({ filename: 'self.md', content: 'CANONICAL BODY' });
  a = await authorship.getAuthorship('self.md');
  const { contentHash } = await import('../src/mindfiles/authorship.js');
  ok(a && a.hash === contentHash('CANONICAL BODY'), 'A10 hash matches attributed content', a?.hash?.slice(0, 8));
  ok(a.hash !== contentHash('SOMETHING ELSE'), 'A10b hash detects a divergent live content');

  // ── A11: ⭐ the AGENT tool path actually SNAPSHOTS the pre-write state — the
  //    spine of V12 (an agent overnight rewrite must be recoverable/diffable).
  //    self.md has been rewritten several times above; today's snapshot must exist.
  const today = new Date().toISOString().split('T')[0];
  const snaps = await mf.listSnapshots('self.md');
  ok(snaps.includes(today), 'A11 agent write auto-snapshots the prior self.md', JSON.stringify(snaps));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
