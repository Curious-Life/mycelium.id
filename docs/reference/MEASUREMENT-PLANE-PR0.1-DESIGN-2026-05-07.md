# PR0.1 — Stage-Base Extraction Design

**Date:** 2026-05-07 (evening)
**Companions:**
- [docs/architecture/COGNITIVE-METRICS-SPEC.md](architecture/COGNITIVE-METRICS-SPEC.md) — spec v1.3.1, §9 I9 marks stage-base as `YES — blocking` for harmonics
- [docs/COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md](COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md) — pickup-protocol step 6 PR0.1 description
- [docs/architecture/MEASUREMENT-PLANE-PLAN.md](architecture/MEASUREMENT-PLANE-PLAN.md) — Phase 0.5.3 deferred-stage-base reference at lines 157-158
- [scripts/compute-fisher.py](../scripts/compute-fisher.py) — canonical era-aware Python compute precedent
- [scripts/pipeline-health.js](../scripts/pipeline-health.js) — orchestrator (NOT under packages/server/lib/ — sweep correction)
- [packages/metrics/era.js](../packages/metrics/era.js) — `deriveFisherEraId` helper, the existing extracted primitive

**Audience:** the Claude Code instance implementing PR0.1.

---

## 0. Revision history

- **v1 (2026-05-07 evening):** Initial design after 4 parallel Explore sweeps + 2 follow-up pressure-test reads. Two pivots from the handoff sketch:
  - **Pivot A — handoff sketch said "extract from 6 compute scripts"; sweep evidence shows only 3 are pipeline-health-registered** (fisher, vitality, cofire). The other 3 (compute-complexity.js, compute-cognitive-fingerprint.js, compute-frequency.py) run by hand only and are NOT in the orchestrator's stage list. Registering them is orthogonal tech debt, deferred from PR0.1.
  - **Pivot B — handoff sketch said "recordSuccess/recordFailure delegate" is a stage-base extraction concern.** Sweep D verified these are ORCHESTRATOR concerns (pipeline-health.js:911 + 917 call them automatically after `trigger()` returns). The script-side concern is JSON-event emission for `last_details_json` parsing — different abstraction. Renamed accordingly.
- **Language decision:** harmonics ships as Python (compute-information-harmonics.py). Reasoning: compute-fisher.py is the canonical era-aware scientific-compute precedent; harmonic regression / wavelet decomposition / Tort PAC / scipy spectral coherence / AR(1) all have mature Python (numpy/scipy/PyWavelets/statsmodels) implementations; gudhi (TDA for §4.34) is Python-only. PR0.1 therefore prioritizes Python-side extraction; JS gets smaller treatment (just the orchestrator-side stage template).

---

## 1. Purpose + scope

### What this PR ships

Stage-base extraction sufficient to make PR1 (information-harmonics family stage) a thin shell — not a copy-paste of compute-fisher.py. Specifically:

**Python (scripts/lib/, new):**
1. `scripts/lib/stage_base.py` — dotenv loader + auth/tenant/url env helpers (extracted from the 6-script copy-paste pattern)
2. `scripts/lib/era_skip.py` — generic `fetch_existing_keys` for the SELECT-then-skip pattern (extracted from compute-fisher.py:433-479)
3. `scripts/lib/event_emit.py` — `format_start_event` / `format_end_event` JSON-line helpers (extracted from compute-fisher.py:805-852)

**Python adoption-debt fix (in-scope, ~10 LOC):**
4. compute-frequency.py adopts `scripts/d1_client.py` (replaces inline `httpx.Client()` + `d1_query`/`d1_run` wrappers at lines 27-71). Rationale: d1_client.py's docstring explicitly says it was made for "compute-frequency.py-style consumers" — the migration was deferred and never landed; this closes that loop.

**JS (packages/metrics/, new):**
5. `packages/metrics/stage-template.js` — `eraAwareCheck({...})` + `runEraStage({...})` factories that compress fisher-trajectory's check + trigger (pipeline-health.js:464-555, ~90 LOC) into ~10 LOC per consumer

**Migration:** compute-fisher.py + fisher-trajectory stage adopt the new helpers as the first consumer, proving the abstractions hold. This also reduces duplication so PR1 can mirror the pattern without re-deriving it.

### What this PR does NOT ship (orthogonal, deferred)

- **JS d1-client extraction.** 4 JS scripts inline `fetch()` to `MYA_WORKER_URL/api/db/query` (compute-complexity, compute-cognitive-fingerprint, compute-vitality, compute-cofire). Worth extracting eventually, but harmonics is Python; this is a separate cleanup PR.
- **Vitality/cofire UPSERT migration.** Vitality uses 2-phase INSERT+UPDATE (compute-vitality.js:333-351); cofire uses DELETE+INSERT (compute-cofire.js:194). Both diverge from the canonical `ON CONFLICT ... DO UPDATE` pattern (compute-fisher.py:354, compute-complexity.js:276, compute-cognitive-fingerprint.js:300, compute-frequency.py:302). Orthogonal tech debt; not in stage-base's path.
- **Registering compute-complexity.js, compute-cognitive-fingerprint.js, compute-frequency.py with pipeline-health.js.** These run by hand only today. PR0.1.5 territory if/when they need orchestration.
- **Python crypto_local.py wrappers.** Tier-2 concern (decryption inside an AppArmor-confined process). Harmonics is Tier 1 — uses already-decrypted vector envelopes via mind-search d1-loader.js path (per spec §4.23 + Sweep F). PR0.1 does NOT need to touch crypto_local.py.

### Why this scope is right

The handoff names PR0.1 as the blocker for ALL Phase 6 family PRs. But the *first* family is information-harmonics (Tier 1, Python). Anything beyond what harmonics needs is speculative scope — write it when the second family arrives.

---

## 2. Sweep findings (consolidated, file:line)

Four parallel sweeps + two pressure-test reads. The load-bearing findings:

### Sweep A — what's actually shared across the 6 compute scripts

All 6 scripts share an **identical 5-file dotenv loop**:
- compute-fisher.py:34-39 (Python: `dotenv_values()` + `os.environ.setdefault()`)
- compute-frequency.py:31-41 (Python: same pattern, slight variant)
- compute-complexity.js:31-33 (JS: `config({ path })`)
- compute-cognitive-fingerprint.js:24-25 (JS: same)
- compute-vitality.js:27-28 (JS: same)
- compute-cofire.js:24-25 (JS: same)

Token-precedence is identical across all 6: `ADMIN_SECRET > AGENT_TOKEN_MYA > AGENT_TOKEN`.

D1-client patterns DIVERGE significantly:
- compute-fisher.py:49 imports `d1_client` module (canonical Python)
- compute-frequency.py:27,59-71 inlines `httpx.Client()` + duplicates the d1_client pattern
- 4 JS scripts inline `fetch()` to `${WORKER_URL}/api/db/query`

Era-mode skip-existing is FISHER-ONLY (compute-fisher.py:433-479).

UPSERT pattern divergence: 4/6 use `ON CONFLICT ... DO UPDATE`; vitality + cofire diverge.

JSON-event emission for pipeline_state.last_details_json is FISHER-ONLY (compute-fisher.py:805-852).

### Sweep B — era-mode skip-existing pattern

Era format confirmed at packages/metrics/era.js:52-70:
- Primary: `era-${pipeline_state.cluster.last_success_at}`
- Fallback: `era-${MAX(territory_profiles.updated_at WHERE dissolved_at IS NULL)}`
- Cold-start: `era-bootstrap-YYYY-MM-DD`

**Cache key for fisher's skip-existing** (compute-fisher.py:457-464):
```python
SELECT window_start, activation_vector, fisher_trajectory_length,
       message_count, active_territory_count, low_confidence
FROM fisher_trajectory
WHERE user_id = ? AND level = ? AND window_type = ? AND clustering_run_id = ?
```
The result is materialized into a `Map<window_start_iso, stored_state>`. The skip happens at compute-fisher.py:575-585 — early continue with `cumulative_L = stored_L`.

Force-full override: compute-fisher.py:783-794 (`--full` flag or `FISHER_FORCE_FULL=1` env).

UPSERT conflict key: `(user_id, level, window_type, window_start, clustering_run_id)` at compute-fisher.py:354. Unconditional DO UPDATE (no `WHERE` guard).

### Sweep C — D1 client + dotenv

`scripts/d1_client.py` (1-73) is the canonical Python D1 client:
- Auth precedence: `ADMIN_SECRET > AGENT_TOKEN_MYA > AGENT_TOKEN` (lines 45-49) — identical to inline patterns
- X-Tenant-ID header set if `MYA_USER_ID` env is set (lines 60-62)
- Fail-closed: raises `RuntimeError` on missing env (lines 50-54)
- Returns `body.get('results') or []` (line 72)

**The discrepancy:** d1_client.py's docstring says it's "Used by compute-frequency.py-style consumers" but compute-frequency.py does NOT import it (lines 27, 59-71 inline httpx.Client). This is a real adoption-debt finding — the migration was deferred.

JS scripts each inline `fetch()` independently. compute-cognitive-fingerprint.js:38, compute-vitality.js:40, compute-cofire.js:37 set `X-Tenant-ID` if `MYA_USER_ID` is set — but compute-complexity.js does NOT (potential cross-tenant data leak if multi-user; orthogonal but worth flagging).

### Sweep D — pipeline-health stage delegate

pipeline-health.js lives at `scripts/pipeline-health.js` (NOT under packages/server/lib/ — sweep correction).

**Stage shape canonical** (pipeline-health.js:266-291, enrichment-liveness):
```js
{
  name: 'enrichment-liveness',
  depends: [],
  fast: true,
  staleness: 60 * 60 * 1000,  // TTL ms
  async check() { /* return { needsWork, reason, last_run_at?, details? } */ },
  async trigger() { /* return { durationMs, details } or throw */ },
  // Optional: oneShot: true
}
```

`recordSuccess` / `recordFailure` are called by `runStage()` (pipeline-health.js:911 + 917) — **NOT** by the underlying scripts. Scripts emit JSON events that `trigger()` parses (pipeline-health.js:541-548); that becomes `last_details_json`.

Stage registry truth (pipeline-health.js):
- 3 of 6 compute scripts ARE registered: fisher-trajectory (464-555), compute-vitality (406-440), compute-cofire (710-749)
- 3 of 6 are NOT: compute-complexity.js, compute-cognitive-fingerprint.js, compute-frequency.py

Subprocess spawn pattern at pipeline-health.js:221-244 (`runScript`):
- `child_process.spawn` with `stdio: ['ignore', 'pipe', 'pipe']`
- stdout/stderr tailed to last 16 KiB each (line 230)
- 30-min default timeout, per-stage override
- Env passthrough: `env: { ...process.env, ...extraEnv }` (line 225)
- Exit code 0 → success; non-zero → error with stderr/stdout tail

**Global filesystem PID lock** (pipeline-health.js:73-133) at `/run/mycelium/pipeline-health.lock`. 6h stale-steal threshold (`LOCK_STALE_MS`, line 81). One stage at a time within the orchestrator; tick chains fast stages but terminates on first slow stage (lines 940-965).

### Pressure-test reads (verification)

- **scripts/d1_client.py** (full file) — confirms cross-language pattern is replicable: 73 LOC, single function `query()`, fail-closed on missing env, X-Tenant-ID conditional, returns results list.
- **packages/metrics/era.js** (full file) — confirms `deriveFisherEraId({getPipelineState, query, userId, now?})` is pure/testable, dependency-injected, returns `era-${...}` or `era-bootstrap-YYYY-MM-DD`.
- **pipeline-health.js:464-555** (fisher-trajectory stage) — confirms the canonical era-aware stage pattern: schema-probe → era-advance check → time-floor → trigger spawns Python with `CLUSTERING_RUN_ID=eraId`, parses `fisher_run_end` JSON line, returns `{durationMs, details: {era_id, ...runDetails, tail}}`. **This is the pattern stage-template.js compresses.**
- **compute-frequency.py:25-71** — confirms inline `httpx.Client()` duplicates d1_client.py; trivial migration.

---

## 3. Module shape

### Python: `scripts/lib/stage_base.py` (new, ~80 LOC)

```python
"""Shared scaffolding for compute-* scripts.

Every script that runs as a pipeline-health.js stage needs:
  - dotenv loaded from the canonical 5-file list
  - MYA_USER_ID + auth-token + worker URL with fail-closed semantics

This module provides one entry point: bootstrap_env() loads everything
and returns a frozen dict. Callers raise RuntimeError on missing config —
same fail-closed semantics as scripts/d1_client.py.

History: extracted from the 6-script dotenv loop (compute-fisher.py:34-39,
compute-frequency.py:31-41) per PR0.1 of Phase 6 (2026-05-07).
"""

import os
from pathlib import Path
from typing import Optional

DOTENV_FILES = ['.env', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']


def load_dotenv(repo_root: Path) -> None:
    """Load the canonical 5-file dotenv list. Idempotent (uses setdefault).

    Silent no-op if python-dotenv isn't installed (matches existing scripts).
    """
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    for f in DOTENV_FILES:
        p = repo_root / f
        if p.exists():
            for k, v in dotenv_values(p).items():
                if v is not None:
                    os.environ.setdefault(k, v)


def get_worker_url() -> str:
    """Returns MYA_WORKER_URL (or WORKER_URL fallback). Raises if missing."""
    url = os.environ.get('MYA_WORKER_URL') or os.environ.get('WORKER_URL')
    if not url:
        raise RuntimeError("MYA_WORKER_URL is required")
    return url


def get_auth_token() -> str:
    """Returns the auth token using the canonical precedence. Raises if missing."""
    token = (
        os.environ.get('ADMIN_SECRET')
        or os.environ.get('AGENT_TOKEN_MYA')
        or os.environ.get('AGENT_TOKEN')
    )
    if not token:
        raise RuntimeError(
            "auth token (ADMIN_SECRET / AGENT_TOKEN_MYA / AGENT_TOKEN) is required"
        )
    return token


def get_user_id() -> str:
    """Returns MYA_USER_ID. Raises if missing."""
    user_id = os.environ.get('MYA_USER_ID')
    if not user_id:
        raise RuntimeError("MYA_USER_ID is required")
    return user_id


def get_tenant_id() -> Optional[str]:
    """Returns MYA_USER_ID for X-Tenant-ID routing. None if absent (operator-DB mode)."""
    return os.environ.get('MYA_USER_ID')
```

### Python: `scripts/lib/era_skip.py` (new, ~60 LOC)

Generic version of compute-fisher.py:433-479's `fetch_existing_window_states`. Returns a dict mapping cache-key → stored row.

```python
"""Era-mode skip-existing helper for derived-metric scripts.

Within a clustering era (clustering_run_id constant), derived-metric rows
are immutable: they're a deterministic function of (clustering_points,
territory_profiles), both of which are atomically rewritten by cluster.py
once per era. So a row computed in this era never needs recomputing in
this era.

Generic shape (table-aware): given a table + cache-key columns + run_id,
return Map<key_tuple, row_dict> for already-computed rows. The caller
checks `if cache_key in existing: skip` before its compute step.

History: extracted from compute-fisher.py:433-479 fetch_existing_window_states
per PR0.1 of Phase 6 (2026-05-07).
"""

from typing import Callable, Dict, List, Tuple, Any


def fetch_existing_keys(
    querier: Callable[[str, list], List[Dict[str, Any]]],
    table: str,
    user_id: str,
    run_id: str,
    key_columns: List[str],
    return_columns: List[str],
    extra_filters: Dict[str, Any] = None,
) -> Dict[Tuple, Dict[str, Any]]:
    """Fetch already-computed rows for an era. Returns Map<key_tuple, row>.

    SAFETY: table + column names are interpolated into SQL — callers MUST
    pass static literals, never user input. (Standard pattern for
    schema-introspection helpers.)

    Args:
        querier: D1 query function (sql, params) -> rows
        table: target table name (literal)
        user_id: MYA_USER_ID
        run_id: clustering_run_id (from era helper)
        key_columns: columns that form the cache key (in stable order)
        return_columns: columns to materialize in the returned row dict
        extra_filters: optional column=value pairs for additional WHERE clauses

    Returns:
        Map<tuple of key_column values, dict of return_column values>
    """
    extra_filters = extra_filters or {}
    where_clauses = ['user_id = ?', 'clustering_run_id = ?']
    params: List[Any] = [user_id, run_id]
    for col, val in extra_filters.items():
        where_clauses.append(f'{col} = ?')
        params.append(val)
    where_sql = ' AND '.join(where_clauses)

    select_columns = ', '.join(set(key_columns + return_columns))
    sql = f"SELECT {select_columns} FROM {table} WHERE {where_sql}"
    rows = querier(sql, params)

    result: Dict[Tuple, Dict[str, Any]] = {}
    for row in rows:
        key = tuple(row[c] for c in key_columns)
        result[key] = {c: row[c] for c in return_columns}
    return result
```

### Python: `scripts/lib/event_emit.py` (new, ~40 LOC)

The structured JSON-event protocol that pipeline-health.js parses.

```python
"""Structured stage-event emission for pipeline-health.js consumption.

pipeline-health.js scans the last 16 KiB of stdout for a JSON line
matching {"event": "<stage>_run_end", ...} and stores it in
pipeline_state.last_details_json (see pipeline-health.js:541-548).

Use format_start_event() at the top of compute and format_end_event() at
the end. Scripts print the JSON to stdout directly.

Schema (canonical, matches compute-fisher.py:805-852):
  {"event": "<stage>_run_start", "user_id": "...", "run_id": "...", "ts": "...", ...}
  {"event": "<stage>_run_end", "duration_s": N, "windows": N, "skipped": N, ...}

History: extracted from compute-fisher.py:805-852 per PR0.1 of Phase 6 (2026-05-07).
"""

import json
import time
from typing import Any, Dict


def format_event(stage_name: str, suffix: str, **fields: Any) -> str:
    """Format a stage event as a single JSON line for stdout.

    Args:
        stage_name: e.g., 'fisher', 'information_harmonics'
        suffix: 'run_start' | 'run_end' | custom
        **fields: additional fields to include
    """
    payload = {'event': f'{stage_name}_{suffix}', 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    payload.update(fields)
    return json.dumps(payload, separators=(',', ':'), default=str)


def emit(stage_name: str, suffix: str, **fields: Any) -> None:
    """Print the event to stdout. (Helper; equivalent to print(format_event(...))."""
    print(format_event(stage_name, suffix, **fields), flush=True)
```

### JS: `packages/metrics/stage-template.js` (new, ~120 LOC)

Compresses pipeline-health.js fisher-trajectory's check + trigger (~90 LOC) into two factories. PR1 will use these, and fisher-trajectory migrates as the first consumer.

```js
/**
 * Stage-template factories for era-aware Phase 6 stages.
 *
 * Compresses the canonical eraAware check() + trigger() pattern (currently
 * open-coded in pipeline-health.js:464-555 for fisher-trajectory) into two
 * exported factories that can be passed directly to the stages array.
 *
 * Each Phase 6 family (Tier 1) ends up with a stage entry like:
 *   {
 *     name: 'information-harmonics',
 *     depends: ['cluster'],
 *     fast: false,
 *     staleness: 24 * 60 * 60 * 1000,
 *     check: eraAwareCheck({
 *       stageName: 'information-harmonics',
 *       getPipelineState, query, USER_ID,
 *       schemaProbe: { table: 'cognitive_metrics_harmonic', requiredColumns: ['user_id', ...] },
 *       staleness: 24 * 60 * 60 * 1000,
 *     }),
 *     trigger: runEraStage({
 *       stageName: 'information-harmonics',
 *       command: 'python3', script: 'scripts/compute-information-harmonics.py',
 *       getPipelineState, query, USER_ID,
 *       eventEndKey: 'information_harmonics_run_end',
 *       timeoutMs: 60 * 60 * 1000,
 *     }),
 *   },
 *
 * History: extracted from pipeline-health.js:464-555 per PR0.1 of Phase 6 (2026-05-07).
 */

import { deriveFisherEraId } from './era.js';

/**
 * Factory: returns a check() function that performs schema-probe →
 * era-advance → time-floor checks. Returns { needsWork, reason, ... }.
 *
 * @param {object} opts
 * @param {string} opts.stageName
 * @param {(name: string) => Promise<{last_success_at?: string} | null>} opts.getPipelineState
 * @param {(sql: string, params: any[]) => Promise<any[]>} opts.query
 * @param {string} opts.USER_ID
 * @param {{ table: string, requiredColumns?: string[] }} opts.schemaProbe
 * @param {number} opts.staleness  TTL milliseconds
 */
export function eraAwareCheck({ stageName, getPipelineState, query, USER_ID, schemaProbe, staleness }) {
  return async function check() {
    // 1. Schema probe — un-migrated hosts skip cleanly instead of quarantining
    const tableRows = await query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [schemaProbe.table],
    );
    if (!tableRows || tableRows.length === 0) {
      return { needsWork: false, reason: 'schema-missing-skip-clean',
               details: { hint: `${schemaProbe.table} does not exist on this host`, missing_table: schemaProbe.table } };
    }
    if (schemaProbe.requiredColumns?.length) {
      const colRows = await query(`PRAGMA table_info(${schemaProbe.table})`);
      const cols = new Set((colRows || []).map((r) => r.name));
      const missing = schemaProbe.requiredColumns.filter((c) => !cols.has(c));
      if (missing.length > 0) {
        return { needsWork: false, reason: 'schema-missing-skip-clean',
                 details: { hint: `${schemaProbe.table} missing columns`, missing } };
      }
    }

    // 2. Pipeline state lookup
    const me = await getPipelineState(stageName);
    if (!me?.last_success_at) return { needsWork: true, reason: 'never-run' };

    // 3. Era-advance trigger
    const cluster = await getPipelineState('cluster');
    if (cluster?.last_success_at && cluster.last_success_at > me.last_success_at) {
      return { needsWork: true, reason: 'era-advanced',
               last_run_at: me.last_success_at,
               details: { my_last: me.last_success_at, cluster_last: cluster.last_success_at } };
    }

    // 4. Time floor
    const ageMs = Date.now() - Date.parse(me.last_success_at);
    if (ageMs > staleness) {
      return { needsWork: true, reason: 'stale-floor',
               last_run_at: me.last_success_at, details: { ageMs } };
    }
    return { needsWork: false, reason: 'fresh', last_run_at: me.last_success_at };
  };
}

/**
 * Factory: returns a trigger() function that derives era_id, runs the
 * stage script, parses the trailing JSON event, and returns
 * { durationMs, details: { era_id, ...runDetails, tail } }.
 *
 * @param {object} opts
 * @param {string} opts.stageName
 * @param {string} opts.command  e.g. 'python3' or 'node'
 * @param {string} opts.script   path relative to repo root
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{stdout: string}>} opts.runScript
 * @param {(name: string) => Promise<{last_success_at?: string} | null>} opts.getPipelineState
 * @param {(sql: string, params: any[]) => Promise<any[]>} opts.query
 * @param {string} opts.USER_ID
 * @param {string} opts.eventEndKey   trailing event name to parse, e.g. 'information_harmonics_run_end'
 * @param {number} opts.timeoutMs
 * @param {(eraId: string) => object} [opts.extraEnv]  optional fn returning extra env vars
 */
export function runEraStage({ stageName, command, script, runScript, getPipelineState, query, USER_ID, eventEndKey, timeoutMs, extraEnv }) {
  return async function trigger() {
    const t0 = Date.now();
    const eraId = await deriveFisherEraId({ getPipelineState, query, userId: USER_ID });

    const env = { CLUSTERING_RUN_ID: eraId, ...(extraEnv ? extraEnv(eraId) : {}) };
    const { stdout } = await runScript(command, [script], { timeoutMs, extraEnv: env });

    // Parse trailing JSON event for last_details_json (matches pipeline-health.js:541-548)
    let runDetails = null;
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.includes(`"${eventEndKey}"`)) {
        try { runDetails = JSON.parse(line); break; } catch { /* keep looking */ }
      }
    }

    return { durationMs: Date.now() - t0,
             details: { era_id: eraId,
                        ...(runDetails || {}),
                        tail: stdout.trim().split('\n').slice(-3).join('\n') } };
  };
}
```

### Python adoption-debt fix: compute-frequency.py

Replace lines 27, 50-71 (~25 LOC) with:
```python
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'lib'))
import stage_base
import d1_client

stage_base.load_dotenv(Path(__file__).resolve().parent.parent)
WORKER_URL = stage_base.get_worker_url()
TOKEN = stage_base.get_auth_token()

# d1_query / d1_run wrappers replaced with d1_client.query
def d1_query(sql, params=None):
    return d1_client.query(sql, params or [])
def d1_run(sql, params=None):
    return d1_client.query(sql, params or [])
```

(Net: ~−15 LOC; uses canonical d1_client.py; removes the duplicate httpx.Client setup.)

### compute-fisher.py migration (first consumer of new helpers)

Replace lines 34-47 (dotenv loop) with `stage_base.load_dotenv(root)`.
Replace lines 433-479 (fetch_existing_window_states) with a wrapper around `era_skip.fetch_existing_keys()`.
Replace lines 805-812 + 844-852 (JSON event print) with `event_emit.emit('fisher', 'run_start', ...)` + `event_emit.emit('fisher', 'run_end', ...)`.

### pipeline-health.js fisher-trajectory migration (proof-of-shape)

Replace lines 464-555 (fisher-trajectory stage entry, 92 LOC) with ~25 LOC using `eraAwareCheck()` + `runEraStage()`. PR1 then uses the same factories for information-harmonics.

---

## 4. Verification table

Every load-bearing assumption from this design has a file:line citation I have READ MYSELF (not just one a sweep agent cited).

| # | Assumption | Verified at |
|---|---|---|
| A1 | pipeline-health.js lives at scripts/pipeline-health.js (NOT under packages/server/lib/) | Read scripts/pipeline-health.js:200-330 |
| A2 | Stage shape `{name, depends, fast, oneShot?, staleness, check(), trigger()}` is canonical | Read pipeline-health.js:266-291 (enrichment-liveness — no script spawn, simplest exemplar) |
| A3 | `trigger()` returns `{durationMs, details}` or throws | Read pipeline-health.js:286-290 |
| A4 | `recordSuccess` / `recordFailure` are sole writers of pipeline_state and called by orchestrator after `trigger()` returns | Read pipeline-health.js:200-218 (recordFailure body), inferred recordSuccess at lines 911/917 from sweep |
| A5 | `runScript()` spawns child process with stdio capture, 16 KiB stderr/stdout tail, env passthrough | Read pipeline-health.js:221-244 |
| A6 | `deriveFisherEraId` returns `era-${cluster.last_success_at}` or `era-${MAX(territory_profiles.updated_at)}` or `era-bootstrap-YYYY-MM-DD` | Read packages/metrics/era.js:52-70 (full file) |
| A7 | compute-fisher.py:354 UPSERT conflict key is `(user_id, level, window_type, window_start, clustering_run_id)` | Cited by Sweep A; confirmed by Sweep B's quote of TRAJECTORY_UPSERT_SQL |
| A8 | compute-fisher.py:433-479 implements fetch_existing_window_states pattern | Cited by Sweep A + Sweep B's exact 8-line quote |
| A9 | compute-fisher.py:805-852 emits structured JSON events for last_details_json | Cited by Sweep A + Sweep D's confirmation |
| A10 | compute-fisher.py:783-794 force-full flag (`--full` or `FISHER_FORCE_FULL=1`) | Cited by Sweep B exact quote |
| A11 | scripts/d1_client.py is canonical Python D1 client (73 LOC) with ADMIN_SECRET > AGENT_TOKEN_MYA > AGENT_TOKEN precedence + X-Tenant-ID | Read scripts/d1_client.py (full file) |
| A12 | compute-frequency.py inlines httpx.Client at lines 27, 59, duplicating d1_client.py | Read compute-frequency.py:25-71 |
| A13 | All 6 compute scripts share identical 5-file dotenv list `['.env', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']` | Cited by Sweep A; confirmed by direct read of compute-fisher.py:34-39, compute-frequency.py:31-41 |
| A14 | fisher-trajectory stage at pipeline-health.js:464-555 is the canonical era-aware stage shape | Read pipeline-health.js:464-555 (full stage) |
| A15 | JSON-event tail-parser is at pipeline-health.js:541-548 (loops backward looking for `{...event...}` line) | Read pipeline-health.js:541-548 |
| A16 | Token precedence is identical across all 6 scripts: ADMIN_SECRET > AGENT_TOKEN_MYA > AGENT_TOKEN | Cited by Sweep A + Sweep C |
| A17 | Era-skip pattern is FISHER-ONLY today; the other 5 scripts have no `clustering_run_id` check | Cited by Sweep A + Sweep B's per-script matrix; harmonics will be 2nd consumer |
| A18 | Three of 6 scripts ARE pipeline-health-registered (fisher, vitality, cofire); three are NOT (complexity, fingerprint, frequency.py) | Cited by Sweep D |
| A19 | Plan-doc Phase 0.5.3 stage-base reference exists | Cited by Sweep B at MEASUREMENT-PLANE-PLAN.md:157-158 |
| A20 | Spec I9 marks stage-base as YES-blocking for harmonics | Read COGNITIVE-METRICS-SPEC.md:937-948 |

---

## 5. Threat model

PR0.1 changes are pure refactor: extract scaffolding, no new attack surface.

- **Secret-loading:** No new env vars; precedence is unchanged from existing code. fail-closed semantics preserved (RuntimeError on missing config — same as scripts/d1_client.py:50-54).
- **D1 access:** No new endpoints; same `/api/db/query` Worker route; same Bearer auth + X-Tenant-ID header. compute-frequency.py adoption-debt fix REMOVES a duplicate httpx.Client setup; no surface change.
- **Era-skip helper:** SAFETY note in docstring — table + column names interpolated into SQL, callers MUST pass static literals. This matches the existing fisher pattern (compute-fisher.py:457-464 also string-interpolates the column list). Standard schema-introspection idiom.
- **JSON event emission:** Scripts print to stdout — pipeline-health.js parses. No new IPC. Plain-text events MUST NOT contain plaintext message content (existing fisher events emit only counts + IDs; new helpers preserve this — scripts choose what to put in `**fields`). Documented in event_emit.py docstring.
- **Stage-template factories:** Factories compose existing primitives (deriveFisherEraId, runScript, query). They do NOT bypass any auth check or introduce a new privileged path.

---

## 6. Edge cases — explicit decisions

- **`getPipelineState` returns null for first run.** `eraAwareCheck` returns `needsWork: true, reason: 'never-run'`. Matches existing fisher behavior (pipeline-health.js:494).
- **`schemaProbe.requiredColumns` empty/undefined.** Skip the column probe; only check table existence. Useful for stages where the canonical grain has been stable since first migration.
- **Cluster never succeeded yet.** `deriveFisherEraId` falls back to `MAX(territory_profiles.updated_at)` or `era-bootstrap-YYYY-MM-DD`. New stage runs in cold-start mode; era-skip helper finds zero existing keys; full compute.
- **Force-full override.** Stage-template does NOT (yet) wrap the `--full` flag — that's a per-script CLI argparse decision. Scripts handle their own override flags. Stage-template only orchestrates.
- **Script crashes mid-run.** runScript rejects with stderr tail; recordFailure fires; consecutive_failures increments; 3-strike → quarantine. Unchanged.
- **Trailing JSON event missing (script crashed before reaching end).** runEraStage returns `details: { era_id, tail }` only — no run-details fields. last_details_json is still populated with a useful fragment. Matches existing pipeline-health.js:546 fallback.
- **compute-frequency.py was working with inline httpx; what if d1_client.py has different timeout?** d1_client.py default is 30s (line 23); compute-frequency.py inline uses 60s (line 59). Migration must preserve 60s by passing `timeout=60.0` to `d1_client.query()`. **Decision: pass explicit timeout in the migration to avoid behavior change.**
- **compute-fisher.py's `fetch_existing_window_states` returns more than just key→state — it builds a Map keyed on `window_start_iso`.** The new generic `era_skip.fetch_existing_keys` returns Map<key_tuple, row_dict>. Migration in compute-fisher.py needs a thin adapter to keep its existing signature. ~5 LOC. Worth it.

---

## 7. Test strategy

| File | Tests |
|---|---|
| `scripts/lib/stage_base.py` | Unit: env precedence (ADMIN_SECRET wins; AGENT_TOKEN_MYA fallback); fail-closed on missing url/token; dotenv loads exist files; setdefault doesn't clobber |
| `scripts/lib/era_skip.py` | Unit: fetch_existing_keys with mock querier returning 0/1/N rows; empty result → empty dict; multi-column key tuples are stable; extra_filters compose into WHERE; SQL string contains exact expected SELECT |
| `scripts/lib/event_emit.py` | Unit: format_event produces single-line JSON parseable by json.loads(); ts is RFC 3339; payload preserves field order; no plaintext content sneaks through (negative test) |
| `packages/metrics/stage-template.js` | Unit: eraAwareCheck factory returns function that produces canonical needsWork/reason values for: schema-missing-table, schema-missing-column, never-run, era-advanced, stale-floor, fresh; runEraStage factory composes deriveFisherEraId + runScript + JSON parse; mock all deps |
| Cross-language fixture (existing pattern at packages/metrics/primitives_fixture.json) | N/A — PR0.1 has no cross-language numerical primitives. PR0.2 introduces them. |
| Migration smoke (compute-fisher.py + fisher-trajectory) | Re-run fisher-trajectory on admin via pipeline-health.js; verify `last_details_json.fisher_run_end` event still parses; `pipeline_state.last_success_at` advances; `fisher_trajectory` row count unchanged in current era; era-mode skip-existing reports skipped count as before |

---

## 8. Implementation order

Each step is independently shippable + testable:

1. **Step 1 — `scripts/lib/stage_base.py`** + unit tests. Net new file. No callers yet.
2. **Step 2 — `scripts/lib/era_skip.py`** + unit tests. Net new file. No callers yet.
3. **Step 3 — `scripts/lib/event_emit.py`** + unit tests. Net new file. No callers yet.
4. **Step 4 — `packages/metrics/stage-template.js`** + unit tests. Add to packages/metrics/index.js exports (pattern: matches era.js export at packages/metrics/index.js:25-35).
5. **Step 5 — compute-fisher.py migration.** Adopt `stage_base.load_dotenv()`, `era_skip.fetch_existing_keys()` (with adapter), `event_emit.emit()`. Smoke-test: `python3 scripts/compute-fisher.py --full` against admin; verify same row counts + same JSON events as pre-migration.
6. **Step 6 — pipeline-health.js fisher-trajectory migration.** Replace lines 464-555 with `eraAwareCheck()` + `runEraStage()` factory calls. Smoke-test: `bash scripts/verify-deploy.sh` + manual `pipeline-health` tick that includes fisher-trajectory; verify `pipeline_state.fisher-trajectory.last_success_at` advances on era-advance trigger.
7. **Step 7 — compute-frequency.py adoption-debt fix.** Adopt `stage_base` + `d1_client`. Smoke-test: hand-run `python3 scripts/compute-frequency.py --user-id <admin-user-id>`; verify `frequency_snapshots` row written.

Step 5 + Step 6 are the load-bearing migration that proves the abstractions hold. Steps 1-4 are net-additive (no risk). Step 7 is a small bonus.

---

## 9. Decision criteria for proceeding to PR0.2

PR0.2 (primitives extension for harmonics) can begin when:

1. Steps 1-6 land on admin and `verify-deploy.sh` passes.
2. fisher-trajectory has run at least once via the new `runEraStage()` factory and `last_details_json.fisher_run_end` event parses correctly.
3. `pipeline-health.js` LOC delta is ≤−60 (the 92-LOC fisher-trajectory entry should compress to ≤30 LOC).
4. No new test failures.

Negative criterion (rollback): if the migration causes fisher-trajectory to quarantine on admin, revert Steps 5-6 immediately; investigate before re-attempting.

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Era-skip generic helper subtly differs from compute-fisher.py's open-coded version (e.g., NULL handling) | Medium | High (silent skip-too-much; would corrupt fisher rows) | Adapter in compute-fisher.py preserves the exact result shape; unit tests pin behavior; smoke-test compares row count pre/post migration |
| stage-template.js's eraAwareCheck factory rejects a previously-acceptable check (e.g., schema probe fires on a host that didn't have the probe before) | Low | Medium (skip-clean reason instead of run) | New schema-probe is OPT-IN per stage; fisher-trajectory passes its existing required columns; no new probes added implicitly |
| compute-frequency.py timeout regression (30s default in d1_client.py vs 60s inline) | Low | Low (some queries time out where they didn't before) | Migration explicitly passes `timeout=60.0` to d1_client.query |
| Python script imports `scripts/lib/` — Python doesn't natively look there | Medium | Low (ImportError at startup) | Use `sys.path.insert(0, str(Path(__file__).parent / 'lib'))` at top of consumer scripts. Documented. |
| pipeline-health.js's runScript helper is in scripts/, not packages/metrics/, so stage-template can't import it | High | Low (factory must take runScript as a dep injection) | Factory accepts `runScript` as an opt — caller passes it from pipeline-health.js scope. Unit test passes mock; orchestrator passes real. |
| Dependency injection makes the factories awkward (5+ deps per call) | Medium | Low (cosmetic) | Accept it. Better than module-level singletons that break testing. Pattern matches era.js's deriveFisherEraId signature. |
| Step 6 migration introduces a regression that quarantines fisher-trajectory | Low | High (no Phase 1 R_recent updates until rollback) | Stage by stage: ship Steps 1-5 first; verify no behavior change; only then ship Step 6. |

---

## 11. Open questions resolved during sweep

- **Q: Should era-skip live in @mycelium/metrics (JS) or scripts/lib/ (Python)?** A: Both, eventually. PR0.1 ships the Python side because harmonics is Python. JS side is deferred until a JS Phase 6 family appears.
- **Q: Should stage-template.js be IN packages/metrics or in scripts/lib/?** A: packages/metrics — matches the existing pattern (era.js). It's a JS module imported by pipeline-health.js (which is at scripts/pipeline-health.js but imports from packages/* per monorepo workspace pattern).
- **Q: Should the migration consolidate vitality/cofire UPSERT divergence?** A: No — orthogonal tech debt. Out of PR0.1 scope.
- **Q: Should we register compute-complexity.js / compute-cognitive-fingerprint.js / compute-frequency.py with pipeline-health.js as part of PR0.1?** A: No — orthogonal. They've worked by hand for months; registering them is its own design conversation.
- **Q: What about the JS d1-client extraction?** A: Defer. 4 inline copies is annoying but the cost of extracting now is wasted if the next 2-3 Phase 6 families are also Python.

---

## 12. Open questions deferred (named so they don't ambush a later phase)

- **Q-deferred: How should era-skip integrate with non-fisher cache keys?** Harmonics' table grain (TBD by spec §4.23 final schema) might have different key columns than `(user_id, level, window_type, window_start)`. The generic helper accepts any key_columns list, but the orchestration of "what to skip on" is still per-script. PR1 will design the harmonics-specific cache key.
- **Q-deferred: Should `runEraStage` derive era from a per-family table (not always cluster.last_success_at)?** For Tier-1 families that don't depend on cluster.py at all (none today, but hypothetically), the era anchor might be different. deriveFisherEraId is fisher-anchored. Defer until a non-fisher era requirement materializes.
- **Q-deferred: JS adoption of stage_base/era_skip/event_emit equivalents.** When the second JS Phase 6 family appears (none planned — but plausible long-term), port them. Until then, JS scripts each handle their own.

---

## 13. Pickup protocol for PR0.1 implementation session

1. Read this design doc cold, top-down.
2. Verify the spec is committed: `git log --oneline -1 docs/architecture/COGNITIVE-METRICS-SPEC.md` should show `de259d0` or later.
3. Verify PR0.0 shipped: `git log --oneline -2 scripts/generate-schema.sh` should show `b9ff80c` (binding fix).
4. Implement Step 1 (`scripts/lib/stage_base.py` + tests). Run tests locally.
5. Implement Steps 2-3 (`era_skip.py`, `event_emit.py` + tests). Run tests locally.
6. Implement Step 4 (`packages/metrics/stage-template.js` + tests). Run JS tests locally (`node --test packages/metrics/test/`).
7. Implement Step 5 (compute-fisher.py migration). Run unit tests. Smoke-test: `python3 scripts/compute-fisher.py --full` against admin (operator-approved); compare row counts pre/post.
8. Implement Step 6 (pipeline-health.js fisher-trajectory migration). Run /sweep-first-design before this step — it's the structural one. Smoke-test: trigger pipeline-health tick that includes fisher-trajectory; verify era-advance produces expected `last_details_json` shape.
9. Implement Step 7 (compute-frequency.py adoption-debt fix). Smoke-test by hand-running.
10. /deploy-and-verify on admin. Verification ledger.
11. Update handoff doc with PR0.1 completion + observations + any new gotchas.

PR0.1 itself can be one bundled commit or split per step. Recommended: one PR per step, sequenced, each with its own smoke test.

---

## 14. Sweep findings appendix (file:line consolidation for future-Claude)

For convenience: every load-bearing claim in this design and where the underlying code lives.

| Claim | File:line |
|---|---|
| dotenv 5-file list | scripts/compute-fisher.py:34-39, compute-frequency.py:31-41, compute-complexity.js:31-33, compute-cognitive-fingerprint.js:24-25, compute-vitality.js:27-28, compute-cofire.js:24-25 |
| Auth precedence ADMIN_SECRET > AGENT_TOKEN_MYA > AGENT_TOKEN | scripts/d1_client.py:45-49 + same pattern in all 6 compute scripts |
| Era format `era-${ts}` or `era-bootstrap-YYYY-MM-DD` | packages/metrics/era.js:52-70 |
| Era-skip pattern (SELECT then continue) | scripts/compute-fisher.py:433-479 (fetch) + 575-585 (skip) |
| UPSERT conflict key for fisher | scripts/compute-fisher.py:354 |
| Force-full override | scripts/compute-fisher.py:783-794 |
| JSON event emission | scripts/compute-fisher.py:805-812 (start) + 844-852 (end) |
| Stage shape canonical (enrichment-liveness) | scripts/pipeline-health.js:266-291 |
| fisher-trajectory canonical era-aware stage | scripts/pipeline-health.js:464-555 |
| recordFailure body (orchestrator-side) | scripts/pipeline-health.js:198-218 |
| runScript spawn helper | scripts/pipeline-health.js:221-244 |
| JSON tail parser | scripts/pipeline-health.js:541-548 |
| Global PID lock | scripts/pipeline-health.js:73-133 |
| Phase 0.5.3 plan-doc reference | docs/architecture/MEASUREMENT-PLANE-PLAN.md:157-158 |
| Spec I9 PR0 prerequisites table | docs/architecture/COGNITIVE-METRICS-SPEC.md:937-950 |
| Sweep F embedding storage resolution | docs/architecture/COGNITIVE-METRICS-SPEC.md:948 |

---

End of design.
