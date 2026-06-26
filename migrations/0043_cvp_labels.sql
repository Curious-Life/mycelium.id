-- 0043 — CVP labels (operator ground-truth for inner-state axis validation).
--
-- The Construct Validity Protocol (src/metrics/cvp.js) can only flip an axis to
-- cvp_status='pass' with >= 20 operator labels. This table stores those labels: the
-- user's rating of how much a given time-window leans on a given axis. A label is
-- scoped to the seed version it was rated under (anchor_version) — a seed change is a
-- metric change (spec §2.4), so labels do not carry across versions; re-validate.
--
-- Plaintext columns (no per-field envelope): confidentiality is whole-file SQLCipher
-- (ENCRYPTED_FIELDS is empty post-collapse). A label is the user's own self-assessment,
-- protected at rest by the vault key, never logged.
--
-- UNIQUE(window key + axis + version) → re-rating the same window UPSERTs (one label
-- per window per axis per version).

CREATE TABLE IF NOT EXISTS cvp_labels (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id        TEXT NOT NULL,
  axis           TEXT NOT NULL,       -- 'tone' | 'charge' | … (which axis this rates)
  anchor_version TEXT NOT NULL,       -- the seed version the window was scored under
  window_end     TEXT NOT NULL,       -- window key (with granularity + era_id)
  granularity    TEXT NOT NULL,       -- 'alpha' | 'theta' | 'delta'
  era_id         TEXT NOT NULL,       -- clustering run the window belongs to
  target         REAL NOT NULL,       -- operator label: the construct score (e.g. -1..+1)
  labeled_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, axis, anchor_version, window_end, granularity, era_id)
);

CREATE INDEX IF NOT EXISTS idx_cvp_labels_axis
  ON cvp_labels (user_id, axis, anchor_version);
