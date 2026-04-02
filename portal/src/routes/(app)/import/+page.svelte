<script lang="ts">
	import JSZip from 'jszip';
	import { apiPostForm } from '$lib/api';

	type ImportSource = 'obsidian' | 'chatgpt' | 'claude' | 'linkedin';

	interface ImportStats {
		conversations?: number;
		messages?: number;
		projects?: number;
		project_docs?: number;
		memories?: number;
		skipped_duplicates?: number;
		artifacts_kept?: number;
		artifacts_deduplicated?: number;
		imported?: number;
		skipped?: number;
		connections?: number;
		connections_skipped?: number;
		noise_filtered?: number;
		group_chats?: number;
		contacts_with_messages?: number;
	}

	interface ImportResult {
		type: string;
		imported: number;
		skipped: number;
		stats?: ImportStats;
	}

	let selectedSource = $state<ImportSource | null>(null);
	let fileInput: HTMLInputElement;
	let files = $state<FileList | null>(null);
	let importing = $state(false);
	let statusMsg = $state<string | null>(null);
	let error = $state<string | null>(null);
	let result = $state<ImportResult | null>(null);

	const sources: { id: ImportSource; name: string; description: string; accept: string; hint: string }[] = [
		{ id: 'claude', name: 'Claude', description: 'Import Claude conversation export', accept: '.zip,.json', hint: 'Conversations, projects, memories, and artifacts with automatic deduplication' },
		{ id: 'chatgpt', name: 'ChatGPT', description: 'Import OpenAI conversation export', accept: '.zip,.json', hint: 'Conversation trees flattened to canonical path with deduplication' },
		{ id: 'obsidian', name: 'Obsidian', description: 'Import your Obsidian vault', accept: '.zip', hint: 'Markdown notes imported as documents' },
		{ id: 'linkedin', name: 'LinkedIn', description: 'Import your LinkedIn data export', accept: '.zip', hint: 'Connections, messages, and professional network — auto-encrypted and deduplicated' },
	];

	/**
	 * For large ZIPs (>90MB), extract just the JSON conversation files client-side
	 * and re-pack them into a smaller ZIP. This avoids Cloudflare's 100MB upload limit.
	 * Media files (images, etc.) are stripped — only conversation data is imported.
	 */
	async function prepareFile(file: File): Promise<File> {
		// Small files or non-ZIPs: upload as-is
		if (file.size < 90_000_000 || !file.name.endsWith('.zip')) {
			return file;
		}

		statusMsg = 'Large file detected — extracting conversation data...';

		const buffer = await file.arrayBuffer();
		const zip = await JSZip.loadAsync(buffer);
		const jsonFiles = Object.keys(zip.files).filter(n => n.endsWith('.json') && !zip.files[n].dir);
		const mdFiles = Object.keys(zip.files).filter(n => n.endsWith('.md') && !zip.files[n].dir);
		const csvFiles = Object.keys(zip.files).filter(n => n.endsWith('.csv') && !zip.files[n].dir);

		const dataFiles = [...jsonFiles, ...mdFiles, ...csvFiles];
		if (dataFiles.length === 0) {
			throw new Error('No importable data found in this ZIP.');
		}

		// Re-pack only data files into a new smaller ZIP (strip media)
		const newZip = new JSZip();
		for (const name of dataFiles) {
			const content = await zip.files[name].async('uint8array');
			newZip.file(name, content);
		}

		const newBuffer = await newZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
		statusMsg = `Extracted ${dataFiles.length} data files (${Math.round(newBuffer.size / 1024 / 1024)}MB)`;

		return new File([newBuffer], file.name, { type: 'application/zip' });
	}

	async function handleImport() {
		if (!files?.length) return;
		importing = true;
		error = null;
		result = null;
		statusMsg = null;

		try {
			const prepared = await prepareFile(files[0]);
			statusMsg = 'Uploading and importing...';

			const formData = new FormData();
			formData.append('file', prepared);

			const res = await apiPostForm<{
				importResult?: ImportResult;
				type?: string;
				content?: string;
				error?: string;
			}>('/portal/upload', formData);

			if (res.importResult) {
				result = res.importResult;
			} else if (res.type === 'import') {
				result = { type: selectedSource || 'unknown', imported: 0, skipped: 0 };
			} else {
				error = 'File was uploaded but not recognized as an export. Make sure you selected the right format.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
		} finally {
			importing = false;
			statusMsg = null;
		}
	}

	function formatResult(r: ImportResult): string[] {
		const lines: string[] = [];
		const s = r.stats;
		if (!s) {
			lines.push(`${r.imported} items imported${r.skipped > 0 ? `, ${r.skipped} skipped` : ''}`);
			return lines;
		}

		if (r.type === 'claude') {
			if (s.messages) lines.push(`${s.messages} messages from ${s.conversations || '?'} conversations`);
			if (s.skipped_duplicates) lines.push(`${s.skipped_duplicates} duplicate messages skipped`);
			if (s.artifacts_kept || s.artifacts_deduplicated) {
				lines.push(`${s.artifacts_kept || 0} artifacts kept, ${s.artifacts_deduplicated || 0} versions deduplicated`);
			}
			if (s.projects) lines.push(`${s.projects} projects imported (${s.project_docs || 0} docs)`);
			if (s.memories) lines.push(`${s.memories} memories imported`);
		} else if (r.type === 'chatgpt') {
			if (s.messages) lines.push(`${s.messages} messages from ${s.conversations || '?'} conversations`);
			if (s.skipped_duplicates) lines.push(`${s.skipped_duplicates} duplicates skipped`);
		} else if (r.type === 'linkedin') {
			if (s.connections) lines.push(`${s.connections} contacts imported`);
			if (s.noise_filtered) lines.push(`${s.noise_filtered} noise connections filtered`);
			if (s.messages) lines.push(`${s.messages} messages from ${s.conversations || '?'} conversations`);
			if (s.group_chats) lines.push(`${s.group_chats} group chats`);
			if (s.contacts_with_messages) lines.push(`${s.contacts_with_messages} contacts with message history`);
			if (s.skipped_duplicates) lines.push(`${s.skipped_duplicates} duplicate messages skipped`);
		} else if (r.type === 'obsidian') {
			lines.push(`${s.imported || r.imported} notes imported`);
			if (s.skipped || r.skipped) lines.push(`${s.skipped || r.skipped} skipped`);
		}

		if (lines.length === 0) {
			lines.push(`${r.imported} items imported`);
		}
		return lines;
	}

	function reset() {
		selectedSource = null;
		files = null;
		result = null;
		error = null;
		statusMsg = null;
	}
</script>

<svelte:head>
	<title>Import - Mycelium</title>
</svelte:head>

<div class="max-w-2xl mx-auto px-8 py-8">
	<h1 class="text-xl font-medium text-[var(--color-text-emphasis)] mb-2">Import Data</h1>
	<p class="text-sm text-[var(--color-text-secondary)] mb-8">
		Bring your data from other platforms into Mycelium
	</p>

	{#if result}
		<!-- Result -->
		<div class="card p-6 text-center">
			<div class="text-jade text-4xl mb-4">&#10003;</div>
			<h2 class="text-lg font-medium text-[var(--color-text-emphasis)]">Import Complete</h2>
			<div class="mt-3 space-y-1">
				{#each formatResult(result) as line}
					<p class="text-sm text-[var(--color-text-secondary)]">{line}</p>
				{/each}
			</div>
			<button onclick={reset} class="btn btn-secondary mt-6">Import More</button>
		</div>
	{:else if !selectedSource}
		<!-- Source selection -->
		<div class="grid gap-4">
			{#each sources as src}
				<button
					onclick={() => selectedSource = src.id}
					class="card p-5 text-left hover:border-[var(--color-accent)] transition-colors"
				>
					<h3 class="text-sm font-medium text-[var(--color-text-emphasis)]">{src.name}</h3>
					<p class="text-xs text-[var(--color-text-secondary)] mt-1">{src.description}</p>
					<p class="text-xs text-[var(--color-text-tertiary)] mt-1">{src.hint}</p>
				</button>
			{/each}
		</div>
	{:else}
		<!-- File upload -->
		<div class="space-y-6">
			<button onclick={() => { selectedSource = null; error = null; }} class="btn-ghost text-xs">
				&#8592; Back to sources
			</button>

			<div class="card p-6">
				<h3 class="text-sm font-medium text-[var(--color-text-emphasis)] mb-2">
					Upload {sources.find(s => s.id === selectedSource)?.name} export
				</h3>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
					{sources.find(s => s.id === selectedSource)?.hint}
				</p>

				<input
					bind:this={fileInput}
					bind:files={files}
					type="file"
					accept={sources.find(s => s.id === selectedSource)?.accept}
					class="block w-full text-sm text-[var(--color-text-secondary)]
						file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
						file:text-sm file:font-medium file:bg-[var(--color-elevated)]
						file:text-[var(--color-text-primary)] hover:file:bg-[var(--color-border)]"
				/>

				{#if error}
					<div class="mt-4 p-4 bg-coral/10 border border-coral/20 rounded-lg">
						<p class="text-sm text-coral">{error}</p>
					</div>
				{/if}

				{#if statusMsg}
					<p class="mt-3 text-xs text-[var(--color-text-tertiary)]">{statusMsg}</p>
				{/if}

				{#if files?.length}
					<div class="mt-2 text-xs text-[var(--color-text-tertiary)]">
						{files[0].name} ({Math.round(files[0].size / 1024 / 1024)}MB)
					</div>
					<button
						onclick={handleImport}
						disabled={importing}
						class="btn btn-primary mt-4 w-full"
					>
						{#if importing}
							<span class="inline-block animate-spin mr-2">&#9696;</span>
							{statusMsg || 'Importing...'}
						{:else}
							Import {files[0].name}
						{/if}
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
