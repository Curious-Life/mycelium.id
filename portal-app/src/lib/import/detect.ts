// portal-app/src/lib/import/detect.ts — client side of the local auto-detect +
// one-click import flow (backend shipped in #324). The local backend scans an
// allowlist of known data-source folders (Obsidian vaults, Claude Code session
// transcripts) and returns presence + counts + dates ONLY — never content.
// Import then reads the files off disk server-side (loopback posture); the
// browser never uploads them and never sends a client-chosen path.
import { apiGet, apiPost } from '$lib/api';

export type DetectedAction = 'import-folder' | 'import-claude-code';

export interface DetectedSource {
	source: 'obsidian' | 'claude-code';
	found: boolean;
	path: string;
	count: number;
	unit: string; // 'notes' | 'sessions'
	importable: boolean;
	action: DetectedAction;
	dateRange?: [string | null, string | null]; // claude-code: [earliest, latest] YYYY-MM-DD
	vaults?: { path: string; name: string; count: number }[]; // obsidian
}

export interface DetectImportResult {
	imported: number;
	skipped: number;
	failed: number;
	detail: string;
}

/** Scan this Mac for importable local sources. Returns [] on no findings. */
export async function scanSources(): Promise<DetectedSource[]> {
	const d = await apiGet<{ ok: boolean; sources?: DetectedSource[] }>('/portal/import/detect');
	return d.sources ?? [];
}

/**
 * Import a detected source. Uses the server-side `path` from detect (never a
 * client-supplied path). `mode` applies to Claude Code only (clean = human↔agent
 * conversation; full = every turn incl. tool calls); ignored for Obsidian.
 * Normalises the two backend response shapes into one DetectImportResult.
 */
export async function importDetected(
	s: DetectedSource,
	opts: { mode?: 'clean' | 'full' } = {},
): Promise<DetectImportResult> {
	if (s.action === 'import-claude-code') {
		const d = await apiPost<{
			imported: number; skipped: number; failed: number;
			stats?: { sessions?: number };
		}>('/portal/import/claude-code', { folderPath: s.path, mode: opts.mode ?? 'clean' });
		const sessions = d.stats?.sessions ?? 0;
		return {
			imported: d.imported ?? 0,
			skipped: d.skipped ?? 0,
			failed: d.failed ?? 0,
			detail: `${d.imported ?? 0} message${(d.imported ?? 0) === 1 ? '' : 's'}${sessions ? ` from ${sessions} session${sessions === 1 ? '' : 's'}` : ''}`,
		};
	}
	// import-folder → Obsidian (ObsidianSummary shape)
	const d = await apiPost<{
		documentsUpserted?: number; skipped?: number;
		memoriesCreated?: number; memoriesUpdated?: number;
	}>('/portal/import/obsidian', { folderPath: s.path });
	const docs = d.documentsUpserted ?? 0;
	return {
		imported: docs,
		skipped: d.skipped ?? 0,
		failed: 0,
		detail: `${docs} note${docs === 1 ? '' : 's'}`,
	};
}
