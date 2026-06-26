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
	| 'import-local-files';

export interface DetectedCategory {
	key: 'document' | 'image' | 'audio' | 'video';
	label: string;
	count: number;
	dateRange?: [string | null, string | null];
	roots?: string[];
}

export interface DetectedSource {
	source: 'obsidian' | 'claude-code' | 'hermes' | 'openclaw' | 'local-files';
	found: boolean;
	path: string;
	count: number;
	unit: string; // 'notes' | 'sessions' | 'messages' | 'files'
	importable: boolean;
	action: DetectedAction;
	dateRange?: [string | null, string | null]; // [earliest, latest] YYYY-MM-DD
	vaults?: { path: string; name: string; count: number }[]; // obsidian
	persona?: boolean; // hermes: a SOUL.md persona was found
	notes?: number; // openclaw: workspace memory-doc count
	categories?: DetectedCategory[]; // local-files: per-category counts
}

// Sources that import an agent's conversation history → support the
// clean (conversation only) / full (every tool call too) mode toggle.
export const AGENT_MODE_SOURCES = new Set(['claude-code', 'hermes', 'openclaw']);

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

	if (s.action === 'import-local-files') {
		const d = await apiPost<{
			scanned?: number; failed?: number;
			documents?: { created?: number; deduped?: number };
			attachments?: { imported?: number; deduped?: number };
		}>('/portal/import/local-files', opts.categories?.length ? { categories: opts.categories } : {});
		const docs = d.documents?.created ?? 0;
		const files = d.attachments?.imported ?? 0;
		const skipped = (d.documents?.deduped ?? 0) + (d.attachments?.deduped ?? 0);
		return { imported: docs + files, skipped, failed: d.failed ?? 0,
			detail: `${plural(docs, 'document')} · ${plural(files, 'file')}` };
	}

	// import-folder → Obsidian (ObsidianSummary shape)
	const d = await apiPost<{ documentsUpserted?: number; skipped?: number }>(
		'/portal/import/obsidian', { folderPath: s.path });
	const docs = d.documentsUpserted ?? 0;
	return { imported: docs, skipped: d.skipped ?? 0, failed: 0, detail: `${plural(docs, 'note')}` };
}
