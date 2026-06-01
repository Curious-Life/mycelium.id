-- 0002 — local file storage for self-hosted uploads.
--
-- V1 stores uploaded file bytes encrypted-at-rest on LOCAL DISK (mind-files
-- envelope), not in Cloudflare R2. `r2_key` stays for production-import
-- compatibility; `local_path` is the self-hosted storage key (relative path
-- under data/uploads/). Nullable — an attachment may predate the column or be
-- R2-sourced on import.
ALTER TABLE attachments ADD COLUMN local_path TEXT;
