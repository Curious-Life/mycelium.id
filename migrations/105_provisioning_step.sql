-- Add status_step column for live provisioning progress tracking
ALTER TABLE provisioning_jobs ADD COLUMN status_step TEXT;
