#!/usr/bin/env python3
"""pipeline/compute-coherence.py — Stage: coherence-universal.

Per-window semantic coherence from the EXISTING messages.embedding_768 vectors
(decrypted via the same wrapped-DEK path cluster.py / compute-fisher use — NO
embedder, NO LLM, NO new dependency). Implements:

  §4.31 semantic_coherence_adjacent — mean pairwise cosine similarity of
        CONSECUTIVE message embeddings within a window. RIGOR: validated-clinical
        in a pre-psychotic cohort (Bedi 2015) BUT with MASSIVE overclaim risk —
        predictive validity is for psychosis onset in high-risk individuals, NOT
        general journaling. We label this experimental-for-journaling and force
        low_confidence; presentation MUST refuse anything clinical/diagnostic
        (encoded in `notes`).
  §3.2.5 discourse_coherence_embedding — cosine similarity of consecutive message
        pairs (replaces keyword connective density). This is the SAME consecutive-
        pair signal as §4.31 (the spec notes they coincide); stored as its own
        column for the metric inventory. RIGOR: well-grounded-heuristic.
  semantic_coherence companion: stddev of the consecutive-pair similarities
        (flow volatility) — partial coherence (0.4-0.8) is the healthy zone per
        spec §1.4; high stddev = abrupt topic shifts.
  NEW entity_grid_coherence (Tier-2; Barzilay & Lapata 2008; needs NER) —
        HONEST STUB → always NULL (no NER available; spec §3.4 #3 is Tier-2).
        NEVER fabricated.

OVERCLAIM GUARD (spec §1.4 line ~100): we do NOT claim maximum coherence = good.
The healthy zone is ~0.4-0.8 (edge of criticality); 1.0 = rigidity. `notes`
carries the honest framing; low_confidence forced true until per-user calibration.

Per-window scalars → cognitive_metrics_coherence (migration 0009).

ENCRYPTION: all metric scalars + notes caller-encrypted (stage_crypto.enc);
structural columns plaintext. embedding_768 vectors are decrypted ONLY in-process
and NEVER logged/serialized.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-coherence.py

Security: counts only in logs — never coherence values, never vectors.
"""

import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent

import stage_base
import era_skip
import event_emit
import d1_client
import stage_crypto

stage_base.load_dotenv(_REPO_ROOT)

from compute_information_harmonics import (
    GRANULARITIES,
    decrypt_vectors,
    fetch_envelopes_chunked,
    fetch_message_metadata,
    windows_for,
    _detect_history_days,
    _iso_to_unix,
)

MIN_PAIRS = 2   # need >= 2 consecutive pairs for a meaningful mean+stddev

COHERENCE_NOTE = (
    "Partial coherence (~0.4-0.8) is the healthy zone, not the maximum (1.0 = "
    "rigidity). Predictive validity (Bedi 2015) is for psychosis onset in "
    "clinical high-risk cohorts ONLY — NOT diagnostic for general journaling."
)


def consecutive_cosine(embeddings: np.ndarray) -> np.ndarray:
    """cos_sim(e_t, e_{t+1}) for L2-normalized consecutive embeddings (length N-1).
    Embeddings are L2-normalized at ingest (embed-service.py:187-188), so the dot
    product IS the cosine similarity."""
    n = embeddings.shape[0]
    if n < 2:
        return np.array([], dtype=np.float64)
    return np.einsum('ij,ij->i', embeddings[:-1], embeddings[1:]).astype(np.float64)


COH_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_coherence ("
    "  user_id, window_end, granularity, era_id, language,"
    "  semantic_coherence_adjacent, coherence_stddev, discourse_coherence_embedding,"
    "  entity_grid_coherence,"
    "  pair_count, message_count, low_confidence, notes"
    ") VALUES (?,?,?,?,?, ?,?,?, ?, ?,?,?,?) "
    "ON CONFLICT(user_id, window_end, granularity, language, era_id) "
    "DO UPDATE SET "
    "  semantic_coherence_adjacent=excluded.semantic_coherence_adjacent,"
    "  coherence_stddev=excluded.coherence_stddev,"
    "  discourse_coherence_embedding=excluded.discourse_coherence_embedding,"
    "  entity_grid_coherence=excluded.entity_grid_coherence,"
    "  pair_count=excluded.pair_count,"
    "  message_count=excluded.message_count,"
    "  low_confidence=excluded.low_confidence,"
    "  notes=excluded.notes,"
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)


def upsert_row(user_id, row, querier):
    e = stage_crypto.enc
    params = [
        user_id, row['window_end'], row['granularity'], row['era_id'], 'en',
        e(row.get('mean')), e(row.get('stddev')), e(row.get('discourse')),
        e(None),   # entity_grid_coherence — HONEST STUB (no NER), always NULL
        row.get('pair_count', 0), row.get('message_count', 0),
        1,  # low_confidence ALWAYS true (overclaim guard / awaiting calibration)
        e(COHERENCE_NOTE),
    ]
    querier(COH_UPSERT_SQL, params)


def fetch_existing(user_id, run_id, querier):
    raw = era_skip.fetch_existing_keys(
        querier, table='cognitive_metrics_coherence', user_id=user_id, run_id=run_id,
        key_columns=['granularity', 'window_end'], return_columns=[], run_id_column='era_id',
    )
    return set(raw.keys())


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    run_id = os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(user_id, querier=querier)

    t0 = datetime.now(timezone.utc)
    event_emit.emit('coherence', 'run_start', user=user_id[:8], era_id=run_id, ts=t0.isoformat())

    metadata = fetch_message_metadata(user_id, querier=querier)
    if len(metadata) < 2:
        event_emit.emit('coherence', 'run_end', era_id=run_id, totals={'computed': 0},
                        reason='insufficient-data')
        return

    history_days = _detect_history_days(metadata)
    existing = fetch_existing(user_id, run_id, querier)

    ids = [m['id'] for m in metadata]
    envelopes = fetch_envelopes_chunked(ids, querier=querier)
    vectors = decrypt_vectors(envelopes)
    ordered = [(m['created_at'], vectors[m['id']]) for m in metadata if m['id'] in vectors]
    if len(ordered) < 2:
        event_emit.emit('coherence', 'run_end', era_id=run_id, totals={'computed': 0},
                        reason='decrypt-failed')
        return

    timestamps_unix = np.array([_iso_to_unix(ts) for ts, _ in ordered], dtype=np.float64)
    embeddings = np.stack([v for _, v in ordered])

    now = datetime.now(timezone.utc)
    computed = 0
    skipped = 0
    for granularity in GRANULARITIES:
        for w_start, w_end in windows_for(granularity, now=now, history_days=history_days):
            w_end_iso = w_end.isoformat()
            if (granularity, w_end_iso) in existing:
                skipped += 1
                continue
            w_start_unix = w_start.timestamp()
            w_end_unix = w_end.timestamp()
            mask = (timestamps_unix >= w_start_unix) & (timestamps_unix < w_end_unix)
            idx = np.flatnonzero(mask)
            msg_count = int(idx.size)
            if msg_count < 2:
                continue
            win_emb = embeddings[idx]
            sims = consecutive_cosine(win_emb)
            if sims.size < MIN_PAIRS:
                continue
            mean = float(np.mean(sims))
            stddev = float(np.std(sims))
            upsert_row(user_id, {
                'window_end': w_end_iso, 'granularity': granularity, 'era_id': run_id,
                'mean': mean, 'stddev': stddev, 'discourse': mean,  # same consecutive-pair signal
                'pair_count': int(sims.size), 'message_count': msg_count,
            }, querier)
            computed += 1

    t1 = datetime.now(timezone.utc)
    event_emit.emit('coherence', 'run_end', era_id=run_id,
                    totals={'computed': computed, 'skipped': skipped},
                    rigor='validated-clinical(Bedi2015, OVERCLAIM-guarded)/well-grounded-heuristic',
                    entity_grid='STUB (needs NER)',
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    print(f"[coherence] computed={computed} skipped={skipped} (entity_grid_coherence=STUB)", flush=True)


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('compute-coherence', main)
