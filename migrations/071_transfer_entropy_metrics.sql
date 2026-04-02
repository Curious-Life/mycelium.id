-- Migration 071: Add Transfer Entropy network metrics to psychological_measurements
-- Transfer Entropy provides a scalable alternative to Phi (IIT) for measuring
-- information integration between topics.

-- Add Transfer Entropy columns
ALTER TABLE psychological_measurements
ADD COLUMN IF NOT EXISTS te_network_integration REAL,
ADD COLUMN IF NOT EXISTS te_total REAL,
ADD COLUMN IF NOT EXISTS te_mean REAL,
ADD COLUMN IF NOT EXISTS te_max REAL,
ADD COLUMN IF NOT EXISTS te_interpretation TEXT,
ADD COLUMN IF NOT EXISTS te_hub_scores JSONB,
ADD COLUMN IF NOT EXISTS te_dominant_flows JSONB;

-- Add comments
COMMENT ON COLUMN psychological_measurements.te_network_integration IS 'Network integration score from Transfer Entropy analysis [0, 1]';
COMMENT ON COLUMN psychological_measurements.te_total IS 'Total transfer entropy across all topic pairs (bits)';
COMMENT ON COLUMN psychological_measurements.te_mean IS 'Mean transfer entropy per edge (bits)';
COMMENT ON COLUMN psychological_measurements.te_max IS 'Maximum transfer entropy (strongest causal link, bits)';
COMMENT ON COLUMN psychological_measurements.te_interpretation IS 'Categorical interpretation: fragmented, loosely_connected, moderately_integrated, well_integrated, highly_integrated';
COMMENT ON COLUMN psychological_measurements.te_hub_scores IS 'JSON object mapping topic_id to {out: outbound_strength, in: inbound_strength}';
COMMENT ON COLUMN psychological_measurements.te_dominant_flows IS 'JSON array of top information flows: [{source, target, te}, ...]';

-- Create index for filtering by TE interpretation
CREATE INDEX IF NOT EXISTS idx_psych_te_interpretation
ON psychological_measurements(te_interpretation)
WHERE te_interpretation IS NOT NULL;

-- Create index for finding high-integration sessions
CREATE INDEX IF NOT EXISTS idx_psych_te_integration
ON psychological_measurements(te_network_integration DESC)
WHERE te_network_integration IS NOT NULL;
