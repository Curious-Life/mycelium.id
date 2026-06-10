// Polls the unified activity feed (GET /portal/activity) — every active
// background/inference job with a live ETA. Drives the mindscape chip's
// "Describing your areas · 5/16 · ~28s left" line + (later) a header dot.
import { writable, get } from 'svelte/store';
import { apiGet } from '$lib/api';

export interface ActivityJob {
  id: string;
  kind: string;
  stage: string;
  done: number;
  total: number;
  remaining: number;
  etaSeconds: number | null;
  status: string;
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

/** Format an ETA in seconds as a compact "~28s" / "~3m" string. */
export function fmtEta(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 90) return `~${Math.max(1, Math.round(sec))}s`;
  return `~${Math.round(sec / 60)}m`;
}

/** The lead active job (most recent), or null. */
export function leadActive(): ActivityJob | null {
  return get(activity).active[0] ?? null;
}
