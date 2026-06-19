"""stage_result.py — per-stage health recording + fail-loud for Python measurement
stages. Python mirror of pipeline/lib/stage-result.js.

Two entry points:

  run_main(stage, main_fn)  — wrap a stage's `if __name__ == '__main__'` call. Records
      success to pipeline_state on clean completion (last_success_at + duration), or
      records failure (bounded reason) + RE-RAISES on any exception so the process
      exits non-zero (run-clustering.sh `set -e` aborts → jobs.js names the stage).
      No reindent of the stage body required.

  Accumulator + finalize()  — for stages with a per-row WRITE loop that today swallows
      failures and continues: count ok()/fail() and call finalize() so a materially-
      incomplete write (0 on input, or >fail_ratio) fails loud instead of exit-0.

This populates the pipeline_state ledger that era-resolution (src/db/metrics.js,
stage_base.derive_era_id) and /metric-freshness already READ but nothing wrote — so
cluster's success here fixes era rung 1, and every stage's last_success/last_failure
becomes visible on the measurement-health surface.

Content-free (§1): only counts, the stage name, and a bounded exception class ever
reach pipeline_state — never a realm/territory name, message, or model output.
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable, Optional

import d1_client
import stage_base

QUARANTINE_AT = 3


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


def record_success(querier: Callable, user_id: str, stage: str, duration_ms: Optional[int] = None, details: Optional[dict] = None) -> None:
    try:
        querier(
            "INSERT INTO pipeline_state "
            "(user_id, stage_name, last_success_at, consecutive_failures, quarantined, last_duration_ms, last_details_json, updated_at) "
            "VALUES (?, ?, datetime('now'), 0, 0, ?, ?, datetime('now')) "
            "ON CONFLICT(user_id, stage_name) DO UPDATE SET "
            "last_success_at=datetime('now'), consecutive_failures=0, quarantined=0, "
            "last_duration_ms=excluded.last_duration_ms, last_details_json=excluded.last_details_json, "
            "updated_at=datetime('now')",
            [user_id, stage, duration_ms, json.dumps(details) if details else None],
        )
    except Exception:
        pass  # health recording is best-effort — never mask the stage's own result


def record_failure(querier: Callable, user_id: str, stage: str, reason: Any = None, duration_ms: Optional[int] = None) -> None:
    r = (str(reason).split("\n")[0][:300]) if reason is not None else None
    try:
        querier(
            "INSERT INTO pipeline_state "
            "(user_id, stage_name, last_failure_at, last_failure_reason, consecutive_failures, quarantined, last_duration_ms, updated_at) "
            "VALUES (?, ?, datetime('now'), ?, 1, 0, ?, datetime('now')) "
            "ON CONFLICT(user_id, stage_name) DO UPDATE SET "
            "last_failure_at=datetime('now'), last_failure_reason=excluded.last_failure_reason, "
            "consecutive_failures=pipeline_state.consecutive_failures + 1, "
            f"quarantined=CASE WHEN pipeline_state.consecutive_failures + 1 >= {QUARANTINE_AT} THEN 1 ELSE 0 END, "
            "last_duration_ms=excluded.last_duration_ms, updated_at=datetime('now')",
            [user_id, stage, r, duration_ms],
        )
    except Exception:
        pass


class StageIncomplete(RuntimeError):
    pass


class Accumulator:
    """Per-row write accounting for a loop-based stage."""

    def __init__(self, stage: str, fail_ratio: float = 0.1):
        self.stage = stage
        self.fail_ratio = fail_ratio
        self.attempted = 0
        self.written = 0
        self.failed = 0
        self._samples: list[str] = []

    def ok(self) -> None:
        self.attempted += 1
        self.written += 1

    def skip(self) -> None:
        """Content absent (legitimately nothing to write) — NOT counted as attempted.
        Parity with the JS createStageResult().skip()."""

    def fail(self, err: Any) -> None:
        self.attempted += 1
        self.failed += 1
        if len(self._samples) < 3:
            self._samples.append(str(err).split("\n")[0][:200])

    def incomplete(self) -> bool:
        return self.attempted > 0 and (self.written == 0 or self.failed / self.attempted > self.fail_ratio)

    def reason(self) -> str:
        tail = f" (e.g. {self._samples[0]})" if self._samples else ""
        return f"{self.stage}: incomplete — {self.written}/{self.attempted} written, {self.failed} failed{tail}"

    def details(self) -> dict:
        return {"attempted": self.attempted, "written": self.written, "failed": self.failed}


def finalize(querier: Callable, user_id: str, acc: Accumulator, t0: float) -> None:
    """Decide a loop stage's fate: raise StageIncomplete (→ non-zero exit) on materially-
    incomplete output, else record success. Call at the end of the loop body."""
    if acc.incomplete():
        record_failure(querier, user_id, acc.stage, acc.reason(), _ms(t0))
        raise StageIncomplete(acc.reason())
    record_success(querier, user_id, acc.stage, _ms(t0), acc.details())


def run_main(stage: str, main_fn: Callable[[], Any]) -> None:
    """Wrap a stage's __main__ entry: record success on clean completion, or record
    failure + re-raise on exception (fail-loud). For loop stages that already call
    finalize() inside main_fn, the success recording here is idempotent (last write wins)."""
    querier = d1_client.query
    user_id = stage_base.get_user_id()
    t0 = time.monotonic()
    try:
        main_fn()
    except SystemExit as e:
        # Intentional stop via sys.exit(). Clean (0/None) → success. A non-zero code
        # is the stage's OWN fatal/skip signal (several stages exit(1) on benign
        # "insufficient data") — surface it via the exit code + run-clustering set -e
        # + jobs.js, but do NOT record a failure here: that would false-quarantine a
        # stage on a sparse vault. The health surface still flags it (stale = no fresh
        # success).
        if e.code in (0, None):
            record_success(querier, user_id, stage, _ms(t0), None)
        raise
    except BaseException as e:  # genuine exception (incl. StageIncomplete) → record + re-raise
        record_failure(querier, user_id, stage, e, _ms(t0))
        raise
    record_success(querier, user_id, stage, _ms(t0), None)
