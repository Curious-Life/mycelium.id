// Load the 111-table schema into a fresh SQLite db.
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.argv[2] || 'data/mycelium.db';
const schemaPath = process.argv[3] || 'migrations/0001_init.sql';
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(readFileSync(schemaPath, 'utf8'));
const n = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
console.log(`init-db: ${n} tables in ${dbPath}`);
db.close();
