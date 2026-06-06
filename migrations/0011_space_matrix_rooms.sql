-- 0011_space_matrix_rooms.sql — Phase B: 1 shared space ⇄ 1 Megolm room.
-- A dedicated binding (NOT space_rooms, which is the orthogonal nested-folder
-- model). The room is created lazily on the first share-grant; members are
-- synced from space_access (grant → invite, revoke → kick).
CREATE TABLE IF NOT EXISTS space_matrix_rooms (
  space_id   TEXT PRIMARY KEY,        -- → users.id (type='space')
  room_id    TEXT NOT NULL,           -- the Matrix room id (!room:hs)
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_space_matrix_rooms_room ON space_matrix_rooms(room_id);
