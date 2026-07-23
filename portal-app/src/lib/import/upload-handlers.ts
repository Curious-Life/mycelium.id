// Shared import upload handlers — the ONE place the portal classifies and
// uploads files, used by both <ImportField> (UI) and ImportDropZone (headless),
// and ready for ImportView / ChatFloat to adopt (Phase 2c-continued). Mirrors
// the backend spine (src/ingest/run-import.js): archive → /portal/upload
// (chunked), loose file → /portal/upload/file (the spine makes md/txt/pdf into
// documents, images into attachments), folder of notes → /portal/import/obsidian.
import JSZip from 'jszip';
import { api } from '$lib/api';
import { signalImportCompleted } from '$lib/stores/onboarding-data.svelte';

export type ImportResult = {
	kind: 'archive' | 'files' | 'folder';
	type?: string; // 'claude' | 'chatgpt' | 'mycelium' | 'bundle' | 'document' | 'file' | 'image' | 'obsidian'
	imported: number;
	skipped: number;
	failed: number;
	detail: string;
	error?: string;
};

type Opts = { onStatus?: (s: string) => void; onProgress?: (pct: number) => void };

const ARCHIVE_RE = /\.(zip|json)$/i;
// Notes the folder importer treats as documents (Obsidian .md + plain .txt/.markdown).
const NOTE_RE = /\.(md|markdown|txt)$/i;
const num = (n: unknown) => (typeof n === 'number' ? n : Number(n) || 0);

// ── Folder-aware drop support (R2-FOLDERIMPORT) ──────────────────────────────
// A dropped desktop folder arrives as directory ENTRIES on `dataTransfer.items`,
// NOT as files on `dataTransfer.files` — so the plain `.files` path silently
// dropped the folder ("uploaded but not recognized as an export"). We expand the
// directory here (webkitGetAsEntry → createReader walk) into a flat File[] with a
// synthesized `webkitRelativePath`, so `importFolder()` (the Obsidian path that
// builds the folder tree + folder_id) can consume a drop exactly like the picker.
type FsEntry = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
	createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void };
};

/** Read a directory reader fully — readEntries returns ≤100 entries per call. */
function readAllEntries(reader: { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void }): Promise<FsEntry[]> {
	const all: FsEntry[] = [];
	return new Promise((resolve, reject) => {
		const pump = () => reader.readEntries((batch) => {
			if (!batch.length) { resolve(all); return; }
			all.push(...batch);
			pump();
		}, reject);
		pump();
	});
}

/** Depth-first walk of a dropped entry into `out`, stamping webkitRelativePath. */
async function walkEntry(entry: FsEntry, prefix: string, out: File[]): Promise<void> {
	if (entry.isFile && entry.file) {
		const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
		const relPath = prefix + entry.name;
		// webkitRelativePath is a read-only getter on File.prototype; shadow it with
		// an own property so importFolder()/the server see the vault-relative path.
		try { Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true }); } catch { /* engine froze it — importFolder falls back to name */ }
		out.push(file);
	} else if (entry.isDirectory && entry.createReader) {
		const children = await readAllEntries(entry.createReader());
		for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out);
	}
}

/**
 * Resolve a drop's DataTransfer into a flat File[] + whether a DIRECTORY was
 * dropped. MUST be invoked synchronously from the drop handler (the items list
 * is only valid during the event) — the synchronous prefix reads the entries
 * before the first await, so `await filesFromDataTransfer(e.dataTransfer)` is safe.
 * Falls back to `dataTransfer.files` when the entries API is unavailable.
 */
export async function filesFromDataTransfer(dt: DataTransfer | null): Promise<{ files: File[]; hadDirectory: boolean }> {
	const fallback = Array.from(dt?.files || []);
	const items = dt?.items;
	if (!items || !items.length || typeof (items[0] as unknown as { webkitGetAsEntry?: unknown })?.webkitGetAsEntry !== 'function') {
		return { files: fallback, hadDirectory: false };
	}
	// Grab entries SYNCHRONOUSLY (items go stale after the handler returns).
	const entries: FsEntry[] = [];
	let hadDirectory = false;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it.kind !== 'file') continue;
		const entry = (it as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
		if (!entry) continue;
		entries.push(entry);
		if (entry.isDirectory) hadDirectory = true;
	}
	if (!entries.length) return { files: fallback, hadDirectory: false };
	const out: File[] = [];
	for (const entry of entries) await walkEntry(entry, '', out);
	// If nothing walked (permission quirk), fall back to the plain file list.
	return { files: out.length ? out : fallback, hadDirectory };
}

// Last path segment (handles `/` and `\`), for depth-aware entry-name checks that
// mirror the server's basename detection (src/ingest/archive-entries.js).
const zipBasename = (n: string) => n.split('/').pop()!.split('\\').pop()!;

/**
 * For large conversation ZIPs (>90MB), strip media client-side and re-pack just
 * the data files, so we don't spend minutes uploading media that a CONVERSATION
 * import would discard anyway. (Chunked upload already handles >100MB, so this is
 * a bandwidth/time optimization, not a transport requirement.)
 *
 * Uploaded RAW (media preserved), because the media IS the payload there:
 *   • Mycelium vault exports (a manifest.json at any depth) — media in attachments/;
 *   • >500MB — server extracts;
 *   • a BUNDLE (no conversations.json anywhere) — a plain zip of PDFs/images/docs
 *     (incl. Google Takeout): stripping to json/md/csv would gut the import.
 * Stripping only happens for a genuine conversation export (a conversations.json
 * at any depth), where media is discardable noise. Signature files are matched by
 * BASENAME AT ANY DEPTH so a re-zipped / nested export is handled like the server.
 */
export async function prepareFile(file: File, onStatus: (s: string) => void = () => {}): Promise<File> {
	if (file.size < 90_000_000 || !file.name.endsWith('.zip')) return file;
	if (file.size > 500_000_000) {
		onStatus(`Large file (${Math.round(file.size / 1024 / 1024)}MB) — uploading directly, server will extract…`);
		return file;
	}
	const zip = await JSZip.loadAsync(await file.arrayBuffer());
	const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
	// A Mycelium vault export keeps media in attachments/ — never strip it (basename at any depth).
	if (names.some((n) => zipBasename(n) === 'manifest.json')) {
		onStatus(`Mycelium vault export (${Math.round(file.size / 1024 / 1024)}MB) — uploading with media intact…`);
		return file;
	}
	// Only a real conversation export (conversations.json at any depth) is stripped —
	// its media is noise. A bundle has none, so its media must survive: upload raw.
	if (!names.some((n) => zipBasename(n) === 'conversations.json')) {
		onStatus(`Large file (${Math.round(file.size / 1024 / 1024)}MB) — uploading with files intact…`);
		return file;
	}
	onStatus('Large file detected — extracting conversation data…');
	const dataFiles = names.filter((n) => /\.(json|md|csv)$/.test(n));
	if (dataFiles.length === 0) throw new Error('No importable data found in this ZIP.');
	const newZip = new JSZip();
	for (const name of dataFiles) newZip.file(name, await zip.files[name].async('uint8array'));
	const newBuffer = await newZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
	onStatus(`Extracted ${dataFiles.length} data files (${Math.round(newBuffer.size / 1024 / 1024)}MB)`);
	return new File([newBuffer], file.name, { type: 'application/zip' });
}

/** Import one-or-more loose/archive files; aggregates an honest result. */
export async function importFiles(files: File[], opts: Opts = {}): Promise<ImportResult> {
	const { onStatus = () => {}, onProgress = () => {} } = opts;
	const { uploadFile } = await import('$lib/chunked-upload');
	let imported = 0, skipped = 0, failed = 0;
	// Bundle attachments (images/PDF-as-media) are NOT deduplicated on re-import —
	// a document keys on its path and updates in place, but an attachment gets a
	// fresh blob every run. Say so instead of letting the user assume a re-run is
	// free (server: src/ingest/run-import.js runBundle).
	let attachmentsAdded = 0;
	let type: string | undefined;
	let error: string | undefined;
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		onStatus(files.length > 1 ? `Importing ${i + 1}/${files.length}: ${file.name}…` : `Importing ${file.name}…`);
		try {
			if (ARCHIVE_RE.test(file.name)) {
				const prepared = await prepareFile(file, onStatus);
				const res = await uploadFile(prepared, (p: { percent: number }) => onProgress(p.percent));
				const d = await res.json().catch(() => ({}));
				if (!res.ok) { failed++; error = d.error || `Could not import ${file.name}.`; continue; }
				type = type || d.importResult?.type;
				imported += num(d.importResult?.imported ?? d.stats?.messages ?? d.messages);
				if (d.importResult?.type === 'bundle') attachmentsAdded += num(d.importResult?.stats?.attachments);
				skipped += num(d.importResult?.skipped ?? d.stats?.skipped_duplicates);
				failed += num(d.importResult?.failed ?? d.stats?.failed);
			} else {
				const fd = new FormData();
				fd.append('file', file);
				fd.append('lastModified', new Date(file.lastModified).toISOString());
				const res = await api('/portal/upload/file', { method: 'POST', body: fd });
				const d = await res.json().catch(() => ({}));
				if (!res.ok) { failed++; error = d.error || `Could not import ${file.name}.`; continue; }
				type = type || d.type; // 'document' | 'file' | 'image'
				imported += 1;
			}
		} catch { failed++; }
	}
	const kind: ImportResult['kind'] = files.some((f) => ARCHIVE_RE.test(f.name)) ? 'archive' : 'files';
	const detail = `${imported.toLocaleString()} imported${skipped ? `, ${skipped} duplicates` : ''}${failed ? `, ${failed} failed` : ''}`
		+ (attachmentsAdded ? ` — ${attachmentsAdded.toLocaleString()} image/media file${attachmentsAdded === 1 ? '' : 's'} added as new items (importing this zip again adds another copy)` : '');
	// Data landed → tell the invite panel (and any other readiness consumer) to re-read, so
	// "no data uploaded" can never persist over a full vault after a drop or a Library import.
	// This is the shared chokepoint <ImportField> and <ImportDropZone> both funnel through.
	if (imported > 0) signalImportCompleted();
	return { kind, type, imported, skipped, failed, detail, error };
}

const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|pdf|mp3|m4a|wav|ogg|flac|mp4|mov|webm)$/i;
const MAX_ASSET = 25 * 1024 * 1024;
const MAX_TOTAL_ASSETS = 150 * 1024 * 1024;
const toBase64 = async (f: File) => {
	const buf = new Uint8Array(await f.arrayBuffer());
	let s = ''; const CHUNK = 0x8000;
	for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
	return btoa(s);
};

/** Import a folder of markdown notes (+ media) via the obsidian endpoint. */
export async function importFolder(list: File[], opts: Opts = {}): Promise<ImportResult> {
	const { onStatus = () => {} } = opts;
	onStatus('Reading folder…');
	const mdFiles = list.filter((f) => NOTE_RE.test(f.name));
	if (!mdFiles.length) return { kind: 'folder', imported: 0, skipped: 0, failed: 0, detail: '', error: 'No notes (.md, .markdown, .txt) found in that folder.' };
	const vaultName = (((mdFiles[0] as any).webkitRelativePath as string) || '').split('/')[0] || undefined;
	const prefix = vaultName ? `${vaultName}/` : '';
	const relOf = (f: File) => {
		const rel = ((f as any).webkitRelativePath as string) || f.name;
		return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
	};
	const files: { relPath: string; content?: string; contentBase64?: string; mtime?: string }[] =
		await Promise.all(mdFiles.map(async (f) => ({ relPath: relOf(f), content: await f.text(), mtime: new Date(f.lastModified).toISOString() })));
	onStatus('Reading folder media…');
	let assetTotal = 0;
	for (const f of list) {
		if (!ASSET_RE.test(f.name)) continue;
		if (f.size === 0 || f.size > MAX_ASSET || assetTotal + f.size > MAX_TOTAL_ASSETS) continue;
		assetTotal += f.size;
		files.push({ relPath: relOf(f), contentBase64: await toBase64(f), mtime: new Date(f.lastModified).toISOString() });
	}
	onStatus('Importing notes…');
	const res = await api('/portal/import/obsidian', { method: 'POST', body: JSON.stringify({ files, vaultName }) });
	const d = await res.json().catch(() => ({}));
	if (!res.ok || !d.ok) return { kind: 'folder', imported: 0, skipped: 0, failed: 0, detail: '', error: d.error || `Import failed (${res.status}).` };
	const imported = num(d.documentsUpserted);
	const detail = `${imported.toLocaleString()} notes${d.failed ? `, ${num(d.failed)} failed` : ''}${d.assets?.imported ? `, ${num(d.assets.imported)} media` : ''}`;
	// A folder of notes is data landing too — same signal, so the invite learns about it.
	if (imported > 0) signalImportCompleted();
	return { kind: 'folder', type: 'obsidian', imported, skipped: num(d.skipped), failed: num(d.failed), detail };
}
