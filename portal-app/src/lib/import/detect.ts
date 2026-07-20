// portal-app/src/lib/import/detect.ts — client side of the local auto-detect +
// one-click import flow (backend shipped in #324). The local backend scans an
// allowlist of known data-source folders (Obsidian vaults, Claude Code session
// transcripts) and returns presence + counts + dates ONLY — never content.
// Import then reads the files off disk server-side (loopback posture); the
// browser never uploads them and never sends a client-chosen path.
import { apiGet, apiPost } from '$lib/api';

export type DetectedAction =
	| 'import-folder'
	| 'import-claude-code'
	| 'import-hermes'
	| 'import-openclaw'
	| 'import-local-files'
	| 'import-recent-export';

export interface DetectedCategory {
	key: 'document' | 'image' | 'audio' | 'video';
	label: string;
	count: number;
	dateRange?: [string | null, string | null];
	roots?: string[];
}

export interface DetectedSource {
	source: 'obsidian' | 'claude-code' | 'hermes' | 'openclaw' | 'local-files' | 'recent-export';
	found: boolean;
	path: string;
	count: number;
	unit: string; // 'notes' | 'sessions' | 'messages' | 'files' | 'items'
	importable: boolean;
	action: DetectedAction;
	dateRange?: [string | null, string | null]; // [earliest, latest] YYYY-MM-DD
	vaults?: { path: string; name: string; count: number }[]; // obsidian
	persona?: boolean; // hermes: a SOUL.md persona was found
	notes?: string | number; // openclaw: workspace memory-doc count | recent-export: window note
	categories?: DetectedCategory[]; // local-files: per-category counts
}

// Sources that run through the unified async job (POST /portal/import/run) with
// live progress + cancel, rather than a one-shot blocking POST. Driven client-
// side by startImportRun / pollImportRun / cancelImportRun below.
export const ASYNC_RUN_SOURCES = new Set(['recent-export']);

// Sources that import an agent's conversation history → support the
// clean (conversation only) / full (every tool call too) mode toggle.
export const AGENT_MODE_SOURCES = new Set(['claude-code', 'hermes', 'openclaw']);

export interface DetectImportResult {
	imported: number;
	skipped: number;
	failed: number;
	detail: string;
}

export interface ScanResult {
	sources: DetectedSource[];
	/** Broad-sweep root basenames macOS is blocking (TCC prompt pending / denied).
	 *  Non-empty + no sources ⇒ "grant access & re-scan", not "nothing here" (ON-5). */
	blocked: string[];
}

/** Scan this Mac for importable local sources + which roots macOS is blocking. */
export async function scanSources(): Promise<ScanResult> {
	const d = await apiGet<{ ok: boolean; sources?: DetectedSource[]; blocked?: string[] }>('/portal/import/detect');
	return { sources: d.sources ?? [], blocked: d.blocked ?? [] };
}

/**
 * Import a detected source. Uses the server-side `path` from detect (never a
 * client-supplied path). `mode` applies to Claude Code only (clean = human↔agent
 * conversation; full = every turn incl. tool calls); ignored for Obsidian.
 * Normalises the two backend response shapes into one DetectImportResult.
 */
export async function importDetected(
	s: DetectedSource,
	opts: { mode?: 'clean' | 'full'; categories?: string[] } = {},
): Promise<DetectImportResult> {
	const mode = opts.mode ?? 'clean';
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

	if (s.action === 'import-claude-code') {
		const d = await apiPost<{ imported: number; skipped: number; failed: number; stats?: { sessions?: number } }>(
			'/portal/import/claude-code', { folderPath: s.path, mode });
		const sessions = d.stats?.sessions ?? 0;
		return { imported: d.imported ?? 0, skipped: d.skipped ?? 0, failed: d.failed ?? 0,
			detail: `${plural(d.imported ?? 0, 'message')}${sessions ? ` from ${plural(sessions, 'session')}` : ''}` };
	}

	if (s.action === 'import-hermes') {
		const d = await apiPost<{ imported: number; skipped: number; failed: number; sessions?: number; persona?: number }>(
			'/portal/import/hermes', { mode });
		const sessions = d.sessions ?? 0;
		const persona = d.persona ? ' · persona' : '';
		return { imported: d.imported ?? 0, skipped: d.skipped ?? 0, failed: d.failed ?? 0,
			detail: `${plural(d.imported ?? 0, 'message')}${sessions ? ` from ${plural(sessions, 'session')}` : ''}${persona}` };
	}

	if (s.action === 'import-openclaw') {
		const d = await apiPost<{ imported: number; skipped: number; failed: number; sessions?: number; docs?: { imported?: number } }>(
			'/portal/import/openclaw', { mode });
		const sessions = d.sessions ?? 0;
		const docs = d.docs?.imported ?? 0;
		return { imported: d.imported ?? 0, skipped: d.skipped ?? 0, failed: d.failed ?? 0,
			detail: `${plural(d.imported ?? 0, 'message')}${sessions ? ` from ${plural(sessions, 'session')}` : ''}${docs ? ` · ${plural(docs, 'memory doc')}` : ''}` };
	}

	// NOTE: 'import-local-files' is NOT handled here — the sweep can be 10k+ files
	// (minutes of work), so it runs as an async BACKGROUND job with live progress.
	// ScanForData drives it via startLocalSweep / pollLocalSweep / cancelLocalSweep
	// below, not this one-shot await.

	// import-folder → Obsidian (ObsidianSummary shape)
	const d = await apiPost<{ documentsUpserted?: number; skipped?: number }>(
		'/portal/import/obsidian', { folderPath: s.path });
	const docs = d.documentsUpserted ?? 0;
	return { imported: docs, skipped: d.skipped ?? 0, failed: 0, detail: `${plural(docs, 'note')}` };
}

// ── Broad local-files sweep — async background job (progress-polled) ───────────
export type SweepStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';
export interface SweepProgress {
	status: SweepStatus;
	total: number;      // files discovered so far (grows as roots are walked)
	processed: number;  // files looked at
	imported: number;   // documents + attachments actually brought in
	deduped: number;    // already-in-vault, skipped
	skipped: number;    // oversize / unreadable / unsafe
	failed: number;
	truncated?: boolean;
	error?: string;
}
const emptySweep: SweepProgress = { status: 'idle', total: 0, processed: 0, imported: 0, deduped: 0, skipped: 0, failed: 0 };
const asSweep = (d: Partial<SweepProgress> | null | undefined): SweepProgress => ({ ...emptySweep, ...(d ?? {}) });

/** Start (or re-attach to) the background sweep. Returns the initial progress. */
export async function startLocalSweep(categories?: string[]): Promise<SweepProgress> {
	const d = await apiPost<Partial<SweepProgress>>('/portal/import/local-files', categories?.length ? { categories } : {});
	return asSweep(d);
}
/** Poll the running/last sweep's progress. */
export async function pollLocalSweep(): Promise<SweepProgress> {
	const res = await apiGet<Partial<SweepProgress>>('/portal/import/local-files/progress');
	return asSweep(res);
}
/** Ask the running sweep to stop (cooperative — already-imported files stay). */
export async function cancelLocalSweep(): Promise<SweepProgress> {
	const d = await apiPost<Partial<SweepProgress>>('/portal/import/local-files/cancel', {});
	return asSweep(d);
}

// ── Unified async import run (POST /portal/import/run) — registry-driven ────────
// The generic background-job surface every registry source with a `run` uses
// (recent-export today; more as the capture importers migrate). Same shape as the
// local sweep so the UI progress loop is identical.
/** Start (or re-attach to) a registry import job. `opts` carries e.g. { dirPath }. */
export async function startImportRun(key: string, opts: Record<string, unknown> = {}): Promise<SweepProgress> {
	const d = await apiPost<Partial<SweepProgress>>('/portal/import/run', { key, ...opts });
	return asSweep(d);
}
/** Poll the running/last import job's progress. */
export async function pollImportRun(): Promise<SweepProgress> {
	const res = await apiGet<Partial<SweepProgress>>('/portal/import/run/progress');
	return asSweep(res);
}
/** Ask the running import job to stop (cooperative). */
export async function cancelImportRun(): Promise<SweepProgress> {
	const d = await apiPost<Partial<SweepProgress>>('/portal/import/run/cancel', {});
	return asSweep(d);
}
