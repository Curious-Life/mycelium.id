"""pipeline/anchors/definitions.py — versioned embedding-anchor definitions (E1).

Spec §2.4 (anchor cluster management) + §4.5/4.11/4.12/4.13 (the construct
metrics). Each construct is defined by ~10 seed phrases that mark a semantic
region in Nomic embedding space. These REPLACE the old keyword/word-list
measures (spec §3.2): insight_word_density → insight_embedding_proximity,
reflective_marker_density → reflective_embedding_density,
sentiment_volatility_within_window → affective_volatility_within_window.

These definitions are NOT secret (they are construct definitions, like a survey
instrument) — they live in version control as plaintext. But because an anchor
change IS a metric change (spec §2.4), every set carries:
  - ANCHOR_VERSION       — bumped whenever any seed set changes
  - seed_content_hash()  — sha256 over the canonical (sorted) seed set, so the
                           pipeline can detect a definition drift and re-embed
                           (the stored anchor vector then no longer matches).

The seed phrases for §4.5 and §4.12 are taken VERBATIM from the spec
(COGNITIVE-MEASUREMENT-SPEC §4.5 / §4.12). The affect anchors (§4.13) and the
reflection-vs-insight split (§4.11 shares the reflection anchor with §4.12 per
the spec) are prototypical expressions chosen to span the construct; they are
labeled experimental and gated by CVP (§2.3) like the rest of the family.
"""

from __future__ import annotations

import hashlib
import json

# Bump whenever ANY seed set below changes. Stored alongside each anchor vector
# (cognitive_anchor_vectors.anchor_version) + each metric row
# (cognitive_metrics_anchor.anchor_version) so reads are provenance-anchored.
ANCHOR_VERSION = "v1-2026-06-04"

# The matryoshka/full dim of the anchor vectors. Messages store embedding_768
# (768-D, L2-normalized at ingest); the §4.5/4.11/4.12/4.13 metrics compute
# cos_sim(message_embedding, anchor) so the anchor MUST live in the SAME space.
# We embed + store at the full 768-D (cosine is dimensionality-consistent).
ANCHOR_DIM = 768

# Construct → ordered list of seed phrases. ~10 per construct (spec §2.4).
SEED_PHRASES: dict[str, list[str]] = {
    # §4.5 insight_embedding_proximity (replaces insight_word_density).
    # Seeds VERBATIM from spec §4.5.
    "insight": [
        "I just realized",
        "now I understand",
        "looking back I see",
        "it occurred to me",
        "I finally see",
        "what I'm noticing",
        "the connection I'm making",
        "this changes how I think about",
        "I hadn't considered",
        "now it makes sense",
    ],
    # §4.12 reflective_embedding_density + §4.11 inner_territory_presence
    # (both use the reflection anchor; spec §4.11 "embedding-space distance to a
    # 'reflection' anchor"). Seeds VERBATIM from spec §4.12.
    "reflection": [
        "looking back",
        "I've been thinking about",
        "what I notice is",
        "on reflection",
        "I wonder if",
        "when I consider",
        "as I examine this",
        "stepping back I see",
        "what strikes me",
        "the pattern I notice",
    ],
    # §4.13 affective_volatility_within_window — positive/negative affect anchor
    # clusters (~10 prototypical emotional expressions each; spec §4.13 step 1).
    "affect_positive": [
        "I feel so happy",
        "this is wonderful",
        "I'm grateful and content",
        "what a joyful moment",
        "I feel hopeful and alive",
        "this brings me peace",
        "I'm excited and energized",
        "I feel loved and safe",
        "everything feels right",
        "I'm proud of this",
    ],
    "affect_negative": [
        "I feel so sad",
        "this is awful",
        "I'm anxious and afraid",
        "what a painful moment",
        "I feel hopeless and tired",
        "this fills me with dread",
        "I'm angry and frustrated",
        "I feel alone and lost",
        "everything feels wrong",
        "I'm ashamed of this",
    ],
}

# Canonical construct order (PRIMARY KEY component + stable iteration).
CONSTRUCTS = tuple(SEED_PHRASES.keys())

# The Nomic task to use when embedding the seed phrases. Anchors are "documents"
# defining a region (matches how message embeddings are produced at ingest). The
# embed-service HTTP API takes task ∈ {"query","document"} (TASK_PREFIXES in
# pipeline/embed-service.py). The embedder layer applies the prefix.
ANCHOR_EMBED_TASK = "document"


def seed_content_hash(construct: str) -> str:
    """Stable sha256 over a construct's seed set (order-independent).

    A change to ANY seed phrase changes the hash → the pipeline detects the drift
    (stored hash != recomputed hash) and re-embeds. Order-independent (sorted) so
    a pure reordering of equivalent seeds is NOT treated as a metric change.
    """
    seeds = SEED_PHRASES[construct]
    canonical = json.dumps(sorted(seeds), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def all_content_hashes() -> dict[str, str]:
    """{construct: seed_content_hash} for every construct."""
    return {c: seed_content_hash(c) for c in CONSTRUCTS}
