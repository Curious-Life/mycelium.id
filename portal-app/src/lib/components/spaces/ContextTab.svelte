<script lang="ts">
	/**
	 * Context tab — the structural surface of a Space.
	 *
	 * A Space's Context is a flat or nested arrangement of:
	 *   - documents (linked from the contributor's library, never copied)
	 *   - folders   (nestable; a folder can contain more documents and
	 *                sub-folders)
	 *
	 * Documents can live at the space root OR inside a folder. Folders
	 *  are stored as `space_rooms` rows under the hood — the migration
	 *  doesn't rename the table because doing so would churn every
	 *  reference; the model is identical, the user-facing name shifted
	 *  to "folder" / "Context."
	 *
	 * UX matches the personal library: top-level grid → drill into a
	 * folder → grid again. Breadcrumb at the top, "Add folder" + "Add
	 * document" buttons, single confirm-on-delete per item.
	 */
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { api } from '$lib/api';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import DocThumbnail from '$lib/components/library/DocThumbnail.svelte';
	import { subscribeToDoc } from '$lib/document-live';
	import { applyMorph, resetMorph } from '$lib/markdown-morph';
	import { wrapHtmlForLive, mountLiveIframe, type LiveIframeHandle } from '$lib/iframe-live';

	let {
		spaceId,
		canEdit,
	}: { spaceId: string; canEdit: boolean } = $props();

	// Card-size toggle, mirrors the library's behaviour. Persisted
	// independently from the library setting so a user can keep the
	// library compact while reading a space's HTML covers at full size.
	let gridSize = $state<'sm' | 'lg'>('lg');
	if (browser) {
		const saved = localStorage.getItem('mycelium.spaces.gridSize');
		if (saved === 'sm' || saved === 'lg') gridSize = saved;
	}
	function setGridSize(s: 'sm' | 'lg') {
		gridSize = s;
		if (browser) localStorage.setItem('mycelium.spaces.gridSize', s);
	}
	const gridMinPx = $derived(gridSize === 'lg' ? 360 : 200);

	// Strip path → filename, then split off extension. The filename
	// IS the title (matches the library's convention; agents author
	// docs with descriptive filenames). Format = uppercase extension
	// or "DOC" fallback for unextensioned paths.
	function basenameAndFormat(path: string): { name: string; format: string } {
		const last = (path.split('/').pop() || path).trim();
		const dot = last.lastIndexOf('.');
		if (dot <= 0) return { name: last, format: 'DOC' };
		return {
			name: last.slice(0, dot),
			format: last.slice(dot + 1).toUpperCase(),
		};
	}

	// ── Author + date helpers ────────────────────────────────────────
	// Mirrors library/+page.svelte; kept inline so this component can
	// stand alone. Agent display names come from /portal/agents (dynamic;
	// supports user-customized agent names).
	let agentNameMap = $state<Record<string, string>>({});
	if (browser) {
		api('/portal/agents').then(async (res) => {
			if (res.ok) {
				const data = await res.json();
				const map: Record<string, string> = {};
				for (const a of data.agents || []) map[a.id] = a.name;
				agentNameMap = map;
			}
		}).catch(() => {});
	}

	interface DocMetaSource { user_name?: string }
	interface DocMeta { source?: DocMetaSource }

	function parseDocMetadata(raw: unknown): DocMeta | null {
		if (!raw) return null;
		if (typeof raw === 'object') return raw as DocMeta;
		if (typeof raw === 'string') {
			try { return JSON.parse(raw) as DocMeta; } catch { return null; }
		}
		return null;
	}

	function getAuthorLabel(createdBy?: string | null, metadata?: string | DocMeta | null): string | null {
		if (!createdBy) return null;
		if (createdBy === 'user' || createdBy === 'self') return 'You';
		if (agentNameMap[createdBy]) return agentNameMap[createdBy];
		const colon = createdBy.indexOf(':');
		if (colon > 0) {
			const meta = parseDocMetadata(metadata);
			const displayName = meta?.source?.user_name?.trim();
			if (displayName) return displayName;
			const platform = createdBy.slice(0, colon);
			const platformLabel = ({ tg: 'Telegram', wa: 'WhatsApp', discord: 'Discord' } as Record<string, string>)[platform] || platform;
			return `${platformLabel} user`;
		}
		return createdBy;
	}

	function formatRelative(dateStr?: string | null): string {
		if (!dateStr) return '';
		const d = new Date(dateStr);
		if (Number.isNaN(d.getTime())) return '';
		const diff = Date.now() - d.getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	interface Folder {
		id: string;
		space_id: string;
		parent_id: string | null;
		name: string;
		essence: string | null;
		cover_doc_path: string | null;
		position: number;
		created_at: string;
	}

	interface Doc {
		id: string;
		path: string;
		title: string | null;
		summary: string | null;
		source_type: string | null;
		position: number;
		// Joined from documents (LEFT JOIN — null if the seeded doc no
		// longer exists in the contributor's library):
		created_by?: string | null;
		metadata?: string | null;
		updated_at?: string | null;
	}

	interface LibraryDoc {
		path: string;
		title?: string;
		summary?: string;
		source_type?: string;
	}

	// Breadcrumb of folders we've drilled into.
	// Empty trail = at the space root.
	let trail = $state<Folder[]>([]);
	let currentParentId = $derived<string | null>(trail.length ? trail[trail.length - 1].id : null);
	let folders = $state<Folder[]>([]);
	let docs = $state<Doc[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// In-place doc viewer. Clicking a doc card replaces the grid with
	// a render of the actual content (HTML in iframe, markdown parsed,
	// plain text monospaced). Back navigation returns to the grid at
	// the same drill level — folder trail is preserved.
	let openDoc = $state<Doc | null>(null);
	let openDocContent = $state<string | null>(null);
	let openDocLoading = $state(false);
	let openDocError = $state<string | null>(null);

	function docKind(path: string): 'html' | 'markdown' | 'text' {
		const ext = (path.split('.').pop() || '').toLowerCase();
		if (ext === 'html' || ext === 'htm') return 'html';
		if (ext === 'md' || ext === 'markdown') return 'markdown';
		return 'text';
	}

	const openDocMarkdown = $derived.by(() => {
		if (!openDoc || !openDocContent || docKind(openDoc.path) !== 'markdown') return '';
		try {
			const raw = marked.parse(openDocContent, { gfm: true, breaks: true }) as string;
			return DOMPurify.sanitize(raw);
		} catch {
			return '';
		}
	});

	async function fetchOpenDoc() {
		if (!openDoc) return;
		const path = openDoc.path;
		try {
			const res = await api(`/portal/documents/${path}`);
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const data = await res.json();
			// Don't clobber if the user navigated to a different doc
			// while this fetch was inflight.
			if (openDoc?.path !== path) return;
			openDocContent = data.document?.content || '';
			openDocError = null;
		} catch (e: any) {
			if (openDoc?.path !== path) return;
			openDocError = e?.message || 'Failed to load document';
		}
	}

	async function selectDoc(doc: Doc) {
		openDoc = doc;
		openDocContent = null;
		openDocLoading = true;
		openDocError = null;
		await fetchOpenDoc();
		openDocLoading = false;
	}

	function closeDoc() {
		openDoc = null;
		openDocContent = null;
		openDocError = null;
	}

	// ── Live updates: while a doc is open in the full-screen viewer,
	// subscribe to per-doc SSE so agent rewrites land instantly. The
	// markdown viewer morphs in place; the HTML iframe goes through the
	// iframe-live postMessage protocol (no flash, scroll preserved).
	$effect(() => {
		if (!browser) return;
		if (!openDoc) return;
		const path = openDoc.path;
		const sub = subscribeToDoc(path, {
			onUpdate: () => fetchOpenDoc(),
			onDelete: () => {
				if (openDoc?.path === path) closeDoc();
			},
		});
		return () => sub.dispose();
	});

	let mdContainer = $state<HTMLDivElement | null>(null);
	$effect(() => {
		if (!mdContainer || !openDocContent || !openDoc) return;
		if (docKind(openDoc.path) !== 'markdown') return;
		applyMorph(mdContainer, openDocMarkdown);
	});
	$effect(() => {
		// New doc → drop the cached morph signature.
		if (openDoc?.path) resetMorph(mdContainer);
	});

	let liveIframeEl = $state<HTMLIFrameElement | null>(null);
	let liveIframeHandle: LiveIframeHandle | null = null;
	$effect(() => {
		if (!liveIframeEl) return;
		liveIframeHandle?.dispose();
		liveIframeHandle = mountLiveIframe(liveIframeEl);
		return () => {
			liveIframeHandle?.dispose();
			liveIframeHandle = null;
		};
	});
	$effect(() => {
		if (!liveIframeEl || !openDocContent || !openDoc) return;
		if (docKind(openDoc.path) !== 'html') return;
		const html = openDocContent;
		const last = (liveIframeEl as any).__lastLiveContent;
		if (last === html) return;
		(liveIframeEl as any).__lastLiveContent = html;
		if (liveIframeHandle) {
			liveIframeHandle.update(html);
		} else {
			liveIframeEl.srcdoc = wrapHtmlForLive(html);
		}
	});

	// Add-folder modal
	let showAddFolder = $state(false);
	let newFolderName = $state('');
	let newFolderEssence = $state('');
	let creatingFolder = $state(false);

	// Add-document modal
	let showAddDoc = $state(false);
	let libraryDocs = $state<LibraryDoc[]>([]);
	let libraryLoading = $state(false);
	let librarySearch = $state('');
	let adding = $state(false);

	const filteredLibraryDocs = $derived(() => {
		const q = librarySearch.trim().toLowerCase();
		if (!q) return libraryDocs;
		return libraryDocs.filter(
			(d) =>
				d.path.toLowerCase().includes(q) ||
				(d.title || '').toLowerCase().includes(q),
		);
	});

	async function loadLevel(parentId: string | null) {
		loading = true;
		error = null;
		try {
			// Folders endpoint stays /rooms (table name unchanged); the
			// rename is UI-only. Docs endpoint splits on parent: at the
			// space root we hit /contents (root-level docs); inside a
			// folder we hit /rooms/<id>/contents (folder-scoped docs).
			const foldersUrl = parentId
				? `/portal/spaces/${spaceId}/rooms?parent=${encodeURIComponent(parentId)}`
				: `/portal/spaces/${spaceId}/rooms`;
			const docsUrl = parentId
				? `/portal/spaces/${spaceId}/rooms/${parentId}/contents`
				: `/portal/spaces/${spaceId}/contents`;
			const [foldersRes, docsRes] = await Promise.all([api(foldersUrl), api(docsUrl)]);
			if (!foldersRes.ok) throw new Error(`Folders ${foldersRes.status}`);
			const foldersData = await foldersRes.json();
			folders = foldersData.rooms || [];
			if (docsRes.ok) {
				const docsData = await docsRes.json();
				docs = docsData.documents || [];
			} else {
				docs = [];
			}
		} catch (e: any) {
			error = e?.message || 'Failed to load';
			folders = [];
			docs = [];
		} finally {
			loading = false;
		}
	}

	function enterFolder(folder: Folder) {
		trail = [...trail, folder];
		loadLevel(folder.id);
	}

	function jumpTo(index: number) {
		if (index < 0) {
			trail = [];
			loadLevel(null);
		} else {
			trail = trail.slice(0, index + 1);
			loadLevel(trail[index].id);
		}
	}

	async function createFolder() {
		const name = newFolderName.trim();
		if (!name) return;
		creatingFolder = true;
		try {
			const res = await api(`/portal/spaces/${spaceId}/rooms`, {
				method: 'POST',
				body: JSON.stringify({
					name,
					essence: newFolderEssence.trim() || null,
					parentId: currentParentId,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Create failed');
			}
			newFolderName = '';
			newFolderEssence = '';
			showAddFolder = false;
			await loadLevel(currentParentId);
		} catch (e: any) {
			error = e?.message || 'Failed to create folder';
		} finally {
			creatingFolder = false;
		}
	}

	async function deleteFolder(folder: Folder) {
		if (!confirm(`Delete folder "${folder.name}"? Documents stay in your library; the folder and its references are removed.`)) return;
		try {
			const res = await api(`/portal/spaces/${spaceId}/rooms/${folder.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Delete failed');
			}
			await loadLevel(currentParentId);
		} catch (e: any) {
			error = e?.message || 'Failed to delete folder';
		}
	}

	async function openAddDoc() {
		showAddDoc = true;
		librarySearch = '';
		if (libraryDocs.length === 0) {
			libraryLoading = true;
			try {
				const res = await api('/portal/documents');
				if (res.ok) {
					const data = await res.json();
					libraryDocs = data.documents || [];
				}
			} finally {
				libraryLoading = false;
			}
		}
	}

	async function addDoc(doc: LibraryDoc) {
		adding = true;
		try {
			// Root vs folder: hit different endpoints. Same payload shape,
			// idempotent under the (space_id, document_path) UNIQUE for
			// root-level adds and (room_id, document_path) for folders.
			const url = currentParentId
				? `/portal/spaces/${spaceId}/rooms/${currentParentId}/seed-doc`
				: `/portal/spaces/${spaceId}/seed-doc`;
			const res = await api(url, {
				method: 'POST',
				body: JSON.stringify({ documentPath: doc.path }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Add failed');
			}
			showAddDoc = false;
			await loadLevel(currentParentId);
		} catch (e: any) {
			error = e?.message || 'Failed to add document';
		} finally {
			adding = false;
		}
	}

	async function removeDoc(d: Doc) {
		const url = currentParentId
			? `/portal/spaces/${spaceId}/rooms/${currentParentId}/contents/${d.id}`
			: `/portal/spaces/${spaceId}/contents/${d.id}`;
		try {
			const res = await api(url, { method: 'DELETE' });
			if (!res.ok) throw new Error('Remove failed');
			await loadLevel(currentParentId);
		} catch (e: any) {
			error = e?.message || 'Failed to remove document';
		}
	}

	onMount(() => loadLevel(null));
</script>

<!-- ── Full-screen doc viewer ────────────────────────────────────
     When a doc card is selected we leave the inline grid in place
     (so re-entering after Back lands on the same scroll position)
     and overlay the viewer at fixed inset:0. Just a tiny back-to-
     space row, the rest of the viewport is the doc — html iframe,
     marked+DOMPurify markdown, or preformatted text. Z-index sits
     below the chat (9999) so the floating chat stays accessible. -->
{#if openDoc}
	<div class="space-doc-fullscreen fixed inset-0 z-40 flex flex-col bg-[var(--color-bg)]">
		<div class="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
			<button
				onclick={closeDoc}
				class="flex items-center gap-1.5 px-2 py-1 -ml-1 rounded-md text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] transition-colors"
				title="Back to space"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
				Back to space
			</button>
			<div class="flex-1 min-w-0">
				<div class="text-sm font-medium text-[var(--color-text-primary)] truncate">{openDoc.title || basenameAndFormat(openDoc.path).name}</div>
				<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] mt-0.5">{basenameAndFormat(openDoc.path).format}</div>
			</div>
			<a
				href={`/library?doc=${encodeURIComponent(openDoc.path)}`}
				class="text-[11px] text-[var(--color-text-tertiary)] hover:text-aurum transition-colors no-underline shrink-0"
				title="Open in library"
			>
				Open in library →
			</a>
		</div>
		<div class="flex-1 min-h-0 overflow-hidden bg-white">
			{#if openDocLoading}
				<div class="flex items-center justify-center h-full">
					<div class="w-6 h-6 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
				</div>
			{:else if openDocError}
				<div class="p-6 text-center text-sm text-coral">{openDocError}</div>
			{:else if openDocContent !== null}
				{#if docKind(openDoc.path) === 'html'}
					<iframe
						bind:this={liveIframeEl}
						title={openDoc.title || openDoc.path}
						sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
						class="w-full h-full border-0 block bg-white"
					></iframe>
				{:else if docKind(openDoc.path) === 'markdown'}
					<div
						bind:this={mdContainer}
						class="doc-thumb-prose px-6 py-6 h-full overflow-y-auto max-w-3xl mx-auto"
						style="color: #222;"
					></div>
				{:else}
					<pre class="m-0 px-6 py-6 h-full overflow-auto whitespace-pre-wrap font-mono text-[13px] leading-[1.5] text-[#222] bg-white">{openDocContent}</pre>
				{/if}
			{:else}
				<div class="p-6 text-center text-sm text-[var(--color-text-tertiary)]">No content.</div>
			{/if}
		</div>
	</div>
{/if}

<div class="px-5 py-4 space-y-4">
	<!-- Breadcrumb (grid view only — full-screen viewer handles its own chrome) -->
	<div class="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] flex-wrap">
		<button
			onclick={() => { jumpTo(-1); }}
			class="hover:text-[var(--color-text-primary)] transition-colors {trail.length === 0 ? 'text-[var(--color-text-primary)] font-medium' : ''}"
		>
			Context
		</button>
		{#each trail as folder, i}
			<span class="text-[var(--color-text-tertiary)]">›</span>
			<button
				onclick={() => { jumpTo(i); }}
				class="hover:text-[var(--color-text-primary)] transition-colors {i === trail.length - 1 ? 'text-[var(--color-text-primary)] font-medium' : ''}"
			>
				{folder.name}
			</button>
		{/each}
	</div>

	<!-- Current folder essence -->
	{#if trail.length > 0 && trail[trail.length - 1].essence}
		<p class="text-sm text-[var(--color-text-secondary)]">{trail[trail.length - 1].essence}</p>
	{/if}

	<!-- Action bar — add buttons + size toggle -->
	<div class="flex items-center gap-2 flex-wrap">
		{#if canEdit}
			<button
				onclick={() => { showAddFolder = true; }}
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-aurum bg-aurum/10 hover:bg-aurum/20 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 12v6m-3-3h6" stroke-linecap="round"/></svg>
				Add folder
			</button>
			<button
				onclick={openAddDoc}
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amethyst bg-amethyst/10 hover:bg-amethyst/20 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 12v6m-3-3h6" stroke-linecap="round"/></svg>
				Add document
			</button>
		{/if}

		<!-- Card-size toggle — same affordance as the library; lives at
		     the right of the action bar so it doesn't fight with the
		     primary add buttons. Only meaningful when there are cards
		     to render, but always visible to keep the chrome stable. -->
		<div class="ml-auto flex items-center gap-0.5 p-0.5 bg-[var(--color-elevated)] rounded-lg">
			<button
				class="p-1.5 rounded transition-colors {gridSize === 'sm' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
				onclick={() => setGridSize('sm')}
				title="Compact cards"
				aria-label="Compact card size"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<rect x="4"  y="4"  width="4" height="4" rx="0.5" />
					<rect x="10" y="4"  width="4" height="4" rx="0.5" />
					<rect x="16" y="4"  width="4" height="4" rx="0.5" />
					<rect x="4"  y="10" width="4" height="4" rx="0.5" />
					<rect x="10" y="10" width="4" height="4" rx="0.5" />
					<rect x="16" y="10" width="4" height="4" rx="0.5" />
					<rect x="4"  y="16" width="4" height="4" rx="0.5" />
					<rect x="10" y="16" width="4" height="4" rx="0.5" />
					<rect x="16" y="16" width="4" height="4" rx="0.5" />
				</svg>
			</button>
			<button
				class="p-1.5 rounded transition-colors {gridSize === 'lg' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
				onclick={() => setGridSize('lg')}
				title="Large cards (better for HTML previews)"
				aria-label="Large card size"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<rect x="4"  y="4"  width="7" height="7" rx="1" />
					<rect x="13" y="4"  width="7" height="7" rx="1" />
					<rect x="4"  y="13" width="7" height="7" rx="1" />
					<rect x="13" y="13" width="7" height="7" rx="1" />
				</svg>
			</button>
		</div>
	</div>

	{#if error}
		<p class="text-xs text-coral">{error}</p>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<div class="w-6 h-6 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
		</div>
	{:else}
		<!-- One unified grid with folders first, then documents.
		     Same card-frame for both so the layout reads as one wall of
		     contents. HTML docs render their live preview via
		     DocThumbnail; non-HTML docs show
		     a folder-style placeholder with title + summary; folders
		     show a folder icon + essence. -->
		{#if folders.length > 0 || docs.length > 0}
			<div class="grid gap-3 sm:gap-4" style="grid-template-columns: repeat(auto-fill, minmax({gridMinPx}px, 1fr));">

				{#each folders as folder (folder.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => enterFolder(folder)}
						onkeydown={(e) => { if (e.key === 'Enter') enterFolder(folder); }}
						role="button"
						tabindex="0"
						class="group flex flex-col rounded-xl p-3 transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] text-left relative border-[var(--color-border)] hover:border-aurum/50"
					>
						<div class="w-full aspect-[4/3] rounded-lg mb-3 bg-[var(--color-elevated)] overflow-hidden relative flex items-center justify-center">
							<svg class="w-12 h-12 text-aurum/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
								<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
							</svg>
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-1.5 mb-1">
								<svg class="w-3.5 h-3.5 text-aurum flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
								</svg>
								<h3 class="text-sm font-medium text-[var(--color-text-primary)] truncate">{folder.name}</h3>
							</div>
							{#if folder.essence}
								<p class="text-xs text-[var(--color-text-secondary)] line-clamp-2">{folder.essence}</p>
							{/if}
						</div>
						{#if canEdit}
							<button
								onclick={(e) => { e.stopPropagation(); deleteFolder(folder); }}
								class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-tertiary)] hover:text-coral hover:bg-black/20 transition-all"
								title="Delete folder"
								aria-label="Delete folder"
							>
								<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
							</button>
						{/if}
					</div>
				{/each}

				{#each docs as doc (doc.id)}
					{@const meta = basenameAndFormat(doc.path)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					{@const author = getAuthorLabel(doc.created_by, doc.metadata)}
					{@const when = formatRelative(doc.updated_at)}
					<button
						type="button"
						onclick={() => selectDoc(doc)}
						class="group flex flex-col rounded-xl transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] text-left relative border-[var(--color-border)] hover:border-aurum/50 overflow-hidden p-0"
					>
						<!-- Title + format header. Filename without extension on
						     the left (truncate); format chip on the right. A
						     subtitle below shows author + when, mirroring the
						     library card. Author resolves agent IDs to names
						     and falls back to platform-shorthand for tokens. -->
						<div class="px-3 py-2 border-b border-[var(--color-border)]">
							<div class="flex items-center gap-2">
								<h3 class="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)] truncate">
									{doc.title || meta.name}
								</h3>
								<span class="flex-shrink-0 text-[9px] font-mono uppercase tracking-wider text-[var(--color-text-tertiary)] bg-[var(--color-elevated)] px-1.5 py-0.5 rounded">
									{meta.format}
								</span>
							</div>
							{#if author || when}
								<p class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 truncate">
									{#if author}{author}{/if}{#if author && when}<span class="mx-1">·</span>{/if}{#if when}{when}{/if}
								</p>
							{/if}
						</div>
						<!-- Live preview, full card width. DocThumbnail handles
						     the format-specific render: HTML in iframe, markdown
						     parsed + sanitized, plain text monospaced. -->
						<div class="w-full aspect-[4/3] bg-[var(--color-elevated)] overflow-hidden relative">
							<DocThumbnail path={doc.path} title={doc.title || meta.name} ariaLabel={doc.title || doc.path} />
						</div>
						{#if canEdit}
							<!-- A real <button> can't nest in the card <button>; a
							     span with role/keyboard handlers is the SSR-safe form. -->
							<span
								role="button"
								tabindex="0"
								onclick={(e) => { e.preventDefault(); e.stopPropagation(); removeDoc(doc); }}
								onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removeDoc(doc); } }}
								class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-tertiary)] hover:text-coral hover:bg-black/40 transition-all backdrop-blur-sm cursor-pointer"
								title="Remove from this space (doc stays in your library)"
								aria-label="Remove from this space"
							>
								<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
							</span>
						{/if}
					</button>
				{/each}

			</div>
		{:else if !error}
			<div class="text-center py-12 text-[var(--color-text-tertiary)] text-sm">
				{#if currentParentId}
					This folder is empty. {canEdit ? 'Add a sub-folder or a document.' : ''}
				{:else}
					Nothing here yet. {canEdit ? "Add a folder or a document to start building this space's context." : ''}
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Add-folder modal -->
{#if showAddFolder}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4"
		style="background: rgba(10, 10, 12, 0.72); backdrop-filter: blur(20px) saturate(140%);"
	>
		<div class="w-full max-w-md rounded-2xl border border-white/[0.06] p-6" style="background: rgba(26, 26, 31, 0.95);">
			<h2 class="text-base font-medium text-[var(--color-text-emphasis)] mb-1">
				{currentParentId ? `New folder in "${trail[trail.length - 1].name}"` : 'New folder'}
			</h2>
			<p class="text-xs text-[var(--color-text-tertiary)] mb-4">A folder organizes documents and sub-folders inside this space.</p>
			<input
				type="text"
				bind:value={newFolderName}
				placeholder="Folder name"
				class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] mb-3"
			/>
			<textarea
				bind:value={newFolderEssence}
				placeholder="What's this folder about? (optional)"
				rows="2"
				class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] mb-4 resize-none"
			></textarea>
			<div class="flex items-center justify-end gap-2">
				<button
					onclick={() => { showAddFolder = false; newFolderName = ''; newFolderEssence = ''; }}
					class="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
				>Cancel</button>
				<button
					onclick={createFolder}
					disabled={creatingFolder || !newFolderName.trim()}
					class="px-4 py-1.5 rounded-lg text-xs font-medium bg-aurum text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-40"
				>
					{creatingFolder ? 'Creating...' : 'Create folder'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Add-document modal -->
{#if showAddDoc}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4"
		style="background: rgba(10, 10, 12, 0.72); backdrop-filter: blur(20px) saturate(140%);"
	>
		<div class="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border border-white/[0.06] p-6" style="background: rgba(26, 26, 31, 0.95);">
			<h2 class="text-base font-medium text-[var(--color-text-emphasis)] mb-1">Add a document</h2>
			<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
				The document stays in your library. Adding it here links it
				{currentParentId ? `into "${trail[trail.length - 1].name}".` : 'into this space.'}
			</p>
			<input
				type="text"
				bind:value={librarySearch}
				placeholder="Search your library..."
				class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] mb-3"
			/>
			<div class="flex-1 overflow-y-auto -mx-2 px-2 mb-4">
				{#if libraryLoading}
					<div class="flex items-center justify-center py-12">
						<div class="w-5 h-5 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
					</div>
				{:else if filteredLibraryDocs().length === 0}
					<p class="text-xs text-[var(--color-text-tertiary)] py-8 text-center">No matching documents.</p>
				{:else}
					<div class="space-y-1">
						{#each filteredLibraryDocs() as doc (doc.path)}
							<button
								onclick={() => addDoc(doc)}
								disabled={adding}
								class="w-full text-left flex items-start gap-3 p-2 rounded-lg hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-50"
							>
								<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
									<polyline points="14 2 14 8 20 8"/>
								</svg>
								<div class="flex-1 min-w-0">
									<p class="text-xs font-medium text-[var(--color-text-primary)] truncate">{doc.title || doc.path}</p>
									<p class="text-[10px] text-[var(--color-text-tertiary)] truncate font-mono">{doc.path}</p>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="flex items-center justify-end">
				<button
					onclick={() => { showAddDoc = false; }}
					class="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
				>Done</button>
			</div>
		</div>
	</div>
{/if}
