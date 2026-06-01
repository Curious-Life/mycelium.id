<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { api } from '$lib/api';

	interface MediaItem {
		id: string;
		type: 'image' | 'voice' | 'video' | 'file';
		url: string;
		streamUid: string | null;
		filename: string | null;
		fileSize: number | null;
		description: string | null;
		transcript: string | null;
		createdAt: string | null;
		embedUrl?: string;
	}

	type FilterType = 'all' | 'image' | 'voice' | 'video';

	let items = $state<MediaItem[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	let activeFilter = $state<FilterType>('all');
	let searchQuery = $state('');
	let searchTimeout: ReturnType<typeof setTimeout>;

	// Detail panel
	let selectedItem = $state<MediaItem | null>(null);
	let editingDescription = $state(false);
	let editDescription = $state('');
	let savingDescription = $state(false);
	let expandedImage = $state<string | null>(null);

	// Panel resize
	let panelWidth = $state(420);
	let isResizing = $state(false);
	let isFullscreen = $state(false);

	// Delete
	let showDeleteConfirm = $state(false);
	let isDeleting = $state(false);

	const PAGE_SIZE = 50;
	const PANEL_MIN = 320;
	const PANEL_MAX = 700;

	const filters: { id: FilterType; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'image', label: 'Photos' },
		{ id: 'voice', label: 'Audio' },
		{ id: 'video', label: 'Video' },
	];

	onMount(() => {
		loadMedia();
		// Restore panel width from localStorage
		if (browser) {
			const saved = localStorage.getItem('media-panel-width');
			if (saved) panelWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, parseInt(saved, 10)));
		}
	});

	async function loadMedia(append = false) {
		if (!append) loading = true;
		else loadingMore = true;

		try {
			const params = new URLSearchParams();
			if (activeFilter !== 'all') params.set('type', activeFilter);
			if (searchQuery.trim()) params.set('search', searchQuery.trim());
			params.set('limit', String(PAGE_SIZE));
			if (append) params.set('offset', String(items.length));

			const res = await api(`/portal/attachments?${params}`);
			if (res.ok) {
				const data = await res.json();
				if (append) {
					items = [...items, ...data.attachments];
				} else {
					items = data.attachments;
				}
				total = data.total;
			}
		} catch (e) {
			console.error('[Media] Failed to load:', e);
		}

		loading = false;
		loadingMore = false;
	}

	function setFilter(f: FilterType) {
		activeFilter = f;
		items = [];
		loadMedia();
	}

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			items = [];
			loadMedia();
		}, 300);
	}

	async function openDetail(item: MediaItem) {
		selectedItem = item;
		editingDescription = false;
		showDeleteConfirm = false;
		isFullscreen = false;
		// Load Stream embed URL for videos
		if (item.type === 'video' && item.streamUid && !item.embedUrl) {
			try {
				const res = await api(`/portal/stream-token/${item.id}`);
				if (res.ok) {
					const data = await res.json();
					item.embedUrl = data.embedUrl;
					selectedItem = { ...item };
				}
			} catch (e) {
				console.error('[Media] Failed to load stream token:', e);
			}
		}
	}

	function closeDetail() {
		selectedItem = null;
		editingDescription = false;
		showDeleteConfirm = false;
		isFullscreen = false;
	}

	function startEditDescription() {
		if (!selectedItem) return;
		editDescription = selectedItem.description || '';
		editingDescription = true;
	}

	async function saveDescription() {
		if (!selectedItem) return;
		savingDescription = true;
		try {
			const res = await api(`/portal/attachments/${selectedItem.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ description: editDescription }),
			});
			if (res.ok) {
				selectedItem = { ...selectedItem, description: editDescription };
				items = items.map(i => i.id === selectedItem!.id ? { ...i, description: editDescription } : i);
				editingDescription = false;
			}
		} catch (e) {
			console.error('[Media] Failed to save description:', e);
		}
		savingDescription = false;
	}

	async function handleDelete() {
		if (!selectedItem) return;
		isDeleting = true;
		try {
			const res = await api(`/portal/attachments/${selectedItem.id}`, { method: 'DELETE' });
			if (res.ok) {
				const deletedId = selectedItem.id;
				items = items.filter(i => i.id !== deletedId);
				total = Math.max(0, total - 1);
				closeDetail();
			} else {
				console.error('[Media] Delete failed:', await res.text());
			}
		} catch (e) {
			console.error('[Media] Delete error:', e);
		}
		isDeleting = false;
		showDeleteConfirm = false;
	}

	// Panel resize
	function startResize(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		const startX = e.clientX;
		const startWidth = panelWidth;

		function onMouseMove(e: MouseEvent) {
			const delta = startX - e.clientX;
			panelWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, startWidth + delta));
		}

		function onMouseUp() {
			isResizing = false;
			if (browser) localStorage.setItem('media-panel-width', String(panelWidth));
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}

	function handlePanelKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (showDeleteConfirm) showDeleteConfirm = false;
			else if (editingDescription) editingDescription = false;
			else closeDetail();
		}
	}

	function formatFileSize(bytes: number | null): string {
		if (!bytes) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return '';
		return new Date(dateStr).toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', year: 'numeric',
			hour: '2-digit', minute: '2-digit',
		});
	}
</script>

<svelte:head>
	<title>Media - Mycelium</title>
</svelte:head>

<!-- Image lightbox -->
{#if expandedImage}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center cursor-pointer"
		onclick={() => expandedImage = null}
		onkeydown={(e) => { if (e.key === 'Escape') expandedImage = null; }}
		role="dialog"
		tabindex="-1"
	>
		<img src={expandedImage} alt="" class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
	</div>
{/if}

<div class="media-page">
	<!-- Header -->
	<div class="media-header px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]/50">
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-2 sm:gap-3">
				<span class="text-[var(--color-text-tertiary)]">
					<svg class="w-6 h-6 sm:w-7 sm:h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<circle cx="8.5" cy="8.5" r="1.5" />
						<path stroke-linecap="round" stroke-linejoin="round" d="m21 15-5-5L5 21" />
					</svg>
				</span>
				<div>
					<h1 class="text-lg sm:text-xl font-medium text-[var(--color-text-primary)]">Media</h1>
					<p class="text-xs sm:text-sm text-[var(--color-text-tertiary)]">{total} item{total !== 1 ? 's' : ''}</p>
				</div>
			</div>

			<!-- Search -->
			<div class="relative">
				<input
					bind:value={searchQuery}
					oninput={handleSearch}
					type="text"
					placeholder="Search..."
					class="w-36 sm:w-48 pl-8 pr-3 py-1.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
				<svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
				</svg>
			</div>
		</div>

		<!-- Filter tabs -->
		<div class="flex items-center gap-1 mt-3">
			{#each filters as f}
				<button
					onclick={() => setFilter(f.id)}
					class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors {activeFilter === f.id
						? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
						: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
				>
					{f.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Content area: grid + optional side panel -->
	<div class="media-body">
		<!-- Media grid (always visible) -->
		<div class="media-content p-3 sm:p-6">
			{#if loading}
				<div class="flex items-center justify-center h-full">
					<div class="text-center">
						<div class="w-10 h-10 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin mx-auto mb-4"></div>
						<p class="text-[var(--color-text-tertiary)] text-sm">Loading...</p>
					</div>
				</div>
			{:else if items.length === 0}
				<!-- Empty state -->
				<div class="flex items-center justify-center h-full p-8">
					<div class="text-center max-w-md">
						<div class="w-16 h-16 rounded-full bg-[var(--color-elevated)] flex items-center justify-center mx-auto mb-4">
							<svg class="w-8 h-8 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<rect x="3" y="3" width="18" height="18" rx="2" />
								<circle cx="8.5" cy="8.5" r="1.5" />
								<path stroke-linecap="round" stroke-linejoin="round" d="m21 15-5-5L5 21" />
							</svg>
						</div>
						<h3 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">
							{searchQuery ? 'No results found' : 'No media yet'}
						</h3>
						<p class="text-sm text-[var(--color-text-secondary)]">
							{searchQuery ? 'Try a different search term.' : 'Drop files anywhere to upload, or use the attach button in chat.'}
						</p>
					</div>
				</div>
			{:else}
				<div class="media-grid">
					{#each items as item}
						<button
							onclick={() => openDetail(item)}
							class="media-card group {selectedItem?.id === item.id ? 'ring-2 ring-[var(--color-accent)]' : ''}"
						>
							{#if item.type === 'image'}
								<img
									src={item.url}
									alt={item.description || item.filename || ''}
									class="w-full h-full object-cover"
									loading="lazy"
								/>
							{:else if item.type === 'video'}
								<div class="w-full h-full bg-[var(--color-elevated)] flex items-center justify-center">
									<svg class="w-10 h-10 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<polygon points="5 3 19 12 5 21 5 3" />
									</svg>
								</div>
							{:else if item.type === 'voice'}
								<div class="w-full h-full bg-[var(--color-elevated)] flex flex-col items-center justify-center gap-2 p-3">
									<svg class="w-8 h-8 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
									</svg>
									{#if item.transcript}
										<p class="text-[10px] text-[var(--color-text-tertiary)] line-clamp-3 text-center leading-tight">
											{item.transcript}
										</p>
									{/if}
								</div>
							{:else}
								<div class="w-full h-full bg-[var(--color-elevated)] flex flex-col items-center justify-center gap-2 p-3">
									<svg class="w-8 h-8 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
										<polyline points="14 2 14 8 20 8"/>
									</svg>
									<span class="text-[10px] text-[var(--color-text-tertiary)] truncate max-w-full">{item.filename || 'File'}</span>
								</div>
							{/if}

							<!-- Hover overlay -->
							<div class="media-overlay">
								<span class="text-xs text-white truncate max-w-full">{item.filename || item.description || 'Untitled'}</span>
								{#if item.fileSize}
									<span class="text-[10px] text-white/70">{formatFileSize(item.fileSize)}</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>

				<!-- Load more -->
				{#if items.length < total}
					<div class="flex justify-center py-6">
						<button
							onclick={() => loadMedia(true)}
							disabled={loadingMore}
							class="px-4 py-2 text-sm bg-[var(--color-elevated)] hover:bg-[var(--color-border)] text-[var(--color-text-primary)] rounded-lg transition-colors disabled:opacity-50"
						>
							{loadingMore ? 'Loading...' : `Load more (${items.length} of ${total})`}
						</button>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Detail side panel -->
		{#if selectedItem}
			<!-- Mobile: full-screen overlay backdrop -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="md:hidden fixed inset-0 bg-black/50 z-40"
				onclick={closeDetail}
				onkeydown={() => {}}
			></div>

			<!-- Panel -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<aside
				class="detail-panel {isFullscreen ? 'fullscreen' : ''}"
				style="--panel-w: {panelWidth}px;"
				tabindex="-1"
				onkeydown={handlePanelKeydown}
			>
				<!-- Resize handle (desktop only, not in fullscreen) -->
				{#if !isFullscreen}
					<div
						class="hidden md:block absolute -left-1 top-0 bottom-0 w-2.5 cursor-ew-resize group z-10"
						onmousedown={startResize}
						role="separator"
						aria-orientation="vertical"
					>
						<div class="absolute left-1 top-0 bottom-0 w-0.5 bg-[var(--color-border)] group-hover:bg-[var(--color-accent)] transition-colors {isResizing ? 'bg-[var(--color-accent)]' : ''}"></div>
					</div>
				{/if}

				<!-- Header -->
				<div class="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-4 py-3 shrink-0">
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-sm font-medium text-[var(--color-text-primary)] truncate flex-1 min-w-0">
							{selectedItem.filename || 'Untitled'}
						</h2>
						<div class="flex items-center gap-0.5 flex-shrink-0">
							<!-- Expand / collapse -->
							<button
								onclick={() => isFullscreen = !isFullscreen}
								class="p-1.5 hover:bg-[var(--color-elevated)] rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
								title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
							>
								{#if isFullscreen}
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
									</svg>
								{:else}
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
									</svg>
								{/if}
							</button>
							<!-- Delete -->
							<button
								onclick={() => showDeleteConfirm = true}
								class="p-1.5 hover:bg-red-500/10 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-red-400"
								title="Delete"
								disabled={isDeleting}
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
								</svg>
							</button>
							<!-- Close -->
							<button
								onclick={closeDetail}
								class="p-1.5 hover:bg-[var(--color-elevated)] rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
								title="Close"
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
					</div>

					<!-- Delete confirmation -->
					{#if showDeleteConfirm}
						<div class="mt-3 p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
							<p class="text-xs text-[var(--color-text-secondary)] mb-2">Delete this file? This cannot be undone.</p>
							<div class="flex items-center gap-2 justify-end">
								<button
									onclick={() => showDeleteConfirm = false}
									class="px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded transition-colors"
								>
									Cancel
								</button>
								<button
									onclick={handleDelete}
									disabled={isDeleting}
									class="px-3 py-1 text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded transition-colors disabled:opacity-50"
								>
									{isDeleting ? 'Deleting...' : 'Delete'}
								</button>
							</div>
						</div>
					{/if}
				</div>

				<!-- Scrollable content -->
				<div class="flex-1 overflow-y-auto p-4">
					<!-- Preview -->
					<div class="mb-4">
						{#if selectedItem.type === 'image'}
							<button class="block cursor-pointer w-full" onclick={() => expandedImage = selectedItem?.url ?? null}>
								<img
									src={selectedItem.url}
									alt={selectedItem.description || selectedItem.filename || 'Image'}
									class="w-full rounded-lg border border-[var(--color-border)] object-contain"
									style="max-height: {isFullscreen ? '70vh' : '50vh'};"
								/>
							</button>
						{:else if selectedItem.type === 'video'}
							{#if selectedItem.embedUrl}
								<div class="relative aspect-video rounded-lg overflow-hidden border border-[var(--color-border)]">
									<iframe
										src={selectedItem.embedUrl}
										title="Video player"
										class="absolute inset-0 w-full h-full"
										allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
										allowfullscreen
									></iframe>
								</div>
							{:else if selectedItem.streamUid}
								<div class="flex items-center justify-center h-32 bg-[var(--color-elevated)] rounded-lg border border-[var(--color-border)]">
									<div class="animate-pulse text-[var(--color-text-tertiary)] text-sm">Loading video...</div>
								</div>
							{:else}
								<video controls preload="metadata" class="w-full rounded-lg border border-[var(--color-border)]">
									<source src={selectedItem.url} />
								</video>
							{/if}
						{:else if selectedItem.type === 'voice'}
							<div class="p-4 bg-[var(--color-elevated)] rounded-lg border border-[var(--color-border)]">
								<audio controls preload="metadata" class="w-full block">
									<source src={selectedItem.url} />
								</audio>
								{#if selectedItem.transcript}
									<p class="text-sm text-[var(--color-text-secondary)] mt-3 italic leading-relaxed">
										{selectedItem.transcript}
									</p>
								{/if}
							</div>
						{:else}
							<div class="p-6 bg-[var(--color-elevated)] rounded-lg border border-[var(--color-border)] text-center">
								<svg class="w-12 h-12 text-[var(--color-text-tertiary)] mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
									<polyline points="14 2 14 8 20 8"/>
								</svg>
								<a
									href={selectedItem.url}
									download={selectedItem.filename || true}
									class="inline-flex items-center gap-2 px-4 py-2 bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded-lg text-sm hover:bg-[var(--color-accent)]/20 transition-colors"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
									</svg>
									Download
								</a>
							</div>
						{/if}
					</div>

					<!-- Info -->
					<div class="space-y-3">
						<!-- Description -->
						<div>
							<div class="flex items-center justify-between">
								<span class="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wide">Description</span>
								{#if !editingDescription}
									<button
										onclick={startEditDescription}
										class="text-xs text-[var(--color-accent)] hover:underline"
									>
										Edit
									</button>
								{/if}
							</div>
							{#if editingDescription}
								<div class="mt-1 flex flex-col gap-2">
									<textarea
										bind:value={editDescription}
										class="w-full p-2 text-sm bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] resize-none focus:border-[var(--color-accent)] focus:outline-none"
										rows="3"
										placeholder="Add a description..."
									></textarea>
									<div class="flex items-center gap-2 justify-end">
										<button
											onclick={() => editingDescription = false}
											class="px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
										>
											Cancel
										</button>
										<button
											onclick={saveDescription}
											disabled={savingDescription}
											class="px-3 py-1 text-xs bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 disabled:opacity-50"
										>
											{savingDescription ? 'Saving...' : 'Save'}
										</button>
									</div>
								</div>
							{:else}
								<p class="text-sm text-[var(--color-text-secondary)] mt-0.5">
									{selectedItem.description || 'No description'}
								</p>
							{/if}
						</div>

						<!-- Meta -->
						<div class="flex items-center gap-3 flex-wrap text-xs text-[var(--color-text-tertiary)] pt-2 border-t border-[var(--color-border)]">
							{#if selectedItem.fileSize}
								<span>{formatFileSize(selectedItem.fileSize)}</span>
							{/if}
							<span class="capitalize">{selectedItem.type}</span>
							{#if selectedItem.createdAt}
								<span>{formatDate(selectedItem.createdAt)}</span>
							{/if}
						</div>
					</div>
				</div>
			</aside>
		{/if}
	</div>
</div>

<style>
	.media-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
	.media-header {
		flex-shrink: 0;
	}
	.media-body {
		flex: 1;
		display: flex;
		overflow: hidden;
	}
	.media-content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
	}

	.media-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 0.5rem;
	}

	@media (min-width: 640px) {
		.media-grid {
			grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
			gap: 0.75rem;
		}
	}

	.media-card {
		position: relative;
		aspect-ratio: 1;
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--color-border);
		cursor: pointer;
		transition: border-color 0.15s, transform 0.15s;
		background: var(--color-surface);
	}
	.media-card:hover {
		border-color: var(--color-accent);
		transform: scale(1.02);
	}

	.media-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		padding: 0.5rem;
		background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.media-card:hover .media-overlay {
		opacity: 1;
	}

	/* Detail panel */
	.detail-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 50;
		background: var(--color-surface);
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--color-border);
		box-shadow: -4px 0 24px rgba(0, 0, 0, 0.3);
	}

	@media (min-width: 768px) {
		.detail-panel {
			position: relative;
			top: auto;
			right: auto;
			bottom: auto;
			left: auto;
			width: var(--panel-w, 420px);
			flex-shrink: 0;
			z-index: 20;
		}
		.detail-panel.fullscreen {
			position: fixed;
			top: 0;
			right: 0;
			bottom: 0;
			left: 0;
			width: 100%;
			z-index: 50;
		}
	}

	.line-clamp-3 {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
