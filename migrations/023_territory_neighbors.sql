-- =============================================
-- Territory Neighbors
-- =============================================
-- Tracks relationships between territories:
-- - spatial: based on 3D centroid distance
-- - temporal: based on overlapping activity periods
-- - semantic: based on shared entities (future)

CREATE TABLE territory_neighbors (
    id SERIAL PRIMARY KEY,
    territory_id INT NOT NULL,
    neighbor_id INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    connection_type TEXT NOT NULL,  -- 'spatial', 'temporal', 'semantic'
    distance FLOAT,                  -- Euclidean for spatial
    overlap_start DATE,              -- For temporal
    overlap_end DATE,
    shared_entities INT DEFAULT 0,   -- For semantic

    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint
    UNIQUE(user_id, territory_id, neighbor_id, connection_type)
);

-- RLS
ALTER TABLE territory_neighbors ENABLE ROW LEVEL SECURITY;

CREATE POLICY territory_neighbors_user_policy ON territory_neighbors
    FOR ALL USING (user_id = auth.uid());

-- Index for lookups
CREATE INDEX idx_territory_neighbors_lookup
    ON territory_neighbors(user_id, territory_id, connection_type);
