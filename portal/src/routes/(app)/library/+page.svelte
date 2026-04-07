<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { navigationState } from '$lib/stores/navigation';
	import { api } from '$lib/api';

	marked.use({ gfm: true, breaks: true });

	// List item from /portal/documents (lightweight — no full content)
	interface DocListItem {
		path: string;
		title?: string;
		summary?: string;
		source_type?: string;
		created_by?: string;
		updated_at?: string;
		pinned?: number | boolean;
		folder_id?: string;
	}

	// Full document from /portal/documents/:path
	interface DocFull extends DocListItem {
		content?: string;
	}

	interface Folder {
		id: string;
		name: string;
		parent_id?: string;
	}

	let documents = $state<DocListItem[]>([]);
	let folders = $state<Folder[]>([]);
	let selectedDoc = $state<DocFull | null>(null);
	let loadingDoc = $state(false);
	let searchQuery = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let copySuccess = $state(false);
	let viewMode = $state<'grid' | 'list'>('grid');

	// Edit mode
	let editing = $state(false);
	let editContent = $state('');
	let saving = $state(false);
	let editorRef = $state<HTMLTextAreaElement | null>(null);
	let showRawMarkdown = $state(false);
	const activeFolderId = $derived($navigationState.activeFolderId);

	// New document
	let showNewDocInput = $state(false);
	let newDocTitle = $state('');
	let creatingDoc = $state(false);

	// Drag state
	let draggingDoc = $state<string | null>(null);

	// Context menu
	let contextMenu = $state<{ x: number; y: number; doc: DocListItem } | null>(null);
	let showDeleteConfirm = $state(false);
	let isDeleting = $state(false);
	let showMoveMenu = $state(false);

	// Long-press for mobile
	let longPressTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let longPressStartPos = $state<{ x: number; y: number } | null>(null);

	// Track previous folder to detect changes
	let prevFolderId = $state<string | null | undefined>(undefined);

	onMount(async () => {
		await Promise.all([loadDocuments(), loadFolders()]);
		loading = false;
		prevFolderId = activeFolderId;

		// Handle browser back/forward
		function handlePopState(e: PopStateEvent) {
			if (e.state?.docPath) {
				const doc = documents.find(d => d.path === e.state.docPath);
				if (doc) {
					selectDoc(doc, false);
				}
			} else {
				selectedDoc = null;
				editing = false;
			}
		}

		// Reload after drag-and-drop move
		function handleDocMoved() {
			loadDocuments();
		}

		window.addEventListener('popstate', handlePopState);
		window.addEventListener('doc-moved', handleDocMoved);
		return () => {
			window.removeEventListener('popstate', handlePopState);
			window.removeEventListener('doc-moved', handleDocMoved);
		};
	});

	// Reload documents when activeFolderId changes
	$effect(() => {
		const current = activeFolderId;
		if (prevFolderId !== undefined && current !== prevFolderId) {
			prevFolderId = current;
			selectedDoc = null;
			editing = false;
			loadDocuments();
		}
	});

	async function loadDocuments() {
		loadError = null;
		try {
			let url = '/portal/documents';
			const params = new URLSearchParams();
			if (activeFolderId === 'starred') {
				params.set('pinned', '1');
			} else if (activeFolderId) {
				params.set('folder_id', activeFolderId);
			}
			const qs = params.toString();
			if (qs) url += `?${qs}`;

			const res = await api(url);
			if (res.ok) {
				const data = await res.json();
				documents = data.documents || [];
			} else {
				console.error('[Library] Failed to load documents:', res.status, res.statusText);
				loadError = `Failed to load documents (${res.status})`;
			}
		} catch (e) {
			console.error('[Library] Error loading documents:', e);
			loadError = e instanceof Error ? e.message : 'Failed to load documents';
		}
	}

	async function loadFolders() {
		try {
			const res = await api('/portal/folders');
			if (res.ok) {
				const data = await res.json();
				folders = data.folders || [];
			}
		} catch (e) {
			console.error('[Library] Error loading folders:', e);
		}
	}

	const filteredDocs = $derived.by(() => {
		let docs = documents;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			docs = docs.filter(d =>
				(d.title || d.path).toLowerCase().includes(q) ||
				d.summary?.toLowerCase().includes(q)
			);
		}
		return docs;
	});

	async function selectDoc(doc: DocListItem, pushHistory = true) {
		loadingDoc = true;
		editing = false;
		selectedDoc = { ...doc, content: '' };
		if (browser && pushHistory) {
			history.pushState({ docPath: doc.path }, '', `/library?doc=${encodeURIComponent(doc.path)}`);
		}
		try {
			const res = await api(`/portal/documents/${doc.path}`);
			if (res.ok) {
				const data = await res.json();
				selectedDoc = { ...doc, ...data.document };
			}
		} catch {}
		loadingDoc = false;
	}

	function startEditing() {
		if (!selectedDoc) return;
		editContent = selectedDoc.content || '';
		editing = true;
		showRawMarkdown = true;
	}

	function cancelEditing() {
		editing = false;
		editContent = '';
		showRawMarkdown = false;
	}

	async function saveDocument() {
		if (!selectedDoc) return;
		saving = true;
		try {
			const res = await api('/portal/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: selectedDoc.path,
					title: selectedDoc.title,
					content: editContent,
				}),
			});
			if (res.ok) {
				selectedDoc = { ...selectedDoc, content: editContent };
				editing = false;
			}
		} catch (e) {
			console.error('[Library] Failed to save:', e);
		}
		saving = false;
	}

	async function togglePin(doc: DocListItem, e?: MouseEvent) {
		if (e) { e.stopPropagation(); e.preventDefault(); }
		const newPinned = !doc.pinned;
		try {
			const res = await api('/portal/documents/pin', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: doc.path, pinned: newPinned }),
			});
			if (res.ok) {
				documents = documents.map(d =>
					d.path === doc.path ? { ...d, pinned: newPinned } : d
				);
				if (selectedDoc?.path === doc.path) {
					selectedDoc = { ...selectedDoc, pinned: newPinned };
				}
			}
		} catch (e) {
			console.error('[Library] Failed to toggle pin:', e);
		}
	}

	// ── Markdown rendering with interactive checkboxes ──

	function renderMarkdown(content: string, interactive = false): string {
		if (!content) return '';
		const raw = marked.parse(content, { async: false }) as string;
		let html = DOMPurify.sanitize(raw, {
			ADD_ATTR: ['data-checkbox-index'],
		});

		// Post-process: make checkboxes interactive with data attributes
		if (interactive) {
			let checkboxIndex = 0;
			html = html.replace(/<input\s+(?:checked\s+)?type="checkbox"\s*(?:checked\s+)?(?:disabled\s+)?\/?\s*>/gi, (match) => {
				const checked = /checked/i.test(match);
				const idx = checkboxIndex++;
				return `<input type="checkbox" data-checkbox-index="${idx}" ${checked ? 'checked' : ''} class="doc-checkbox" />`;
			});
		}

		return html;
	}

	// Toggle a checkbox in markdown source by its index
	function toggleCheckboxInContent(content: string, checkboxIndex: number): string {
		let idx = 0;
		return content.replace(/- \[([ xX])\]/g, (match, check) => {
			if (idx++ === checkboxIndex) {
				return check.trim() ? '- [ ]' : '- [x]';
			}
			return match;
		});
	}

	// Handle checkbox click in read-only preview mode
	async function handleReadOnlyCheckboxClick(checkboxIndex: number) {
		if (!selectedDoc?.content) return;
		const updated = toggleCheckboxInContent(selectedDoc.content, checkboxIndex);
		selectedDoc = { ...selectedDoc, content: updated };
		// Auto-save
		try {
			await api('/portal/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: selectedDoc.path,
					title: selectedDoc.title,
					content: updated,
				}),
			});
		} catch (e) {
			console.error('[Library] Auto-save failed:', e);
		}
	}

	// Handle checkbox click in editor preview pane
	function handleEditorCheckboxClick(checkboxIndex: number) {
		editContent = toggleCheckboxInContent(editContent, checkboxIndex);
	}

	// Delegate click events from rendered markdown
	function handleContentClick(e: MouseEvent, mode: 'readonly' | 'editor') {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT' && target.classList.contains('doc-checkbox')) {
			e.preventDefault();
			const idx = parseInt(target.getAttribute('data-checkbox-index') || '0');
			if (mode === 'readonly') {
				handleReadOnlyCheckboxClick(idx);
			} else {
				handleEditorCheckboxClick(idx);
			}
		}
	}

	// ── Formatting toolbar ──

	function insertFormat(before: string, after: string = '') {
		if (!editorRef) return;
		const start = editorRef.selectionStart;
		const end = editorRef.selectionEnd;
		const selected = editContent.substring(start, end);
		const replacement = before + (selected || 'text') + after;
		editContent = editContent.substring(0, start) + replacement + editContent.substring(end);

		// Restore cursor
		requestAnimationFrame(() => {
			if (!editorRef) return;
			editorRef.focus();
			if (selected) {
				editorRef.selectionStart = start;
				editorRef.selectionEnd = start + replacement.length;
			} else {
				editorRef.selectionStart = start + before.length;
				editorRef.selectionEnd = start + before.length + 4; // select 'text'
			}
		});
	}

	function insertLinePrefix(prefix: string) {
		if (!editorRef) return;
		const start = editorRef.selectionStart;
		// Find the start of the current line
		const lineStart = editContent.lastIndexOf('\n', start - 1) + 1;
		editContent = editContent.substring(0, lineStart) + prefix + editContent.substring(lineStart);

		requestAnimationFrame(() => {
			if (!editorRef) return;
			editorRef.focus();
			editorRef.selectionStart = editorRef.selectionEnd = start + prefix.length;
		});
	}

	function handleEditorKeydown(e: KeyboardEvent) {
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key === 'b') {
			e.preventDefault();
			insertFormat('**', '**');
		} else if (mod && e.key === 'i') {
			e.preventDefault();
			insertFormat('*', '*');
		} else if (mod && e.key === 'k') {
			e.preventDefault();
			insertFormat('[', '](url)');
		} else if (mod && e.key === 's') {
			e.preventDefault();
			saveDocument();
		}
	}

	// ── Helpers ──

	function getCategoryFromPath(path?: string): string | null {
		if (!path) return null;
		const parts = path.split('/');
		return parts.length > 1 ? parts[0] : null;
	}

	function formatDate(dateStr?: string, relative = false) {
		if (!dateStr) return '';
		const d = new Date(dateStr);
		if (relative) {
			const now = Date.now();
			const diff = now - d.getTime();
			const mins = Math.floor(diff / 60000);
			if (mins < 1) return 'Just now';
			if (mins < 60) return `${mins}m ago`;
			const hrs = Math.floor(mins / 60);
			if (hrs < 24) return `${hrs}h ago`;
			const days = Math.floor(hrs / 24);
			if (days < 7) return `${days}d ago`;
		}
		return d.toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', year: 'numeric'
		});
	}

	function wordCount(content?: string): number {
		if (!content) return 0;
		return content.trim().split(/\s+/).filter(Boolean).length;
	}

	function getSourceLabel(source?: string): string | null {
		if (!source) return null;
		switch (source) {
			case 'import_obsidian': case 'obsidian': return 'Obsidian';
			case 'import_claude': case 'claude': return 'Claude';
			case 'import_chatgpt': case 'chatgpt': return 'ChatGPT';
			case 'transcription': return 'Call Transcript';
			case 'upload': return 'Upload';
			case 'portal': case 'native': return null;
			default: return null;
		}
	}

	const AGENT_NAMES: Record<string, string> = {
		'personal-agent': 'Mya',
		'mya-personal': 'Mya',
		'company-agent': 'Com',
		'research-agent': 'Ada',
		'commercial-intelligence-agent': 'Rex',
		'publishing-agent': 'Noa',
		'wealth-agent': 'Rob',
		'qa-agent': 'QA',
		'intel-agent': 'Apollo',
		'moms-agent': 'Māra',
	};

	function getAuthorLabel(createdBy?: string): string | null {
		if (!createdBy) return null;
		if (createdBy === 'user') return 'You';
		return AGENT_NAMES[createdBy] || createdBy;
	}

	function getFolderLabel(): string {
		if (!activeFolderId) return 'All Documents';
		if (activeFolderId === 'starred') return 'Starred';
		const folder = folders.find(f => f.id === activeFolderId);
		return folder?.name || 'Folder';
	}

	function handleDragStart(e: DragEvent, doc: DocListItem) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData('application/x-doc-path', doc.path);
		e.dataTransfer.setData('text/plain', doc.title || doc.path);
		e.dataTransfer.effectAllowed = 'move';
		draggingDoc = doc.path;
	}

	function handleDragEnd() {
		draggingDoc = null;
	}

	// ── Context menu ──

	function openContextMenu(e: MouseEvent, doc: DocListItem) {
		e.preventDefault();
		e.stopPropagation();
		showDeleteConfirm = false;
		showMoveMenu = false;
		contextMenu = { x: e.clientX, y: e.clientY, doc };
	}

	function closeContextMenu() {
		contextMenu = null;
		showDeleteConfirm = false;
		showMoveMenu = false;
	}

	function handleTouchStart(e: TouchEvent, doc: DocListItem) {
		const touch = e.touches[0];
		longPressStartPos = { x: touch.clientX, y: touch.clientY };
		longPressTimer = setTimeout(() => {
			e.preventDefault();
			if (navigator.vibrate) navigator.vibrate(50);
			showDeleteConfirm = false;
			showMoveMenu = false;
			contextMenu = { x: longPressStartPos!.x, y: longPressStartPos!.y, doc };
		}, 500);
	}

	function handleTouchMove(e: TouchEvent) {
		if (!longPressTimer || !longPressStartPos) return;
		const touch = e.touches[0];
		const dx = touch.clientX - longPressStartPos.x;
		const dy = touch.clientY - longPressStartPos.y;
		if (Math.sqrt(dx * dx + dy * dy) > 10) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	function handleTouchEnd() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	async function deleteDocument(doc: DocListItem) {
		isDeleting = true;
		try {
			const encodedPath = doc.path.split('/').map(encodeURIComponent).join('/');
			const res = await api(`/portal/documents/${encodedPath}`, { method: 'DELETE' });
			if (res.ok) {
				documents = documents.filter(d => d.path !== doc.path);
				if (selectedDoc?.path === doc.path) {
					selectedDoc = null;
					editing = false;
				}
				closeContextMenu();
			} else {
				console.error('[Library] Delete failed:', res.status);
			}
		} catch (e) {
			console.error('[Library] Failed to delete document:', e);
		}
		isDeleting = false;
	}

	async function moveDocToFolder(doc: DocListItem, folderId: string | null) {
		try {
			const res = await api('/portal/documents/move', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: doc.path, folder_id: folderId }),
			});
			if (res.ok) {
				closeContextMenu();
				loadDocuments();
			}
		} catch (e) {
			console.error('[Library] Failed to move document:', e);
		}
	}

	async function createNewDocument() {
		if (!newDocTitle.trim() || creatingDoc) return;
		creatingDoc = true;
		try {
			const slug = newDocTitle.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
			const path = slug;
			const folderId = activeFolderId && activeFolderId !== 'starred' ? activeFolderId : null;
			const res = await api('/portal/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path,
					title: newDocTitle.trim(),
					content: '',
					folder_id: folderId,
				}),
			});
			if (res.ok) {
				newDocTitle = '';
				showNewDocInput = false;
				await loadDocuments();
				// Open the new doc and start editing
				const newDoc = documents.find(d => d.path === path);
				if (newDoc) {
					await selectDoc(newDoc);
					startEditing();
				}
			}
		} catch (e) {
			console.error('[Library] Failed to create document:', e);
		}
		creatingDoc = false;
	}

	async function copyDocumentContent() {
		if (!selectedDoc?.content) return;
		try {
			await navigator.clipboard.writeText(selectedDoc.content);
			copySuccess = true;
			setTimeout(() => copySuccess = false, 2000);
		} catch { /* ignore */ }
	}

	function downloadDocument() {
		if (!selectedDoc?.content) return;
		const title = selectedDoc.title || selectedDoc.path || 'document';
		const blob = new Blob([selectedDoc.content], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') closeContextMenu(); }} />

<svelte:head>
	<title>Library - Mycelium</title>
</svelte:head>

<div class="library-page">
	<!-- Header -->
	<div class="library-header px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]/50">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2 sm:gap-3 min-w-0">
				<span class="text-[var(--color-text-tertiary)]">
					<svg class="w-6 h-6 sm:w-7 sm:h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
						<polyline points="14 2 14 8 20 8"/>
						<line x1="16" y1="13" x2="8" y2="13"/>
						<line x1="16" y1="17" x2="8" y2="17"/>
					</svg>
				</span>
				<div class="min-w-0">
					<h1 class="text-lg sm:text-xl font-medium text-[var(--color-text-primary)] truncate">{getFolderLabel()}</h1>
					<p class="text-xs sm:text-sm text-[var(--color-text-tertiary)]">
						{filteredDocs.length} {filteredDocs.length === 1 ? 'document' : 'documents'}
					</p>
				</div>
			</div>

			<div class="flex items-center gap-2">
				<!-- Search -->
				<div class="relative">
					<input
						bind:value={searchQuery}
						type="text"
						placeholder="Search..."
						class="w-36 sm:w-48 pl-8 pr-3 py-1.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
					</svg>
				</div>

				<!-- New document -->
				<button
					onclick={() => { showNewDocInput = !showNewDocInput; if (!showNewDocInput) newDocTitle = ''; }}
					class="p-1.5 rounded-lg transition-colors {showNewDocInput ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
					title="New document"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
					</svg>
				</button>

				<!-- View mode toggle -->
				<div class="flex items-center gap-0.5 p-0.5 bg-[var(--color-elevated)] rounded-lg">
					<button
						class="p-1.5 rounded transition-colors {viewMode === 'list' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
						onclick={() => viewMode = 'list'}
						title="List view"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
						</svg>
					</button>
					<button
						class="p-1.5 rounded transition-colors {viewMode === 'grid' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
						onclick={() => viewMode = 'grid'}
						title="Grid view"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
						</svg>
					</button>
				</div>
			</div>
		</div>

		<!-- New document input -->
		{#if showNewDocInput}
			<div class="flex items-center gap-2 mt-3">
				<input
					bind:value={newDocTitle}
					type="text"
					placeholder="Document title..."
					class="flex-1 px-3 py-1.5 text-sm bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
					onkeydown={(e) => { if (e.key === 'Enter') createNewDocument(); if (e.key === 'Escape') { showNewDocInput = false; newDocTitle = ''; } }}
					autofocus
				/>
				<button
					onclick={createNewDocument}
					disabled={!newDocTitle.trim() || creatingDoc}
					class="px-3 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
				>
					{creatingDoc ? 'Creating...' : 'Create'}
				</button>
			</div>
		{/if}
	</div>

	<!-- Content -->
	<div class="library-content p-3 sm:p-6" class:no-scroll={!!selectedDoc}>
		{#if loading}
			<div class="flex items-center justify-center h-full">
				<div class="text-center">
					<div class="w-10 h-10 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin mx-auto mb-4"></div>
					<p class="text-[var(--color-text-tertiary)] text-sm">Loading...</p>
				</div>
			</div>
		{:else if loadError}
			<div class="flex items-center justify-center h-full p-8">
				<div class="text-center max-w-md">
					<div class="w-16 h-16 rounded-full bg-coral/10 flex items-center justify-center mx-auto mb-4">
						<svg class="w-8 h-8 text-coral" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
						</svg>
					</div>
					<h3 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Could not load library</h3>
					<p class="text-sm text-[var(--color-text-secondary)] mb-4">{loadError}</p>
					<button
						onclick={() => { loadError = null; loading = true; loadDocuments().then(() => loading = false); }}
						class="px-4 py-2 text-sm bg-[var(--color-elevated)] hover:bg-[var(--color-border)] text-[var(--color-text-primary)] rounded-lg transition-colors"
					>
						Try again
					</button>
				</div>
			</div>
		{:else if filteredDocs.length === 0}
			<div class="flex items-center justify-center h-full p-8">
				<div class="text-center max-w-md">
					<div class="w-16 h-16 rounded-full bg-[var(--color-elevated)] flex items-center justify-center mx-auto mb-4">
						<svg class="w-8 h-8 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
							<polyline points="14 2 14 8 20 8"/>
						</svg>
					</div>
					<h3 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">
						{searchQuery ? 'No results found' : 'No documents yet'}
					</h3>
					<p class="text-sm text-[var(--color-text-secondary)]">
						{searchQuery ? 'Try a different search term.' : 'Import from Obsidian or create documents via chat.'}
					</p>
				</div>
			</div>
		{:else if selectedDoc}
			<!-- Document detail view -->
			<div class="doc-detail-view max-w-4xl mx-auto">
				<!-- Back button -->
				<button
					onclick={() => { if (browser) { history.back(); } else { selectedDoc = null; editing = false; } }}
					class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] mb-4 transition-colors"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
					</svg>
					Back to library
				</button>

				<!-- Header with actions -->
				<div class="flex items-start justify-between gap-4 mb-4">
					<div class="flex-1 min-w-0">
						<h1 class="text-2xl font-medium text-[var(--color-text-emphasis)]">
							{selectedDoc.title || selectedDoc.path}
						</h1>
						<div class="flex items-center gap-3 mt-2 flex-wrap">
							{#if getCategoryFromPath(selectedDoc.path)}
								<span class="tag-warm">{getCategoryFromPath(selectedDoc.path)}</span>
							{/if}
							{#if getAuthorLabel(selectedDoc.created_by)}
								<span class="text-xs text-[var(--color-text-tertiary)]">
									by {getAuthorLabel(selectedDoc.created_by)}
								</span>
							{/if}
							{#if getSourceLabel(selectedDoc.source_type)}
								<span class="text-xs text-[var(--color-text-tertiary)]">
									via {getSourceLabel(selectedDoc.source_type)}
								</span>
							{/if}
							{#if selectedDoc.content}
								<span class="text-xs text-[var(--color-text-tertiary)]">
									{wordCount(selectedDoc.content).toLocaleString()} words
								</span>
							{/if}
							{#if selectedDoc.updated_at}
								<span class="text-xs text-[var(--color-text-tertiary)]" title={new Date(selectedDoc.updated_at).toLocaleString()}>
									Updated {formatDate(selectedDoc.updated_at, true)}
								</span>
							{/if}
						</div>
					</div>

					<!-- Action buttons -->
					<div class="flex items-center gap-1 flex-shrink-0">
						<!-- Pin/unpin -->
						<button
							onclick={(e) => togglePin(selectedDoc!, e)}
							class="p-2 rounded-lg transition-colors {selectedDoc.pinned ? 'text-aurum hover:bg-aurum/10' : 'text-[var(--color-text-secondary)] hover:bg-azure/20 hover:text-azure'}"
							aria-label={selectedDoc.pinned ? 'Unstar' : 'Star'}
							title={selectedDoc.pinned ? 'Unstar' : 'Star'}
						>
							<svg class="w-5 h-5" fill={selectedDoc.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
							</svg>
						</button>
						<!-- Edit -->
						{#if !editing}
							<button
								onclick={startEditing}
								class="p-2 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure"
								aria-label="Edit"
								title="Edit document"
							>
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
									<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
								</svg>
							</button>
						{/if}
						<button
							onclick={downloadDocument}
							class="p-2 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure"
							aria-label="Download"
							title="Download as markdown"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
							</svg>
						</button>
						<button
							onclick={copyDocumentContent}
							class="p-2 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure"
							aria-label="Copy content"
							title="Copy content"
						>
							{#if copySuccess}
								<svg class="w-5 h-5 text-jade" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 13l4 4L19 7" />
								</svg>
							{:else}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
								</svg>
							{/if}
						</button>
						<!-- Delete -->
						<button
							onclick={() => { contextMenu = { x: 0, y: 0, doc: selectedDoc! }; showDeleteConfirm = true; }}
							class="p-2 hover:bg-red-500/10 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-red-400"
							aria-label="Delete"
							title="Delete document"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
							</svg>
						</button>
					</div>
				</div>

				<!-- Divider -->
				<div class="border-t border-[var(--color-border)] mb-6"></div>

				<!-- Content -->
				{#if loadingDoc}
					<div class="flex items-center justify-center py-12">
						<div class="w-8 h-8 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
					</div>
				{:else if editing}
					<!-- ═══ EDITOR MODE ═══ -->
					<div class="flex flex-col gap-3">
						<!-- Editor toolbar -->
						<div class="flex items-center justify-between gap-2 flex-wrap">
							{#if showRawMarkdown}
								<div class="flex items-center gap-1 flex-wrap">
									<button onclick={() => insertFormat('**', '**')} class="toolbar-btn" title="Bold (Ctrl+B)">
										<strong>B</strong>
									</button>
									<button onclick={() => insertFormat('*', '*')} class="toolbar-btn" title="Italic (Ctrl+I)">
										<em>I</em>
									</button>
									<button onclick={() => insertFormat('`', '`')} class="toolbar-btn" title="Inline code">
										<code class="text-[10px]">&lt;/&gt;</code>
									</button>
									<div class="w-px h-5 bg-[var(--color-border)] mx-1"></div>
									<button onclick={() => insertLinePrefix('## ')} class="toolbar-btn" title="Heading">H2</button>
									<button onclick={() => insertLinePrefix('### ')} class="toolbar-btn" title="Subheading">H3</button>
									<div class="w-px h-5 bg-[var(--color-border)] mx-1"></div>
									<button onclick={() => insertLinePrefix('- ')} class="toolbar-btn" title="Bullet list">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
									</button>
									<button onclick={() => insertLinePrefix('- [ ] ')} class="toolbar-btn" title="Todo checkbox">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
									</button>
									<button onclick={() => insertLinePrefix('> ')} class="toolbar-btn" title="Blockquote">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M10 11h-4a1 1 0 01-1-1v-3a1 1 0 011-1h3a1 1 0 011 1v6c0 2.667-1.333 4.333-4 5M19 11h-4a1 1 0 01-1-1v-3a1 1 0 011-1h3a1 1 0 011 1v6c0 2.667-1.333 4.333-4 5" /></svg>
									</button>
									<button onclick={() => insertFormat('[', '](url)')} class="toolbar-btn" title="Link (Ctrl+K)">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
									</button>
								</div>
							{:else}
								<span class="text-xs text-[var(--color-text-tertiary)]">
									{wordCount(editContent).toLocaleString()} words &middot; {editContent.length.toLocaleString()} chars
								</span>
							{/if}

							<!-- Formatted / Markdown toggle -->
							<button
								onclick={() => showRawMarkdown = !showRawMarkdown}
								class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors {showRawMarkdown ? 'border-[var(--color-accent)]/40 text-[var(--color-accent)] bg-[var(--color-accent)]/5' : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-tertiary)]'}"
							>
								<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<path d="M16 18L22 12L16 6M8 6L2 12L8 18" />
								</svg>
								{showRawMarkdown ? 'Preview' : 'Edit'}
							</button>
						</div>

						<!-- Content: formatted view or raw markdown -->
						{#if showRawMarkdown}
							<textarea
								bind:this={editorRef}
								bind:value={editContent}
								onkeydown={handleEditorKeydown}
								class="editor-textarea"
								placeholder="Write in markdown..."
							></textarea>
						{:else}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="doc-content"
								onclick={(e) => handleContentClick(e, 'editor')}
							>
								{@html renderMarkdown(editContent, true)}
							</div>
						{/if}

						<!-- Footer: save/cancel -->
						<div class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
							<button
								onclick={cancelEditing}
								class="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded-lg transition-colors"
							>
								Cancel
							</button>
							<button
								onclick={saveDocument}
								disabled={saving}
								class="px-4 py-2 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
							>
								{saving ? 'Saving...' : 'Save'}
							</button>
						</div>
					</div>
				{:else}
					<!-- ═══ READ-ONLY VIEW ═══ -->
					{#if selectedDoc.content}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="doc-content"
							onclick={(e) => handleContentClick(e, 'readonly')}
						>
							{@html renderMarkdown(selectedDoc.content, true)}
						</div>
					{:else}
						<p class="text-[var(--color-text-tertiary)] text-sm">No content available.</p>
					{/if}
				{/if}
			</div>
		{:else if viewMode === 'list'}
			<!-- List view -->
			<div class="max-w-3xl mx-auto space-y-1.5">
				{#each filteredDocs as doc}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => selectDoc(doc)}
						onkeydown={(e) => { if (e.key === 'Enter') selectDoc(doc); }}
						oncontextmenu={(e) => openContextMenu(e, doc)}
						ontouchstart={(e) => handleTouchStart(e, doc)}
						ontouchmove={handleTouchMove}
						ontouchend={handleTouchEnd}
						draggable={true}
						ondragstart={(e) => handleDragStart(e, doc)}
						ondragend={handleDragEnd}
						role="button"
						tabindex="0"
						class="flex items-start gap-2 sm:gap-3 rounded-lg sm:rounded-xl p-2.5 sm:p-3 transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] w-full text-left border-[var(--color-border)] hover:border-aurum/50 group {draggingDoc === doc.path ? 'opacity-40' : ''}"
					>
						<span class="text-[var(--color-text-tertiary)] flex-shrink-0 w-8 sm:w-10 flex items-center justify-center pt-0.5">
							<svg class="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
								<polyline points="14 2 14 8 20 8"/>
								<line x1="16" y1="13" x2="8" y2="13"/>
								<line x1="16" y1="17" x2="8" y2="17"/>
							</svg>
						</span>
						<div class="flex-1 min-w-0 text-left">
							<div class="flex items-center gap-1.5 sm:gap-2 mb-0.5">
								{#if doc.pinned}
									<svg class="w-3.5 h-3.5 text-aurum flex-shrink-0" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
									</svg>
								{/if}
								<h3 class="text-sm sm:text-base font-medium text-[var(--color-text-primary)] truncate">
									{doc.title || doc.path}
								</h3>
							</div>
							{#if doc.summary}
								<p class="text-xs sm:text-sm text-[var(--color-text-secondary)] leading-snug line-clamp-2">
									{doc.summary}
								</p>
							{/if}
							<p class="text-xs text-[var(--color-text-tertiary)] mt-1 sm:mt-1.5">
								{#if getAuthorLabel(doc.created_by)}{getAuthorLabel(doc.created_by)}{/if}
								{#if getSourceLabel(doc.source_type)}<span class="hidden sm:inline"> &middot; {getSourceLabel(doc.source_type)}</span>{/if}
								{#if getCategoryFromPath(doc.path)}<span class="hidden sm:inline"> &middot; {getCategoryFromPath(doc.path)}</span>{/if}
								{#if doc.updated_at} &middot; {formatDate(doc.updated_at, true)}{/if}
							</p>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Grid view -->
			<div class="grid gap-3 sm:gap-4" style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));">
				{#each filteredDocs as doc}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => selectDoc(doc)}
						onkeydown={(e) => { if (e.key === 'Enter') selectDoc(doc); }}
						oncontextmenu={(e) => openContextMenu(e, doc)}
						ontouchstart={(e) => handleTouchStart(e, doc)}
						ontouchmove={handleTouchMove}
						ontouchend={handleTouchEnd}
						draggable={true}
						ondragstart={(e) => handleDragStart(e, doc)}
						ondragend={handleDragEnd}
						role="button"
						tabindex="0"
						class="flex flex-col rounded-xl p-3 transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] text-left relative group border-[var(--color-border)] hover:border-aurum/50 {draggingDoc === doc.path ? 'opacity-40' : ''}"
					>
						{#if doc.pinned}
							<div class="absolute top-2 right-2 z-10 text-aurum">
								<svg class="w-4 h-4" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
								</svg>
							</div>
						{/if}

						<div class="w-full aspect-[4/3] rounded-lg mb-3 bg-[var(--color-elevated)] p-3 overflow-hidden relative">
							<div class="flex items-center gap-1.5 mb-2">
								<span class="text-[var(--color-text-tertiary)]">
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
										<polyline points="14 2 14 8 20 8"/>
									</svg>
								</span>
								{#if doc.title}
									<span class="text-xs font-medium text-[var(--color-text-primary)] truncate">{doc.title}</span>
								{/if}
							</div>
							<p class="text-[11px] text-[var(--color-text-secondary)] leading-relaxed line-clamp-6">
								{doc.summary || doc.title || doc.path}
							</p>
							<div class="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[var(--color-elevated)] to-transparent"></div>
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-xs text-[var(--color-text-tertiary)]">
								{#if getAuthorLabel(doc.created_by)}{getAuthorLabel(doc.created_by)} &middot; {/if}{formatDate(doc.updated_at, true)}{#if getSourceLabel(doc.source_type)} &middot; {getSourceLabel(doc.source_type)}{/if}
							</p>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Context menu -->
{#if contextMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 z-40" onclick={closeContextMenu} oncontextmenu={(e) => { e.preventDefault(); closeContextMenu(); }}></div>
	<div
		class="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 min-w-[180px]"
		style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
	>
		{#if showDeleteConfirm}
			<div class="px-3 py-2">
				<p class="text-sm text-[var(--color-text-primary)] mb-2">Delete this document?</p>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-3">This cannot be undone.</p>
				<div class="flex items-center gap-2 justify-end">
					<button
						onclick={() => { showDeleteConfirm = false; }}
						class="px-2.5 py-1 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] transition-colors"
					>Cancel</button>
					<button
						onclick={() => deleteDocument(contextMenu!.doc)}
						disabled={isDeleting}
						class="px-2.5 py-1 text-xs rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
					>{isDeleting ? 'Deleting...' : 'Delete'}</button>
				</div>
			</div>
		{:else if showMoveMenu}
			<button
				onclick={() => { moveDocToFolder(contextMenu!.doc, null); }}
				class="ctx-item"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
				No folder
			</button>
			{#each folders as folder}
				<button
					onclick={() => moveDocToFolder(contextMenu!.doc, folder.id)}
					class="ctx-item {contextMenu!.doc.folder_id === folder.id ? 'text-[var(--color-accent)]' : ''}"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
					{folder.name}
				</button>
			{/each}
			<div class="mx-2 my-1 h-px bg-[var(--color-border)]"></div>
			<button onclick={() => { showMoveMenu = false; }} class="ctx-item text-[var(--color-text-tertiary)]">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
				Back
			</button>
		{:else}
			<!-- Open -->
			<button onclick={() => { selectDoc(contextMenu!.doc); closeContextMenu(); }} class="ctx-item">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
				Open
			</button>
			<!-- Star/Unstar -->
			<button onclick={() => { togglePin(contextMenu!.doc); closeContextMenu(); }} class="ctx-item">
				<svg class="w-4 h-4" fill={contextMenu.doc.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/></svg>
				{contextMenu.doc.pinned ? 'Unstar' : 'Star'}
			</button>
			<!-- Move to folder -->
			{#if folders.length > 0}
				<button onclick={() => { showMoveMenu = true; }} class="ctx-item">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
					Move to folder
				</button>
			{/if}
			<div class="mx-2 my-1 h-px bg-[var(--color-border)]"></div>
			<!-- Delete -->
			<button onclick={() => { showDeleteConfirm = true; }} class="ctx-item text-red-400 hover:!bg-red-500/10">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
				Delete
			</button>
		{/if}
	</div>
{/if}

<style>
	/* ── Context menu ── */
	.ctx-item {
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
	.ctx-item:hover {
		background: var(--color-elevated);
		color: var(--color-text-primary);
	}

	/* ── Page layout — guaranteed scroll ── */
	.library-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
	.library-header {
		flex-shrink: 0;
	}
	.library-content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.library-content.no-scroll {
		overflow: hidden;
	}
	.doc-detail-view {
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.line-clamp-2 {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.line-clamp-6 {
		display: -webkit-box;
		-webkit-line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* ── Toolbar ── */

	.toolbar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 0.375rem;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		transition: all 0.15s;
	}
	.toolbar-btn:hover {
		background: var(--color-elevated);
		color: var(--color-text-primary);
	}

	/* ── Split editor ── */

	.editor-textarea {
		width: 100%;
		min-height: 70vh;
		padding: 1rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		font-size: 0.9375rem;
		font-family: var(--font-sans);
		line-height: 1.7;
		color: var(--color-text-primary);
		resize: vertical;
		tab-size: 2;
	}
	.editor-textarea:focus {
		border-color: var(--color-accent);
		outline: none;
		background: var(--color-surface);
	}
	.editor-textarea::placeholder {
		color: var(--color-text-tertiary);
	}

	/* ── Document content / Markdown styling ── */

	.doc-content {
		line-height: 1.75;
		color: var(--color-text-primary);
		font-size: 0.9375rem;
	}

	/* Headings */
	.doc-content :global(h1) {
		font-size: 1.75rem;
		font-weight: 600;
		margin: 2rem 0 1rem 0;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-emphasis);
	}
	.doc-content :global(h2) {
		font-size: 1.375rem;
		font-weight: 600;
		margin: 1.75rem 0 0.75rem 0;
		color: var(--color-text-emphasis);
	}
	.doc-content :global(h3) {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 1.5rem 0 0.5rem 0;
		color: var(--color-text-primary);
	}
	.doc-content :global(h4) {
		font-size: 1rem;
		font-weight: 600;
		margin: 1.25rem 0 0.5rem 0;
		color: var(--color-text-primary);
	}

	/* Paragraphs */
	.doc-content :global(p) {
		margin: 0 0 1rem 0;
	}

	/* Lists */
	.doc-content :global(ul),
	.doc-content :global(ol) {
		margin: 0.5rem 0 1rem 0;
		padding-left: 1.5rem;
	}
	.doc-content :global(ul) { list-style-type: disc; }
	.doc-content :global(ol) { list-style-type: decimal; }
	.doc-content :global(li) {
		margin: 0.25rem 0;
	}
	.doc-content :global(li p) {
		margin: 0;
	}

	/* Task lists (checkboxes) */
	.doc-content :global(li:has(> input[type="checkbox"])) {
		list-style: none;
		margin-left: -1.5rem;
		padding-left: 0;
	}
	.doc-content :global(input[type="checkbox"].doc-checkbox) {
		width: 1rem;
		height: 1rem;
		margin-right: 0.5rem;
		vertical-align: middle;
		cursor: pointer;
		accent-color: var(--color-accent);
		position: relative;
		top: -1px;
	}
	.doc-content :global(li:has(> input[type="checkbox"]:checked)) {
		color: var(--color-text-tertiary);
		text-decoration: line-through;
		text-decoration-color: var(--color-text-tertiary);
	}

	/* Strong / em */
	.doc-content :global(strong) {
		font-weight: 600;
		color: var(--color-text-emphasis);
	}
	.doc-content :global(em) {
		font-style: italic;
	}

	/* Inline code */
	.doc-content :global(code) {
		font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
		font-size: 0.85em;
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
	}

	/* Code blocks */
	.doc-content :global(pre) {
		margin: 1rem 0;
		padding: 1rem;
		border-radius: 0.5rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		overflow-x: auto;
		line-height: 1.5;
	}
	.doc-content :global(pre code) {
		padding: 0;
		border: none;
		background: none;
		font-size: 0.8rem;
	}

	/* Blockquotes */
	.doc-content :global(blockquote) {
		margin: 1rem 0;
		padding: 0.75rem 1rem;
		border-left: 3px solid var(--color-accent);
		background: rgba(var(--color-accent-rgb, 99, 102, 241), 0.06);
		border-radius: 0 0.375rem 0.375rem 0;
		color: var(--color-text-secondary);
	}
	.doc-content :global(blockquote p) {
		margin: 0;
	}
	.doc-content :global(blockquote blockquote) {
		margin-top: 0.5rem;
	}

	/* Links */
	.doc-content :global(a) {
		color: var(--color-accent);
		text-decoration: none;
	}
	.doc-content :global(a:hover) {
		text-decoration: underline;
	}

	/* Horizontal rules */
	.doc-content :global(hr) {
		margin: 2rem 0;
		border: none;
		border-top: 1px solid var(--color-border);
	}

	/* Tables */
	.doc-content :global(table) {
		width: 100%;
		margin: 1rem 0;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	.doc-content :global(th),
	.doc-content :global(td) {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		text-align: left;
	}
	.doc-content :global(th) {
		background: var(--color-elevated);
		font-weight: 600;
		color: var(--color-text-emphasis);
	}
	.doc-content :global(tr:nth-child(even) td) {
		background: rgba(var(--color-accent-rgb, 99, 102, 241), 0.03);
	}

	/* Images */
	.doc-content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.5rem;
		margin: 1rem 0;
	}
</style>
