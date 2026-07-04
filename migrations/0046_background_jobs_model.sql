-- 0046_background_jobs_model.sql — record WHICH model a job is running.
-- The activity feed (portal-activity.js shape()) already projects `model`; this
-- adds the column so the header indicator can show "a model is working on it"
-- with the model name (e.g. a channel-turn replying to a Telegram/Discord message).
-- Content-free per §1: a model NAME only, never user text or model output.
-- Additive + nullable → safe at-rest migration.
ALTER TABLE background_jobs ADD COLUMN model TEXT;
