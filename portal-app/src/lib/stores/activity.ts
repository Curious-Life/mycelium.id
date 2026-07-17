// Polls the unified activity feed (GET /portal/activity) — every active
// background/inference job with a live ETA. Drives the mindscape chip's
// "Describing your areas · 5/16 · ~28s left" line + (later) a header dot.
import { writable, get } from 'svelte/store';
import { apiGet } from '$lib/api';

export interface ActivityJob {
  id: string;
  kind: string;
  stage: string;
  model?: string | null;    // what model is doing the work (e.g. 'qwen3.5:4b', 'nomic-v1.5')
  process?: string | null;  // what process it's running (e.g. 'on-box labeling', 'on-box embedding')
  done: number;
  total: number;
  remaining: number;
  etaSeconds: number | null;
  status: string;
  stalled?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export const activity = writable<{ active: ActivityJob[]; recent: ActivityJob[] }>({ active: [], recent: [] });

let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;

async function poll() {
  try {
    const d = await apiGet<{ active: ActivityJob[]; recent: ActivityJob[] }>('/portal/activity');
    activity.set({ active: d?.active ?? [], recent: d?.recent ?? [] });
  } catch {
    /* leave the last snapshot */
  }
}

/** Begin polling (ref-counted) — call from a component's onMount; returns a stop fn. */
export function startActivityPolling(intervalMs = 2500): () => void {
  subscribers += 1;
  if (!timer) {
    void poll();
    timer = setInterval(poll, intervalMs);
  }
  return () => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Format an ETA in seconds as a compact "~28s" / "~3m" / "~2h 5m" string. */
export function fmtEta(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 90) return `~${Math.max(1, Math.round(sec))}s`;
  const mins = Math.round(sec / 60);
  // ⚠️ HOURS EXIST BECAUSE §3.9's WHOLE SUBJECT IS A 29-HOUR IMPORT. This stopped at minutes, so
  // the moment R1 made the number real the headline case rendered "~1740m left" — technically
  // true, legible only with a calculator, and useless for the one decision it informs ("do I
  // leave this running overnight?"). An honest number the reader cannot parse is not honesty.
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
}

/**
 * Format a byte count as "1.2 GB" / "840 MB" / "12 KB". For the `model-pull` feed row,
 * whose done/total are BYTES (the drainer beats ollama's {completed,total} straight
 * through): rendered as `{done}/{total}` it printed ten-digit raw byte counts for a
 * 3.4GB download — technically true, legible to nobody (§3.8: "Downloading qwen3.5:4b
 * — 1.2 / 3.4 GB"). Same honesty rule as fmtEta's hours: an honest number the reader
 * cannot parse is not honesty.
 */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${Math.round(n)} B`;
}

/** Parse a SQLite `datetime('now')` string ('YYYY-MM-DD HH:MM:SS', UTC) — or an
 *  ISO string — to epoch ms. Returns NaN when unparseable. */
function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
}

/** Compact "just now" / "3m ago" / "2h ago" / "Jun 18" for a finished job. */
export function fmtAgo(ts: string | null | undefined): string {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A finished job is a "fresh" error worth flagging red for a short window. */
export function isFreshError(job: ActivityJob | undefined | null, withinMs = 5 * 60_000): boolean {
  if (!job || job.status !== 'error') return false;
  const t = parseTs(job.finishedAt);
  return !Number.isFinite(t) || Date.now() - t < withinMs;
}

/** A human label for a terminal job status. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'done': return 'Done';
    case 'error': return 'Failed';
    case 'abandoned': return 'Stopped';
    default: return status;
  }
}

/** The lead active job (most recent), or null. */
export function leadActive(): ActivityJob | null {
  return get(activity).active[0] ?? null;
}
