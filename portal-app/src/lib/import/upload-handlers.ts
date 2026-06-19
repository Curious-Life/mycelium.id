// Shared import upload handlers — the ONE place the portal classifies and
// uploads files, used by both <ImportField> (UI) and ImportDropZone (headless),
// and ready for ImportView / ChatFloat to adopt (Phase 2c-continued). Mirrors
// the backend spine (src/ingest/run-import.js): archive → /portal/upload
// (chunked), loose file → /portal/upload/file (the spine makes md/txt/pdf into
// documents, images into attachments), folder of notes → /portal/import/obsidian.
import JSZip from 'jszip';
import { api } from '$lib/api';

export type ImportResult = {
	kind: 'archive' | 'files' | 'folder';
	type?: string; // 'claude' | 'chatgpt' | 'mycelium' | 'document' | 'file' | 'image' | 'obsidian'
	imported: number;
	skipped: number;
	failed: number;
	detail: string;
	error?: string;
};

type Opts = { onStatus?: (s: string) => void; onProgress?: (pct: number) => void };

const ARCHIVE_RE = /\.(zip|json)$/i;
const num = (n: unknown) => (typeof n === 'number' ? n : Number(n) || 0);

/**
 * For large conversation ZIPs (>90MB), strip media client-side and re-pack just
 * the data files so the upload stays under the transport (Cloudflare 100MB)
 * limit. Mycelium vault exports and >500MB files are uploaded raw (server
 * extracts / media must be preserved). Throws if a big ZIP has no data files.
 */
export async function prepareFile(file: File, onStatus: (s: string) => void = () => {}): Promise<File> {
	if (file.size < 90_000_000 || !file.name.endsWith('.zip')) return file;
	if (file.size > 500_000_000) {
		onStatus(`Large file (${Math.round(file.size / 1024 / 1024)}MB) — uploading directly, server will extract…`);
		return file;
	}
	onStatus('Large file detected — extracting conversation data…');
	const zip = await JSZip.loadAsync(await file.arrayBuffer());
	// A Mycelium vault export keeps media in attachments/ — never strip it.
	if (zip.file('manifest.json')) {
		onStatus(`Mycelium vault export (${Math.round(file.size / 1024 / 1024)}MB) — uploading with media intact…`);
		return file;
	}
	const dataFiles = Object.keys(zip.files).filter((n) => /\.(json|md|csv)$/.test(n) && !zip.files[n].dir);
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
	const detail = `${imported.toLocaleString()} imported${skipped ? `, ${skipped} duplicates` : ''}${failed ? `, ${failed} failed` : ''}`;
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
	const mdFiles = list.filter((f) => /\.md$/i.test(f.name));
	if (!mdFiles.length) return { kind: 'folder', imported: 0, skipped: 0, failed: 0, detail: '', error: 'No .md notes found in that folder.' };
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
	return { kind: 'folder', type: 'obsidian', imported, skipped: num(d.skipped), failed: num(d.failed), detail };
}
