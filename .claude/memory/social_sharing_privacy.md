---
name: Social Sharing Privacy Research
description: Embedding inversion risks, safe abstraction levels, DP mechanisms, and connection mindscape design for Mycelium's social layer
type: project
---

Key findings from Ada's research (2026-04-05) on safe social sharing of Mindscape data.

**Why:** Mycelium needs a social layer where users can discover and connect based on shared interests — but raw embeddings are invertible to near-exact text (Vec2Text 92% recovery). The architecture must share *enough* for meaningful matching while protecting content.

**How to apply:** When building any social/sharing feature, use these abstraction levels. Never expose raw vectors or unnoised centroids externally.

## Safe Abstraction Spectrum (dangerous → safe)

1. **Raw embeddings** — NEVER share. 92% exact text recovery (Vec2Text, ALGEN, ZSInvert).
2. **Individual atom vectors** — NEVER share externally. Same risk as raw.
3. **Territory centroids (unnoised)** — MEDIUM risk. Topic recoverable. Only share with DP noise (epsilon 5-10).
4. **Territory centroids + DP noise (epsilon 3-5)** — LOW risk. Formal privacy guarantees. Good for discovery.
5. **Topic labels** — LOW risk. No vector to invert. Safe at Theme/Realm level. Check specificity at Territory level.
6. **Statistical properties** (cluster count, spread, density, entropy) — MINIMAL risk. Reveals cognitive style, not content. Safe for public profiles.
7. **LSH hashes** of centroids — LOW risk. Non-invertible, lossy. Good for approximate discovery.

## Recommended Sharing Tiers

- **Public profile**: Territory labels (Theme-level) + statistical properties only
- **Discovery layer**: LSH hashes + DP-noised centroids (epsilon 3)
- **Matching layer**: DP-noised centroids (epsilon 5-10) + SPARSE concept-aware protection
- **Bilateral check**: SMPC on raw centroids (neither party sees raw data)
- **Internal only**: Raw embeddings, never exposed

## DP Mechanisms for Centroids

- **CMAG** (ACM TOPS 2025): Mahalanobis-calibrated elliptical noise. Better than uniform Gaussian.
- **SPARSE** (ICLR 2026): Concept-aware — selectively protects sensitive dimensions. Maps to per-territory privacy.
- **Eguard**: Post-hoc transformer projection. >95% token protection, >98% downstream consistency.
- Practical epsilon: 3-5 for social features on personal conversation embeddings.

## Connection Mindscapes (Overlap Visualization)

- **Spotify Blend** is closest production analog — taste match score, Venn diagram UX, data stories.
- **Three approaches**: Label overlap (simplest), centroid cosine similarity matrix (richer), Wasserstein distribution matching (richest).
- **Connections have shape**: broad-shallow, deep-narrow, complementary, twin, asymmetric.
- **Tree-Wasserstein Distance** (NeurIPS 2024) handles hierarchical structure (Atom→Territory→Theme→Realm).

## Per-Territory Access Controls

- Maps to Contextual Integrity (Nissenbaum): each territory IS a context with its own sharing norms.
- Phase 1: Simple Public/Friends/Private per territory (default: Private).
- Phase 2: Context templates ("Work Self", "Social Self", "Creative Self", "Private Self").
- Phase 3: CI-informed dynamic suggestions ("This territory discusses medical topics...").

## Key Papers

- Vec2Text (arXiv:2310.06816) — embedding inversion, 92% exact match
- SPARSE (arXiv:2602.07090) — concept-aware DP for embeddings
- CMAG (ACM TOPS 2025) — Mahalanobis metric DP for sentence embeddings
- Tree-Wasserstein (NeurIPS 2024) — hierarchical distribution comparison
- Contextual Integrity operationalized (arXiv:2408.02373)
