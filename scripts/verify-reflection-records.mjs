// scripts/verify-reflection-records.mjs — Context Engine "day cards" gate.
//
// A dated, queryable per-cycle reflection record for categorizing days + tracing red threads.
// Verifies: migration 0032 (table + plaintext keys + indexes), the encryption allowlist, the
// DAL (record / recent / listRange + themes JSON round-trip + defaults), the recordReflection /
// listReflections tools, that EVERY cycle logs one, and chat-grantability.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createReflectionsNamespace } from '../src/db/reflections.js';
import { createReflectionsDomain } from '../src/tools/reflections.js';
import { CYCLES } from '../src/agent/cycle-prompts.js';
import { isGrantableTool, DOMAINS } from '../src/agent/tool-domains.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

// ── 1. migration + encryption ────────────────────────────────────────────────
const db = new Database(':memory:');
applyMigrations(db);
applyMigrations(db); // idempotent
const cols = db.prepare('PRAGMA table_info(reflection_records)').all().map((r) => r.name);
ok(['id', 'user_id', 'cycle', 'day', 'summary', 'themes', 'day_type', 'body', 'created_at'].every((c) => cols.includes(c)), 'migration 0032 creates reflection_records with all columns');
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_reflection_records_%'").all().map((r) => r.name);
ok(idx.length >= 2, 'day + cycle indexes created', `(${idx.length})`);
const crypto = readFileSync(join(ROOT, 'src/crypto/crypto-local.js'), 'utf8');
ok(/reflection_records:\s*\[[^\]]*'summary'[^\]]*'themes'[^\]]*'day_type'[^\]]*'body'/.test(crypto), 'ENCRYPTED_FIELDS encrypts summary/themes/day_type/body (cycle/day stay plaintext)');

// ── 2. DAL (raw d1Query over the real schema; encryption is the adapter's job) ─
let n = 0;
const d1Query = async (sql, params = []) => {
  const stmt = db.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: stmt.all(...params) };
  stmt.run(...params); return { results: [] };
};
const ns = createReflectionsNamespace({ d1Query, randomUUID: () => `r${++n}`, now: () => new Date().toISOString() });

await ns.record('u1', { cycle: 'evening', day: '2026-06-18', summary: 'shipped the index fix; publishing still blocked', themes: ['publishing block', 'shipping'], dayType: 'build-heavy' });
await ns.record('u1', { cycle: 'integration', day: '2026-06-19', summary: 'podcast broke the block', themes: ['publishing block'], dayType: 'breakthrough' });
await ns.record('u1', { cycle: 'weird-cycle', day: 'not-a-date', summary: 'fallback test' }); // → cycle 'adhoc', day today

const recent = await ns.recent('u1', { limit: 10 });
ok(recent.length === 3, 'recent returns all records', `(${recent.length})`);
ok(Array.isArray(recent[0].themes), 'themes round-trips as an array (JSON parse)');
const evening = recent.find((r) => r.cycle === 'evening');
ok(evening && evening.themes.includes('publishing block') && evening.dayType === 'build-heavy', 'record fields persist + decode');
const adhoc = recent.find((r) => r.cycle === 'adhoc');
ok(adhoc && /^\d{4}-\d{2}-\d{2}$/.test(adhoc.day), 'unknown cycle → adhoc; bad date → today');

// filter a fixed past day (avoids colliding with the adhoc record stamped "today")
const range = await ns.listRange('u1', { start: '2026-06-18', end: '2026-06-18' });
ok(range.length === 1 && range[0].cycle === 'evening', 'listRange filters by day');

// red-thread trace: find every record touching a theme (JS-side over decrypted records)
const thread = recent.filter((r) => r.themes.includes('publishing block'));
ok(thread.length === 2, 'a red thread can be traced across days', `(${thread.length})`);

// ── 3. tools ─────────────────────────────────────────────────────────────────
const { tools, handlers } = createReflectionsDomain({ db: { reflections: ns }, userId: 'u1' });
ok(tools.map((t) => t.name).sort().join(',') === 'listReflections,recordReflection', 'domain exposes recordReflection + listReflections');
ok(/Error/.test(await handlers.recordReflection({})), 'recordReflection requires a summary');
const r = await handlers.recordReflection({ cycle: 'morning', summary: 'a fresh start', themes: ['x'] });
ok(/Recorded morning reflection/.test(r), 'recordReflection writes a record');
ok(/publishing block/.test(await handlers.listReflections({})), 'listReflections shows the records + threads');

// ── 4. every cycle logs a day card ───────────────────────────────────────────
ok(CYCLES.every((c) => c.body.includes('recordReflection') && c.body.includes(`cycle: '${c.id}'`)), 'every cycle body ends with recordReflection (its own id)');
ok(CYCLES.every((c) => c.enabledTools.includes('recordReflection')), 'every cycle is granted recordReflection');

// ── 5. chat-grantable ────────────────────────────────────────────────────────
ok(DOMAINS.some((d) => d.key === 'reflections'), "tool-domains has a 'reflections' domain");
ok(['recordReflection', 'listReflections'].every((t) => isGrantableTool(t)), 'reflection tools are chat-grantable');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
