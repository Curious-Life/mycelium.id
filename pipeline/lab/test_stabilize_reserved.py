#!/usr/bin/env python3
"""verify:stabilize-reserved — guards the ghost-territory id-reuse fix.

THE BUG this gate exists to keep dead: `stabilize_ids()` allocated ids for newly
formed clusters from `max(old ∪ new) + 1`, where `old` comes ONLY from
clustering_points. A territory whose whole membership was DELETED has no
clustering_points rows — but it still owns a `territory_profiles` row. So its id
was invisible to the allocator, a fresh cluster was handed that exact id, and
`INSERT … ON CONFLICT(territory_id,user_id) DO UPDATE` (cluster.py) wrote the NEW
cluster's stats INTO the ghost's row — inheriting its name, essence, chronicle and
centroid. That is "every re-import inherits corrupted state".

`reserved_ids` is the fix: ids that already own a profile row are never handed to a
newly-formed cluster, in EITHER allocation path (first-run and incremental).

Pure stdlib — imports pipeline/stabilize.py directly. No numpy, no vault, no keys,
no DB. Prints a PASS/FAIL ledger + VERDICT, exits non-zero on any failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # pipeline/
from stabilize import stabilize_ids  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"\n      {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


# ── S1. FIRST-RUN path (old_assignments empty — exactly what a run looks like
#        after a delete emptied clustering_points) must not reuse a ghost id.
ghosts = {0, 1, 2}
new = {'p1': 0, 'p2': 0, 'p3': 1}
mapping, events, _ = stabilize_ids({}, new, 'territory', reserved_ids=ghosts)
assigned = set(mapping.values())
check('S1 first-run never allocates a RESERVED (ghost) id',
      assigned.isdisjoint(ghosts), f'assigned={sorted(assigned)} reserved={sorted(ghosts)}')

check('S1b first-run events carry the REMAPPED id, not the raw label',
      {e['cluster_id'] for e in events} == assigned,
      f"events={sorted(e['cluster_id'] for e in events)} assigned={sorted(assigned)}")

check('S1c first-run assigns a DISTINCT id per cluster',
      len(assigned) == len(mapping), f'mapping={mapping}')

# ── S2. CONTROL: with no reserved ids the first-run mapping is still identity
#        (the fix must not perturb a clean vault).
m2, _, _ = stabilize_ids({}, new, 'territory')
check('S2 CONTROL: no reserved ids → identity mapping (clean vault unchanged)',
      m2 == {0: 0, 1: 1}, f'mapping={m2}')

# ── S3. INCREMENTAL path: a cluster with no Jaccard match gets a fresh id that is
#        neither an existing live id nor a ghost id.
old = {'a': 0, 'b': 0, 'c': 1, 'd': 1}
# 'a','b' stay together (matches old 0); e/f/g are entirely new points.
new3 = {'a': 5, 'b': 5, 'e': 6, 'f': 6, 'g': 6}
reserved3 = {0, 1, 2, 3, 7}   # 0,1 live; 2,3,7 ghosts with surviving profile rows
m3, ev3, _ = stabilize_ids(old, new3, 'territory', reserved_ids=reserved3)
formed3 = {e['cluster_id'] for e in ev3 if e['event_type'] == 'formed'}
check('S3 incremental: a newly-formed cluster gets a NON-reserved id',
      formed3 and formed3.isdisjoint(reserved3),
      f'formed={sorted(formed3)} reserved={sorted(reserved3)}')

check('S3b incremental: an existing territory still INHERITS its id via Jaccard '
      '(reserved must not break legitimate continuity)',
      m3.get(5) == 0, f'mapping={m3}')

# ── S4. MUTATION CONTROL: with reserved_ids dropped, the very same incremental
#        input DOES collide with a ghost — i.e. this gate is measuring the fix,
#        not a property that holds anyway.
m4, ev4, _ = stabilize_ids(old, new3, 'territory')
formed4 = {e['cluster_id'] for e in ev4 if e['event_type'] == 'formed'}
check('S4 MUTATION CONTROL: without reserved_ids the SAME input collides with a ghost id',
      bool(formed4 & reserved3),
      f'formed_without_fix={sorted(formed4)} would collide with {sorted(formed4 & reserved3)}')

# ── S5. Dissolved events are still emitted for territories that DID lose their
#        match (the pre-existing contract must survive the change).
old5 = {'a': 0, 'b': 0, 'z': 9}
new5 = {'a': 0, 'b': 0}
_, ev5, _ = stabilize_ids(old5, new5, 'territory')
check('S5 dissolved event still emitted for an unmatched old cluster',
      any(e['event_type'] == 'dissolved' and e['cluster_id'] == 9 for e in ev5),
      f"events={[(e['event_type'], e['cluster_id']) for e in ev5]}")

print()
print('=' * 64)
if FAILS:
    print(f'VERDICT: NO-GO — {len(FAILS)} failed: {", ".join(FAILS)}')
    print('=' * 64)
    sys.exit(1)
print('VERDICT: GO — stabilize_ids never merges a new cluster into a ghost profile row  EXIT=0')
print('=' * 64)
