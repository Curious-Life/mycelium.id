// Apply all migrations/*.sql in lexical order against a better-sqlite3 db.
//
// Single source of truth so init-db + every verify script load the SAME schema
// — no per-script hardcoded 0001_init.sql (which drifts the moment a 0002 lands).
// Idempotent-ish: re-running on a populated db re-execs CREATE TABLE IF NOT
// EXISTS (no-op) but a bare ALTER TABLE ADD COLUMN would throw "duplicate
// column". So ALTERs are guarded here by a pragma check before exec.
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLedger, readLedger, recordApplied, inspectLineage, assertLineageStrict, sha256 } from './migration-ledger.js';

const MIGRATIONS_DIR = 'migrations';

/** Columns already present on a table (lowercased names). */
function columnSet(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name.toLowerCase()));
  } catch { return new Set(); }
}

/**
 * Apply every migrations/*.sql in order. CREATE TABLE IF NOT EXISTS is
 * naturally idempotent. `ALTER TABLE <t> ADD COLUMN <c>` is made idempotent by
 * skipping when the column already exists (SQLite has no ADD COLUMN IF NOT
 * EXISTS). A file that adds columns is applied statement-by-statement so EVERY
 * bare ADD COLUMN is guarded — the previous first-match-only guard silently
 * skipped columns 2..n when re-running a multi-ADD-COLUMN file on a populated
 * db. Returns the list of files applied.
 */
export function applyMigrations(db, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  // LEDGER (see db/migration-ledger.js): record what shaped this vault + skip what's already
  // applied (real vault: 458ms → 3ms per boot). Bootstrap: an un-ledgered vault has an EMPTY
  // ledger → every file runs the idempotent path exactly as before, then is recorded.
  // Divergence is REPORTED, never gated — a boot-time refusal on a Finder-launched app is an
  // unrecoverable white screen, and dev/prod share one vault so branch skew is routine.
  ensureLedger(db);
  const present = new Map(files.map((f) => [f, sha256(readFileSync(join(dir, f), 'utf8'))]));
  const ledger = readLedger(db);
  const findings = inspectLineage(ledger, present);
  if (findings.foreign.length) {
    console.error(`[mycelium] VAULT LINEAGE: this vault records ${findings.foreign.length} migration(s) this build does not have ` +
      `(${findings.foreign.slice(0, 4).join(', ')}${findings.foreign.length > 4 ? ', …' : ''}). Another build (a different repo ` +
      `checkout, a newer version, or a feature branch) migrated it. Booting anyway; schema assumptions may not hold.`);
  }
  if (findings.changed.length) {
    console.error(`[mycelium] VAULT LINEAGE: migration file(s) changed after being applied ` +
      `(${findings.changed.slice(0, 4).join(', ')}${findings.changed.length > 4 ? ', …' : ''}). Re-recording; not re-applying.`);
  }
  assertLineageStrict(findings); // no-op unless MYCELIUM_STRICT_LINEAGE=1 (CI only)

  // SELF-HEAL (regression guard): the pre-ledger code re-asserted every file on every boot,
  // so a dropped/missing table silently came back. Skip-if-applied removes that safety net.
  // Cheap restoration: if any table this build expects is ABSENT, ignore the ledger for this
  // boot and re-assert everything (all files are idempotent — CREATE TABLE IF NOT EXISTS +
  // guarded ADD COLUMN + the two self-idempotent backfills).
  // Only meaningful once the ledger would make us SKIP: on a fresh/bootstrap vault every
  // table is "missing" by definition — that's the initial apply, not a heal.
  const missing = ledger.size ? missingExpectedTables(db, dir, files) : [];
  const heal = missing.length > 0;
  if (heal) {
    console.error(`[mycelium] vault schema is missing ${missing.length} expected table(s) ` +
      `(${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}) → re-applying all migrations (self-heal)`);
  }

  const applied = [];
  for (const f of files) {
    if (!heal && ledger.get(f) === present.get(f)) continue; // already applied, unchanged → skip
    const sql = readFileSync(join(dir, f), 'utf8');
    applyOne(db, sql);
    recordApplied(db, f, present.get(f));
    applied.push(f);
  }

  // SCHEMA DRIFT — the only check that can see a LEDGER-LESS foreign build (the canonical
  // repo records nothing, so the ledger above stays silent). Runs AFTER our own migrations
  // so anything left over is genuinely not ours. Warn-only + best-effort: this must never
  // affect whether the vault opens. On the live vault today this reports
  // attachments.transcribe_attempts — the canonical repo's 0041.
  try {
    const drift = schemaDrift(db, dir);
    if (drift.length) {
      const shown = drift.slice(0, 6).map((d) => `${d.table}.${d.column}`).join(', ');
      console.error(`[mycelium] VAULT SCHEMA DRIFT: ${drift.length} column(s) present that this build's ` +
        `migrations never create (${shown}${drift.length > 6 ? ', …' : ''}). Another Mycelium build has migrated ` +
        `this vault — check that no other codebase/MCP points at this data dir (~/.claude.json). Booting anyway.`);
    }
  } catch { /* never let a diagnostic break boot */ }

  return applied;
}

// Never treat a SQL keyword as a table name. Without this, a `CREATE TABLE IF NOT EXISTS x`
// whose optional-group match slips captures "IF" → a table that can never exist → self-heal
// fires on EVERY boot and re-applies all 54 migrations, silently undoing the whole point.
const NOT_A_TABLE = new Set(['if', 'not', 'exists', 'temp', 'temporary', 'virtual']);

/** Table names this build's migrations create (cheap regex over CREATE TABLE …). */
function expectedTables(dir, files) {
  const out = new Set();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi)) {
      if (!NOT_A_TABLE.has(m[1].toLowerCase())) out.add(m[1]);
    }
  }
  return out;
}

/** Expected tables that are ABSENT from the vault (→ self-heal). Never throws. */
/**
 * WOULD applyMigrations WRITE to this vault? Answered from a READ-ONLY handle, so it can be
 * asked BEFORE anything opens the vault write-capable.
 *
 * This exists because of D-117's second half, and it was found by an adversarial review that
 * REPRODUCED 2,273,280 bytes written into a damaged ENCRYPTED vault on the very commit that
 * claimed to close D-117. The reasoning that let it through was mine and it was wrong: I
 * asserted an already-encrypted vault was covered by the runtime halt latch. It is not.
 * ensureVaultSchema opens the vault raw and keyed and calls applyMigrations BEFORE createDb
 * exists — the same un-latched raw-handle window I had granted only to plaintext vaults.
 *
 * The mechanism is the self-heal at :61-66: a damaged vault loses tables, missingExpectedTables
 * sees them missing, `heal` goes true, and EVERY migration is re-applied over the damage. So
 * "would this write?" is exactly the question, and it is cheap — a ledger read plus one
 * sqlite_master scan, no page walk — which is what makes the expensive quick_check affordable
 * to gate behind it instead of running on every boot of a multi-GB vault.
 *
 * FAILS TOWARD CHECKING. Any error answering the question returns true: "I could not tell
 * whether this write is safe" must mean "verify first", never "go ahead".
 *
 * @param {import('better-sqlite3').Database} db a READ-ONLY handle
 * @returns {boolean}
 */
export function migrationsWouldWrite(db, dir = MIGRATIONS_DIR) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const present = new Map(files.map((f) => [f, sha256(readFileSync(join(dir, f), 'utf8'))]));
    let ledger;
    try { ledger = readLedger(db); } catch { return true; }   // no ledger table ⇒ everything applies
    if (!ledger.size) return true;                             // pre-ledger or bootstrap vault
    if (missingExpectedTables(db, dir, files).length) return true; // the self-heal path
    return files.some((f) => ledger.get(f) !== present.get(f));
  } catch {
    return true;
  }
}

function missingExpectedTables(db, dir, files) {
  try {
    const have = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
    return [...expectedTables(dir, files)].filter((t) => !have.has(t));
  } catch { return []; }
}

/**
 * Columns present in the vault that THIS build's migrations never create — the fingerprint
 * of a foreign/divergent lineage (this is how `attachments.transcribe_attempts`, created only
 * by the canonical repo's 0041, is visible). Unlike the ledger, this SEES a ledger-less
 * foreign build. Reporting only: an extra column is ambiguous (foreign lineage vs. one of
 * your own feature branches), and boot-time refusal is not survivable in the shipped app.
 * @returns {Array<{table:string, column:string}>}
 */
export function schemaDrift(db, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const mem = new Database(':memory:');
  try {
    for (const f of files) { try { applyOne(mem, readFileSync(join(dir, f), 'utf8')); } catch { /* best-effort */ } }
    const drift = [];
    for (const t of expectedTables(dir, files)) {
      const expect = columnSet(mem, t);
      if (!expect.size) continue;
      for (const c of columnSet(db, t)) if (!expect.has(c)) drift.push({ table: t, column: c });
    }
    return drift;
  } catch { return []; } finally { try { mem.close(); } catch { /* */ } }
}

/** Apply ONE migration file with the idempotency guards (unchanged semantics). */
function applyOne(db, sql) {
  if (/ALTER TABLE\s+\w+\s+ADD COLUMN/i.test(sql)) {
    // Per-statement so each ADD COLUMN is guarded independently. Safe for the
    // simple ALTER/CREATE migration files (no procedural bodies / inner ';').
    for (const stmt of splitStatements(sql)) {
      const addCol = stmt.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
      if (addCol) {
        const [, table, col] = addCol;
        if (columnSet(db, table).has(col.toLowerCase())) continue; // already applied
      }
      db.exec(stmt);
    }
  } else {
    // No ADD COLUMN — CREATE TABLE IF NOT EXISTS files are naturally
    // idempotent; exec whole (preserves behavior for 0001's 111 tables).
    db.exec(sql);
  }
}

/** Split simple migration SQL into statements (strips line comments). */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
