-- Add nomic_embedding column to store 256D float32 vectors (1024 bytes each)
-- This eliminates re-embedding on every clustering run
ALTER TABLE clustering_points ADD COLUMN nomic_embedding BLOB;
