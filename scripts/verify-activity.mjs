// verify:activity — the unified activity feed over background_jobs (db.activityFeed).
// Boots a temp vault, round-trips begin/heartbeat/finish/active/recent, proves the
// fail-closed reaper flips a stale 'running' row → 'abandoned', and asserts the rows
// are CONTENT-FREE (kind/status/step/stage only — never message text or names, §1).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-activity.db', KCV = 'data/verify-activity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const af = db.activityFeed;
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// A raw connection for direct inspection / backdating (bypasses the adapter).
const raw = new Database(DB);
const rowOf = (id) => raw.prepare('SELECT id,kind,status,step,total_steps,stage_label FROM background_jobs WHERE id = ?').get(id);

// A1. begin → active shows a running row
const id = await af.begin({ userId: U, kind: 'describe:name', totalSteps: 5, stageLabel: 'Naming areas' });
let active = await af.active(U);
rec('A1. begin → active shows the running job', active.length === 1 && active[0].kind === 'describe:name' && Number(active[0].total_steps) === 5, JSON.stringify(active[0] || {}));

// A2. heartbeat → step advances + total updates
await af.heartbeat(id, { step: 3, totalSteps: 6 });
active = await af.active(U);
rec('A2. heartbeat advances step + total', Number(active[0]?.step) === 3 && Number(active[0]?.total_steps) === 6, `step=${active[0]?.step} total=${active[0]?.total_steps}`);

// A2b. stalled flag round-trips via the keep-alive heartbeat (Gap #4)
await af.heartbeat(id, { stalled: true });
active = await af.active(U);
const stalledOn = Number(active[0]?.stalled) === 1;
await af.heartbeat(id, { stalled: false });
active = await af.active(U);
const stalledOff = Number(active[0]?.stalled) === 0;
rec('A2b. heartbeat carries stalled (true→1, false→0)', stalledOn && stalledOff, `on=${stalledOn} off=${stalledOff}`);

// A2c. a keep-alive heartbeat refreshes last_heartbeat → a slow-but-alive job is NOT
// false-reaped (the Gap #4 regression: the feed reaped quiet-but-running jobs because
// heartbeats only fired on Step lines). The watchdog's stalled-tick keeps it fresh.
raw.prepare("UPDATE background_jobs SET last_heartbeat = datetime('now','-120 seconds') WHERE id = ?").run(id);
await af.heartbeat(id, { stalled: true });
await af.reap(U);
rec('A2c. stalled keep-alive prevents false-reap', rowOf(id)?.status === 'running', JSON.stringify(rowOf(id) || {}));

// A3. finish → leaves active, enters recent (done)
await af.finish(id, { status: 'done' });
active = await af.active(U);
const recent = await af.recent(U, 5);
rec('A3. finish → not active; appears in recent as done', active.length === 0 && recent.some((r) => r.id === id && r.status === 'done'), `active=${active.length} recent=${recent.length}`);

// A4. reaper is fail-closed: a stale 'running' row (dead child) → 'abandoned'
const stale = await af.begin({ userId: U, kind: 'mycelium_generate', totalSteps: 16, stageLabel: 'Mapping your mind' });
raw.prepare("UPDATE background_jobs SET last_heartbeat = datetime('now','-120 seconds') WHERE id = ?").run(stale);
await af.reap(U);
rec('A4. reap flips a stale running row → abandoned (fail-closed)', rowOf(stale)?.status === 'abandoned', JSON.stringify(rowOf(stale)));
active = await af.active(U);
rec('A4b. reaped row is not active', !active.some((r) => r.id === stale), `active=${active.length}`);

// A5. content-free: kind is a known token, stage_label is a constant phrase — no
// names, no message text ever lands in a row (§1 zero-plaintext-leakage).
const c = rowOf(id);
const cleanStage = /^[A-Za-z][A-Za-z ]*$/.test(c?.stage_label || '');
const knownKind = /^(describe:name|describe:chronicle|mycelium_generate|embed)$/.test(c?.kind || '');
rec('A5. rows are content-free (constant stage label + known kind, no names)', cleanStage && knownKind, JSON.stringify(c));

raw.close();
close();
const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — activity feed: begin/heartbeat/finish/active/recent + fail-closed reap + content-free  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);
