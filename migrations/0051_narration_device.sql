-- 0050 — narration_runs: WHERE the narration content actually went.
--
-- THE BUG THIS REPLACES. NarrateControl showed "on-box" vs "⚠ cloud · content leaves this
-- machine" by regex-matching narration_runs.provider — a DISPLAY NAME — with an unanchored
-- /local|ollama|on-?box|127\.0\.0\.1/i. A cloud provider LABELLED "localai" (labels are free
-- text the user types) rendered as on-box while its content went to an internet host. Worse,
-- `provider` was never a fact about the run at all: the route stored req.body.provider
-- verbatim — a CLIENT-SUPPLIED STRING with no connection to the provider that ran the walk
-- (resolved server-side per-turn by run-turn → resolve.js).
--
-- A NAME CANNOT ANSWER "did this leave my machine"; only the base_url can, via the one shared
-- host parser (src/inference/presets.js isLoopbackUrl). So the SERVER records the fact and the
-- UI renders it.
--
-- OBSERVED, NOT PREDICTED. These are written as the walk runs, from the provider that ACTUALLY
-- answered each turn (loop.js actualOnThisDevice, read AFTER any chain advance). A snapshot
-- taken at run start would be unsound: a sensitive chain is [localPrimary, eu-zdr…, localFloor],
-- so a run whose on-box Ollama dies falls back to EU CLOUD mid-run — the snapshot would still
-- say "on-box" while the bytes left. That is the very class of lie this migration exists to end.
--
-- Operational metadata only — a boolean and a jurisdiction name. No vault content (§1).
--
-- narration_runs.provider is now VESTIGIAL and stays NULL: the job no longer accepts a caller
-- label. It is left in place rather than dropped (SQLite ADD-only; dropping means a table
-- rebuild) — nothing reads it. Do NOT revive it to feed a UI claim: that is this bug.

-- NULL = UNKNOWN: no turn has run yet, or a turn ran through a wire we cannot attribute (the
-- local FLOOR carries no base_url, so describeProvider can't answer). NULL claims NOTHING —
-- the UI stays silent rather than guessing. 1 = every observed turn was PROVEN on this device.
-- 0 = at least one turn left it (sticky: once content leaves, it has left).
ALTER TABLE narration_runs ADD COLUMN on_this_device INTEGER;

-- JSON array of the DISTINCT jurisdictions that received content off-device ("eu-zdr",
-- "us-standard", …) — so the warning can say WHERE it went, not just that it went. NULL/[]
-- while nothing has left. Accumulated across pause/resume (seeded from this column).
ALTER TABLE narration_runs ADD COLUMN off_device_jurisdictions TEXT;
