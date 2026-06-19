// verify:cluster-embed — cluster.py's full-text window + weight-pool helpers
// (the β fix: imported attachment/document points cluster on FULL content, not
// the first 2000 chars). Spawns the venv python on the pure property test in
// pipeline/lab/cluster_embed_test.py (no ONNX model, no D1). Mirrors the
// python-gate pattern used by verify:fisher et al.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PY = existsSync('pipeline/.venv/bin/python3') ? 'pipeline/.venv/bin/python3' : 'python3';
const HEX64 = 'a'.repeat(64);
const r = spawnSync(PY, ['pipeline/lab/cluster_embed_test.py'], {
  stdio: 'inherit',
  // cluster.py touches MYCELIUM_DB at import; a dummy path is enough (the test
  // never opens it — main() is __name__-guarded and the helpers are pure).
  env: {
    ...process.env,
    PYTHONPATH: 'pipeline',
    MYCELIUM_DB: process.env.MYCELIUM_DB || '/tmp/verify-cluster-embed-dummy.db',
    MINDSCAPE_OWNER_ID: process.env.MINDSCAPE_OWNER_ID || 'local-user',
    USER_MASTER: process.env.USER_MASTER || HEX64,
    SYSTEM_KEY: process.env.SYSTEM_KEY || HEX64,
  },
});
if (r.error) { console.error(`VERDICT: NO-GO — could not run python (${r.error.message})`); process.exit(1); }
process.exit(r.status === 0 ? 0 : 1);
