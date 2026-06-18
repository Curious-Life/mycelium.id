#!/usr/bin/env python3
"""pipeline/compute-anchors.py — Stage: embedding-anchor (E1, Tier-1).

Greenfield embedding-anchor family. Spec §2.4 (anchor infrastructure), §2.3 (CVP
mandatory gate), §4.5/4.11/4.12/4.13 (the construct metrics). Replaces the old
keyword measures (spec §3.2): insight_word_density → insight_embedding_proximity,
reflective_marker_density → reflective_embedding_density,
sentiment_volatility_within_window → affective_volatility_within_window.

TWO phases:

  PHASE A — ensure anchor vectors (spec §2.4).
    For each construct (insight / reflection / affect_positive / affect_negative),
    if no stored anchor vector exists for the current ANCHOR_VERSION *or* the
    stored seed_content_hash drifted, embed the ~10 seed phrases via the pluggable
    embedder (HttpEmbedder in prod = the SAME Nomic service that produced
    messages.embedding_768; StubEmbedder in the verify gate), mean-pool +
    L2-normalize → the anchor vector, and store it ENCRYPTED at rest as a vector
    envelope (crypto_local.encrypt_vector, byte-compatible with embedding_768).
    anchor_version + seed_content_hash are kept plaintext for re-embed detection.

  PHASE B — per-window construct metrics (spec §4.5/4.11/4.12/4.13).
    For each (granularity, window) over the user's messages, decrypt each
    message's embedding_768 (the SAME wrapped-DEK path cluster.py / fisher use)
    and compute cosine similarity to each construct anchor:
      §4.5  insight_embedding_proximity        = mean cos(msg, C_insight)
      §4.12 reflective_embedding_density        = fraction(cos(msg, C_reflection)
                                                  > REFLECT_THRESHOLD)
      §4.11 inner_territory_presence            = mean cos(msg, C_reflection)
      §4.13 affective_volatility_within_window  = stddev over msgs of
                                                  cos(msg, C_pos) - cos(msg, C_neg)
    All metric scalars + notes are caller-encrypted (stage_crypto.enc). Structural
    columns stay plaintext.

CVP GATE (spec §2.3 — MANDATORY honesty). Real Construct Validity Protocol needs
operator human-labeled held-out data (unavailable here). So this stage computes +
stores every metric with low_confidence=1 and cvp_status='pending', and the S1
REST bridge (src/portal-measurement.js) does NOT surface these as validated (it
serves only the harmonic family today; the anchor table is intentionally NOT
wired into a validated surface). This is the correct spec-mandated state, not a
shortcut. The CVP harness (X1, scripts/verify-cvp.mjs + src/metrics/cvp.js)
documents exactly what calibration must run before cvp_status can flip to 'pass'.

REFLECT_THRESHOLD is a PROVISIONAL value (no operator calibration) → carried in
`notes` + low_confidence; CVP must calibrate it before §4.12 is trustworthy.

Direct invocation:
    ANCHOR_EMBEDDER=http MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-anchors.py

Security: counts/construct names/enums only in logs — NEVER anchor vectors,
NEVER message vectors, NEVER metric values, NEVER plaintext.
"""

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
import crypto_local
import stage_crypto

stage_base.load_dotenv(_REPO_ROOT)

# Anchor definitions + pluggable embedder (pipeline/anchors/*).
sys.path.insert(0, str(Path(__file__).resolve().parent / "anchors"))
import definitions as anchordefs  # noqa: E402
from embedder import get_embedder  # noqa: E402

from compute_information_harmonics import (  # noqa: E402
    GRANULARITIES,
    decrypt_vectors,
    fetch_envelopes_chunked,
    fetch_message_metadata,
    windows_for,
    _detect_history_days,
    _iso_to_unix,
)

# §4.12 reflective-embedding-density threshold. PROVISIONAL (no operator labels);
# CVP must calibrate. A message counts toward the density if its cosine proximity
# to the reflection anchor exceeds this. Kept conservative; honesty in `notes`.
REFLECT_THRESHOLD = float(os.environ.get("ANCHOR_REFLECT_THRESHOLD", "0.5"))

MIN_MESSAGES = 1   # a window needs >= 1 message to produce a proximity mean

ANCHOR_NOTE = (
    "Tier-1 embedding-anchor metric (spec §4.5/4.11/4.12/4.13). CVP NOT calibrated "
    "(cvp_status=pending) — no operator-labeled held-out data. NOT validated; do "
    "NOT surface as a measured construct. reflective_embedding_density uses a "
    "PROVISIONAL proximity threshold pending CVP calibration."
)

_MASTER_KEY = None


def _master_key():
    global _MASTER_KEY
    if _MASTER_KEY is None:
        _MASTER_KEY = crypto_local.load_master_key()
    return _MASTER_KEY


# ── Phase A: anchor vectors ──────────────────────────────────────────────

ANCHOR_SELECT_SQL = (
    "SELECT construct, seed_content_hash, dim FROM cognitive_anchor_vectors "
    "WHERE anchor_version = ?"
)
ANCHOR_UPSERT_SQL = (
    "INSERT INTO cognitive_anchor_vectors "
    "(construct, anchor_version, seed_content_hash, dim, seed_count, embedder_label, anchor_vector) "
    "VALUES (?,?,?,?,?,?,?) "
    "ON CONFLICT(construct, anchor_version) DO UPDATE SET "
    "  seed_content_hash=excluded.seed_content_hash, dim=excluded.dim, "
    "  seed_count=excluded.seed_count, embedder_label=excluded.embedder_label, "
    "  anchor_vector=excluded.anchor_vector, "
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)


def ensure_anchor_vectors(querier) -> dict[str, np.ndarray]:
    """Phase A. Return {construct: anchor_vector (L2-normalized np.float32 768)}.

    Embeds + stores (ENCRYPTED) any construct whose anchor is missing for the
    current ANCHOR_VERSION or whose seed_content_hash drifted. Already-current
    anchors are decrypted from storage (no re-embed).
    """
    mk = _master_key()
    version = anchordefs.ANCHOR_VERSION
    hashes = anchordefs.all_content_hashes()

    existing = {}
    for r in querier(ANCHOR_SELECT_SQL, [version]):
        existing[r["construct"]] = r.get("seed_content_hash")

    # Decide which constructs need (re)embedding.
    stale = [c for c in anchordefs.CONSTRUCTS
             if existing.get(c) != hashes[c]]

    embedder = get_embedder()
    out: dict[str, np.ndarray] = {}

    if stale:
        for construct in stale:
            seeds = anchordefs.SEED_PHRASES[construct]
            rows = embedder.embed(seeds)  # (S, 768) L2-normalized
            mean_vec = rows.mean(axis=0).astype(np.float32)
            norm = float(np.linalg.norm(mean_vec)) or 1.0
            mean_vec = (mean_vec / norm).astype(np.float32)
            env = crypto_local.encrypt_vector(mean_vec, "personal", mk)
            querier(ANCHOR_UPSERT_SQL, [
                construct, version, hashes[construct], anchordefs.ANCHOR_DIM,
                len(seeds), embedder.label, env,
            ])
            out[construct] = mean_vec

    # Load anchors for the constructs we did NOT (re)embed this run.
    for construct in anchordefs.CONSTRUCTS:
        if construct in out:
            continue
        row = querier(
            "SELECT anchor_vector FROM cognitive_anchor_vectors "
            "WHERE construct=? AND anchor_version=?",
            [construct, version],
        )
        if not row:
            raise RuntimeError(f"anchor vector missing after ensure for {construct!r}")
        env = row[0]["anchor_vector"]
        vec = crypto_local.decrypt_vector(env, mk, dim=anchordefs.ANCHOR_DIM)
        norm = float(np.linalg.norm(vec)) or 1.0
        out[construct] = (vec / norm).astype(np.float32)

    return out, version, ("reembedded" if stale else "cached"), [c for c in stale]


# ── Phase B: per-window metrics ──────────────────────────────────────────

METRIC_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_anchor ("
    "  user_id, window_end, granularity, era_id, language, anchor_version,"
    "  insight_embedding_proximity, reflective_embedding_density,"
    "  inner_territory_presence, affective_volatility_within_window,"
    "  cvp_status, message_count, low_confidence, notes"
    ") VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?) "
    "ON CONFLICT(user_id, window_end, granularity, language, era_id, anchor_version) "
    "DO UPDATE SET "
    "  insight_embedding_proximity=excluded.insight_embedding_proximity,"
    "  reflective_embedding_density=excluded.reflective_embedding_density,"
    "  inner_territory_presence=excluded.inner_territory_presence,"
    "  affective_volatility_within_window=excluded.affective_volatility_within_window,"
    "  cvp_status=excluded.cvp_status,"
    "  message_count=excluded.message_count,"
    "  low_confidence=excluded.low_confidence,"
    "  notes=excluded.notes,"
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)


def compute_window_metrics(win_emb: np.ndarray, anchors: dict[str, np.ndarray]) -> dict:
    """Pure: cosine-proximity metrics for one window's message embeddings.

    win_emb: (M, 768) L2-normalized message embeddings (M >= 1). anchors: each
    L2-normalized → dot product == cosine similarity.
    """
    cos_insight = win_emb @ anchors["insight"]            # (M,)
    cos_reflect = win_emb @ anchors["reflection"]         # (M,)
    cos_pos = win_emb @ anchors["affect_positive"]        # (M,)
    cos_neg = win_emb @ anchors["affect_negative"]        # (M,)

    affect_score = cos_pos - cos_neg                      # (M,) spec §4.13 step 2
    return {
        "insight_embedding_proximity": float(np.mean(cos_insight)),
        "reflective_embedding_density": float(np.mean(cos_reflect > REFLECT_THRESHOLD)),
        "inner_territory_presence": float(np.mean(cos_reflect)),
        "affective_volatility_within_window": (
            float(np.std(affect_score)) if affect_score.size > 1 else 0.0
        ),
    }


def upsert_metric_row(user_id, row, anchor_version, querier):
    e = stage_crypto.enc
    querier(METRIC_UPSERT_SQL, [
        user_id, row["window_end"], row["granularity"], row["era_id"], "en", anchor_version,
        e(row.get("insight_embedding_proximity")),
        e(row.get("reflective_embedding_density")),
        e(row.get("inner_territory_presence")),
        e(row.get("affective_volatility_within_window")),
        "pending",                       # cvp_status — plaintext gate (spec §2.3)
        row.get("message_count", 0),
        1,                               # low_confidence ALWAYS true (CVP pending)
        e(ANCHOR_NOTE),
    ])


def fetch_existing(user_id, run_id, anchor_version, querier):
    raw = era_skip.fetch_existing_keys(
        querier, table="cognitive_metrics_anchor", user_id=user_id, run_id=run_id,
        key_columns=["granularity", "window_end"], return_columns=[], run_id_column="era_id",
    )
    # era_skip keys on (granularity, window_end); anchor_version is part of the PK
    # but a single run uses one version, so the era-skip key is sufficient.
    return set(raw.keys())


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    run_id = os.environ.get("CLUSTERING_RUN_ID") or stage_base.derive_era_id(user_id, querier=querier)

    t0 = datetime.now(timezone.utc)
    event_emit.emit("anchors", "run_start", user=user_id[:8], era_id=run_id, ts=t0.isoformat(),
                    anchor_version=anchordefs.ANCHOR_VERSION,
                    embedder=os.environ.get("ANCHOR_EMBEDDER", "http"))

    # ── Phase A: anchors (always — cheap; needed even with few messages) ──
    anchors, anchor_version, anchor_mode, stale = ensure_anchor_vectors(querier)

    metadata = fetch_message_metadata(user_id, querier=querier)
    if len(metadata) < MIN_MESSAGES:
        event_emit.emit("anchors", "run_end", era_id=run_id,
                        totals={"computed": 0, "anchors": len(anchors)},
                        anchor_mode=anchor_mode, reason="insufficient-data",
                        cvp_status="pending")
        print(f"[anchors] anchors={len(anchors)} ({anchor_mode}) windows_computed=0 cvp=pending", flush=True)
        return

    history_days = _detect_history_days(metadata)
    existing = fetch_existing(user_id, run_id, anchor_version, querier)

    ids = [m["id"] for m in metadata]
    envelopes = fetch_envelopes_chunked(ids, querier=querier)
    vectors = decrypt_vectors(envelopes)
    ordered = [(m["created_at"], vectors[m["id"]]) for m in metadata if m["id"] in vectors]
    if len(ordered) < MIN_MESSAGES:
        event_emit.emit("anchors", "run_end", era_id=run_id,
                        totals={"computed": 0, "anchors": len(anchors)},
                        anchor_mode=anchor_mode, reason="decrypt-failed", cvp_status="pending")
        return

    timestamps_unix = np.array([_iso_to_unix(ts) for ts, _ in ordered], dtype=np.float64)
    embeddings = np.stack([v for _, v in ordered])
    # Re-L2-normalize defensively (ingest normalizes, but anchors assume unit norm).
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True).clip(min=1e-8)
    embeddings = (embeddings / norms).astype(np.float32)

    now = datetime.now(timezone.utc)
    computed = 0
    skipped = 0
    for granularity in GRANULARITIES:
        for w_start, w_end in windows_for(granularity, now=now, history_days=history_days):
            w_end_iso = w_end.isoformat()
            if (granularity, w_end_iso) in existing:
                skipped += 1
                continue
            mask = ((timestamps_unix >= w_start.timestamp())
                    & (timestamps_unix < w_end.timestamp()))
            idx = np.flatnonzero(mask)
            if idx.size < MIN_MESSAGES:
                continue
            win_emb = embeddings[idx]
            metrics = compute_window_metrics(win_emb, anchors)
            metrics.update({
                "window_end": w_end_iso, "granularity": granularity, "era_id": run_id,
                "message_count": int(idx.size),
            })
            upsert_metric_row(user_id, metrics, anchor_version, querier)
            computed += 1

    t1 = datetime.now(timezone.utc)
    event_emit.emit("anchors", "run_end", era_id=run_id,
                    totals={"computed": computed, "skipped": skipped, "anchors": len(anchors)},
                    anchor_version=anchor_version, anchor_mode=anchor_mode,
                    stale_constructs=stale, cvp_status="pending",
                    reflect_threshold=REFLECT_THRESHOLD,
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    print(f"[anchors] anchors={len(anchors)} ({anchor_mode}) computed={computed} "
          f"skipped={skipped} cvp=pending (Tier-1, NOT validated)", flush=True)


if __name__ == "__main__":
    import stage_result
    stage_result.run_main('compute-anchors', main)
