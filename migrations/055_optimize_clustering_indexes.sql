-- =============================================
-- Optimized Indexes for Clustering Sync
-- =============================================
-- The NOT EXISTS queries in sync functions scan both source tables and clustering_points.
-- This migration adds optimized indexes to reduce IO on Supabase (especially nano instances).

-- Composite index for efficient NOT EXISTS lookups
-- The existing UNIQUE constraint on (user_id, source_type, source_id) helps,
-- but an index with source_id first helps for the EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_cp_source_lookup
ON clustering_points(source_type, source_id, user_id);

-- Index on messages for sync query (content check + existence)
CREATE INDEX IF NOT EXISTS idx_messages_sync_clustering
ON messages(user_id, id) WHERE content IS NOT NULL AND LENGTH(content) > 0;

-- Index on documents for sync query
CREATE INDEX IF NOT EXISTS idx_documents_sync_clustering
ON documents(user_id, id) WHERE content IS NOT NULL AND LENGTH(content) > 10;

-- Index on attachments for transcript sync
CREATE INDEX IF NOT EXISTS idx_attachments_transcript_sync
ON attachments(user_id, id) WHERE transcript IS NOT NULL AND LENGTH(transcript) > 10;

-- Index on attachments for image description sync
CREATE INDEX IF NOT EXISTS idx_attachments_imgdesc_sync
ON attachments(user_id, id, attachment_type) WHERE description IS NOT NULL AND LENGTH(description) > 10;

-- Index on reflections for sync query
CREATE INDEX IF NOT EXISTS idx_reflections_sync_clustering
ON reflections(user_id, id) WHERE content IS NOT NULL AND LENGTH(content) > 10;

-- Analyze tables after adding indexes
ANALYZE clustering_points;
ANALYZE messages;
ANALYZE documents;
ANALYZE attachments;
ANALYZE reflections;
