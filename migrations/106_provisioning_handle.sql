-- Add handle column to provisioning_jobs
ALTER TABLE provisioning_jobs ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_handle ON provisioning_jobs(handle) WHERE status != 'failed';
