<script lang="ts">
	// ImportField — ONE uploader for every surface (onboarding, Library import,
	// drop zone, chat). Drag-drop + file picker + optional folder picker, routed
	// to the right backend endpoint by what you give it:
	//   • a folder (webkitdirectory)        → POST /portal/import/obsidian (notes + media)
	//   • an archive (.zip/.json)            → chunked POST /portal/upload  (Claude/ChatGPT/vault)
	//   • a loose file (.md/.txt/.pdf/…/img) → POST /portal/upload/file     (→ document or attachment)
	// The backend spine (src/ingest/run-import.js) decides document-vs-attachment;
	// this component just classifies transport and reports an honest result.
	import { api } from '$lib/api';
	import { uploadFile as chunkedUpload } from '$lib/chunked-upload';

	let {
		accept = '*',
		multiple = true,
		folder = true,
		label = 'Drop files here, or choose',
		onResult = (_r: ImportFieldResult) => {},
		onError = (_e: string) => {},
	}: {
		accept?: string;
		multiple?: boolean;
		folder?: boolean;
		label?: string;
		onResult?: (r: ImportFieldResult) => void;
		onError?: (e: string) => void;
	} = $props();

	type ImportFieldResult = { kind: 'archive' | 'files' | 'folder'; imported: number; skipped: number; failed: number; detail: string };

	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);
	let status = $state('');
	let error = $state('');
	let dragOver = $state(false);

	const ARCHIVE_RE = /\.(zip|json)$/i;
	const num = (n: unknown) => (typeof n === 'number' ? n : Number(n) || 0);

	function reset() { error = ''; status = ''; }

	async function handleFiles(list: File[]) {
		if (!list.length) return;
		busy = true; reset();
		let imported = 0, skipped = 0, failed = 0;
		try {
			for (let i = 0; i < list.length; i++) {
				const file = list[i];
				status = list.length > 1 ? `Importing ${i + 1}/${list.length}: ${file.name}…` : `Importing ${file.name}…`;
				try {
					if (ARCHIVE_RE.test(file.name)) {
						// Conversation export / vault zip → chunked archive route.
						const res = await chunkedUpload(file, (p) => { status = `Uploading ${file.name}… ${p.percent}%`; });
						const d = await res.json().catch(() => ({}));
						if (!res.ok) { failed++; error = d.error || `Could not import ${file.name}.`; continue; }
						imported += num(d.importResult?.imported ?? d.stats?.messages ?? d.messages);
						skipped += num(d.importResult?.skipped ?? d.stats?.skipped_duplicates);
						failed += num(d.importResult?.failed ?? d.stats?.failed);
					} else {
						// Loose file → the spine turns md/txt/pdf/docx into a document,
						// images/binaries into attachments. lastModified preserves the date.
						const fd = new FormData();
						fd.append('file', file);
						fd.append('lastModified', new Date(file.lastModified).toISOString());
						const res = await api('/portal/upload/file', { method: 'POST', body: fd });
						const d = await res.json().catch(() => ({}));
						if (!res.ok) { failed++; error = d.error || `Could not import ${file.name}.`; continue; }
						imported += 1;
					}
				} catch { failed++; }
			}
			const detail = `${imported.toLocaleString()} imported${skipped ? `, ${skipped} duplicates` : ''}${failed ? `, ${failed} failed` : ''}`;
			onResult({ kind: list.some((f) => ARCHIVE_RE.test(f.name)) ? 'archive' : 'files', imported, skipped, failed, detail });
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Import failed.';
			error = msg; onError(msg);
		} finally {
			busy = false; status = '';
		}
	}

	// Folder (webkitdirectory): collect .md notes + media → /portal/import/obsidian.
	// Mirrors the proven Library importer (vault-relative relPaths + base64 media).
	const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|pdf|mp3|m4a|wav|ogg|flac|mp4|mov|webm)$/i;
	const MAX_ASSET = 25 * 1024 * 1024;
	const MAX_TOTAL_ASSETS = 150 * 1024 * 1024;
	const toBase64 = async (f: File) => {
		const buf = new Uint8Array(await f.arrayBuffer());
		let s = ''; const CHUNK = 0x8000;
		for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
		return btoa(s);
	};

	async function handleFolder(list: File[]) {
		busy = true; reset(); status = 'Reading folder…';
		try {
			const mdFiles = list.filter((f) => /\.md$/i.test(f.name));
			if (!mdFiles.length) { error = 'No .md notes found in that folder.'; onError(error); return; }
			const vaultName = (((mdFiles[0] as any).webkitRelativePath as string) || '').split('/')[0] || undefined;
			const prefix = vaultName ? `${vaultName}/` : '';
			const relOf = (f: File) => {
				const rel = ((f as any).webkitRelativePath as string) || f.name;
				return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
			};
			const files: { relPath: string; content?: string; contentBase64?: string; mtime?: string }[] =
				await Promise.all(mdFiles.map(async (f) => ({ relPath: relOf(f), content: await f.text(), mtime: new Date(f.lastModified).toISOString() })));
			status = 'Reading folder media…';
			let assetTotal = 0;
			for (const f of list) {
				if (!ASSET_RE.test(f.name)) continue;
				if (f.size === 0 || f.size > MAX_ASSET || assetTotal + f.size > MAX_TOTAL_ASSETS) continue;
				assetTotal += f.size;
				files.push({ relPath: relOf(f), contentBase64: await toBase64(f), mtime: new Date(f.lastModified).toISOString() });
			}
			status = 'Importing notes…';
			const res = await api('/portal/import/obsidian', { method: 'POST', body: JSON.stringify({ files, vaultName }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) { error = d.error || `Import failed (${res.status}).`; onError(error); return; }
			const imported = num(d.documentsUpserted);
			const detail = `${imported.toLocaleString()} notes${d.failed ? `, ${num(d.failed)} failed` : ''}${d.assets?.imported ? `, ${num(d.assets.imported)} media` : ''}`;
			onResult({ kind: 'folder', imported, skipped: num(d.skipped), failed: num(d.failed), detail });
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Could not read the folder.';
			error = msg; onError(msg);
		} finally {
			busy = false; status = '';
		}
	}

	function onFilePicked(e: Event) {
		const list = Array.from((e.target as HTMLInputElement).files || []);
		if (list.length) handleFiles(list);
	}
	function onFolderPicked(e: Event) {
		const list = Array.from((e.target as HTMLInputElement).files || []);
		if (list.length) handleFolder(list);
	}
	function onDrop(e: DragEvent) {
		e.preventDefault(); dragOver = false;
		const list = Array.from(e.dataTransfer?.files || []);
		if (list.length) handleFiles(list);
	}
</script>

<div
	class="import-field"
	class:drag={dragOver}
	class:busy
	role="button"
	tabindex="0"
	ondragover={(e) => { e.preventDefault(); dragOver = true; }}
	ondragleave={(e) => { e.preventDefault(); dragOver = false; }}
	ondrop={onDrop}
	onclick={() => !busy && fileInput?.click()}
	onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) fileInput?.click(); }}
>
	<input bind:this={fileInput} type="file" {accept} {multiple} class="sr-only" onchange={onFilePicked} disabled={busy} />
	{#if folder}
		<input bind:this={folderInput} type="file" webkitdirectory multiple class="sr-only" onchange={onFolderPicked} disabled={busy} />
	{/if}

	<span class="if-label">{busy ? (status || 'Importing…') : label}</span>
	{#if folder && !busy}
		<button type="button" class="if-folder" onclick={(e) => { e.stopPropagation(); folderInput?.click(); }}>or choose a folder of notes</button>
	{/if}
	{#if error}<p class="if-err">{error}</p>{/if}
</div>

<style>
	.import-field {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 1.1rem 1rem; border: 1px dashed var(--glass-input-border, rgba(255,255,255,0.18));
		border-radius: 10px; cursor: pointer; text-align: center;
		color: var(--color-text-secondary); font-size: 0.8rem;
		transition: border-color 0.15s ease, background 0.15s ease;
	}
	.import-field:hover, .import-field.drag { border-color: rgba(229, 184, 76, 0.5); background: var(--glass-card-hover, rgba(255,255,255,0.03)); }
	.import-field.busy { cursor: default; opacity: 0.85; }
	.if-label { color: var(--color-text-secondary); }
	.if-folder { background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; font-size: 0.72rem; color: var(--color-accent-aurum, #e5b84c); }
	.if-folder:hover { text-decoration: underline; }
	.if-err { font-size: 0.74rem; color: #f87171; margin: 0.2rem 0 0; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
</style>
