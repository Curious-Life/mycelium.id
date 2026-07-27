// scripts/lib/pipeline-fixture.mjs — a REAL vault for the end-to-end pipeline gate.
//
// Not a mock. The stages decrypt `messages.embedding_768` as raw LE-f32 bytes and cluster on the
// result, so a fixture of `'x'` strings (the shape used by verify-pipeline-integrity) proves
// nothing about whether the pipeline RUNS. This writes genuine 768-dim L2-normalised vectors drawn
// from K separated centres, so cluster.py finds real structure and every downstream metric stage
// has something to compute over.
//
// Deterministic by construction (a seeded LCG, never Math.random) — a gate that produces a
// different vault each run is a gate that flakes, and a flaky gate gets ignored.
//
// Content-free: the message text is generated filler. Nothing here touches a real vault.
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/db/migrate.js';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DIM = 768;

/**
 * @param {object} [o]
 * @param {string} [o.dbPath]      where to write the vault
 * @param {string} [o.userId]
 * @param {number} [o.clusters]    latent cluster count
 * @param {number} [o.perCluster]  messages per cluster
 * @param {number} [o.days]        spread of created_at, in days
 * @returns {{ dbPath:string, userId:string, messages:number, clusters:number }}
 */
export function buildPipelineFixture({
  dbPath = 'data/verify-pipeline-e2e.db',
  userId = 'local-user',
  clusters = 4,
  perCluster = 60,
  days = 180,
} = {}) {
  // A stale vault from a previous run would let a stage "pass" on last run's rows.
  if (existsSync(dbPath)) unlinkSync(dbPath);
  try { mkdirSync(dirname(dbPath), { recursive: true }); } catch { /* exists */ }

  const db = new Database(dbPath);
  applyMigrations(db);

  let s = 0x2545f491;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

  db.prepare('INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)').run(userId, 'Fixture');

  const centres = Array.from({ length: clusters }, () => unit(Array.from({ length: DIM }, () => gauss())));
  const ins = db.prepare(`
    INSERT INTO messages (id, user_id, role, content, message_type, created_at,
                          nlp_processed, embedding_768, scope, agent_id, conversation_id)
    VALUES (?, ?, ?, ?, 'chat', ?, 2, ?, 'personal', 'personal-agent', ?)`);

  const START = Date.UTC(2026, 0, 1);
  const DAY = 86_400_000;
  let n = 0;

  db.transaction(() => {
    for (let c = 0; c < clusters; c++) {
      for (let i = 0; i < perCluster; i++) {
        // centre + noise: tight enough to cluster, loose enough not to be degenerate.
        const v = unit(centres[c].map((x) => x + gauss() * 0.35));
        const buf = Buffer.alloc(DIM * 4);
        v.forEach((x, j) => buf.writeFloatLE(x, j * 4));
        // Spread over `days` with a diurnal hour — the behavioral/frequency/fisher stages need a
        // time series, not a single timestamp.
        const day = Math.floor((i / perCluster) * days);
        const hour = 8 + (i % 12);
        const ts = new Date(START + day * DAY + hour * 3_600_000).toISOString();
        ins.run(`m-${c}-${i}`, userId, i % 3 === 0 ? 'assistant' : 'user',
          `Note about topic ${c}, entry ${i}. ${'context '.repeat(20)}`,
          ts, buf, `conv-${c}-${Math.floor(i / 10)}`);
        n++;
      }
    }
  })();

  db.close();
  return { dbPath, userId, messages: n, clusters };
}
