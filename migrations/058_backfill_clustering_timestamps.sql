-- =============================================
-- Backfill timestamps for clustering_points
-- =============================================
-- Ensures all clustering_points entries have valid created_at timestamps
-- by fetching from their original source tables.

-- Backfill message timestamps
UPDATE clustering_points cp
SET created_at = m.created_at
FROM messages m
WHERE cp.source_type = 'message'
  AND cp.source_id = m.id
  AND (cp.created_at IS NULL OR cp.created_at = '2000-01-01'::timestamptz);

-- Backfill document timestamps
UPDATE clustering_points cp
SET created_at = COALESCE(d.created_at, d.updated_at, NOW())
FROM documents d
WHERE cp.source_type = 'document'
  AND cp.source_id = d.id
  AND (cp.created_at IS NULL OR cp.created_at = '2000-01-01'::timestamptz);

-- Backfill transcript timestamps (from attachments table)
UPDATE clustering_points cp
SET created_at = COALESCE(a.created_at, NOW())
FROM attachments a
WHERE cp.source_type = 'transcript'
  AND cp.source_id = a.id
  AND (cp.created_at IS NULL OR cp.created_at = '2000-01-01'::timestamptz);

-- Backfill reflection timestamps
UPDATE clustering_points cp
SET created_at = COALESCE(r.created_at, NOW())
FROM reflections r
WHERE cp.source_type = 'reflection'
  AND cp.source_id = r.id
  AND (cp.created_at IS NULL OR cp.created_at = '2000-01-01'::timestamptz);

-- Backfill image_description timestamps (from attachments table)
UPDATE clustering_points cp
SET created_at = COALESCE(a.created_at, NOW())
FROM attachments a
WHERE cp.source_type = 'image_description'
  AND cp.source_id = a.id
  AND (cp.created_at IS NULL OR cp.created_at = '2000-01-01'::timestamptz);

-- For any remaining NULL timestamps, set to NOW() as fallback
UPDATE clustering_points
SET created_at = NOW()
WHERE created_at IS NULL;
