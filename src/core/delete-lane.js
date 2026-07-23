// The delete lane — a process-wide "a destructive bulk delete is in flight" flag.
//
// WHY: the guard was one-directional. portal-data.js refuses to START a delete
// while a mindscape Generate is running, but nothing stopped a Generate from
// starting DURING a delete (jobs.js:startClusteringJob had no visibility of
// portal-data.js's closure-scoped `deleteJob`). That race is exactly the one that
// corrupts: cluster.py reads clustering_points to build its old→new diff while the
// delete is halfway through emptying that table, so it sees a torn membership,
// mis-stabilizes ids, and writes a new cluster's stats into a half-dead row.
//
// Deliberately in-process and dependency-free: V1 is single-user, single-process
// for both surfaces (portal REST + the job runner live in the same node process),
// and the vault writer-lock (src/db/writer-lock.js) already fences foreign
// processes. This is the intra-process half of that fence.
//
// Balanced use is mandatory — always end() in a `finally`. A leaked lane would
// wedge Generate permanently, so end() is idempotent and the token is checked.

let active = 0;
let startedAt = null;
let token = 0;

/** Mark a destructive delete as in flight. Returns an end() you MUST call in a finally. */
export function beginDelete() {
  active += 1;
  if (active === 1) startedAt = Date.now();
  const mine = ++token;
  let ended = false;
  return function end() {
    if (ended) return;          // idempotent — a double-end must not free someone else's lane
    ended = true;
    void mine;
    active = Math.max(0, active - 1);
    if (active === 0) startedAt = null;
  };
}

/** True while any bulk delete is in flight. */
export function isDeleteRunning() { return active > 0; }

/** { running, startedAt } for status surfaces. Never exposes ids or scope. */
export function deleteLaneStatus() { return { running: active > 0, startedAt }; }

/** Test-only reset. */
export function _resetDeleteLane() { active = 0; startedAt = null; }
