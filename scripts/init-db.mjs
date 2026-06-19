// Load the full schema (all migrations/*.sql in order) into a SQLite db.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyMigrations } from '../src/db/migrate.js';
import { dbPath as resolveDbPath } from '../src/paths.js';

// Explicit arg wins (e.g. data/verify-*.db); else <dataDir>/mycelium.db — which
// honours MYCELIUM_DATA_DIR/MYCELIUM_DB and falls back to ./data in dev.
const dbPath = process.argv[2] || resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
const applied = applyMigrations(db);
const n = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
console.log(`init-db: ${n} tables in ${dbPath} (${applied.length} migrations: ${applied.join(', ')})`);
db.close();
