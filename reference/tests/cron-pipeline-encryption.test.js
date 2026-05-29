/**
 * Regression guard: cron-pipeline scripts must route writes through the
 * canonical `@mycelium/core/db.js` chokepoint, NOT bare `fetch` to
 * /api/db/query or /api/db/batch.
 *
 * Why: the canonical d1Query in `packages/core/db-d1.js:241` calls
 * `autoEncryptParams` on every write (line 261) and fail-closes if the
 * master key is missing (line 251). Bare-fetch callers post raw plaintext
 * params to the Worker — which is a pure passthrough on writes (verified:
 * `packages/worker/src/handlers/db-proxy.ts` lines 35-37, 237-238). So
 * any write through bare fetch lands as plaintext in D1, violating §1
 * "Zero plaintext leakage."
 *
 * This bug class hid for months because the scripts' bare-fetch d1Query
 * helpers correctly applied `autoDecryptResults` on reads — round-tripping
 * through the same script returned decrypted data, even though the
 * underlying write was plaintext. The PR-A scanner caught it during R2-401
 * triage (multiple hosts found plaintext values
 * across realms / semantic_themes / territory_profiles).
 *
 * The fix migrated 5 scripts to `db.rawQuery` / `db.rawQueryBatch`. This
 * test pins the migration: any future PR that reintroduces a bare fetch
 * to /api/db/query or /api/db/batch in these files fails this assertion.
 *
 * If a writer needs raw access for a non-encryption-aware path (e.g. a
 * one-off operator script), use `db.rawQuery` (canonical) — there is
 * never a legitimate reason to bypass autoEncryptParams. If you find one,
 * document it in this test as an explicit allowlist entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const PIPELINE_SCRIPTS = [
  'scripts/describe-chronicles.js',
  'scripts/describe-clusters.js',
  'scripts/describe-territories.js',
  'scripts/backfill-semantic-themes.js',
  'scripts/compute-vitality.js',
];

// Regex matches `fetch(...)` calls whose URL string contains either the
// `/api/db/query` or `/api/db/batch` Worker route. Catches:
//   fetch(`${WORKER_URL}/api/db/query`, ...)
//   fetch('http://worker/api/db/batch', ...)
//   fetch(WORKER_URL + "/api/db/query", ...)
// Whitespace and quote variants permitted between `fetch(` and the URL.
const BARE_DB_FETCH_RE = /fetch\s*\([^)]*\/api\/db\/(query|batch)/;

describe('cron-pipeline encryption discipline', () => {
  for (const path of PIPELINE_SCRIPTS) {
    it(`${path} routes writes through canonical db helpers (no bare /api/db/query|batch fetch)`, () => {
      const src = readFileSync(resolve(repoRoot, path), 'utf8');
      const matches = src.split('\n').filter((line) => BARE_DB_FETCH_RE.test(line));
      assert.deepEqual(
        matches,
        [],
        `${path} contains bare fetch to /api/db/query or /api/db/batch — ` +
          `must use db.rawQuery / db.rawQueryBatch from @mycelium/core/db.js. ` +
          `Offending line(s):\n${matches.join('\n')}`,
      );
    });

    it(`${path} imports initDb + getDb from @mycelium/core/db.js`, () => {
      const src = readFileSync(resolve(repoRoot, path), 'utf8');
      const hasInit = /import\s*\{[^}]*\binitDb\b[^}]*\}\s*from\s*['"]@mycelium\/core\/db\.js['"]/.test(src);
      const hasGetDb = /import\s*\{[^}]*\bgetDb\b[^}]*\}\s*from\s*['"]@mycelium\/core\/db\.js['"]/.test(src);
      assert.equal(hasInit, true, `${path} must import initDb from @mycelium/core/db.js`);
      assert.equal(hasGetDb, true, `${path} must import getDb from @mycelium/core/db.js`);
    });
  }
});

/**
 * Phase D2: Python writers in `scripts/cluster.py` cannot use the
 * JS-only canonical chokepoint. The bridge at `scripts/d1-write-bridge.js`
 * shells the canonical `db.rawQueryBatch` from Node, reachable via
 * `subprocess.run` from Python. This pair of tests pins both halves of
 * the bridge so a future PR can't quietly revert cluster.py back to
 * raw `d1_batch` for `activity_timeline` writes.
 */
describe('cron-pipeline encryption discipline — Phase D2 (Python bridge)', () => {
  it('scripts/d1-write-bridge.js exists and imports the canonical chokepoint', () => {
    const src = readFileSync(resolve(repoRoot, 'scripts/d1-write-bridge.js'), 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*\binitDb\b[^}]*\bgetDb\b[^}]*\}\s*from\s*['"]@mycelium\/core\/db\.js['"]/,
      'bridge must import initDb + getDb from @mycelium/core/db.js',
    );
    assert.match(
      src,
      /db\.rawQueryBatch\s*\(/,
      'bridge must call db.rawQueryBatch (the canonical encrypted batch path)',
    );
  });

  it('scripts/cluster.py writes activity_timeline through the bridge, not bare d1_batch', () => {
    const src = readFileSync(resolve(repoRoot, 'scripts/cluster.py'), 'utf8');

    // Both `activity_timeline` UPDATE blocks must be written via the
    // d1_batch_encrypted helper (which shells to d1-write-bridge.js).
    // If anyone reverts to plain d1_batch, the regex check fails.
    const lines = src.split('\n');
    const timelineWriteContexts = [];
    for (let i = 0; i < lines.length; i++) {
      if (/activity_timeline\s*=\s*\?/.test(lines[i])) {
        // Look ahead 15 lines for the d1_batch(... call that ships this
        // statement. The actual call is in a tight loop below the SQL.
        const ctx = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
        timelineWriteContexts.push({ atLine: i + 1, ctx });
      }
    }
    assert.equal(
      timelineWriteContexts.length,
      2,
      `expected exactly 2 activity_timeline write blocks in cluster.py, found ${timelineWriteContexts.length}`,
    );
    for (const { atLine, ctx } of timelineWriteContexts) {
      assert.match(
        ctx,
        /d1_batch_encrypted\s*\(/,
        `activity_timeline write near line ${atLine} must use d1_batch_encrypted (the Python→Node bridge), not bare d1_batch`,
      );
      assert.doesNotMatch(
        ctx,
        /\bd1_batch\s*\([^)]*statements/,
        `activity_timeline write near line ${atLine} must NOT call d1_batch directly — that bypasses encryption`,
      );
    }
  });

  it('scripts/cluster.py imports subprocess + defines d1_batch_encrypted helper', () => {
    const src = readFileSync(resolve(repoRoot, 'scripts/cluster.py'), 'utf8');
    assert.match(src, /^import\s+subprocess$/m, 'cluster.py must import subprocess (for the bridge invocation)');
    assert.match(
      src,
      /def\s+d1_batch_encrypted\s*\(/,
      'cluster.py must define d1_batch_encrypted helper that shells to d1-write-bridge.js',
    );
    assert.match(
      src,
      /d1-write-bridge\.js/,
      'd1_batch_encrypted helper must reference the bridge script path',
    );
  });
});
