#!/usr/bin/env python3
"""verify:prune-reversible — guards BLOCKER 1 of the delete contract (QA6 PR #322).

THE BUG this gate keeps dead: pipeline/cluster.py's vault-wide liveness prune
(`prune_dead_territories`) dissolved EVERY `territory_profiles` row that held no
`clustering_points`, on every pass — including the below-min-points early return.
The assumption "no points ⇒ deleted" is FALSE. On re-import, src/db/messages.js
`updateContent` DELETES a live message's clustering_points row (and nulls
embedding_768) so the drainer re-embeds + re-clusters. If Generate runs in that
window the territory momentarily holds no live point and was dissolved — and since
`dissolved_at` was SET-ONLY and the id landed in `reserved_territory_ids`, the
returning points formed a NEW territory: the old name/essence/chronicle unreachable
forever.

THE FIX (both halves, both guarded here):
  (a) REVERSIBLE — a territory that regains live points has `dissolved_at` cleared.
  (b) BACKLOG GATE — while embeddings are still draining (a message awaiting
      embedding, or a clustering point awaiting its nomic vector) the prune is
      deferred, so a transiently-absent live territory is never dissolved.
Both call sites (the normal end-of-run call and the below-min-points early return)
route through `prune_dead_territories`, so gating the function covers both.

Pure stdlib: stubs numpy + dotenv so cluster.py imports with no venv, then routes
cluster.d1_query at a real in-memory sqlite3 vault. No keys, no network, no numpy.
Prints a PASS/FAIL ledger + VERDICT, exits non-zero on any failure.
"""
import os
import sqlite3
import sys
import types

# ── Stub the two non-stdlib module-level imports so cluster.py loads without a venv.
# cluster.py evaluates `np.ndarray | None` annotations at def-time, so the numpy stub
# resolves any attribute to the real `object` type (a type → supports `| None` and
# never AttributeErrors). None of numpy's runtime maths is reached — the code under
# test (prune_dead_territories) is pure SQL through the monkeypatched d1_query.
if 'numpy' not in sys.modules:
    class _FakeNumpy(types.ModuleType):
        def __getattr__(self, _name):
            return object
    sys.modules['numpy'] = _FakeNumpy('numpy')
if 'dotenv' not in sys.modules:
    _d = types.ModuleType('dotenv')
    _d.dotenv_values = lambda *a, **k: {}
    sys.modules['dotenv'] = _d

# cluster.py sys.exit(1)s at import if MYCELIUM_DB is unset; set a placeholder (the
# real vault is never opened — d1_query is monkeypatched at an in-memory sqlite3).
os.environ.setdefault('MYCELIUM_DB', ':memory:')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # pipeline/
import cluster  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"\n      {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


# ── In-memory vault + d1_query shim ──────────────────────────────────────────────
def fresh_vault():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE territory_profiles (
          user_id TEXT, territory_id INTEGER, name TEXT, essence TEXT,
          dissolved_at TEXT, dissolved_version TEXT
        );
        CREATE TABLE clustering_points (
          user_id TEXT, territory_id INTEGER, source_type TEXT, source_id TEXT,
          nomic_embedding BLOB
        );
        CREATE TABLE messages (
          user_id TEXT, id TEXT, embedding_768 TEXT, forgotten_at TEXT,
          nlp_processed INTEGER DEFAULT 0, nlp_error TEXT
        );
        """
    )
    return conn


def install(conn):
    """Route cluster.d1_query at `conn`. SELECT → list[dict]; write → []."""
    def d1(sql, params=None):
        cur = conn.execute(sql, params or [])
        if sql.strip().lstrip('(').lower().startswith('select'):
            return [dict(r) for r in cur.fetchall()]
        conn.commit()
        return []
    cluster.d1_query = d1


def terr(conn, tid, dissolved=False):
    conn.execute(
        "INSERT INTO territory_profiles (user_id, territory_id, name, essence, dissolved_at, dissolved_version) "
        "VALUES ('u', ?, ?, ?, ?, ?)",
        [tid, f'name-{tid}', f'essence-{tid}', '2020-01-01T00:00:00Z' if dissolved else None,
         'v0' if dissolved else None],
    )


def point(conn, tid, sid, embedded=True):
    conn.execute(
        "INSERT INTO clustering_points (user_id, territory_id, source_type, source_id, nomic_embedding) "
        "VALUES ('u', ?, 'message', ?, ?)",
        [tid, sid, (b'\x00' if embedded else None)],
    )


def msg(conn, mid, embedded=True, forgotten=False, nlp_processed=0, nlp_error=None):
    conn.execute(
        "INSERT INTO messages (user_id, id, embedding_768, forgotten_at, nlp_processed, nlp_error) "
        "VALUES ('u', ?, ?, ?, ?, ?)",
        [mid, ('vec' if embedded else None), ('2020-01-01T00:00:00Z' if forgotten else None),
         nlp_processed, nlp_error],
    )


def capped_msg(conn, mid, n=5):
    """A PERMANENTLY-STUCK message: retired by the drainer after N counted attempts
    (src/enrich/service.js EMBED_CAPPED_MARK → nlp_processed -1 + 'embed-capped:N').
    embedding_768 stays NULL forever until a boot reclaim / retry-failed."""
    msg(conn, mid, embedded=False, nlp_processed=-1, nlp_error=f'embed-capped:{n}')


def dissolved_at(conn, tid):
    r = conn.execute(
        "SELECT dissolved_at FROM territory_profiles WHERE user_id='u' AND territory_id=?", [tid]
    ).fetchone()
    return r['dissolved_at'] if r else 'MISSING'


V = '2026-07-22T00:00:00Z'

# ── T1. CLEAN vault, no backlog: dead pruned · shared/live kept · previously-
#        dissolved-but-returned RESTORED. The whole contract in one pass. ──────────
c = fresh_vault(); install(c)
terr(c, 10)                       # live, healthy
terr(c, 20, dissolved=True)       # was dissolved — but points have RETURNED
terr(c, 30)                       # genuinely dead (no points) → should dissolve
point(c, 10, 'a', embedded=True)
point(c, 20, 'b', embedded=True)  # 20 holds a live point again
msg(c, 'a', embedded=True); msg(c, 'b', embedded=True)  # no backlog
n = cluster.prune_dead_territories('u', V)
check('T1a genuinely-dead territory 30 IS dissolved (prune still works)', dissolved_at(c, 30) == V,
      f'dissolved_at(30)={dissolved_at(c, 30)!r} n={n}')
check('T1b live territory 10 UNtouched', dissolved_at(c, 10) is None,
      f'dissolved_at(10)={dissolved_at(c, 10)!r}')
check('T1c FIX(a) REVERSIBLE: territory 20 whose points RETURNED is un-dissolved',
      dissolved_at(c, 20) is None, f'dissolved_at(20)={dissolved_at(c, 20)!r}')

# ── T2. RE-IMPORT window (backlog present): a LIVE territory whose only member is
#        mid-re-embed (message live, embedding_768 NULL, its clustering_points row
#        momentarily deleted) must NOT be dissolved. This is the exact ghost bug. ──
c = fresh_vault(); install(c)
terr(c, 40)                       # profile exists, points transiently GONE
# no clustering_points for 40 → looks "dead" to a naive liveness check …
msg(c, 'm40', embedded=False)     # … but its message is LIVE and awaiting re-embed
n = cluster.prune_dead_territories('u', V)
check('T2 FIX(b) BACKLOG GATE: territory 40 (points mid-re-import) is NOT dissolved',
      dissolved_at(c, 40) is None and n == 0,
      f'dissolved_at(40)={dissolved_at(c, 40)!r} n={n}')

# ── T2b. Backlog via an un-embedded CLUSTERING POINT (nomic_embedding NULL) also
#         defers the prune. ─────────────────────────────────────────────────────────
c = fresh_vault(); install(c)
terr(c, 41)
point(c, 42, 'p42', embedded=False)  # a point still awaiting its nomic vector
msg(c, 'x', embedded=True)
n = cluster.prune_dead_territories('u', V)
check('T2b BACKLOG GATE fires on an un-embedded clustering point too (dead 41 NOT dissolved)',
      dissolved_at(c, 41) is None and n == 0,
      f'dissolved_at(41)={dissolved_at(c, 41)!r} n={n}')

# ── T3. RESTORE runs even under backlog (belt-and-suspenders): a territory that was
#        dissolved and whose points returned is un-dissolved BEFORE the gate defers
#        the dead-scan — so an earlier wrong dissolve always self-heals. ────────────
c = fresh_vault(); install(c)
terr(c, 50, dissolved=True)          # dissolved on an earlier pass …
point(c, 50, 's', embedded=True)     # … but its points are back
terr(c, 60)                          # dead — but backlog will defer its dissolve
msg(c, 'pending', embedded=False)    # global backlog
n = cluster.prune_dead_territories('u', V)
check('T3a RESTORE runs under backlog: returned-point territory 50 un-dissolved',
      dissolved_at(c, 50) is None, f'dissolved_at(50)={dissolved_at(c, 50)!r}')
check('T3b under backlog the dead-scan is still deferred: territory 60 NOT dissolved',
      dissolved_at(c, 60) is None, f'dissolved_at(60)={dissolved_at(c, 60)!r}')

# ── T4. A FORGOTTEN un-embedded message is NOT a backlog (forgotten_at set): the
#        gate must not be jammed forever by tombstones. ──────────────────────────────
c = fresh_vault(); install(c)
terr(c, 70)                          # genuinely dead
msg(c, 'tomb', embedded=False, forgotten=True)  # forgotten → excluded from backlog
n = cluster.prune_dead_territories('u', V)
check('T4 forgotten tombstones (embedding NULL but forgotten_at set) do NOT count as backlog → dead 70 dissolved',
      dissolved_at(c, 70) == V, f'dissolved_at(70)={dissolved_at(c, 70)!r} n={n}')

# ── T5. STALENESS BOUND (the deadlock fix). A message that is PERMANENTLY stuck
#        un-embeddable (nlp_processed -1, 'embed-capped:N', embedding_768 NULL forever)
#        must NOT defer the prune forever — otherwise ONE stuck row disables the
#        vault-wide liveness prune indefinitely and genuinely-dead territories (real
#        deletes) are never cleaned. Direction (b) of the deadlock proof. ────────────
c = fresh_vault(); install(c)
terr(c, 80)                          # genuinely dead (no live points) → should dissolve
point(c, 90, 'p90', embedded=True)   # unrelated live territory so `live` is non-empty
terr(c, 90)
msg(c, 'good', embedded=True)        # a healthy embedded message
capped_msg(c, 'stuck')               # the permanently-stuck row — the ONLY thing NULL
n = cluster.prune_dead_territories('u', V)
check('T5 STALENESS BOUND: a capped un-embeddable message does NOT defer the prune → dead 80 dissolved',
      dissolved_at(c, 80) == V, f'dissolved_at(80)={dissolved_at(c, 80)!r} n={n}')
check('T5b the unrelated live territory 90 is untouched',
      dissolved_at(c, 90) is None, f'dissolved_at(90)={dissolved_at(c, 90)!r}')

# ── T6. NO REGRESSION (direction a). An ACTIVELY re-embedding message (pending:
#        nlp_processed 0 / 'embed-retry:N', embedding_768 NULL) STILL defers the prune,
#        even when a capped row is ALSO present. A real re-import must never be
#        dissolved just because some OTHER row is permanently stuck. ─────────────────
c = fresh_vault(); install(c)
terr(c, 100)                                          # dead — but an active re-embed is in flight
msg(c, 'reimbed', embedded=False, nlp_processed=0)    # pending, mid re-embed (fix b protects it)
capped_msg(c, 'also-stuck')                           # a capped row present at the same time
n = cluster.prune_dead_territories('u', V)
check('T6 NO REGRESSION: an active re-embed (pending) STILL defers the prune even with a capped row present',
      dissolved_at(c, 100) is None and n == 0, f'dissolved_at(100)={dissolved_at(c, 100)!r} n={n}')

# ── T6b. A row marked 'embed-retry:N' (still PENDING at nlp_processed 0) is NOT capped
#         and STILL counts as backlog — only the TERMINAL 'embed-capped' marker is
#         excluded. Guards the retry/capped boundary. ──────────────────────────────────
c = fresh_vault(); install(c)
terr(c, 105)
msg(c, 'retrying', embedded=False, nlp_processed=0, nlp_error='embed-retry:3')
n = cluster.prune_dead_territories('u', V)
check('T6b an embed-RETRY row (still pending) STILL defers the prune (dead 105 NOT dissolved)',
      dissolved_at(c, 105) is None and n == 0, f'dissolved_at(105)={dissolved_at(c, 105)!r} n={n}')

# ── T6c. A -1 row with a NON-capped / NULL error (e.g. a legacy poison row the
#         self-heal re-queues) is NOT excluded — the COALESCE keeps the predicate
#         two-valued and it STILL counts as backlog (conservative default). ────────────
c = fresh_vault(); install(c)
terr(c, 108)
msg(c, 'poison', embedded=False, nlp_processed=-1, nlp_error=None)  # -1 but not embed-capped
n = cluster.prune_dead_territories('u', V)
check('T6c a -1 row with a non-capped/NULL error STILL counts as backlog (dead 108 NOT dissolved)',
      dissolved_at(c, 108) is None and n == 0, f'dissolved_at(108)={dissolved_at(c, 108)!r} n={n}')

# ── T7. REVERSIBILITY of the stuck path (direction c). If the prune proceeds past a
#        capped row and dissolves a territory, then the capped message is later
#        reclaimed (retry-failed / boot), finally embeds and rejoins that territory,
#        fix (a) RESTORES it (dissolved_at cleared). Bounds the risk of proceeding. ────
c = fresh_vault(); install(c)
point(c, 110, 'live-elsewhere', embedded=True); terr(c, 110)  # keep `live` non-empty
terr(c, 120)                         # will be dissolved this pass
capped_msg(c, 'will-recover')        # only NULL row is capped → prune proceeds
n1 = cluster.prune_dead_territories('u', V)
check('T7a prune proceeds past the capped row and dissolves dead territory 120',
      dissolved_at(c, 120) == V, f'dissolved_at(120)={dissolved_at(c, 120)!r} n={n1}')
# … now the capped message recovers: reclaimed → embeds → re-clusters back into 120.
c.execute("UPDATE messages SET nlp_processed=1, nlp_error=NULL, embedding_768='vec' WHERE id='will-recover'")
point(c, 120, 'will-recover', embedded=True)                  # its point rejoins territory 120
n2 = cluster.prune_dead_territories('u', V)
check('T7b REVERSIBILITY: once the recovered message rejoins, territory 120 is RESTORED (dissolved_at cleared)',
      dissolved_at(c, 120) is None, f'dissolved_at(120)={dissolved_at(c, 120)!r} n2={n2}')

print()
if FAILS:
    print(f"{len(FAILS)} FAIL: {FAILS}")
    print("VERDICT: NO-GO")
    sys.exit(1)
print("VERDICT: GO — liveness prune is reversible + backlog-gated; the re-import ghost cannot re-form")
