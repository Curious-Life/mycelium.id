/**
 * Alert dispatch — Discord webhook routing for fleet fatals.
 *
 * Runs from the Worker scheduled trigger (every 5 min). Queries two
 * classes of event and posts a dedupe'd Discord alert for each:
 *
 *   1. NEW fatal findings in fleet_health_reports (any VPS → any check).
 *      Dedupe key: alert:<vps_id>:<check_id>:<YYYY-MM-DD-HH>, 6h TTL.
 *   2. Fleet-dark: VPSes whose last_report_at is older than 2h.
 *      Dedupe key: alert:dark:<vps_id>:<YYYY-MM-DD-HH>, 6h TTL.
 *
 * Posts to DISCORD_SECURITY_WEBHOOK_URL (new Worker secret). The
 * webhook targets the security-alerts Discord channel. If the secret
 * is missing we log-warn and return — alerting absence is its own
 * visible state via /api/fleet/alert-dispatch-status.
 *
 * Idempotency: the KV dedupe guarantees repeated cron firings inside
 * a 6h window won't re-spam the same (vps, check) pair. If the fatal
 * persists beyond 6h, a fresh alert fires — so a persistent outage
 * doesn't go silent.
 */

import type { Env } from "../types/env";
import { METRIC_BUDGETS } from "../config/metric-budgets";

const ALERT_TTL_SECONDS = 6 * 60 * 60;
const FLEET_DARK_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const MAX_ALERTS_PER_RUN = 20;

interface FailureRecord {
  id: string;
  severity?: string;
  status?: string;
  message?: string;
}

interface FleetReport {
  id: string;
  vps_id: string;
  reported_at: number;
  handle: string;
  failures: string | null;
  summary: string | null;
}

interface FleetRegistryRow {
  vps_id: string;
  handle: string;
  last_report_at: number | null;
  last_report_status: string | null;
}

export async function dispatchFleetAlerts(env: Env): Promise<{ fatals_alerted: number; dark_alerted: number; pipeline_alerted: number; metric_stale_alerted: number; skipped: number; errors: number }> {
  const stats = { fatals_alerted: 0, dark_alerted: 0, pipeline_alerted: 0, metric_stale_alerted: 0, skipped: 0, errors: 0 };

  const webhookUrl = (env as unknown as Record<string, string | undefined>).DISCORD_SECURITY_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[alert-dispatch] DISCORD_SECURITY_WEBHOOK_URL not set — skipping alert run");
    return stats;
  }
  const db = env.DB;
  const kv = env.KV;
  if (!db || !kv) {
    console.error("[alert-dispatch] env.DB or env.KV missing");
    stats.errors++;
    return stats;
  }

  const now = Date.now();
  const hourBucket = new Date(now).toISOString().slice(0, 13); // YYYY-MM-DDTHH

  // 1. Fatal findings from the most recent report per VPS.
  // fleet_health_reports.failures is a JSON array of result objects;
  // we extract the ones flagged fatal severity + fail status.
  const recent = await db.prepare(
    `SELECT
       fhr.id, fhr.vps_id, fhr.reported_at, fhr.failures, fhr.summary, fr.handle
     FROM fleet_health_reports fhr
     JOIN fleet_registry fr ON fr.vps_id = fhr.vps_id
     WHERE fhr.reported_at > ?
     ORDER BY fhr.reported_at DESC
     LIMIT 50`,
  ).bind(now - FLEET_DARK_THRESHOLD_MS).all<FleetReport>();

  // De-dupe: only the latest report per VPS drives alerts.
  const latestByVps = new Map<string, FleetReport>();
  for (const row of recent.results || []) {
    if (!latestByVps.has(row.vps_id)) latestByVps.set(row.vps_id, row);
  }

  for (const report of latestByVps.values()) {
    if (stats.fatals_alerted >= MAX_ALERTS_PER_RUN) break;
    let failures: FailureRecord[] = [];
    try {
      failures = JSON.parse(report.failures || "[]");
    } catch {
      stats.errors++;
      continue;
    }
    const fatals = failures.filter(
      (f) => (f.severity === "fatal") && (f.status === "fail"),
    );
    for (const f of fatals) {
      if (stats.fatals_alerted >= MAX_ALERTS_PER_RUN) break;
      const dedupeKey = `alert:${report.vps_id}:${f.id}:${hourBucket}`;
      const already = await kv.get(dedupeKey);
      if (already) { stats.skipped++; continue; }
      const ok = await postDiscord(webhookUrl, {
        kind: "fatal",
        handle: report.handle,
        vps_id: report.vps_id,
        check_id: f.id,
        message: f.message || "(no message)",
        reported_at: report.reported_at,
      });
      if (ok) {
        await kv.put(dedupeKey, "1", { expirationTtl: ALERT_TTL_SECONDS });
        stats.fatals_alerted++;
      } else {
        stats.errors++;
      }
    }
  }

  // 2. Fleet-dark: any registered VPS that hasn't reported in >2h.
  const dark = await db.prepare(
    `SELECT vps_id, handle, last_report_at, last_report_status
     FROM fleet_registry
     WHERE last_report_at IS NULL OR last_report_at < ?`,
  ).bind(now - FLEET_DARK_THRESHOLD_MS).all<FleetRegistryRow>();

  for (const v of dark.results || []) {
    if (stats.dark_alerted >= MAX_ALERTS_PER_RUN) break;
    const dedupeKey = `alert:dark:${v.vps_id}:${hourBucket}`;
    const already = await kv.get(dedupeKey);
    if (already) { stats.skipped++; continue; }
    const ageMin = v.last_report_at ? Math.round((now - v.last_report_at) / 60000) : null;
    const ok = await postDiscord(webhookUrl, {
      kind: "fleet-dark",
      handle: v.handle,
      vps_id: v.vps_id,
      age_minutes: ageMin,
    });
    if (ok) {
      await kv.put(dedupeKey, "1", { expirationTtl: ALERT_TTL_SECONDS });
      stats.dark_alerted++;
    } else {
      stats.errors++;
    }
  }

  // 3. Pipeline quarantines: pipeline_state rows with quarantined=1
  // belong to a stage that failed 3+ times consecutively on some VPS's
  // coordinator. See scripts/pipeline-health.js + docs/PIPELINE-
  // COORDINATOR-PLAN.md. Dedupe per (user_id, stage) per hour-bucket
  // so we don't re-alert every cron tick while the quarantine
  // persists — the operator has one hour to see it and respond.
  const quarantined = await db.prepare(
    `SELECT ps.user_id, ps.stage_name, ps.last_failure_reason,
            ps.consecutive_failures, ps.last_failure_at,
            pj.handle
     FROM pipeline_state ps
     LEFT JOIN provisioning_jobs pj ON pj.user_id = ps.user_id
     WHERE ps.quarantined = 1
     LIMIT 50`,
  ).all<PipelineQuarantineRow>();

  for (const q of quarantined.results || []) {
    if (stats.pipeline_alerted >= MAX_ALERTS_PER_RUN) break;
    const dedupeKey = `alert:pipeline:${q.user_id}:${q.stage_name}:${hourBucket}`;
    const already = await kv.get(dedupeKey);
    if (already) { stats.skipped++; continue; }
    const ok = await postDiscord(webhookUrl, {
      kind: "pipeline-quarantine",
      handle: q.handle || "unknown-vps",
      vps_id: q.user_id,
      check_id: q.stage_name,
      message: q.last_failure_reason || "(no reason recorded)",
      reported_at: q.last_failure_at ? Date.parse(q.last_failure_at) : undefined,
      consecutive_failures: q.consecutive_failures,
    });
    if (ok) {
      await kv.put(dedupeKey, "1", { expirationTtl: ALERT_TTL_SECONDS });
      stats.pipeline_alerted++;
    } else {
      stats.errors++;
    }
  }

  // 4. Stale metric outputs — derived-metric tables that haven't been
  // written within their staleness budget. Per docs/architecture/
  // MEASUREMENT-PLANE-PLAN.md (PR 0.2). The April 2026 orchestration
  // gap (compute-frequency / compute-complexity / topology-audit /
  // compute-cognitive-fingerprint silently rotting for 2 weeks) was
  // the regression class this guards against.
  //
  // Owner-DB only for now — the owner's user_id is OWNER_USER_ID env.
  // Cross-tenant freshness alerts will come via fleet_health_reports
  // when each VPS reports its own freshness (separate plan item, not
  // PR 0.2 scope).
  //
  // Dedupe per (user_id, metric_table) per hour so a persistent
  // staleness fires once per hour, not every cron tick.
  const ownerUserId = (env as unknown as Record<string, string | undefined>).OWNER_USER_ID;
  if (ownerUserId) {
    for (const budget of METRIC_BUDGETS) {
      if (stats.metric_stale_alerted >= MAX_ALERTS_PER_RUN) break;
      let lastWrite: string | null = null;
      try {
        const row = await db.prepare(
          `SELECT MAX(${budget.timestamp_column}) AS last_write FROM ${budget.table} WHERE user_id = ?`,
        ).bind(ownerUserId).first<{ last_write: string | null }>();
        lastWrite = row?.last_write ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no such table")) continue;  // table not migrated yet
        console.error(`[alert-dispatch] freshness probe failed for ${budget.table}: ${msg}`);
        stats.errors++;
        continue;
      }
      if (!lastWrite) continue;  // empty table — not "stale", just unstarted
      const writeMs = Date.parse(lastWrite);
      if (!Number.isFinite(writeMs)) continue;
      const ageMs = now - writeMs;
      if (ageMs <= budget.budget_ms) continue;  // fresh

      const dedupeKey = `alert:metric-stale:${ownerUserId}:${budget.table}:${hourBucket}`;
      const already = await kv.get(dedupeKey);
      if (already) { stats.skipped++; continue; }
      const ok = await postDiscord(webhookUrl, {
        kind: "metric-stale",
        handle: "owner",
        vps_id: ownerUserId,
        check_id: budget.table,
        message: `${budget.description} Last write ${lastWrite}, age ${Math.round(ageMs / 3600_000)}h, budget ${Math.round(budget.budget_ms / 3600_000)}h.`,
        reported_at: writeMs,
      });
      if (ok) {
        await kv.put(dedupeKey, "1", { expirationTtl: ALERT_TTL_SECONDS });
        stats.metric_stale_alerted++;
      } else {
        stats.errors++;
      }
    }
  }

  console.log(`[alert-dispatch] run complete: ${JSON.stringify(stats)}`);
  return stats;
}

interface PipelineQuarantineRow {
  user_id: string;
  stage_name: string;
  last_failure_reason: string | null;
  consecutive_failures: number;
  last_failure_at: string | null;
  handle: string | null;
}

interface DiscordPayload {
  kind: "fatal" | "fleet-dark" | "pipeline-quarantine" | "metric-stale";
  handle: string;
  vps_id: string;
  check_id?: string;
  message?: string;
  age_minutes?: number | null;
  reported_at?: number;
  consecutive_failures?: number;
}

/**
 * Smoke-test the security webhook without waiting for a real fleet fatal.
 * Posts one message announcing a test; no dedupe, no D1/KV touched.
 *
 * Returns { ok, webhook_set, status? }. Caller is admin-auth'd in index.ts.
 */
export async function sendTestSecurityAlert(env: Env): Promise<{ ok: boolean; webhook_set: boolean; status?: number; error?: string }> {
  const webhookUrl = (env as unknown as Record<string, string | undefined>).DISCORD_SECURITY_WEBHOOK_URL;
  if (!webhookUrl) {
    return { ok: false, webhook_set: false };
  }
  const content = [
    `**🧪 security-webhook test**`,
    `If you see this, DISCORD_SECURITY_WEBHOOK_URL is wired correctly.`,
    `sent: <t:${Math.floor(Date.now() / 1000)}:F>`,
  ].join("\n");
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, webhook_set: true, status: res.status };
    return { ok: true, webhook_set: true, status: res.status };
  } catch (e: unknown) {
    return { ok: false, webhook_set: true, error: e instanceof Error ? e.message : String(e) };
  }
}

async function postDiscord(webhookUrl: string, p: DiscordPayload): Promise<boolean> {
  let content: string;
  if (p.kind === "fatal") {
    content = [
      `**⚠ FLEET FATAL — ${p.handle}**`,
      `check: \`${p.check_id}\``,
      `message: ${p.message}`,
      `vps: \`${p.vps_id}\``,
      p.reported_at ? `reported: <t:${Math.floor(p.reported_at / 1000)}:R>` : null,
    ].filter(Boolean).join("\n");
  } else if (p.kind === "pipeline-quarantine") {
    content = [
      `**🛑 PIPELINE QUARANTINE — ${p.handle}**`,
      `stage: \`${p.check_id}\``,
      `${p.consecutive_failures ?? 3} consecutive failures`,
      `last reason: ${p.message}`,
      `user: \`${p.vps_id}\``,
      p.reported_at ? `last failure: <t:${Math.floor(p.reported_at / 1000)}:R>` : null,
      `Stage is quarantined — skipped on future ticks until cleared. Clear via /admin/pipeline/health (coming) or UPDATE pipeline_state SET quarantined=0, consecutive_failures=0 WHERE ... .`,
    ].filter(Boolean).join("\n");
  } else if (p.kind === "metric-stale") {
    content = [
      `**⏳ METRIC STALE — ${p.handle}**`,
      `table: \`${p.check_id}\``,
      `${p.message}`,
      `user: \`${p.vps_id}\``,
      p.reported_at ? `last write: <t:${Math.floor(p.reported_at / 1000)}:R>` : null,
      `The compute pipeline that produces this table has not run within budget. Check pipeline-health.js stage status; if the stage is missing, the writer is orphaned (see docs/architecture/MEASUREMENT-PLANE-PLAN.md).`,
    ].filter(Boolean).join("\n");
  } else {
    const ageStr = p.age_minutes === null ? "never reported" : `${p.age_minutes}m since last report`;
    content = [
      `**⚫ FLEET DARK — ${p.handle}**`,
      `vps: \`${p.vps_id}\``,
      ageStr,
      `Check VPS reachability + fleet-attest cron.`,
    ].join("\n");
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(`[alert-dispatch] Discord post failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[alert-dispatch] Discord post threw: ${msg}`);
    return false;
  }
}
