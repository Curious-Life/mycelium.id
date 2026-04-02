<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';
	import { api } from '$lib/api';

	const currentView = $derived($navigationState.primaryView);

	interface Folder {
		id: string;
		name: string;
		parent_id?: string | null;
		doc_count?: number;
	}

	interface FolderNode extends Folder {
		children: FolderNode[];
	}

	let folders = $state<Folder[]>([]);
	let loading = $state(true);
	let expandedIds = $state<Set<string>>(new Set());

	const activeFolderId = $derived($navigationState.activeFolderId);

	// Folder context menu
	let folderCtx = $state<{ x: number; y: number; folder: FolderNode } | null>(null);
	let showFolderDeleteConfirm = $state(false);
	let isDeletingFolder = $state(false);
	let renamingFolderId = $state<string | null>(null);
	let renameValue = $state('');
	let newSubfolderParentId = $state<string | null>(null);
	let newSubfolderName = $state('');
	let creatingSubfolder = $state(false);

	// New root folder
	let showNewFolderInput = $state(false);
	let newFolderName = $state('');
	let creatingFolder = $state(false);

	// Build tree from flat list
	const folderTree = $derived.by(() => {
		const map = new Map<string, FolderNode>();
		const roots: FolderNode[] = [];

		// Create nodes
		for (const f of folders) {
			map.set(f.id, { ...f, children: [] });
		}

		// Build hierarchy
		for (const f of folders) {
			const node = map.get(f.id)!;
			if (f.parent_id && map.has(f.parent_id)) {
				map.get(f.parent_id)!.children.push(node);
			} else {
				roots.push(node);
			}
		}

		return roots;
	});

	onMount(async () => {
		await loadFolders();
		loading = false;
	});

	async function loadFolders() {
		try {
			const res = await api('/portal/folders');
			if (res.ok) {
				const data = await res.json();
				folders = data.folders || [];
				// Auto-expand ancestors of active folder
				if (activeFolderId && activeFolderId !== 'starred') {
					expandAncestors(activeFolderId);
				}
			}
		} catch {}
	}

	function expandAncestors(folderId: string) {
		const parentMap = new Map<string, string>();
		for (const f of folders) {
			if (f.parent_id) parentMap.set(f.id, f.parent_id);
		}
		let current = folderId;
		while (parentMap.has(current)) {
			current = parentMap.get(current)!;
			expandedIds.add(current);
		}
		expandedIds = new Set(expandedIds);
	}

	function toggleExpand(id: string, e: MouseEvent) {
		e.stopPropagation();
		if (expandedIds.has(id)) {
			expandedIds.delete(id);
		} else {
			expandedIds.add(id);
		}
		expandedIds = new Set(expandedIds);
	}

	function selectFolder(id: string | null) {
		navigationState.setActiveFolder(id);
		if (currentView !== 'library') {
			navigationState.setPrimaryView('library');
			goto('/library');
		}
	}

	function selectAndExpand(folder: FolderNode) {
		selectFolder(folder.id);
		if (folder.children.length > 0 && !expandedIds.has(folder.id)) {
			expandedIds.add(folder.id);
			expandedIds = new Set(expandedIds);
		}
	}

	// Drag-and-drop: move documents to folders
	let dragOverFolderId = $state<string | null | 'all'>(null);

	function handleFolderDragOver(e: DragEvent, folderId: string | null) {
		if (!e.dataTransfer) return;
		const types = e.dataTransfer.types;
		const hasDocType = Array.from(types).includes('application/x-doc-path');
		if (!hasDocType) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		dragOverFolderId = folderId ?? 'all';
	}

	function handleFolderDragLeave(e: DragEvent) {
		const related = e.relatedTarget as HTMLElement | null;
		if (related && (e.currentTarget as HTMLElement)?.contains(related)) return;
		dragOverFolderId = null;
	}

	async function handleFolderDrop(e: DragEvent, folderId: string | null) {
		e.preventDefault();
		dragOverFolderId = null;
		const docPath = e.dataTransfer?.getData('application/x-doc-path');
		if (!docPath) return;
		try {
			const res = await api('/portal/documents/move', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: docPath, folder_id: folderId }),
			});
			if (res.ok) {
				window.dispatchEvent(new CustomEvent('doc-moved', { detail: { path: docPath, folderId } }));
			}
		} catch (e) {
			console.error('[LibraryNav] Failed to move document:', e);
		}
	}

	// ── Folder context menu ──

	function openFolderCtx(e: MouseEvent, folder: FolderNode) {
		e.preventDefault();
		e.stopPropagation();
		showFolderDeleteConfirm = false;
		folderCtx = { x: e.clientX, y: e.clientY, folder };
	}

	function closeFolderCtx() {
		folderCtx = null;
		showFolderDeleteConfirm = false;
	}

	function startRename(folder: FolderNode) {
		closeFolderCtx();
		renamingFolderId = folder.id;
		renameValue = folder.name;
	}

	async function submitRename(folderId: string) {
		if (!renameValue.trim()) { renamingFolderId = null; return; }
		try {
			const res = await api(`/portal/folders/${folderId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: renameValue.trim() }),
			});
			if (res.ok) {
				folders = folders.map(f => f.id === folderId ? { ...f, name: renameValue.trim() } : f);
			}
		} catch (e) {
			console.error('[LibraryNav] Failed to rename folder:', e);
		}
		renamingFolderId = null;
	}

	function startNewSubfolder(parentId: string) {
		closeFolderCtx();
		newSubfolderParentId = parentId;
		newSubfolderName = '';
		// Expand parent
		expandedIds.add(parentId);
		expandedIds = new Set(expandedIds);
	}

	async function submitNewSubfolder() {
		if (!newSubfolderName.trim() || creatingSubfolder) return;
		creatingSubfolder = true;
		try {
			const res = await api('/portal/folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newSubfolderName.trim(), parent_id: newSubfolderParentId }),
			});
			if (res.ok) {
				await loadFolders();
			}
		} catch (e) {
			console.error('[LibraryNav] Failed to create subfolder:', e);
		}
		creatingSubfolder = false;
		newSubfolderParentId = null;
		newSubfolderName = '';
	}

	async function deleteFolder(folderId: string) {
		isDeletingFolder = true;
		try {
			const res = await api(`/portal/folders/${folderId}`, { method: 'DELETE' });
			if (res.ok) {
				folders = folders.filter(f => f.id !== folderId);
				if (activeFolderId === folderId) {
					navigationState.setActiveFolder(null);
				}
				closeFolderCtx();
			}
		} catch (e) {
			console.error('[LibraryNav] Failed to delete folder:', e);
		}
		isDeletingFolder = false;
	}

	async function createNewFolder() {
		if (!newFolderName.trim() || creatingFolder) return;
		creatingFolder = true;
		try {
			const res = await api('/portal/folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newFolderName.trim() }),
			});
			if (res.ok) {
				await loadFolders();
				newFolderName = '';
				showNewFolderInput = false;
			}
		} catch (e) {
			console.error('[LibraryNav] Failed to create folder:', e);
		}
		creatingFolder = false;
	}

	const iconClass = 'w-4 h-4 flex-shrink-0';
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { closeFolderCtx(); renamingFolderId = null; newSubfolderParentId = null; showNewFolderInput = false; } }} />

{#snippet folderItem(folder: FolderNode, depth: number)}
	{@const isActive = activeFolderId === folder.id && currentView === 'library'}
	{@const isExpanded = expandedIds.has(folder.id)}
	{@const hasChildren = folder.children.length > 0}
	{@const isDragOver = dragOverFolderId === folder.id}
	{@const isRenaming = renamingFolderId === folder.id}
	{#if isRenaming}
		<div class="flex items-center gap-1.5 px-3 py-1" style="padding-left: {12 + depth * 16}px;">
			<span class="w-4 flex-shrink-0"></span>
			<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
			</svg>
			<input
				bind:value={renameValue}
				type="text"
				class="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-accent)] rounded text-[var(--color-text-primary)] focus:outline-none"
				onkeydown={(e) => { if (e.key === 'Enter') submitRename(folder.id); if (e.key === 'Escape') renamingFolderId = null; }}
				autofocus
			/>
		</div>
	{:else}
		<button
			class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer w-full text-sm relative
				{isDragOver
				? 'bg-[var(--color-accent)]/20 text-[var(--color-text-primary)] ring-1 ring-[var(--color-accent)]'
				: isActive
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-[var(--color-accent)] before:rounded-full'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
			style="padding-left: {12 + depth * 16}px;"
			onclick={() => selectAndExpand(folder)}
			oncontextmenu={(e) => openFolderCtx(e, folder)}
			ondragover={(e) => handleFolderDragOver(e, folder.id)}
			ondragleave={handleFolderDragLeave}
			ondrop={(e) => handleFolderDrop(e, folder.id)}
		>
			<!-- Expand chevron -->
			{#if hasChildren}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span
					class="w-4 h-4 flex items-center justify-center flex-shrink-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-transform duration-150"
					class:rotate-90={isExpanded}
					onclick={(e) => toggleExpand(folder.id, e)}
				>
					<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
					</svg>
				</span>
			{:else}
				<span class="w-4 flex-shrink-0"></span>
			{/if}
			<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				{#if isExpanded && hasChildren}
					<path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z"/>
				{:else}
					<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
				{/if}
			</svg>
			<span class="flex-1 text-left truncate">{folder.name}</span>
			{#if folder.doc_count}
				<span class="text-[0.65rem] text-[var(--color-text-tertiary)] flex-shrink-0">{folder.doc_count}</span>
			{/if}
		</button>
	{/if}
	{#if hasChildren && isExpanded}
		{#each folder.children as child (child.id)}
			{@render folderItem(child, depth + 1)}
		{/each}
	{/if}
	{#if newSubfolderParentId === folder.id}
		<div class="flex items-center gap-1.5 px-3 py-1" style="padding-left: {12 + (depth + 1) * 16}px;">
			<span class="w-4 flex-shrink-0"></span>
			<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
			</svg>
			<input
				bind:value={newSubfolderName}
				type="text"
				placeholder="Folder name..."
				class="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-accent)] rounded text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none"
				onkeydown={(e) => { if (e.key === 'Enter') submitNewSubfolder(); if (e.key === 'Escape') { newSubfolderParentId = null; newSubfolderName = ''; } }}
				autofocus
			/>
		</div>
	{/if}
{/snippet}

<div class="flex flex-col h-full">
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<div class="animate-pulse text-[var(--color-text-tertiary)] text-sm">Loading...</div>
		</div>
	{:else}
		<!-- Library section -->
		<div class="px-2 py-3 flex-1 overflow-y-auto">
			<div class="px-2 mb-2">
				<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
					Library
				</span>
			</div>

			<!-- All Documents -->
			<button
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer w-full text-sm relative
					{dragOverFolderId === 'all'
					? 'bg-[var(--color-accent)]/20 text-[var(--color-text-primary)] ring-1 ring-[var(--color-accent)]'
					: activeFolderId === null && currentView === 'library'
					? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-[var(--color-accent)] before:rounded-full'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
				onclick={() => selectFolder(null)}
				ondragover={(e) => handleFolderDragOver(e, null)}
				ondragleave={handleFolderDragLeave}
				ondrop={(e) => handleFolderDrop(e, null)}
			>
				<span class="w-4"></span>
				<span class="text-[var(--color-text-tertiary)]">
					<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
						<polyline points="14 2 14 8 20 8"/>
						<line x1="16" y1="13" x2="8" y2="13"/>
						<line x1="16" y1="17" x2="8" y2="17"/>
					</svg>
				</span>
				<span class="flex-1 text-left truncate">All Documents</span>
			</button>

			<!-- Starred (smart folder) -->
			<button
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer w-full text-sm relative
					{activeFolderId === 'starred' && currentView === 'library'
					? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-[var(--color-accent)] before:rounded-full'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
				onclick={() => selectFolder('starred')}
			>
				<span class="w-4"></span>
				<span class="text-[var(--color-text-tertiary)]">
					<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
					</svg>
				</span>
				<span class="flex-1 text-left truncate">Starred</span>
			</button>

			<!-- Media -->
			<button
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer w-full text-sm relative
					{currentView === 'media'
					? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-[var(--color-accent)] before:rounded-full'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
				onclick={() => { navigationState.setPrimaryView('media'); goto('/media'); }}
			>
				<span class="w-4"></span>
				<span class="text-[var(--color-text-tertiary)]">
					<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<circle cx="8.5" cy="8.5" r="1.5" />
						<path stroke-linecap="round" stroke-linejoin="round" d="m21 15-5-5L5 21" />
					</svg>
				</span>
				<span class="flex-1 text-left truncate">Media</span>
			</button>

			<!-- Divider + Folders tree -->
			<div class="mx-1 my-2 h-px bg-[var(--color-border)]"></div>

			<div class="flex items-center justify-between px-2 mb-2">
				<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
					Folders
				</span>
				<button
					onclick={() => { showNewFolderInput = !showNewFolderInput; if (!showNewFolderInput) newFolderName = ''; }}
					class="p-0.5 rounded transition-colors {showNewFolderInput ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
					title="New folder"
				>
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
					</svg>
				</button>
			</div>

			{#if showNewFolderInput}
				<div class="flex items-center gap-1.5 px-3 py-1 mb-1">
					<span class="w-4 flex-shrink-0"></span>
					<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
					</svg>
					<input
						bind:value={newFolderName}
						type="text"
						placeholder="Folder name..."
						class="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-accent)] rounded text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none"
						onkeydown={(e) => { if (e.key === 'Enter') createNewFolder(); if (e.key === 'Escape') { showNewFolderInput = false; newFolderName = ''; } }}
						autofocus
					/>
				</div>
			{/if}

			{#each folderTree as folder (folder.id)}
				{@render folderItem(folder, 0)}
			{/each}
		</div>
	{/if}
</div>

<!-- Folder context menu -->
{#if folderCtx}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 z-40" onclick={closeFolderCtx} oncontextmenu={(e) => { e.preventDefault(); closeFolderCtx(); }}></div>
	<div
		class="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 min-w-[160px]"
		style="left: {folderCtx.x}px; top: {folderCtx.y}px;"
	>
		{#if showFolderDeleteConfirm}
			<div class="px-3 py-2">
				<p class="text-sm text-[var(--color-text-primary)] mb-2">Delete folder?</p>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-3">Documents will be moved to All Documents.</p>
				<div class="flex items-center gap-2 justify-end">
					<button
						onclick={() => { showFolderDeleteConfirm = false; }}
						class="px-2.5 py-1 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] transition-colors"
					>Cancel</button>
					<button
						onclick={() => deleteFolder(folderCtx!.folder.id)}
						disabled={isDeletingFolder}
						class="px-2.5 py-1 text-xs rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
					>{isDeletingFolder ? 'Deleting...' : 'Delete'}</button>
				</div>
			</div>
		{:else}
			<button onclick={() => startNewSubfolder(folderCtx!.folder.id)} class="folder-ctx-item">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M12 4v16m8-8H4"/></svg>
				Add subfolder
			</button>
			<button onclick={() => startRename(folderCtx!.folder)} class="folder-ctx-item">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
				Rename
			</button>
			<div class="mx-2 my-1 h-px bg-[var(--color-border)]"></div>
			<button onclick={() => { showFolderDeleteConfirm = true; }} class="folder-ctx-item text-red-400 hover:!bg-red-500/10">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
				Delete
			</button>
		{/if}
	</div>
{/if}

<style>
	.rotate-90 {
		transform: rotate(90deg);
	}

	.folder-ctx-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		transition: all 0.1s;
		text-align: left;
	}
	.folder-ctx-item:hover {
		background: var(--color-elevated);
		color: var(--color-text-primary);
	}
</style>
