<script lang="ts">
	// Wizard Step 4 — Bring your world in (U1.5). Scan-first hero (ScanForData —
	// already TCC-aware: it distinguishes "macOS is blocking access / re-scan" from
	// "genuinely empty", the ON-5 fix) with the explicit sources + a folder-aware
	// drop zone ALWAYS visible below it, so the step is never a dead-end.
	//
	// Copy (operator, QA4 R4): heading "Bring your world in" / lede "Import your
	// data. It's stored encrypted on your device."
	import { api } from '$lib/api';
	import { filesFromDataTransfer } from '$lib/import/upload-handlers';
	import { signalImportCompleted } from '$lib/stores/onboarding-data.svelte';
	import ScanForData from '$lib/components/import/ScanForData.svelte';

	let { onNext, onOpenImport }: { onNext: () => void; onOpenImport: (source?: string) => void } = $props();

	let folderInput = $state<HTMLInputElement>();
	let dragOver = $state(false);
	let importing = $state(false);
	let statusMsg = $state('');
	let importMsg = $state('');
	let importErr = $state('');

	// Folder-aware drop: a dropped FOLDER walks into notes + media (importFolder);
	// dropped loose notes import too. Everything else routes to the full Import view.
	async function onDrop(e: DragEvent) {
		e.preventDefault(); dragOver = false;
		const { files: walked, hadDirectory } = await filesFromDataTransfer(e.dataTransfer);
		if (hadDirectory) { if (walked.length) await importFolderFiles(walked); return; }
		// A loose export file (zip/json) needs source-specific handling — hand off to Import.
		if (e.dataTransfer?.files?.length) onOpenImport();
	}
	function onDragOver(e: DragEvent) { e.preventDefault(); dragOver = true; }
	function onDragLeave(e: DragEvent) { e.preventDefault(); dragOver = false; }

	async function onFolderChosen() {
		const list = folderInput?.files;
		if (list?.length) await importFolderFiles(Array.from(list));
	}

	// Read a folder of notes (.md/.markdown/.txt) + media and POST to the obsidian
	// importer (which builds the folder tree). Any folder works — not Obsidian-specific.
	async function importFolderFiles(list: File[]) {
		if (!list.length || importing) return;
		importing = true; importErr = ''; importMsg = ''; statusMsg = 'Reading folder…';
		try {
			const notes = list.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
			if (!notes.length) { importErr = 'No notes (.md, .markdown, .txt) found in that folder.'; return; }
			const vaultName = (((notes[0] as any).webkitRelativePath as string) || '').split('/')[0] || undefined;
			const prefix = vaultName ? `${vaultName}/` : '';
			const relOf = (f: File) => {
				const rel = ((f as any).webkitRelativePath as string) || f.name;
				return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
			};
			const files = await Promise.all(notes.map(async (f) => ({
				relPath: relOf(f), content: await f.text(), mtime: new Date(f.lastModified).toISOString(),
			})));
			statusMsg = 'Importing notes…';
			const res = await api('/portal/import/obsidian', { method: 'POST', body: JSON.stringify({ files, vaultName }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) { importErr = d.error || 'Could not import that folder.'; return; }
			const n = d.documentsUpserted ?? 0;
			importMsg = `Imported ${n} note${n === 1 ? '' : 's'} — encrypted on your device.`;
			if (n > 0) signalImportCompleted();
		} catch (e) {
			importErr = e instanceof Error ? e.message : 'Could not read the folder.';
		} finally { importing = false; statusMsg = ''; }
	}

	// Explicit sources — zip/json exports route to the full Import view (never a dead-end).
	const SOURCES: { id: string; name: string }[] = [
		{ id: 'claude', name: 'Claude' },
		{ id: 'chatgpt', name: 'ChatGPT' },
		{ id: 'obsidian', name: 'Obsidian' },
		{ id: 'mycelium', name: 'Mycelium vault' },
	];
</script>

<div class="step-body">
	<h1 class="title">Bring your world in</h1>
	<p class="lede">Import your data. It's stored encrypted on your device.</p>

	<!-- Scan-first hero (TCC-aware; never silent-empty). -->
	<div class="scan-hero">
		<ScanForData onImported={() => signalImportCompleted()} />
	</div>

	<!-- Consent line — scanning + import read files; state it plainly before it runs. -->
	<p class="consent">Mycelium reads these files on your device to build your map — nothing leaves your machine.</p>

	<!-- Explicit sources + folder-aware drop — ALWAYS visible (never a dead-end). -->
	<div class="sources">
		{#each SOURCES as s (s.id)}
			<button class="src" onclick={() => onOpenImport(s.id)}>{s.name}</button>
		{/each}
		<button class="src" onclick={() => folderInput?.click()} disabled={importing}>A folder</button>
	</div>
	<input bind:this={folderInput} type="file" webkitdirectory multiple class="hidden-input" onchange={onFolderChosen} />

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="drop" class:over={dragOver} role="button" tabindex="0"
		onclick={() => folderInput?.click()}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); folderInput?.click(); } }}
		ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
		<span>{dragOver ? 'Drop to import' : importing ? (statusMsg || 'Importing…') : 'Drop a folder or notes here, or click to choose a folder'}</span>
	</div>

	{#if importMsg}<p class="ok">{importMsg}</p>{/if}
	{#if importErr}<p class="err">{importErr}</p>{/if}

	<div class="footer">
		<button class="primary" onclick={onNext}>Continue</button>
	</div>
</div>

<style>
	.step-body { display: flex; flex-direction: column; }
	.title { font-family: var(--font-serif, 'Geist', system-ui, sans-serif); font-size: 1.5rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.015em; color: var(--color-text-primary); margin: 0 0 0.5rem; }
	.lede { font-size: 0.9rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0 0 1.2rem; }
	.scan-hero { margin-bottom: 1rem; }
	.consent { font-size: 0.72rem; line-height: 1.45; color: var(--color-text-tertiary); margin: 0 0 1rem; padding-left: 0.7rem; border-left: 2px solid var(--glass-border, rgba(255,255,255,0.12)); }
	.sources { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.7rem; }
	.src { font-size: 0.76rem; padding: 0.35rem 0.85rem; border-radius: 8px; cursor: pointer; font-family: inherit; background: var(--glass-card-bg, rgba(255,255,255,0.03)); border: 1px solid var(--glass-border, rgba(255,255,255,0.12)); color: var(--color-text-primary); }
	.src:hover:not(:disabled) { border-color: rgba(229,184,76,0.5); }
	.src:disabled { opacity: 0.5; cursor: default; }
	.hidden-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
	.drop { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 1.4rem; border-radius: 12px; border: 2px dashed var(--glass-border, rgba(255,255,255,0.16)); color: var(--color-text-secondary); text-align: center; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
	.drop:hover { border-color: rgba(229,184,76,0.5); }
	.drop.over { border-color: var(--color-accent-aurum, #e5b84c); background: rgba(229,184,76,0.08); }
	.drop svg { width: 26px; height: 26px; color: var(--color-text-tertiary); }
	.drop span { font-size: 0.8rem; }
	.ok { font-size: 0.76rem; color: var(--color-accent-jade, #4ade80); margin: 0.6rem 0 0; }
	.err { font-size: 0.76rem; color: var(--color-coral, #e5736b); margin: 0.6rem 0 0; }
	.footer { margin-top: 1.4rem; }
	.primary { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.55rem 1.2rem; border-radius: 9px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-family: inherit; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.2s ease; }
	.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229,184,76,0.25); }
</style>
