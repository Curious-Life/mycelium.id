<script lang="ts">
	// Global vault-import drop zone (web + desktop). Mounted once in the app layout
	// so a file dropped ANYWHERE over the window is added to the vault:
	//   • .zip / .json  → the conversation-import pipeline (chunked-upload → /upload)
	//   • everything else (images, docs, …) → /upload/file (encrypted attachment +
	//     a linked message that enters the embed → mindscape pipeline; images get a
	//     best-effort local-vision caption server-side).
	// Tauri disables its native OS drop handler (main.rs → .disable_drag_drop_handler)
	// so these HTML5 drop events fire identically in the desktop shell.
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { toasts } from '$lib/stores/toast';
	import { importFiles } from '$lib/import/upload-handlers';

	let dragging = $state(false);
	let busy = $state(false);
	let counter = 0; // depth counter so nested dragenter/leave don't flicker the overlay

	// Routing (archive→/upload, loose→/upload/file→document-or-attachment) lives in
	// the shared upload handler — the same logic <ImportField> and the Library
	// importer use, so a dropped .md becomes a Library document, not an attachment.
	async function handleFiles(files: File[]) {
		if (!files.length || busy) return;
		busy = true;
		const pending = toasts.info(`Adding ${files.length} item${files.length > 1 ? 's' : ''} to your vault…`, 120000);
		const r = await importFiles(files);
		toasts.remove(pending);
		busy = false;
		if (r.imported > 0) toasts.success(r.detail);
		else if (r.error) toasts.error(r.error);
		else if (r.failed > 0) toasts.error(`Couldn't add ${r.failed} item${r.failed > 1 ? 's' : ''}`);
	}

	onMount(() => {
		if (!browser) return;
		const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

		const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); counter++; dragging = true; };
		const onOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
		const onLeave = (e: DragEvent) => { if (!dragging) return; e.preventDefault(); counter--; if (counter <= 0) { counter = 0; dragging = false; } };
		const onDrop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault(); counter = 0; dragging = false;
			const files = Array.from(e.dataTransfer?.files || []);
			if (files.length) handleFiles(files);
		};

		window.addEventListener('dragenter', onEnter);
		window.addEventListener('dragover', onOver);
		window.addEventListener('dragleave', onLeave);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragenter', onEnter);
			window.removeEventListener('dragover', onOver);
			window.removeEventListener('dragleave', onLeave);
			window.removeEventListener('drop', onDrop);
		};
	});
</script>

{#if dragging}
	<!-- pointer-events:none so the drop reaches the window handler. NOT aria-hidden: this overlay
	     carries the drop path's ONLY cost disclosure (§3.9/R2), so hiding it from assistive tech
	     made the one surface that says "this costs hours" invisible to exactly the users who can't
	     glance at it (independent review LOW, 2026-07-17). role="status" announces it politely. -->
	<div class="drop-overlay" role="status">
		<div class="drop-card">
			<svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 16V4" />
				<path d="m7 9 5-5 5 5" />
				<path d="M5 20h14" />
			</svg>
			<p class="drop-title">Drop to add to your vault</p>
			<p class="drop-sub">Images, documents, or a Claude / ChatGPT export (.zip)</p>
			<!--
				§3.9/R2 — THIS PATH COMMITS TOO, AND IT USED TO SAY NOTHING. This zone is mounted once in
				the app layout and takes a file dropped ANYWHERE over the window, straight into the same
				pipeline ImportView drives (upload-handlers → /upload). So a 76k-message export dropped on
				the Library page started hours of on-device work having never rendered ImportView's
				expectation copy — R2's promise ("the cost is stated before the user commits") was false on
				this path, and the gate could not see it because it only mounts ImportView (independent
				review HIGH-3, 2026-07-17).
				This overlay renders WHILE DRAGGING — before the drop — so it is this path's last moment to
				decline. Short, because a drag is not the moment for a paragraph; the full statement is on
				the Import screen. No rate is quoted here for the same reason it is not quoted there: the
				measured rate varies 18x with message length.
			-->
			<p class="drop-sub">A large export is hours of work on your Mac — you can pause it any time.</p>
		</div>
	</div>
{/if}

<style>
	.drop-overlay {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		background: rgba(10, 10, 12, 0.72);
		pointer-events: none;
		animation: dz-fade 0.12s ease-out;
	}
	.drop-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 2.5rem 3rem;
		border: 2px dashed var(--color-accent);
		border-radius: var(--radius-lg, 16px);
		background: rgba(20, 20, 23, 0.96);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
		text-align: center;
		max-width: 28rem;
	}
	.drop-icon { width: 40px; height: 40px; color: var(--color-accent); margin-bottom: 0.25rem; }
	.drop-title { font-size: 1.05rem; font-weight: 600; color: var(--color-text-emphasis); }
	.drop-sub { font-size: 0.82rem; color: var(--color-text-tertiary); }
	@keyframes dz-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
