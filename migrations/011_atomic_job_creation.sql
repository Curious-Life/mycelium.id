-- Migration: Atomic job creation to prevent race conditions
-- Ensures only ONE job can be created at a time using row locking

-- Ensure control record exists (required for row locking)
INSERT INTO batch_jobs (id, job_type, status, total_items, processed_items, failed_items)
VALUES ('00000000-0000-0000-0000-000000000001', 'gliner_control', 'idle', 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_gliner_job_atomic(
    p_total_items INT,
    p_max_workers INT,
    p_chunk_size INT,
    p_force BOOLEAN DEFAULT false
) RETURNS JSONB AS $$
DECLARE
    v_running_job_id UUID;
    v_new_job_id UUID;
    v_control_status TEXT;
BEGIN
    -- Lock the control record to prevent concurrent job creation
    -- This is the key to preventing race conditions
    SELECT status INTO v_control_status
    FROM batch_jobs
    WHERE id = '00000000-0000-0000-0000-000000000001'
    FOR UPDATE;

    -- Check for any running jobs
    SELECT id INTO v_running_job_id
    FROM batch_jobs
    WHERE job_type = 'parallel_entity_extraction'
      AND status = 'running'
    LIMIT 1;

    -- If a job is running and not forcing, return error
    IF v_running_job_id IS NOT NULL AND NOT p_force THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'already_running',
            'running_job_id', v_running_job_id
        );
    END IF;

    -- If forcing, cancel all running jobs
    IF p_force AND v_running_job_id IS NOT NULL THEN
        UPDATE batch_jobs
        SET status = 'cancelled',
            completed_at = NOW(),
            error = 'Cancelled by force restart'
        WHERE job_type = 'parallel_entity_extraction'
          AND status = 'running';
    END IF;

    -- Create the new job atomically
    INSERT INTO batch_jobs (
        job_type,
        status,
        total_items,
        processed_items,
        failed_items,
        started_at,
        metadata
    ) VALUES (
        'parallel_entity_extraction',
        'running',
        p_total_items,
        0,
        0,
        NOW(),
        jsonb_build_object('max_workers', p_max_workers, 'chunk_size', p_chunk_size)
    )
    RETURNING id INTO v_new_job_id;

    -- Update control to active
    UPDATE batch_jobs
    SET status = 'active'
    WHERE id = '00000000-0000-0000-0000-000000000001';

    RETURN jsonb_build_object(
        'success', true,
        'job_id', v_new_job_id
    );
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION create_gliner_job_atomic(INT, INT, INT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION create_gliner_job_atomic(INT, INT, INT, BOOLEAN) TO service_role;

-- Atomic continuation job creation (for workers/cron)
-- Only creates job if no other running job exists
CREATE OR REPLACE FUNCTION create_continuation_job_atomic(
    p_total_items INT,
    p_max_workers INT,
    p_chunk_size INT
) RETURNS JSONB AS $$
DECLARE
    v_running_job_id UUID;
    v_new_job_id UUID;
BEGIN
    -- Lock the control record
    PERFORM 1 FROM batch_jobs
    WHERE id = '00000000-0000-0000-0000-000000000001'
    FOR UPDATE;

    -- Check for any running jobs
    SELECT id INTO v_running_job_id
    FROM batch_jobs
    WHERE job_type = 'parallel_entity_extraction'
      AND status = 'running'
    LIMIT 1;

    -- If a job is already running, skip
    IF v_running_job_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'job_already_running',
            'running_job_id', v_running_job_id
        );
    END IF;

    -- Create the continuation job atomically
    INSERT INTO batch_jobs (
        job_type,
        status,
        total_items,
        processed_items,
        failed_items,
        started_at,
        metadata
    ) VALUES (
        'parallel_entity_extraction',
        'running',
        p_total_items,
        0,
        0,
        NOW(),
        jsonb_build_object('max_workers', p_max_workers, 'chunk_size', p_chunk_size)
    )
    RETURNING id INTO v_new_job_id;

    RETURN jsonb_build_object(
        'success', true,
        'job_id', v_new_job_id
    );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION create_continuation_job_atomic(INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION create_continuation_job_atomic(INT, INT, INT) TO service_role;
