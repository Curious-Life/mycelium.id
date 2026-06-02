// Apply all migrations/*.sql in lexical order against a better-sqlite3 db.
//
// Single source of truth so init-db + every verify script load the SAME schema
// — no per-script hardcoded 0001_init.sql (which drifts the moment a 0002 lands).
// Idempotent-ish: re-running on a populated db re-execs CREATE TABLE IF NOT
// EXISTS (no-op) but a bare ALTER TABLE ADD COLUMN would throw "duplicate
// column". So ALTERs are guarded here by a pragma check before exec.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
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
  return files;
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
