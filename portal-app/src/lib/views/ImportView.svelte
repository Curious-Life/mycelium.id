<script lang="ts">
	import { onMount } from 'svelte';
	import JSZip from 'jszip';
	import { uploadFile as chunkedUpload } from '$lib/chunked-upload';
	import { api } from '$lib/api';


	type ImportSource = 'obsidian' | 'chatgpt' | 'claude' | 'linkedin';

	interface ImportStats {
		conversations?: number;
		messages?: number;
		projects?: number;
		project_docs?: number;
		memories?: number;
		folders?: number;
		skipped_duplicates?: number;
		artifacts_kept?: number;
		artifacts_deduplicated?: number;
		assets?: number;
		assets_skipped?: number;
		refs_rewritten?: number;
		refs_unresolved?: number;
		imported?: number;
		skipped?: number;
		connections?: number;
		connections_skipped?: number;
		noise_filtered?: number;
		group_chats?: number;
		contacts_with_messages?: number;
		feedback_count?: number;
		media_references?: number;
		shared_conversations?: number;
	}

	interface ImportResult {
		type: string;
		imported: number;
		skipped: number;
		stats?: ImportStats;
		enrichmentJobId?: string;
		note?: string;
	}

	let selectedSource = $state<ImportSource | null>(null);
	let fileInput = $state<HTMLInputElement>();
	let files = $state<FileList | null>(null);
	let importing = $state(false);
	let statusMsg = $state<string | null>(null);
	let error = $state<string | null>(null);
	let result = $state<ImportResult | null>(null);

	// Obsidian folder import — native picker in the desktop app, <input
	// webkitdirectory> in the browser. Both POST to /portal/import/obsidian.
	let folderInput = $state<HTMLInputElement>();
	let isTauri = $state(false);
	onMount(() => {
		isTauri = typeof window !== 'undefined'
			&& !!((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
		loadConnectors();
	});

	// ── Live connectors (Gmail, Linear, …) ──
	interface ConnectorRun {
		at: string; ok: boolean; pulled?: number; created?: number; updated?: number; deduped?: number; skipped?: string; error?: string; durationMs?: number;
	}
	interface ConnectorStatus {
		id: string; label: string; provider: string; oauth: boolean; status: string;
		connectedAt: string | null; lastSyncAt: string | null; lastError: string | null; itemsLastSync: number | null;
		lastOkAt?: string | null; lastErrorAt?: string | null; idleStreak?: number;
		itemsCreated?: number | null; itemsUpdated?: number | null; itemsDeduped?: number | null;
		budgetDate?: string | null; itemsToday?: number; dailyItemLimit?: number;
		lastRun?: ConnectorRun | null; recentRuns?: ConnectorRun[];
	}
	let connectors = $state<ConnectorStatus[]>([]);
	let connectorMsg = $state<string | null>(null);
	let connectorBusy = $state<string | null>(null);

	// Relative time for connector freshness (e.g. "3h ago"). Empty for missing/invalid.
	function fmtAgo(iso: string | null | undefined): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		const m = Math.floor(ms / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function loadConnectors() {
		try {
			const res = await api('/portal/connectors');
			const d = await res.json();
			connectors = d.connectors || [];
		} catch { /* connectors are optional */ }
	}

	function pollConnectors() {
		if (pollTimer) clearInterval(pollTimer);
		let n = 0;
		pollTimer = setInterval(async () => {
			n += 1;
			await loadConnectors();
			if (n > 30 || connectors.some((c) => c.status === 'connected')) { clearInterval(pollTimer!); pollTimer = null; }
		}, 2000);
	}

	async function connectConnector(c: ConnectorStatus) {
		connectorBusy = c.id; connectorMsg = null;
		try {
			const res = await api(`/portal/connectors/${c.id}/connect`, { method: 'POST', body: '{}' });
			const d = await res.json().catch(() => ({}));
			if (d.authUrl) {
				window.open(d.authUrl, '_blank', 'width=520,height=680');
				connectorMsg = `Authorize ${c.label} in the window that opened, then return here.`;
				pollConnectors();
			} else if (d.ok) {
				await loadConnectors();
			} else if (d.error === 'oauth_not_configured') {
				connectorMsg = `${c.label} isn't configured yet — its OAuth credentials haven't been set up.`;
			} else {
				connectorMsg = `Couldn't connect ${c.label}: ${d.error || 'unknown error'}`;
			}
		} catch (e) {
			connectorMsg = e instanceof Error ? e.message : 'Connect failed';
		} finally { connectorBusy = null; }
	}

	async function syncConnector(c: ConnectorStatus) {
		connectorBusy = c.id; connectorMsg = null;
		try {
			const res = await api(`/portal/connectors/${c.id}/sync`, { method: 'POST', body: '{}' });
			const d = await res.json().catch(() => ({}));
			if (d.ok) { connectorMsg = `${c.label}: ${d.created} new, ${d.updated || 0} updated, ${d.deduped} unchanged.`; await loadConnectors(); }
			else connectorMsg = `Sync failed: ${d.error || 'unknown error'}`;
		} catch (e) {
			connectorMsg = e instanceof Error ? e.message : 'Sync failed';
		} finally { connectorBusy = null; }
	}

	async function disconnectConnector(c: ConnectorStatus) {
		connectorBusy = c.id; connectorMsg = null;
		try { await api(`/portal/connectors/${c.id}/disconnect`, { method: 'POST', body: '{}' }); await loadConnectors(); }
		catch { /* */ } finally { connectorBusy = null; }
	}

	const sources: { id: ImportSource; name: string; description: string; accept: string; hint: string }[] = [
		{ id: 'claude', name: 'Claude', description: 'Import Claude conversation export', accept: '.zip,.json', hint: 'Conversations, projects, memories, and artifacts with automatic deduplication' },
		{ id: 'chatgpt', name: 'ChatGPT', description: 'Import OpenAI conversation export', accept: '.zip,.json', hint: 'Conversation trees flattened to canonical path with deduplication' },
		{ id: 'obsidian', name: 'Obsidian', description: 'Open your Obsidian vault folder', accept: '.md', hint: 'Pick the folder — every .md note becomes a document + a mindscape memory. No export needed.' },
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

		// Very large files (>500MB): upload raw — server handles extraction to avoid browser OOM
		if (file.size > 500_000_000) {
			statusMsg = `Large file (${Math.round(file.size / 1024 / 1024)}MB) — uploading directly, server will extract text data...`;
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

	let uploadProgress = $state(0);

	// Drag-and-drop: drop a file anywhere on the upload card instead of browsing.
	let dragOver = $state(false);
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const dropped = e.dataTransfer?.files;
		if (dropped && dropped.length) { files = dropped; error = null; }
	}
	function onDragOver(e: DragEvent) { e.preventDefault(); dragOver = true; }
	function onDragLeave(e: DragEvent) { e.preventDefault(); dragOver = false; }

	async function handleImport() {
		if (!files?.length) return;
		importing = true;
		error = null;
		result = null;
		statusMsg = null;
		uploadProgress = 0;

		try {
			const prepared = await prepareFile(files[0]);
			statusMsg = 'Uploading...';

			const res = await chunkedUpload(prepared, (p) => {
				uploadProgress = p.percent;
				if (p.stage === 'processing') {
					statusMsg = 'Processing import...';
				} else {
					statusMsg = `Uploading... ${Math.round(p.loaded / 1_000_000)}MB / ${Math.round(p.total / 1_000_000)}MB (${p.percent}%)`;
				}
			});

			statusMsg = null;
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
			uploadProgress = 0;
		}
	}

	interface ObsidianSummary {
		scanned: number; documentsUpserted: number; memoriesCreated: number;
		memoriesDeduped: number; memoriesUpdated?: number; folders: number; skipped: number; truncated?: boolean;
		assets?: { imported: number; deduped: number; blobsReused: number; skipped: number };
		refs?: { rewritten: number; unresolved: number };
	}

	async function importObsidian(payload: { folderPath?: string; files?: { relPath: string; content?: string; contentBase64?: string; mtime?: string }[]; vaultName?: string }) {
		importing = true; error = null; result = null; statusMsg = 'Importing notes…';
		try {
			const res = await api('/portal/import/obsidian', { method: 'POST', body: JSON.stringify(payload) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.ok) throw new Error(data.error || `Import failed (${res.status})`);
			const s = data as ObsidianSummary;
			result = {
				type: 'obsidian',
				imported: s.documentsUpserted,
				skipped: s.skipped,
				stats: {
					imported: s.documentsUpserted, skipped: s.skipped,
					memories: s.memoriesCreated + (s.memoriesUpdated || 0), folders: s.folders,
					assets: (s.assets?.imported || 0) + (s.assets?.deduped || 0),
					assets_skipped: s.assets?.skipped || 0,
					refs_rewritten: s.refs?.rewritten || 0,
					refs_unresolved: s.refs?.unresolved || 0,
				},
			};
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
		} finally {
			importing = false; statusMsg = null;
		}
	}

	async function pickVaultFolder() {
		error = null;
		// A folder <input webkitdirectory> opens the OS folder chooser in both the
		// browser and the Tauri WKWebView, yielding the .md File objects directly.
		// (A native path-based picker for large-vault re-sync arrives with connectors.)
		folderInput?.click();
	}

	async function onFolderChosen() {
		const list = folderInput?.files;
		if (!list || !list.length) return;
		importing = true; error = null; statusMsg = 'Reading vault…';
		try {
			const mdFiles = Array.from(list).filter((f) => /\.md$/i.test(f.name));
			if (!mdFiles.length) { error = 'No .md notes found in that folder.'; return; }
			// webkitRelativePath = "<pickedDir>/sub/note.md" — the picked dir is the
			// vault; send it as vaultName and strip it so relPaths are vault-relative.
			const vaultName = (((mdFiles[0] as any).webkitRelativePath as string) || '').split('/')[0] || undefined;
			const prefix = vaultName ? `${vaultName}/` : '';
			const relOf = (f: File) => {
				const rel = ((f as any).webkitRelativePath as string) || f.name;
				return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
			};
			const files: { relPath: string; content?: string; contentBase64?: string; mtime?: string }[] =
				await Promise.all(mdFiles.map(async (f) => ({
					relPath: relOf(f),
					content: await f.text(),
					mtime: new Date(f.lastModified).toISOString(),
				})));
			// Vault images/media → base64 entries, so `![[photo.png]]` embeds render
			// instead of breaking. Caps mirror the server (25MB/file); a total-payload
			// cap keeps the JSON body within the transport ceiling. Skips are reported.
			const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|pdf|mp3|m4a|wav|ogg|flac|mp4|mov|webm)$/i;
			const MAX_ASSET = 25 * 1024 * 1024;
			const MAX_TOTAL_ASSETS = 150 * 1024 * 1024;
			statusMsg = 'Reading vault media…';
			const toBase64 = async (f: File) => {
				const buf = new Uint8Array(await f.arrayBuffer());
				let s = '';
				const CHUNK = 0x8000;
				for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
				return btoa(s);
			};
			let assetTotal = 0;
			let assetsSkippedClient = 0;
			for (const f of Array.from(list)) {
				if (!ASSET_RE.test(f.name)) continue;
				if (f.size === 0 || f.size > MAX_ASSET || assetTotal + f.size > MAX_TOTAL_ASSETS) { assetsSkippedClient++; continue; }
				assetTotal += f.size;
				files.push({ relPath: relOf(f), contentBase64: await toBase64(f), mtime: new Date(f.lastModified).toISOString() });
			}
			if (assetsSkippedClient > 0) console.warn(`[import] ${assetsSkippedClient} vault media file(s) skipped (size caps)`);
			await importObsidian({ files, vaultName });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read the folder';
		} finally {
			if (importing && !result) { importing = false; statusMsg = null; }
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
			if (s.feedback_count) lines.push(`${s.feedback_count} message ratings preserved`);
			if (s.media_references) lines.push(`${s.media_references} media references preserved`);
			if (s.shared_conversations) lines.push(`${s.shared_conversations} shared conversations included`);
		} else if (r.type === 'linkedin') {
			if (s.connections) lines.push(`${s.connections} contacts imported`);
			if (s.noise_filtered) lines.push(`${s.noise_filtered} noise connections filtered`);
			if (s.messages) lines.push(`${s.messages} messages from ${s.conversations || '?'} conversations`);
			if (s.group_chats) lines.push(`${s.group_chats} group chats`);
			if (s.contacts_with_messages) lines.push(`${s.contacts_with_messages} contacts with message history`);
			if (s.skipped_duplicates) lines.push(`${s.skipped_duplicates} duplicate messages skipped`);
		} else if (r.type === 'obsidian') {
			lines.push(`${s.imported ?? r.imported} notes imported as documents${s.folders ? ` across ${s.folders} folders` : ''}`);
			if (s.memories) lines.push(`${s.memories} new memories queued for the mindscape`);
			if (s.assets) lines.push(`${s.assets} images & files imported${s.refs_rewritten ? ` — ${s.refs_rewritten} embeds now render` : ''}`);
			if (s.refs_unresolved) lines.push(`${s.refs_unresolved} embeds point at files not in the vault (left as-is)`);
			if (s.assets_skipped) lines.push(`${s.assets_skipped} media files skipped (size caps)`);
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

<!-- The workspace pane clips its content (.pane-body overflow:hidden), so each
	 view must own its scroll — like SettingsView's `h-full overflow-y-auto` root.
	 Without this the Import page can't scroll and content below the fold is lost. -->
<div class="h-full overflow-y-auto">
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
			{#if (result.type === 'claude' || result.type === 'chatgpt' || result.type === 'obsidian') && !result.note}
				<p class="text-xs text-[var(--color-accent-aurum)] mt-4">
					{result.type === 'obsidian'
						? 'Your notes are saved and queued — run Generate to weave them into the Mindscape.'
						: 'Your conversations are saved and embedding now. View them in Timeline, then Generate your Mindscape.'}
				</p>
				<div class="flex gap-2 justify-center mt-3">
					<a href="/mindscape" class="btn btn-primary">Go to Mindscape</a>
					{#if result.type !== 'obsidian'}
						<a href="/timeline" class="btn btn-secondary">View in Timeline</a>
					{/if}
				</div>
				<button onclick={reset} class="btn btn-secondary mt-2">Import More</button>
			{:else}
				<button onclick={reset} class="btn btn-secondary mt-6">Import More</button>
			{/if}
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

		{#if connectors.length}
			<div class="mt-10">
				<h2 class="text-sm font-medium text-[var(--color-text-emphasis)] mb-1">Live connections</h2>
				<p class="text-xs text-[var(--color-text-secondary)] mb-4">Continuously sync from your accounts — items become memories in your mindscape.</p>
				<div class="grid gap-3">
					{#each connectors as c}
						<div class="card p-4 flex items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<h3 class="text-sm font-medium text-[var(--color-text-emphasis)]">{c.label}</h3>
									<span class="text-[10px] px-1.5 py-0.5 rounded-full {c.status === 'connected' ? 'bg-jade/15 text-jade' : c.status === 'error' ? 'bg-coral/15 text-coral' : (c.status === 'syncing' || c.status === 'connecting') ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]' : 'bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]'}">{c.status}</span>
								</div>
								<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate">
									{#if c.status === 'error' && c.lastError}<span class="text-coral">Needs reconnect — {c.lastError}</span>{:else if c.lastSyncAt}Last sync {fmtAgo(c.lastSyncAt)}{c.itemsLastSync != null ? ` · ${c.itemsLastSync} items` : ''}{#if c.lastRun && ((c.lastRun.created ?? 0) > 0 || (c.lastRun.updated ?? 0) > 0)} · {c.lastRun.created ?? 0} new, {c.lastRun.updated ?? 0} updated{/if}{#if (c.idleStreak ?? 0) >= 2} · checking less often (no new items){/if}{:else}Not synced yet{/if}{#if (c.itemsToday ?? 0) > 0 && c.dailyItemLimit} · {c.itemsToday}/{c.dailyItemLimit} today{(c.itemsToday ?? 0) >= (c.dailyItemLimit ?? 0) ? ' — budget reached' : ''}{/if}
								</p>
							</div>
							<div class="flex items-center gap-2 shrink-0">
								{#if c.status === 'disconnected'}
									<button onclick={() => connectConnector(c)} disabled={connectorBusy === c.id} class="btn btn-secondary text-xs">{connectorBusy === c.id ? 'Connecting…' : 'Connect'}</button>
								{:else}
									<button onclick={() => (c.status === 'error' ? connectConnector(c) : syncConnector(c))} disabled={connectorBusy === c.id} class="btn-ghost text-xs">{c.status === 'error' ? (connectorBusy === c.id ? 'Reconnecting…' : 'Reconnect') : 'Sync now'}</button>
									<button onclick={() => disconnectConnector(c)} disabled={connectorBusy === c.id} class="btn-ghost text-xs text-coral">Disconnect</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if connectorMsg}<p class="text-xs text-[var(--color-text-tertiary)] mt-3">{connectorMsg}</p>{/if}
			</div>
		{/if}
	{:else}
		<!-- File upload -->
		<div class="space-y-6">
			<button onclick={() => { selectedSource = null; error = null; }} class="btn-ghost text-xs">
				&#8592; Back to sources
			</button>

			<div class="card p-6">
				<h3 class="text-sm font-medium text-[var(--color-text-emphasis)] mb-2">
					{#if selectedSource === 'obsidian'}Open your Obsidian vault{:else}Upload {sources.find(s => s.id === selectedSource)?.name} export{/if}
				</h3>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
					{sources.find(s => s.id === selectedSource)?.hint}
				</p>

				{#if selectedSource === 'obsidian'}
						<button onclick={pickVaultFolder} disabled={importing} class="btn btn-primary w-full">
							{#if importing}
								<span class="inline-block animate-spin mr-2">&#9696;</span>
								{statusMsg || 'Importing…'}
							{:else}
								Open vault folder
							{/if}
						</button>
						<input bind:this={folderInput} type="file" webkitdirectory multiple class="sr-only" onchange={onFolderChosen} />
						{#if !isTauri}
							<p class="mt-3 text-xs text-[var(--color-text-tertiary)]">Pick your vault folder — its .md notes import directly. (In the desktop app this opens a native folder picker.)</p>
						{/if}
					{:else}
					<!-- Drop zone: drag a file in, or click Browse. -->
				<div
					role="button"
					tabindex="0"
					aria-label="Drop a file here or browse"
					onclick={() => fileInput?.click()}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); } }}
					ondragover={onDragOver}
					ondragleave={onDragLeave}
					ondrop={onDrop}
					class="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all duration-150
						{dragOver
							? 'border-[var(--color-accent)] bg-[var(--color-accent)]/20 ring-2 ring-[var(--color-accent)] scale-[1.02] shadow-lg'
							: 'border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-elevated)]'}"
				>
					<svg class="w-7 h-7 mx-auto mb-2 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
					</svg>
					<p class="text-sm text-[var(--color-text-secondary)]">
						{dragOver ? 'Drop to upload' : 'Drag your export here, or click to browse'}
					</p>
					<p class="text-xs text-[var(--color-text-tertiary)] mt-1">
						{sources.find(s => s.id === selectedSource)?.accept} · stays on your machine
					</p>
				</div>

				<input
					bind:this={fileInput}
					bind:files={files}
					type="file"
					accept={sources.find(s => s.id === selectedSource)?.accept}
					class="sr-only"
				/>

				{/if}

					{#if error}
					<div class="mt-4 p-4 bg-coral/10 border border-coral/20 rounded-lg">
						<p class="text-sm text-coral">{error}</p>
					</div>
				{/if}

				{#if statusMsg && selectedSource !== 'obsidian'}
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
</div>
