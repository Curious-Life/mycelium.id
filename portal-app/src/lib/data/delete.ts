// portal-app/src/lib/data/delete.ts — client side of Settings → Data bulk delete
// (backend src/portal-data.js). A bulk delete can be tens of thousands of rows +
// blobs, so it runs as an async BACKGROUND job with live progress, exactly like
// the local-files import sweep (detect.ts). Type-to-confirm: the delete call must
// echo the target key as `confirm` — the server rejects a mismatch (fail-closed).
import { apiGet, apiPost } from '$lib/api';

export interface DataSourceRow {
	source: string;   // family key, e.g. 'import-obsidian'
	label: string;    // human label, e.g. 'Obsidian'
	messages: number;
	documents: number;
	deletable: boolean;
}
export interface DataSummary {
	sources: DataSourceRow[];
	types: { documents: number; media: number; chat: number };
	attachments: number;
}

export type DeleteStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';
export interface DeleteProgress {
	status: DeleteStatus;
	mode?: 'source' | 'type';
	key?: string;
	total: number;
	processed: number;
	deleted: number;
	attachments: number;
	blobs: number;
	indexed: number;
	mindscapeStale?: boolean;
	cancelled?: boolean;
	error?: string;
}
const emptyProgress: DeleteProgress = { status: 'idle', total: 0, processed: 0, deleted: 0, attachments: 0, blobs: 0, indexed: 0 };
const asProgress = (d: Partial<DeleteProgress> | null | undefined): DeleteProgress => ({ ...emptyProgress, ...(d ?? {}) });

/** Per-source + per-type counts for the Data pane cards. */
export async function dataSummary(): Promise<DataSummary> {
	const d = await apiGet<{ ok: boolean } & Partial<DataSummary>>('/portal/data/summary');
	return { sources: d.sources ?? [], types: d.types ?? { documents: 0, media: 0, chat: 0 }, attachments: d.attachments ?? 0 };
}

/**
 * Start (or re-attach to) a bulk delete. `confirm` MUST equal `key` — the server
 * refuses (400) otherwise. Returns the initial progress.
 */
export async function startDelete(mode: 'source' | 'type', key: string, confirm: string): Promise<DeleteProgress> {
	const d = await apiPost<Partial<DeleteProgress>>('/portal/data/delete', { mode, key, confirm });
	return asProgress(d);
}
/** Poll the running/last delete's progress. */
export async function pollDelete(): Promise<DeleteProgress> {
	const d = await apiGet<Partial<DeleteProgress>>('/portal/data/delete/progress');
	return asProgress(d);
}
/** Ask the running delete to stop (cooperative — already-deleted rows stay). */
export async function cancelDelete(): Promise<DeleteProgress> {
	const d = await apiPost<Partial<DeleteProgress>>('/portal/data/delete/cancel', {});
	return asProgress(d);
}
