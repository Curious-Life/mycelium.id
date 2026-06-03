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
	import { api } from '$lib/api';
	import { toasts } from '$lib/stores/toast';

	let dragging = $state(false);
	let busy = $state(false);
	let counter = 0; // depth counter so nested dragenter/leave don't flicker the overlay

	const ARCHIVE_RE = /\.(zip|json)$/i;

	async function uploadAttachment(file: File): Promise<{ captioned?: boolean }> {
		const form = new FormData();
		form.append('file', file);
		// api() rewrites /portal/* → /api/v1/portal/* and leaves FormData alone
		// (no JSON content-type) so the browser sets the multipart boundary.
		const res = await api('/portal/upload/file', { method: 'POST', body: form });
		if (!res.ok) {
			let msg = `Couldn't add ${file.name}`;
			try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
			throw new Error(msg);
		}
		return res.json();
	}

	async function handleFiles(files: File[]) {
		if (!files.length || busy) return;
		busy = true;
		const pending = toasts.info(`Adding ${files.length} item${files.length > 1 ? 's' : ''} to your vault…`, 120000);
		let added = 0, failed = 0, importedMsgs = 0;
		for (const file of files) {
			try {
				if (ARCHIVE_RE.test(file.name)) {
					const { uploadFile } = await import('$lib/chunked-upload');
					const r: any = await uploadFile(file);
					if (r?.importResult?.imported != null) importedMsgs += r.importResult.imported;
				} else {
					await uploadAttachment(file);
				}
				added++;
			} catch (e: any) {
				failed++;
				toasts.error(e?.message || `Couldn't add ${file.name}`);
			}
		}
		toasts.remove(pending);
		busy = false;
		if (added > 0) {
			const parts = [`${added} item${added > 1 ? 's' : ''} added`];
			if (importedMsgs) parts.push(`${importedMsgs} messages imported`);
			toasts.success(parts.join(' · '));
		}
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
	<!-- Visual only — pointer-events:none so the drop reaches the window handler. -->
	<div class="drop-overlay" aria-hidden="true">
		<div class="drop-card">
			<svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 16V4" />
				<path d="m7 9 5-5 5 5" />
				<path d="M5 20h14" />
			</svg>
			<p class="drop-title">Drop to add to your vault</p>
			<p class="drop-sub">Images, documents, or a Claude / ChatGPT export (.zip)</p>
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
