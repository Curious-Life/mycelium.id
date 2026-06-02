"""event_emit.py — local audit/event emission for pipeline stages.

In the cloud app, stage events were scraped from stdout by the JS
stage-template (it scans the last ~16 KiB of stdout for the terminal
``run_end`` event) and/or written to an audit table. The V1 port keeps the
stdout-line behavior — that is the part compute_information_harmonics.py
relies on (it emits ``run_start`` first and ``run_end`` LAST so the scanner
finds it) — and makes table persistence a best-effort no-op-on-failure.

Security: per the stage's contract, payloads carry COUNTS ONLY — no PII, no
embedding values, no message ids. Callers already pass only aggregate stats;
this module does not introspect or expand them.

Surface accessed by compute_information_harmonics.py:
    - emit(stage, event, **fields) -> None
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


def emit(stage: str, event: str, **fields: Any) -> None:
    """Emit one structured event line to stdout (and best-effort audit row).

    The line is a single ``EVENT {json}`` record so the JS stage scanner can
    locate the terminal event by substring without parsing the whole stream.
    """
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "event": event,
        **fields,
    }
    try:
        line = json.dumps(record, default=str, separators=(",", ":"))
    except Exception:
        # Never let serialization of an exotic field kill the stage.
        line = json.dumps(
            {"stage": stage, "event": event, "note": "unserializable-fields"}
        )
    print(f"EVENT {line}", flush=True)

    _try_persist(record)


def _try_persist(record: dict) -> None:
    """Best-effort write to the local agent_events table; silent on failure.

    The local vault has an ``agent_events`` table; persisting here gives a
    durable trail without being load-bearing. Any failure (missing table,
    locked db) is swallowed — stdout emission above is the contract.
    """
    try:
        import d1_client
        d1_client.query(
            "INSERT INTO agent_events (type, agent_id, payload) VALUES (?, ?, ?)",
            [
                f"pipeline.{record.get('stage')}.{record.get('event')}",
                "harmonics-stage",
                json.dumps(record, default=str),
            ],
        )
    except Exception:
        pass
