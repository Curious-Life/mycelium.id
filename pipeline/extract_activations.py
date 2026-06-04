"""Data plumbing for Fisher trajectory: window counts → activation vectors.

Ported VERBATIM from the canonical scripts/extract_activations.py. It already
talks to the data layer via ``import d1_client`` (a thin querier) — V1's
pipeline/d1_client.py exposes the same ``query(sql, params)`` surface over the
local SQLite vault, so no adaptation is needed.

Pure plumbing — no math, no side effects beyond the D1 query itself.
Given (user_id, level, window_start, window_end), returns the counts of
clustering_points falling in the window, grouped at the requested hierarchy
level.

Levels:
  - 'territory' → group directly by clustering_points.territory_id
  - 'theme'     → JOIN territory_profiles for semantic_theme_id
  - 'realm'     → JOIN territory_profiles for realm_id

Security:
  - Every query starts with `WHERE user_id = ?` as the first filter.
  - All values are bound via parameter placeholders. No SQL string-concat.
  - No master-key access. Reads only PLAINTEXT IDs and counts from
    clustering_points / territory_profiles (territory_id/realm_id/
    semantic_theme_id are structural join keys, kept plaintext by design).
"""

from typing import Callable, Optional

import d1_client


LEVELS = ('territory', 'theme', 'realm')


# ── SQL builders ────────────────────────────────────────────────────────────

def _build_count_sql(level: str) -> str:
    """Parameterised count SQL for windowed activations at the given level.

    Bind params (in order): user_id, window_start, window_end.
    """
    if level == 'territory':
        return (
            "SELECT territory_id AS id, COUNT(*) AS n "
            "FROM clustering_points "
            "WHERE user_id = ? "
            "  AND created_at >= ? "
            "  AND created_at < ? "
            "  AND territory_id IS NOT NULL "
            "GROUP BY territory_id"
        )
    if level == 'realm':
        return (
            "SELECT tp.realm_id AS id, COUNT(*) AS n "
            "FROM clustering_points cp "
            "JOIN territory_profiles tp "
            "  ON tp.user_id = cp.user_id "
            " AND tp.territory_id = cp.territory_id "
            "WHERE cp.user_id = ? "
            "  AND cp.created_at >= ? "
            "  AND cp.created_at < ? "
            "  AND tp.realm_id IS NOT NULL "
            "GROUP BY tp.realm_id"
        )
    if level == 'theme':
        return (
            "SELECT tp.semantic_theme_id AS id, COUNT(*) AS n "
            "FROM clustering_points cp "
            "JOIN territory_profiles tp "
            "  ON tp.user_id = cp.user_id "
            " AND tp.territory_id = cp.territory_id "
            "WHERE cp.user_id = ? "
            "  AND cp.created_at >= ? "
            "  AND cp.created_at < ? "
            "  AND tp.semantic_theme_id IS NOT NULL "
            "GROUP BY tp.semantic_theme_id"
        )
    raise ValueError(f"unknown level: {level!r}; expected one of {LEVELS}")


def _build_categories_sql(level: str) -> str:
    """SQL listing all distinct category IDs the user has ever been assigned to.

    Used to define the activation-vector dimension. Categories with 0
    count in any given window still receive a Laplace-smoothed pseudocount
    (handled by fisher.activation_vector).

    Bind param: user_id.
    """
    if level == 'territory':
        return (
            "SELECT DISTINCT territory_id AS id "
            "FROM clustering_points "
            "WHERE user_id = ? AND territory_id IS NOT NULL"
        )
    if level == 'realm':
        return (
            "SELECT DISTINCT realm_id AS id "
            "FROM territory_profiles "
            "WHERE user_id = ? AND realm_id IS NOT NULL"
        )
    if level == 'theme':
        return (
            "SELECT DISTINCT semantic_theme_id AS id "
            "FROM territory_profiles "
            "WHERE user_id = ? AND semantic_theme_id IS NOT NULL"
        )
    raise ValueError(f"unknown level: {level!r}; expected one of {LEVELS}")


# ── Public API ──────────────────────────────────────────────────────────────

def fetch_window_counts(
    user_id: str,
    level: str,
    window_start: str,
    window_end: str,
    querier: Optional[Callable[[str, list], list[dict]]] = None,
) -> dict[str, int]:
    """Count points falling in [window_start, window_end), grouped at level.

    Returns:
        {category_id: count}. Category IDs are stringified for JSON-friendliness.
        Empty dict when no points fall in the window.

    Raises:
        ValueError: when level is not one of LEVELS.
    """
    sql = _build_count_sql(level)
    rows = (querier or d1_client.query)(sql, [user_id, window_start, window_end])
    return {str(row['id']): int(row['n']) for row in rows}


def list_active_categories(
    user_id: str,
    level: str,
    querier: Optional[Callable[[str, list], list[dict]]] = None,
) -> list[str]:
    """All distinct category IDs assigned to the user at this level.

    Returns:
        Sorted list of stringified IDs. Empty list if none.

    Raises:
        ValueError: when level is not one of LEVELS.
    """
    sql = _build_categories_sql(level)
    rows = (querier or d1_client.query)(sql, [user_id])
    return sorted(str(row['id']) for row in rows)
