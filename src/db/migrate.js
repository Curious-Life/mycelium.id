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
 * naturally idempotent; `ALTER TABLE <t> ADD COLUMN <c>` is made idempotent by
 * skipping when the column already exists (SQLite has no ADD COLUMN IF NOT
 * EXISTS). Returns the list of files applied.
 */
export function applyMigrations(db, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // Guard bare ADD COLUMN against re-run (idempotency on a populated db).
    const addCol = sql.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
    if (addCol) {
      const [, table, col] = addCol;
      if (columnSet(db, table).has(col.toLowerCase())) continue; // already applied
    }
    db.exec(sql);
  }
  return files;
}
