<script lang="ts">
	// ImportField — ONE uploader for every surface (onboarding, Library import,
	// drop zone, chat). Drag-drop + file picker + optional folder picker, routed
	// to the right backend endpoint by what you give it:
	//   • a folder (webkitdirectory)        → POST /portal/import/obsidian (notes + media)
	//   • an archive (.zip/.json)            → chunked POST /portal/upload  (Claude/ChatGPT/vault)
	//   • a loose file (.md/.txt/.pdf/…/img) → POST /portal/upload/file     (→ document or attachment)
	// The backend spine (src/ingest/run-import.js) decides document-vs-attachment;
	// this component just classifies transport and reports an honest result.
	import { importFiles, importFolder, type ImportResult } from '$lib/import/upload-handlers';

	let {
		accept = '*',
		multiple = true,
		folder = true,
		label = 'Drop files here, or choose',
		onResult = (_r: ImportResult) => {},
		onError = (_e: string) => {},
	}: {
		accept?: string;
		multiple?: boolean;
		folder?: boolean;
		label?: string;
		onResult?: (r: ImportResult) => void;
		onError?: (e: string) => void;
	} = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);
	let status = $state('');
	let error = $state('');
	let dragOver = $state(false);

	// Both handlers delegate to the shared upload logic ($lib/import/upload-handlers)
	// so this component is pure UI; ImportDropZone (and later ImportView/ChatFloat)
	// reuse the exact same routing.
	async function handleFiles(list: File[]) {
		if (!list.length) return;
		busy = true; error = ''; status = '';
		const r = await importFiles(list, { onStatus: (s) => { status = s; } });
		busy = false; status = '';
		if (r.error && !r.imported) { error = r.error; onError(r.error); } else onResult(r);
	}

	async function handleFolder(list: File[]) {
		if (!list.length) return;
		busy = true; error = ''; status = '';
		const r = await importFolder(list, { onStatus: (s) => { status = s; } });
		busy = false; status = '';
		if (r.error) { error = r.error; onError(r.error); } else onResult(r);
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
