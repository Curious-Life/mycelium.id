-- Migration: Add atomic continuation spawning to prevent race conditions
-- This ensures only ONE worker can spawn the continuation batch

-- Add column to track if continuation has been spawned
ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS continuation_spawned BOOLEAN DEFAULT false;

-- Create atomic function that increments progress AND checks if this worker should spawn continuation
-- Uses FOR UPDATE row locking to prevent race conditions
CREATE OR REPLACE FUNCTION increment_and_check_completion(
    p_job_id UUID,
    p_processed_count INT,
    p_failed_count INT
) RETURNS JSONB AS $$
DECLARE
    v_total INT;
    v_current_processed INT;
    v_current_failed INT;
    v_new_processed INT;
    v_new_failed INT;
    v_already_spawned BOOLEAN;
    v_max_workers INT;
    v_chunk_size INT;
BEGIN
    -- Lock the row to prevent race condition
    SELECT
        total_items,
        processed_items,
        failed_items,
        continuation_spawned,
        COALESCE((metadata->>'max_workers')::INT, 40),
        COALESCE((metadata->>'chunk_size')::INT, 40)
    INTO v_total, v_current_processed, v_current_failed, v_already_spawned, v_max_workers, v_chunk_size
    FROM batch_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    -- Calculate new totals
    v_new_processed := v_current_processed + p_processed_count;
    v_new_failed := v_current_failed + p_failed_count;

    -- Update the counters
    UPDATE batch_jobs
    SET processed_items = v_new_processed,
        failed_items = v_new_failed
    WHERE id = p_job_id;

    -- Check if this increment completed the job AND continuation hasn't been spawned yet
    IF v_new_processed + v_new_failed >= v_total AND NOT v_already_spawned THEN
        -- Atomically mark as spawned (only one worker can win this)
        UPDATE batch_jobs
        SET continuation_spawned = true,
            status = 'completed',
            completed_at = NOW()
        WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'should_spawn', true,
            'processed', v_new_processed,
            'failed', v_new_failed,
            'max_workers', v_max_workers,
            'chunk_size', v_chunk_size
        );
    END IF;

    -- Either not complete yet, or another worker already won the spawn race
    RETURN jsonb_build_object(
        'should_spawn', false,
        'processed', v_new_processed,
        'failed', v_new_failed
    );
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION increment_and_check_completion(UUID, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_and_check_completion(UUID, INT, INT) TO service_role;
