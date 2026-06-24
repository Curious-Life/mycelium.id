// Batched document-preview fetcher for Library grid thumbnails.
//
// Each grid card used to GET /portal/documents/<path> for its FULL content just
// to render a preview — an N+1 storm of full-content decrypts as you scroll.
// Instead, cards call getDocPreview(path); requests within one frame are
// coalesced into a single POST /portal/documents/previews { paths } that returns
// a short content snippet per path (server decrypts only the content column).
// Results are cached per path so a remount (folder drill, grid↔list) is free.
import { api } from '$lib/api';

const FLUSH_MS = 16;   // coalesce ~one frame of newly-visible cards
const MAX_BATCH = 100; // server caps the batch at 100 paths

const cache = new Map<string, string>();
let pending = new Map<string, ((snippet: string) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Resolve the cached/snippet preview for a document path (never rejects). */
export function getDocPreview(path: string): Promise<string> {
	const hit = cache.get(path);
	if (hit !== undefined) return Promise.resolve(hit);
	return new Promise<string>((resolve) => {
		const arr = pending.get(path) || [];
		arr.push(resolve);
		pending.set(path, arr);
		if (!timer) timer = setTimeout(flush, FLUSH_MS);
	});
}

async function flush(): Promise<void> {
	timer = null;
	const entries = [...pending.entries()];
	const batch = entries.slice(0, MAX_BATCH);
	const overflow = entries.slice(MAX_BATCH);
	pending = new Map(overflow);
	if (overflow.length && !timer) timer = setTimeout(flush, FLUSH_MS);

	const paths = batch.map(([p]) => p);
	let previews: Record<string, string> = {};
	try {
		const r = await api('/portal/documents/previews', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ paths }),
		});
		if (r.ok) previews = (await r.json()).previews || {};
	} catch {
		/* leave previews empty → resolve to '' below */
	}

	for (const [path, resolvers] of batch) {
		const snippet = previews[path] ?? '';
		cache.set(path, snippet);
		for (const resolve of resolvers) resolve(snippet);
	}
}
