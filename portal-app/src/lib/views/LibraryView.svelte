<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	// $effect / $state / $derived are Svelte 5 compiler runes — no import.
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { navigationState } from '$lib/stores/navigation';
	import { toasts } from '$lib/stores/toast';
	import { api } from '$lib/api';
	import DocThumbnail from '$lib/components/library/DocThumbnail.svelte';
	import PublishStatusPill from '$lib/components/library/PublishStatusPill.svelte';
	import {
		subscribeToDoc,
		subscribeToLibrary,
		markSelfWrite,
		type LiveConnectionState,
	} from '$lib/document-live';
	import { applyMorph, resetMorph } from '$lib/markdown-morph';
	import { wrapHtmlForLive, mountLiveIframe, type LiveIframeHandle } from '$lib/iframe-live';
	// MarkdownEditor (CodeMirror) is lazy-loaded — see ensureEditor() — so just
	// navigating to the Library doesn't pull in the ~170 KB editor bundle. It
	// loads the first time you edit a doc (no static import on purpose).

	marked.use({ gfm: true, breaks: true });

	// Phase C: the workspace passes the open doc (deep-link / reload restore) + a
	// callback to record selection. Replaces this view's old native pushState/popstate.
	let { doc = null, setParams }: {
		doc?: string | null;
		setParams?: (patch: Record<string, unknown>) => void;
	} = $props();

	// PR 5.10: per-upload sender + channel attribution.
	interface SourceProvenance {
		platform?: string;
		user_id?: string | null;
		user_name?: string | null;
		channel_id?: string | null;
		channel_title?: string | null;
		channel_kind?: string | null;
	}

	interface DocMetadata {
		source?: SourceProvenance;
		[k: string]: unknown;
	}

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
		// metadata is JSON-stringified server-side (Swiss Vault encrypted at
		// rest, decrypted on read); the portal parses it lazily for the
		// author label resolver. May be a string OR a parsed object
		// depending on whether the server pre-parsed it.
		metadata?: string | DocMetadata;
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

	// Media attachment from /portal/attachments — channel media (photos, voice
	// notes, files) + portal uploads. Shown alongside documents in All Documents
	// with inline previews; the actual file serves from `url` (decrypted on read).
	interface MediaItem {
		id: string;
		type: 'image' | 'voice' | 'video' | 'file';
		url: string;
		playbackUrl?: string;
		filename?: string | null;
		fileSize?: number | null;
		description?: string | null;
		transcript?: string | null;
		createdAt?: string | null;
	}

	// One grid/list entry — a document or a media attachment, date-sorted.
	type LibraryItem = { kind: 'doc'; date: string; doc: DocListItem } | { kind: 'media'; date: string; media: MediaItem };

	let documents = $state<DocListItem[]>([]);
	let mediaItems = $state<MediaItem[]>([]);
	let selectedMedia = $state<MediaItem | null>(null);
	let folders = $state<Folder[]>([]);
	let selectedDoc = $state<DocFull | null>(null);
	let loadingDoc = $state(false);
	let searchQuery = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	// Load-on-scroll pagination. We NEVER eager-load the whole vault — doing that
	// fired ~1 request per 150 docs up front, flooding the single-threaded backend
	// and the 6-connection HTTP pool so create/autosave got starved ("queuing
	// behind a bunch of loads"). Page 1 paints immediately; more pages load as you
	// scroll. Search runs SERVER-SIDE (?q=) so filtering never needs the whole
	// vault in memory. `loadGeneration` invalidates an in-flight load when the
	// folder or search changes.
	let loadGeneration = 0;
	let loadingMore = $state(false);
	let docTotal = $state(0);
	const hasMore = $derived(documents.length < docTotal);
	const PAGE_SIZE = 60; // one screenful per page
	// Bottom-of-list sentinel: when it scrolls into view (600px early) we load the
	// next page. Replaces the eager whole-vault background fill.
	let loadSentinel = $state<HTMLDivElement | null>(null);
	let copySuccess = $state(false);
	let viewMode = $state<'grid' | 'list'>('grid');
	// Grid card size — 'sm' = 180px floor (compact, default), 'lg' = 360px
	// floor (≈2× area, makes HTML thumbnail text readable). Persisted so
	// the user's choice survives reload. Only meaningful when viewMode='grid'.
	let gridSize = $state<'sm' | 'lg'>('sm');
	if (browser) {
		const saved = localStorage.getItem('mycelium.library.gridSize');
		if (saved === 'lg' || saved === 'sm') gridSize = saved;
	}
	function setGridSize(s: 'sm' | 'lg') {
		gridSize = s;
		if (browser) localStorage.setItem('mycelium.library.gridSize', s);
	}
	const gridMinPx = $derived(gridSize === 'lg' ? 360 : 180);

	// Edit mode
	let editing = $state(false);
	let editContent = $state('');
	let editorRef = $state<HTMLTextAreaElement | null>(null);
	let showRawMarkdown = $state(false);
	// Lazy-loaded CodeMirror editor + its live instance (for toolbar formatting).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let MarkdownEditor = $state<any>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mdEditor = $state<any>(null);
	async function ensureEditor() {
		if (!MarkdownEditor) MarkdownEditor = (await import('$lib/editor/MarkdownEditor.svelte')).default;
	}

	// One formatting entry point for the toolbar + shortcuts. The live CM editor
	// formats through its own API (keeps the cursor sane); the raw textarea / HTML
	// paths reuse the marker helpers.
	function format(kind: string) {
		if (mdEditor && !showRawMarkdown && !isHtmlDoc(selectedDoc?.path, editContent)) {
			mdEditor.applyFormat(kind);
			return;
		}
		switch (kind) {
			case 'bold': insertFormat('**', '**'); break;
			case 'italic': insertFormat('*', '*'); break;
			case 'code': insertFormat('`', '`'); break;
			case 'strike': insertFormat('~~', '~~'); break;
			case 'link': insertFormat('[', '](url)'); break;
			case 'h1': insertLinePrefix('# '); break;
			case 'h2': insertLinePrefix('## '); break;
			case 'h3': insertLinePrefix('### '); break;
			case 'bullet': insertLinePrefix('- '); break;
			case 'number': insertLinePrefix('1. '); break;
			case 'check': insertLinePrefix('- [ ] '); break;
			case 'quote': insertLinePrefix('> '); break;
		}
	}
	const activeFolderId = $derived($navigationState.activeFolderId);

	// Autosave — the writing sanctuary has no Save button. Edits to `editContent`
	// debounce into a background save; a quiet whisper reflects state. HTML docs
	// keep the explicit textarea path; markdown docs write through MarkdownEditor.
	let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
	const AUTOSAVE_DEBOUNCE_MS = 800;

	function scheduleAutosave() {
		saveState = 'idle';
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => { void autosave(); }, AUTOSAVE_DEBOUNCE_MS);
	}

	function onEditorChange(next: string) {
		editContent = next;
		scheduleAutosave();
	}

	async function autosave() {
		if (!selectedDoc) return;
		if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
		const path = selectedDoc.path;
		const content = editContent;
		// Nothing to do if the buffer already matches what's persisted.
		if (content === (selectedDoc.content ?? '')) { saveState = 'saved'; return; }
		saveState = 'saving';
		// Self-write echo guard: the live broadcaster fires a doc-updated for this
		// write within ~300ms; flagging the path tells our SSE handler to ignore it.
		markSelfWrite(path);
		try {
			const res = await api('/portal/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, title: selectedDoc.title, content }),
			});
			if (res.ok) {
				selectedDoc = { ...selectedDoc, content };
				saveState = 'saved';
			} else {
				// Don't fail silently — your edits aren't saved; tell you so.
				saveState = 'idle';
				toasts.error(`Couldn't save your changes (${res.status}). Your edits are still here — try again.`);
			}
		} catch (e) {
			console.error('[Library] Autosave failed:', e);
			saveState = 'idle';
			toasts.error('Couldn’t save your changes — check your connection. Your edits are still here.');
		}
	}

	// Exit editing — flush any pending autosave first so no keystroke is lost.
	async function finishEditing() {
		await autosave();
		editing = false;
		showRawMarkdown = false;
		agentUpdatedWhileEditing = false;
	}

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

	// Rename (display title only — path is the stable identity, never changed).
	// `renamingPath` marks which doc is being renamed; the card/row/header swaps
	// its title for an input while it matches.
	let renamingPath = $state<string | null>(null);
	let renameValue = $state('');
	let renameInputEl = $state<HTMLInputElement | null>(null);

	// Change link (path / slug rename — the document's IDENTITY, distinct from the
	// display-title rename above). A heavier op: it moves the ?doc= URL id and
	// cascades every reference server-side. Lives in its own context-menu panel.
	let showChangeLink = $state(false);
	let linkValue = $state('');
	let linkInputEl = $state<HTMLInputElement | null>(null);
	let changingLink = $state(false);

	// Long-press for mobile
	let longPressTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let longPressStartPos = $state<{ x: number; y: number } | null>(null);

	// Track previous folder to detect changes
	let prevFolderId = $state<string | null | undefined>(undefined);

	// PR 6: list-channel SSE state. `listConnectionState` mirrors the
	// per-doc connection state and surfaces if the disconnected banner
	// ever needs UI affordance. v1 tracks it but doesn't display anything
	// — the per-doc connection state is more user-visible (it follows
	// the open doc); list-channel disconnect is silent recovery.
	let listConnectionState = $state<LiveConnectionState>('connecting');

	onMount(() => {
		// Initial load is fire-and-forget — the listeners below don't depend on
		// it, so they attach synchronously (onMount must return its cleanup
		// synchronously; an async callback can't).
		void Promise.all([loadDocuments(), loadFolders()]).then(() => {
			loading = false;
			prevFolderId = activeFolderId;
			// Media appears only in the combined "All Documents" feed and costs an
			// attachment decrypt scan — load it AFTER documents paint so the Library
			// shows immediately and media streams in a beat later.
			void loadMedia();
		});

		// Reload after drag-and-drop move
		function handleDocMoved() {
			loadDocuments();
		}

		window.addEventListener('doc-moved', handleDocMoved);

		// Subscribe to the list channel so new agent / importer / bot
		// writes appear without a manual reload. Per PR 5+7, payloads are
		// metadata + structural fields only — title/summary live behind
		// the per-doc fetch. The patcher (below) handles in-place updates
		// for known paths and a filter-aware fetch+insert for unknown
		// paths. Folder mutations refetch `/portal/folders` (cheap; tiny).
		const subList = subscribeToLibrary({
			onResync: () => { loadDocuments(); loadFolders(); },
			onDocUpserted: (ev) => patchListUpsert(ev.path, ev),
			onDocRemoved: (ev) => patchListRemove(ev.path),
			onFolderChanged: () => { loadFolders(); },
			onConnectionState: (state) => { listConnectionState = state; },
		});

		return () => {
			window.removeEventListener('doc-moved', handleDocMoved);
			subList.dispose();
		};
	});

	// ── List-patch helpers ────────────────────────────────────────────

	// Burst coalescer: if many `document-upserted` events arrive in a
	// short window (e.g. 500-doc Obsidian import), fall back to one
	// `loadDocuments()` instead of N point fetches. Threshold tuned for
	// typical chat turns (1–3 doc writes per turn → point fetches) vs
	// bulk operations (8+ events in <500ms → reload).
	const BURST_THRESHOLD = 8;
	const BURST_WINDOW_MS = 500;
	let burstCount = 0;
	let burstTimer: ReturnType<typeof setTimeout> | null = null;

	function patchListUpsert(
		path: string,
		ev: { updated_at?: string; is_pinned?: number; folder_id?: string | null; published?: number },
	) {
		burstCount++;
		if (!burstTimer) {
			burstTimer = setTimeout(() => {
				const exceeded = burstCount > BURST_THRESHOLD;
				burstCount = 0;
				burstTimer = null;
				if (exceeded) loadDocuments();
			}, BURST_WINDOW_MS);
		}

		// Cheap path always runs — even when burst is also scheduling a
		// refetch, the in-place update gives instant feedback.
		const idx = documents.findIndex((d) => d.path === path);
		if (idx >= 0) {
			const next = { ...documents[idx] };
			if (ev.updated_at) next.updated_at = ev.updated_at;
			if (typeof ev.is_pinned === 'number') next.pinned = ev.is_pinned;
			if (ev.folder_id !== undefined) next.folder_id = ev.folder_id ?? undefined;

			// PR 7: filter-membership re-evaluation. If the doc's new
			// state means it no longer belongs in the current view
			// (unpinned while on Starred; moved out of the active
			// folder), drop it from the local list. Don't try to
			// validate move-INTO; that path is unknown and falls
			// through to fetchAndInsertIfMatches when the row arrives.
			if (activeFolderId === 'starred' && !next.pinned) {
				documents = documents.filter((d) => d.path !== path);
				return;
			}
			if (
				activeFolderId &&
				activeFolderId !== 'starred' &&
				next.folder_id !== activeFolderId
			) {
				documents = documents.filter((d) => d.path !== path);
				return;
			}

			documents[idx] = next;
			documents = [...documents]; // reactivity: trigger derived recompute
			return;
		}

		// Unknown path — fetch row to honour folder filter and render.
		fetchAndInsertIfMatches(path);
	}

	async function fetchAndInsertIfMatches(path: string) {
		try {
			const encoded = path.split('/').map(encodeURIComponent).join('/');
			const res = await api(`/portal/documents/${encoded}`);
			if (!res.ok) return;
			const data = await res.json();
			const doc = data?.document;
			if (!doc || !doc.path) return;

			// Filter check — does this doc belong in the current view?
			if (activeFolderId === 'starred' && !doc.is_pinned && !doc.pinned) return;
			if (
				activeFolderId &&
				activeFolderId !== 'starred' &&
				doc.folder_id !== activeFolderId
			) return;

			// Race guard: while the fetch was in flight the user may have
			// switched folders, or the same path may have been inserted
			// (e.g. a previous event raced ahead). Idempotent insert.
			if (documents.some((d) => d.path === doc.path)) return;

			// Strip heavy fields — the list view doesn't render content;
			// keep payload minimal so the array stays cheap to copy.
			const { content: _content, ...listItem } = doc as DocFull;
			documents = [listItem, ...documents];
		} catch {
			// Transient — the next event for this path (or the next
			// reconnect resync) will retry.
		}
	}

	function patchListRemove(path: string) {
		documents = documents.filter((d) => d.path !== path);
		if (selectedDoc?.path === path) {
			selectedDoc = null;
			editing = false;
		}
	}

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

	// Build the query (folder/pinned/search) shared by every page of a load.
	function docsBaseParams(): URLSearchParams {
		const params = new URLSearchParams();
		if (activeFolderId === 'starred') params.set('pinned', '1');
		else if (activeFolderId) params.set('folder_id', activeFolderId);
		const q = searchQuery.trim();
		if (q) params.set('q', q); // server-side search — no whole-vault load
		return params;
	}

	// Load the FIRST page (reset). Supersedes any in-flight load/load-more via the
	// generation token. Never fans out across the whole vault.
	async function loadDocuments() {
		loadError = null;
		const gen = ++loadGeneration;
		loadingMore = false;
		try {
			const params = docsBaseParams();
			params.set('limit', String(PAGE_SIZE));
			params.set('offset', '0');
			const res = await api(`/portal/documents?${params.toString()}`);
			if (gen !== loadGeneration) return; // superseded mid-flight
			if (res.ok) {
				const data = await res.json();
				if (gen !== loadGeneration) return;
				documents = data.documents || [];
				const total = Number(data.total);
				docTotal = Number.isFinite(total) ? total : documents.length;
			} else {
				console.error('[Library] Failed to load documents:', res.status, res.statusText);
				loadError = `Failed to load documents (${res.status})`;
			}
		} catch (e) {
			console.error('[Library] Error loading documents:', e);
			loadError = e instanceof Error ? e.message : 'Failed to load documents';
		}
	}

	// Load-on-scroll: fetch ONE more page at the current offset and append. Fired
	// by the bottom sentinel's IntersectionObserver. One page in flight at a time
	// (loadingMore guard) so scrolling never re-creates the old request flood.
	async function loadMore() {
		if (loadingMore || !hasMore) return;
		const gen = loadGeneration;
		loadingMore = true;
		try {
			const params = docsBaseParams();
			params.set('limit', String(PAGE_SIZE));
			params.set('offset', String(documents.length));
			const res = await api(`/portal/documents?${params.toString()}`);
			if (gen !== loadGeneration) return; // folder/search changed → stale page
			if (!res.ok) return;
			const data = await res.json();
			if (gen !== loadGeneration) return;
			const page: DocListItem[] = data.documents || [];
			const seen = new Set(documents.map((d) => d.path));
			const fresh = page.filter((d) => !seen.has(d.path));
			if (fresh.length) documents = [...documents, ...fresh];
			const total = Number(data.total);
			if (Number.isFinite(total)) docTotal = total;
		} catch (e) {
			console.error('[Library] Error loading more documents:', e);
		} finally {
			if (gen === loadGeneration) loadingMore = false;
		}
	}

	// Debounced server-side search: re-query page 1 when the text changes. The
	// first run (mount) is skipped — onMount already loads page 1.
	let searchDebounce: ReturnType<typeof setTimeout> | null = null;
	let searchInitialized = false;
	$effect(() => {
		const _q = searchQuery; // track
		if (!searchInitialized) { searchInitialized = true; return; }
		if (searchDebounce) clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => { void loadDocuments(); }, 250);
	});

	// Observe the bottom sentinel → load the next page as you approach it.
	$effect(() => {
		if (!browser || !loadSentinel) return;
		const io = new IntersectionObserver(
			(entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); },
			{ rootMargin: '600px' },
		);
		io.observe(loadSentinel);
		return () => io.disconnect();
	});

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

	async function loadMedia() {
		try {
			const res = await api('/portal/attachments?limit=200');
			if (res.ok) {
				const data = await res.json();
				mediaItems = data.attachments || [];
			}
		} catch (e) {
			console.error('[Library] Error loading media:', e);
		}
	}

	// Docs are already filtered server-side (folder + ?q= search), so the loaded
	// set IS the result — no client-side re-filtering, no whole-vault load.
	const filteredDocs = $derived(documents);

	const filteredMedia = $derived.by(() => {
		// Media lives in All Documents only — folders + starred are doc concepts.
		if (activeFolderId) return [];
		let items = mediaItems;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			items = items.filter((m) =>
				(m.filename || '').toLowerCase().includes(q) ||
				(m.description || '').toLowerCase().includes(q) ||
				(m.transcript || '').toLowerCase().includes(q)
			);
		}
		return items;
	});

	// Unified, recency-sorted feed: documents + media in one grid/list.
	const libraryItems = $derived.by<LibraryItem[]>(() => {
		const items: LibraryItem[] = filteredDocs.map((d) => ({ kind: 'doc' as const, date: d.updated_at || '', doc: d }));
		for (const m of filteredMedia) items.push({ kind: 'media' as const, date: m.createdAt || '', media: m });
		return items.sort((a, b) => b.date.localeCompare(a.date));
	});

	function formatBytes(n?: number | null): string {
		if (!n || n <= 0) return '';
		if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function selectDoc(doc: DocListItem, updateParams = true) {
		loadingDoc = true;
		editing = false;
		selectedDoc = { ...doc, content: '' };
		// Phase C: the workspace owns the URL — record the open doc in this tab's
		// params; the store mirrors it to /library?doc=… and restores it on reload.
		if (updateParams) setParams?.({ doc: doc.path });
		try {
			const res = await api(`/portal/documents/${doc.path}`);
			if (res.ok) {
				const data = await res.json();
				selectedDoc = { ...doc, ...data.document };
			}
		} catch {}
		loadingDoc = false;
	}

	// Phase C deep-link / reload restore: when this tab's `doc` param names a
	// document, open it. Guarded against looping with selectDoc's own setParams.
	$effect(() => {
		if (doc && doc !== selectedDoc?.path) {
			const d = documents.find((x) => x.path === doc);
			if (d) selectDoc(d, false);
		}
	});

	function startEditing() {
		if (!selectedDoc) return;
		void ensureEditor(); // lazy-load CodeMirror on first edit
		editContent = selectedDoc.content || '';
		editing = true;
		// Default to the live writing surface (WYSIWYG); raw markdown is one
		// quiet toggle away for power editing.
		showRawMarkdown = false;
		saveState = 'idle';
		agentUpdatedWhileEditing = false;
	}

	// Reload to the agent's latest version, discarding the local edit
	// buffer. Wired to the "Agent updated this — Reload" banner.
	async function discardEditAndReload() {
		if (!selectedDoc) return;
		editing = false;
		editContent = '';
		showRawMarkdown = false;
		agentUpdatedWhileEditing = false;
		await reloadCurrentDoc();
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

	// HTML docs (path ends .html/.htm, or content sniffs as a full HTML
	// document) render in a sandboxed iframe so agent-authored layouts,
	// styles, and scripts work — without granting them parent-origin
	// access. `allow-scripts` without `allow-same-origin` puts the doc in
	// a unique null origin: scripts run, but cookies, the portal API, and
	// the parent DOM are all out of reach.
	function isHtmlDoc(path?: string | null, content?: string | null): boolean {
		if (path && /\.html?$/i.test(path)) return true;
		if (content) {
			const head = content.trimStart().slice(0, 100).toLowerCase();
			if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
		}
		return false;
	}

	// Selected doc is HTML and we're not currently editing it.
	const isHtmlPreview = $derived(
		!!selectedDoc && !editing && isHtmlDoc(selectedDoc.path, selectedDoc.content),
	);

	// Briefly flashes when the live-watch poll picks up a server-side
	// edit — drives the "live" pulse next to the iframe.
	let livePulse = $state(false);
	// Animates while a manual reload is in flight.
	let reloading = $state(false);

	async function reloadCurrentDoc() {
		if (!selectedDoc || reloading) return;
		reloading = true;
		try {
			const res = await api(`/portal/documents/${selectedDoc.path}`);
			if (!res.ok) return;
			const fresh = await res.json();
			// API returns { document: { ... } }; fall back to the legacy
			// flat shape just in case some upstream proxy unwraps.
			const next = fresh?.document ?? fresh;
			const nextContent = typeof next?.content === 'string' ? next.content : null;
			if (nextContent !== null && nextContent !== selectedDoc.content) {
				selectedDoc = { ...selectedDoc, ...next };
				flashPulse();
			} else if (selectedDoc) {
				// Even if content didn't change, force the iframe to
				// re-evaluate (e.g. after the user knows the agent
				// just wrote something) by reassigning.
				selectedDoc = { ...selectedDoc, ...next };
			}
		} finally {
			reloading = false;
		}
	}

	// Live-watch: subscribe to per-doc SSE for any open document. When
	// the agent (or any other writer) upserts the doc, the server
	// pushes a `doc-updated` event and we refetch + morph in place.
	// Pauses when the tab is hidden via the standard visibility check
	// inside the refetch handler (subscription stays open; refetch
	// short-circuits when not visible to avoid wasted work).
	//
	// Replaces the prior 3s polling loop. Polling is no longer used as
	// a fallback for the initial wave — the server-side hook fires
	// reliably for every documents.upsert, and EventSource auto-
	// reconnects on transient failures. If SSE goes terminally
	// disconnected, `liveConnectionState` flips to 'disconnected' and
	// the manual reload button remains available.
	let liveConnectionState = $state<LiveConnectionState>('connecting');
	// True when SSE delivered a `doc-updated` for the open doc while
	// `editing` was true — the morph was suppressed to preserve the
	// user's unsaved buffer, and a banner above the editor offers a
	// reload affordance. Cleared on Reload / Save / Cancel.
	let agentUpdatedWhileEditing = $state(false);
	// True for ~400ms after a live update arrives — drives the gold
	// pulse next to the iframe / publish pill so you can see the doc
	// just refreshed itself.
	function flashPulse() {
		livePulse = true;
		setTimeout(() => { livePulse = false; }, 400);
	}

	$effect(() => {
		if (!browser) return;
		if (!selectedDoc) return;
		const path = selectedDoc.path;

		const refetch = async () => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			try {
				const res = await api(`/portal/documents/${path}`);
				if (!res.ok) return;
				const fresh = await res.json();
				if (!selectedDoc || selectedDoc.path !== path) return;
				const newContent = fresh?.document?.content ?? fresh?.content;
				if (typeof newContent === 'string' && newContent !== selectedDoc.content) {
					selectedDoc = { ...selectedDoc, ...(fresh.document ?? fresh) };
					flashPulse();
				}
			} catch { /* transient; SSE will signal again on next change */ }
		};

		const sub = subscribeToDoc(path, {
			onUpdate: () => {
				// Suppress auto-update while user is editing — they keep
				// their unsaved buffer. We set a flag so the banner can
				// offer "Reload" without waiting for them to manually
				// poll. Cleared when they accept the reload, save, or
				// cancel editing.
				if (editing) {
					agentUpdatedWhileEditing = true;
					return;
				}
				refetch();
			},
			onDelete: () => {
				if (selectedDoc?.path === path) {
					selectedDoc = null;
					editing = false;
				}
			},
			onConnectionState: (state) => { liveConnectionState = state; },
		});

		return () => sub.dispose();
	});

	// ── Markdown morph: keep the read-only viewer's DOM stable across
	// updates so scroll, selection, and focus survive when the agent
	// rewrites the doc. Replaces `{@html}` (which fully swaps innerHTML
	// on every reactivity tick).
	let mdReadonlyContainer = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!mdReadonlyContainer || !selectedDoc?.content || editing) return;
		// Pull the rendered HTML before morphing; the morph is the only
		// place we touch this container's children.
		applyMorph(mdReadonlyContainer, renderMarkdown(selectedDoc.content, true));
	});
	$effect(() => {
		// When switching between docs, drop the cached signature so the
		// next morph never gets short-circuited by a coincidental match.
		if (selectedDoc?.path) resetMorph(mdReadonlyContainer);
	});

	// ── Live HTML iframe: agent rewrites the doc → postMessage update
	// to the bootloader, which morphs document.body in place. No flash,
	// scroll preserved. The first paint sets srcdoc with the wrapped
	// HTML; mountLiveIframe attaches the parent-side handshake.
	let liveHtmlIframe = $state<HTMLIFrameElement | null>(null);
	let liveIframeHandle: LiveIframeHandle | null = null;

	$effect(() => {
		// (Re)mount whenever the iframe element identity changes (Svelte
		// re-renders on conditional toggles like edit-mode <-> read-mode).
		if (!liveHtmlIframe) return;
		liveIframeHandle?.dispose();
		liveIframeHandle = mountLiveIframe(liveHtmlIframe);
		return () => {
			liveIframeHandle?.dispose();
			liveIframeHandle = null;
		};
	});

	$effect(() => {
		// Drive updates: any change to selectedDoc.content for an HTML
		// doc, route through the live handle. It picks postMessage when
		// the bootloader is ready, falls back to srcdoc swap otherwise.
		if (!liveHtmlIframe) return;
		if (!selectedDoc?.content) return;
		if (!isHtmlDoc(selectedDoc.path, selectedDoc.content)) return;
		const html = selectedDoc.content;
		// `update()` itself is idempotent against identical srcdoc
		// reassigns, but we only want to fire on actual content change.
		// Stash the last-applied content on the iframe element to skip
		// when nothing changed.
		const last = (liveHtmlIframe as any).__lastLiveContent;
		if (last === html) return;
		(liveHtmlIframe as any).__lastLiveContent = html;
		if (liveIframeHandle) {
			liveIframeHandle.update(html);
		} else {
			// Pre-mount initial paint — set the wrapped srcdoc directly
			// so the bootloader can start before the parent handshake.
			liveHtmlIframe.srcdoc = wrapHtmlForLive(html);
		}
	});

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
		// Auto-save — flag self-write so the live broadcaster's echo
		// for this exact change doesn't fight the local optimistic
		// update we just applied.
		markSelfWrite(selectedDoc.path);
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
		scheduleAutosave();

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
		scheduleAutosave();

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
			void autosave();
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

	let agentNameMap: Record<string, string> = $state({});
	// Load agent names dynamically (supports user-customized names)
	$effect(() => {
		if (browser) {
			api('/portal/agents').then(async (res) => {
				if (res.ok) {
					const data = await res.json();
					const map: Record<string, string> = {};
					for (const a of data.agents || []) { map[a.id] = a.name; }
					agentNameMap = map;
				}
			}).catch(() => {});
		}
	});

	// Open the chat float scoped to a specific library document.
	// Marker click → set docScope, open the chat. ChatFloat reads
	// docScope and shows a "Re: <title>" chip + appends the doc
	// reference to outgoing messages so the agent has context.
	function openChatForDoc(doc: DocFull | null) {
		if (!doc) return;
		// If the doc was authored by a known agent, prefer chatting
		// with that agent. ChatFloat reads docScope.agentId on its
		// next render and switches itself if the value differs from
		// its current selection.
		const createdBy = doc.created_by;
		const agentId = createdBy && createdBy !== 'user' && createdBy !== 'self' && agentNameMap[createdBy]
			? createdBy
			: null;
		navigationState.setDocScope({
			path: doc.path,
			title: doc.title || doc.path,
			agentId,
		});
		navigationState.setChatOpen(true);
	}

	function parseDocMetadata(raw: unknown): DocMetadata | null {
		if (!raw) return null;
		if (typeof raw === 'object') return raw as DocMetadata;
		if (typeof raw === 'string') {
			try { return JSON.parse(raw) as DocMetadata; } catch { return null; }
		}
		return null;
	}

	function getAuthorLabel(createdBy?: string, metadata?: string | DocMetadata): string | null {
		if (!createdBy) return null;
		// 'user' (legacy) and 'self' both render as "You" — back-compat for
		// the ~600 existing rows that pre-date PR 5.10's token convention.
		if (createdBy === 'user' || createdBy === 'self') return 'You';
		if (agentNameMap[createdBy]) return agentNameMap[createdBy];
		// PR 5.10 platform tokens: 'tg:<id>', 'wa:<id>', 'discord:<id>'.
		// Resolve display name from the encrypted metadata.source block
		// when present; fall back to the bare token (e.g. "tg:707534994")
		// so the row never silently misattributes to "You".
		const colon = createdBy.indexOf(':');
		if (colon > 0) {
			const meta = parseDocMetadata(metadata);
			const displayName = meta?.source?.user_name?.trim();
			if (displayName) return displayName;
			// Token without a resolvable name — show platform shorthand.
			const platform = createdBy.slice(0, colon);
			const platformLabel = ({ tg: 'Telegram', wa: 'WhatsApp', discord: 'Discord' } as Record<string, string>)[platform] || platform;
			return `${platformLabel} user`;
		}
		return createdBy;
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
		showChangeLink = false;
		contextMenu = { x: e.clientX, y: e.clientY, doc };
	}

	function closeContextMenu() {
		contextMenu = null;
		showDeleteConfirm = false;
		showMoveMenu = false;
		showChangeLink = false;
	}

	function handleTouchStart(e: TouchEvent, doc: DocListItem) {
		const touch = e.touches[0];
		longPressStartPos = { x: touch.clientX, y: touch.clientY };
		longPressTimer = setTimeout(() => {
			e.preventDefault();
			if (navigator.vibrate) navigator.vibrate(50);
			showDeleteConfirm = false;
			showMoveMenu = false;
			showChangeLink = false;
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

	// ── Rename (display title) ──────────────────────────────────────────

	function startRename(doc: DocListItem) {
		closeContextMenu();
		renamingPath = doc.path;
		renameValue = doc.title || doc.path;
		// Focus + select the input once it renders.
		requestAnimationFrame(() => { renameInputEl?.focus(); renameInputEl?.select(); });
	}

	function cancelRename() {
		renamingPath = null;
		renameValue = '';
	}

	async function commitRename() {
		const path = renamingPath;
		const title = renameValue.trim();
		if (!path) return;
		const doc = documents.find((d) => d.path === path) ?? (selectedDoc?.path === path ? selectedDoc : null);
		renamingPath = null;
		// No-op if blank or unchanged.
		if (!title || (doc && (doc.title || doc.path) === title)) return;
		// Optimistic update everywhere the title shows.
		documents = documents.map((d) => (d.path === path ? { ...d, title } : d));
		if (selectedDoc?.path === path) selectedDoc = { ...selectedDoc, title };
		markSelfWrite(path); // the rename broadcasts a doc-updated; ignore the echo
		try {
			const res = await api('/portal/documents/rename', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, title }),
			});
			if (!res.ok) {
				let detail = '';
				try { detail = ((await res.json())?.error as string) || ''; } catch { /* no body */ }
				toasts.error(`Couldn't rename (${res.status})${detail ? ` — ${detail}` : ''}`);
				loadDocuments(); // resync to the server's truth
			}
		} catch (e) {
			console.error('[Library] Failed to rename:', e);
			toasts.error(e instanceof Error ? e.message : 'Failed to rename');
			loadDocuments();
		}
	}

	// ── Change link (path / slug — the document's identity) ──────────────
	// Opens the in-menu panel prefilled with the current path. Server-side this is
	// an atomic cascade; client-side we optimistically re-point every path-keyed bit
	// of local state and swallow both SSE echoes (remove(old) + upsert(new)).

	function startChangeLink(doc: DocListItem) {
		showChangeLink = true;
		linkValue = doc.path;
		requestAnimationFrame(() => { linkInputEl?.focus(); linkInputEl?.select(); });
	}

	async function commitChangeLink() {
		const doc = contextMenu?.doc;
		if (!doc || changingLink) return;
		const oldPath = doc.path;
		const newPath = linkValue.trim();
		if (!newPath || newPath === oldPath) { showChangeLink = false; closeContextMenu(); return; }
		changingLink = true;
		// If this doc is open + dirty, flush the pending autosave to the OLD path
		// first (it still exists pre-rename) so no keystroke is lost; we re-point
		// selectedDoc.path on success so later autosaves target the new path.
		if (selectedDoc?.path === oldPath) await autosave();
		// The rename broadcasts remove(old) + upsert(new); swallow BOTH echoes.
		markSelfWrite(oldPath);
		markSelfWrite(newPath);
		try {
			const res = await api('/portal/documents/rename-path', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: oldPath, new_path: newPath }),
			});
			if (res.ok) {
				documents = documents.map((d) => (d.path === oldPath ? { ...d, path: newPath } : d));
				if (selectedDoc?.path === oldPath) {
					selectedDoc = { ...selectedDoc, path: newPath };
					setParams?.({ doc: newPath });
				}
				showChangeLink = false;
				closeContextMenu();
			} else {
				let detail = '';
				try { detail = ((await res.json())?.error as string) || ''; } catch { /* no body */ }
				toasts.error(`Couldn't change the link (${res.status})${detail ? ` — ${detail}` : ''}`);
				loadDocuments(); // resync to the server's truth
			}
		} catch (e) {
			console.error('[Library] Failed to change link:', e);
			toasts.error(e instanceof Error ? e.message : 'Failed to change link');
			loadDocuments();
		} finally {
			changingLink = false;
		}
	}

	async function createNewDocument() {
		if (!newDocTitle.trim() || creatingDoc) return;
		creatingDoc = true;
		try {
			const title = newDocTitle.trim();
			// Slug from the title. A title with no slug-able characters
			// (non-Latin / emoji / symbols-only) used to collapse to an EMPTY
			// path, which the server rejects (400) and the UI swallowed
			// silently — "create does nothing". Fall back to 'untitled', then
			// de-dupe against loaded paths so a new doc never silently
			// overwrites an existing one via upsert.
			const base =
				title
					.toLowerCase()
					.replace(/\s+/g, '-')
					.replace(/[^a-z0-9-]/g, '')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '') || 'untitled';
			let path = base;
			const existing = new Set(documents.map((d) => d.path));
			for (let n = 2; existing.has(path); n++) path = `${base}-${n}`;
			const folderId = activeFolderId && activeFolderId !== 'starred' ? activeFolderId : null;
			const res = await api('/portal/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, title, content: '', folder_id: folderId }),
			});
			if (res.ok) {
				newDocTitle = '';
				showNewDocInput = false;
				// Open the new doc straight from the create response — don't
				// reload-then-find (with pagination the doc may not be on the
				// reloaded page, so the find raced and the editor never opened).
				const created = (await res.json().catch(() => null))?.document as DocFull | undefined;
				void loadDocuments(); // refresh the list in the background
				if (created?.path) {
					selectedDoc = { ...created };
					setParams?.({ doc: created.path });
					startEditing();
				}
			} else {
				// Surface the failure instead of doing nothing. Read a short
				// server message if present (never log/show document content).
				let detail = '';
				try { detail = ((await res.json())?.error as string) || ''; } catch { /* no body */ }
				toasts.error(`Couldn't create the document (${res.status})${detail ? ` — ${detail}` : ''}`);
			}
		} catch (e) {
			console.error('[Library] Failed to create document:', e);
			toasts.error(e instanceof Error ? e.message : 'Failed to create document');
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

	let downloadMenuOpen = $state(false);

	async function exportDocument(format: 'md' | 'html' | 'pdf' | 'docx') {
		if (!selectedDoc?.path) return;
		downloadMenuOpen = false;
		const title = selectedDoc.title || selectedDoc.path || 'document';
		const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_');

		// Fast path: MD has the content already in-memory; skip the round-trip.
		if (format === 'md' && selectedDoc.content) {
			const blob = new Blob([selectedDoc.content], { type: 'text/markdown' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${safeTitle}.md`;
			a.click();
			URL.revokeObjectURL(url);
			return;
		}

		// PDF / DOCX / HTML — server converts via pandoc. Streams binary.
		try {
			const res = await api('/portal/documents/export', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: selectedDoc.path, format }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				console.error('[Library] export failed:', err);
				alert(err.error || `Export to ${format.toUpperCase()} failed`);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${safeTitle}.${format}`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			console.error('[Library] export error:', e);
			alert(e instanceof Error ? e.message : 'Export failed');
		}
	}
</script>

<svelte:window
	onkeydown={(e) => { if (e.key === 'Escape') { closeContextMenu(); downloadMenuOpen = false; } }}
	onclick={() => { if (downloadMenuOpen) downloadMenuOpen = false; }}
/>

<svelte:head>
	<title>Library - Mycelium</title>
</svelte:head>

<div class="library-page">
	<!-- Header — contextual: list mode shows folder label + filters,
		 doc mode shows title + actions. Sticky so cursor anywhere on
		 the page can scroll the body underneath. (PR 5.2) -->
	<div class="library-header px-3 sm:px-6 py-2 sm:py-2.5 border-b border-[var(--color-border)]">
		{#if selectedDoc}
			<!-- ═══ DOC MODE ═══ -->
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-2 min-w-0 flex-1">
					<button
						onclick={() => { selectedDoc = null; editing = false; setParams?.({ doc: null }); }}
						class="p-1.5 -ml-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] transition-colors flex-shrink-0"
						aria-label="Back to library"
						title="Back to library"
					>
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<div class="min-w-0 flex-1">
						{#if renamingPath === selectedDoc.path}
							<input
								bind:this={renameInputEl}
								bind:value={renameValue}
								onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') cancelRename(); }}
								onblur={commitRename}
								class="w-full text-base sm:text-lg font-medium bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-primary)] focus:outline-none"
								aria-label="Rename document"
							/>
						{:else}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<h1
								class="text-base sm:text-lg font-medium text-[var(--color-text-primary)] truncate cursor-text"
								ondblclick={() => startRename(selectedDoc!)}
								title="Double-click to rename"
							>
								{selectedDoc.title || selectedDoc.path}
							</h1>
						{/if}
						<div class="flex items-center gap-x-2 gap-y-0.5 mt-0.5 flex-wrap text-[11px] text-[var(--color-text-tertiary)]">
							{#if getCategoryFromPath(selectedDoc.path)}
								<span class="tag-warm">{getCategoryFromPath(selectedDoc.path)}</span>
							{/if}
							{#if getAuthorLabel(selectedDoc.created_by, selectedDoc.metadata)}
								<span>by {getAuthorLabel(selectedDoc.created_by, selectedDoc.metadata)}</span>
							{/if}
							{#if getSourceLabel(selectedDoc.source_type)}
								<span>via {getSourceLabel(selectedDoc.source_type)}</span>
							{/if}
							{#if selectedDoc.content}
								<span>{wordCount(selectedDoc.content).toLocaleString()} words</span>
							{/if}
							{#if selectedDoc.updated_at}
								<span title={new Date(selectedDoc.updated_at).toLocaleString()}>
									Updated {formatDate(selectedDoc.updated_at, true)}
								</span>
							{/if}
						</div>
					</div>
				</div>

				<!-- Action buttons (top-right of header) -->
				<div class="flex items-center gap-0.5 flex-shrink-0">
					<!-- Pin/unpin -->
					<button
						onclick={(e) => togglePin(selectedDoc!, e)}
						class="p-1.5 rounded-lg transition-colors {selectedDoc.pinned ? 'text-aurum hover:bg-aurum/10' : 'text-[var(--color-text-secondary)] hover:bg-azure/20 hover:text-azure'}"
						aria-label={selectedDoc.pinned ? 'Unstar' : 'Star'}
						title={selectedDoc.pinned ? 'Unstar' : 'Star'}
					>
						<svg class="w-5 h-5" fill={selectedDoc.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
						</svg>
					</button>
					{#if !editing}
						<button
							onclick={startEditing}
							class="p-1.5 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure"
							aria-label="Edit"
							title="Edit document"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
					{/if}
					<!-- Download with format dropdown (PR 5.3). stopPropagation
						 keeps the global onclick (which closes the menu when
						 clicking outside) from also firing on the trigger. -->
					<div class="relative" onclick={(e) => e.stopPropagation()} role="presentation">
						<button
							onclick={(e) => { e.stopPropagation(); downloadMenuOpen = !downloadMenuOpen; }}
							class="p-1.5 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure flex items-center"
							aria-label="Download"
							aria-haspopup="menu"
							aria-expanded={downloadMenuOpen}
							title="Download (choose format)"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
							</svg>
							<svg class="w-3 h-3 -ml-0.5" fill="currentColor" viewBox="0 0 24 24">
								<path d="M7 10l5 5 5-5z"/>
							</svg>
						</button>
						{#if downloadMenuOpen}
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<div
								class="absolute right-0 top-full mt-1 w-44 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg shadow-lg z-20 py-1"
								role="menu"
							>
								<button class="w-full px-3 py-1.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]" role="menuitem" onclick={() => exportDocument('md')}>
									Markdown <span class="text-[var(--color-text-tertiary)] text-xs">(.md)</span>
								</button>
								<button class="w-full px-3 py-1.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]" role="menuitem" onclick={() => exportDocument('pdf')}>
									PDF <span class="text-[var(--color-text-tertiary)] text-xs">(.pdf)</span>
								</button>
								<button class="w-full px-3 py-1.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]" role="menuitem" onclick={() => exportDocument('docx')}>
									Word <span class="text-[var(--color-text-tertiary)] text-xs">(.docx)</span>
								</button>
								<button class="w-full px-3 py-1.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]" role="menuitem" onclick={() => exportDocument('html')}>
									HTML <span class="text-[var(--color-text-tertiary)] text-xs">(.html)</span>
								</button>
							</div>
						{/if}
					</div>
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
					<button
						onclick={() => { contextMenu = { x: 0, y: 0, doc: selectedDoc! }; showDeleteConfirm = true; }}
						class="p-1.5 hover:bg-red-500/10 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-red-400"
						aria-label="Delete"
						title="Delete document"
					>
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
						</svg>
					</button>
				</div>
			</div>
		{:else}
			<!-- ═══ LIST MODE ═══ -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2 sm:gap-3 min-w-0">
					<div class="min-w-0">
						<h1 class="text-lg sm:text-xl font-medium text-[var(--color-text-primary)] truncate">{getFolderLabel()}</h1>
						<p class="text-xs sm:text-sm text-[var(--color-text-tertiary)]">
							{docTotal.toLocaleString()} {docTotal === 1 ? 'document' : 'documents'}{#if filteredMedia.length} · {filteredMedia.length} media{/if}{#if loadingMore} · <span class="text-[var(--color-accent)]">loading…</span>{/if}
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

					<!-- Card-size toggle — only meaningful in grid view; hidden
					     in list view to keep the chrome quiet. Toggles between
					     a 180px (compact) and 360px (≈2× area) minimum card
					     width. The DocThumbnail's logical viewport stays the
					     same, so the rendered preview just gets bigger and
					     more readable. -->
					{#if viewMode === 'grid'}
						<div class="flex items-center gap-0.5 p-0.5 bg-[var(--color-elevated)] rounded-lg">
							<button
								class="p-1.5 rounded transition-colors {gridSize === 'sm' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
								onclick={() => setGridSize('sm')}
								title="Compact cards"
								aria-label="Compact card size"
							>
								<!-- 3×3 grid icon -->
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
								<!-- 2×2 grid icon -->
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<rect x="4"  y="4"  width="7" height="7" rx="1" />
									<rect x="13" y="4"  width="7" height="7" rx="1" />
									<rect x="4"  y="13" width="7" height="7" rx="1" />
									<rect x="13" y="13" width="7" height="7" rx="1" />
								</svg>
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- New document input -->
			{#if showNewDocInput}
				<div class="flex items-center gap-2 mt-3">
					<!-- svelte-ignore a11y_autofocus -->
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
		{/if}
	</div>

	<!-- Content -->
	<div class="library-content p-3 sm:p-6" class:no-scroll={!!selectedDoc} class:editor-flush={editing && !!selectedDoc}>
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
		{:else if libraryItems.length === 0}
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
			<!-- Document detail view — title + actions live in the sticky
				 header above. This block is just the body, which scrolls
				 with the page. (PR 5.2) -->
			<div class="doc-detail-view {isHtmlPreview ? 'w-full' : 'max-w-2xl mx-auto'}">
				{#if loadingDoc}
					<div class="flex items-center justify-center py-12">
						<div class="w-8 h-8 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
					</div>
				{:else if editing}
					<!-- ═══ EDITOR MODE ═══ -->
					<div class="flex flex-col gap-3">
						<!-- AI stays silent while you write: an agent rewrite to
							 this doc is detected (agentUpdatedWhileEditing) but
							 NEVER interrupts — no banner, no content swap. The
							 only surfacing is a calm, peripheral cue in the
							 footer below, which you can ignore or act on when
							 you pause. -->
						<!-- Formatting toolbar — the essentials. Works on the live
							 editor and the raw-markdown textarea; hidden for HTML
							 docs (edited as raw HTML). Word count lives in the
							 header byline above, not here. -->
						<div class="sticky top-0 z-10 bg-[var(--color-bg)] pb-1.5 flex items-center justify-between gap-2 min-h-[32px] flex-wrap">
							{#if !isHtmlDoc(selectedDoc?.path, editContent)}
								<div class="flex items-center gap-0.5 flex-wrap">
									<button class="fmt-btn" title="Heading" onclick={() => format('h1')}>H1</button>
									<button class="fmt-btn" title="Subheading" onclick={() => format('h2')}>H2</button>
									<span class="fmt-sep"></span>
									<button class="fmt-btn" title="Bold (⌘B)" onclick={() => format('bold')}><strong>B</strong></button>
									<button class="fmt-btn" title="Italic (⌘I)" onclick={() => format('italic')}><em class="font-serif">I</em></button>
									<button class="fmt-btn" title="Inline code" onclick={() => format('code')}><code class="text-[10px]">&lt;/&gt;</code></button>
									<span class="fmt-sep"></span>
									<button class="fmt-btn" title="Bullet list" onclick={() => format('bullet')} aria-label="Bullet list">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
									</button>
									<button class="fmt-btn" title="To-do" onclick={() => format('check')} aria-label="To-do checkbox">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
									</button>
									<button class="fmt-btn" title="Quote" onclick={() => format('quote')} aria-label="Blockquote">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M10 11h-4a1 1 0 01-1-1v-3a1 1 0 011-1h3a1 1 0 011 1v6c0 2.667-1.333 4.333-4 5M19 11h-4a1 1 0 01-1-1v-3a1 1 0 011-1h3a1 1 0 011 1v6c0 2.667-1.333 4.333-4 5" /></svg>
									</button>
									<button class="fmt-btn" title="Link (⌘K)" onclick={() => format('link')} aria-label="Link">
										<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
									</button>
								</div>
								<button
									onclick={() => showRawMarkdown = !showRawMarkdown}
									class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors flex-shrink-0 {showRawMarkdown ? 'border-[var(--color-accent)]/40 text-[var(--color-accent)] bg-[var(--color-accent)]/5' : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:border-[var(--color-border)]'}"
									title={showRawMarkdown ? 'Back to the live writing surface' : 'Edit raw markdown'}
								>
									{showRawMarkdown ? 'Live' : 'Markdown'}
								</button>
							{:else}
								<span></span>
							{/if}
						</div>

						<!-- Content: live writing surface (markdown), raw textarea
							 (power editing / HTML docs), or the HTML iframe preview. -->
						{#if isHtmlDoc(selectedDoc?.path, editContent)}
							<textarea
								bind:this={editorRef}
								value={editContent}
								oninput={(e) => onEditorChange(e.currentTarget.value)}
								onkeydown={handleEditorKeydown}
								class="editor-textarea"
								placeholder="Edit HTML…"
							></textarea>
						{:else if showRawMarkdown}
							<textarea
								bind:this={editorRef}
								value={editContent}
								oninput={(e) => onEditorChange(e.currentTarget.value)}
								onkeydown={handleEditorKeydown}
								class="editor-textarea"
								placeholder="Write in markdown…"
							></textarea>
						{:else}
							<!-- The writing sanctuary — CodeMirror live-preview,
								 lazy-loaded so it never weighs down library
								 navigation. Markdown stays the literal buffer. -->
							{#if MarkdownEditor}
								<MarkdownEditor
									bind:this={mdEditor}
									value={editContent}
									onChange={onEditorChange}
									onSave={autosave}
								/>
							{:else}
								<div class="min-h-[60vh] flex items-center justify-center text-[var(--color-text-tertiary)] text-sm">
									<div class="w-5 h-5 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
								</div>
							{/if}
						{/if}

						<!-- Footer: peripheral agent cue (left) + autosave whisper
							 + Done (right). No Save button — edits persist
							 automatically; Done flushes + exits. Sticky to the
							 viewport bottom so it never scrolls out of reach while
							 writing (bg occludes the text scrolling underneath). -->
						<div class="sticky bottom-0 z-10 bg-[var(--color-bg)] border-t border-[var(--color-border)] flex items-center justify-between gap-3 py-2">
							<!-- Calm cue: surfaces an agent's concurrent edit only
								 here, never over your text. Click reloads (which
								 discards your unsaved buffer — hence explicit). -->
							{#if agentUpdatedWhileEditing}
								<button
									type="button"
									onclick={discardEditAndReload}
									class="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)] hover:text-aurum transition-colors"
									title="An agent edited this document. Reload to their version (discards your unsaved edits)."
								>
									<span class="w-1.5 h-1.5 rounded-full bg-aurum/80"></span>
									Updated elsewhere · Reload
								</button>
							{:else}
								<span></span>
							{/if}
							<div class="flex items-center gap-3">
								<span class="text-xs text-[var(--color-text-tertiary)] transition-opacity" class:opacity-0={saveState === 'idle'}>
									{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}
								</span>
								<button
									onclick={finishEditing}
									class="px-4 py-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors"
								>
									Done
								</button>
							</div>
						</div>
					</div>
				{:else}
					<!-- ═══ READ-ONLY VIEW ═══ -->
					{#if selectedDoc.content}
						{#if isHtmlDoc(selectedDoc.path, selectedDoc.content)}
							<!-- Resizable wrapper. CSS `resize: horizontal`
								 gives a native browser drag grip in the
								 bottom-right so the user can shrink the
								 iframe (e.g. to put a second chat or a
								 portal-to-another-vps next to it). The
								 chat float overlays the iframe — that's
								 fine, the iframe keeps its full size. -->
							<div
								class="relative html-preview-wrap"
								style="width: 100%; height: calc(100vh - 8rem);"
							>
								<iframe
									bind:this={liveHtmlIframe}
									title={selectedDoc.title || selectedDoc.path}
									sandbox="allow-scripts allow-popups"
									class="w-full h-full border-0 rounded-lg block"
									style="background: Canvas;"
								></iframe>
								<!-- Top-right overlay group: publish-status pill,
									 reload, chat marker. The pill is the click
									 target for sharing/publishing; livePulse is
									 still wired for the auto-republish flash but
									 the pill itself is what surfaces visibility
									 state. The chat marker is interactive —
									 hover shows who you'd be talking to, click
									 opens the chat float scoped to this doc. -->
								<div class="absolute top-3 right-3 flex items-center gap-2">
									<PublishStatusPill docPath={selectedDoc.path} />
									<!-- Manual reload — refetch the doc now instead of
										 waiting for the next 3s poll. Useful when
										 you just saw the agent finish writing. -->
									<button
										type="button"
										onclick={reloadCurrentDoc}
										disabled={reloading}
										class="flex items-center justify-center w-7 h-7 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors disabled:opacity-50"
										aria-label="Reload document"
										title="Reload"
									>
										<svg
											class="w-3.5 h-3.5 text-white/90 {reloading ? 'animate-spin' : ''}"
											fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75"
										>
											<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6 M20 20v-6h-6 M5 13a8 8 0 0014.5 4 M19 11A8 8 0 004.5 7" />
										</svg>
									</button>
									<button
										type="button"
										onclick={() => openChatForDoc(selectedDoc)}
										class="group/marker relative flex items-center justify-center w-7 h-7 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors"
										aria-label="Chat about this document"
										title="Chat about this document"
									>
										<svg class="w-3.5 h-3.5 text-white/90" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
											<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
										</svg>
										<!-- Hover label: who you'll be chatting with about
											 this doc. Resolves to the agent name when the
											 doc was authored by an agent, else "your agent". -->
										<span class="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-medium text-white/95 bg-black/70 backdrop-blur-sm px-2 py-1 rounded-md opacity-0 group-hover/marker:opacity-100 transition-opacity">
											Chat with {getAuthorLabel(selectedDoc.created_by, selectedDoc.metadata) && getAuthorLabel(selectedDoc.created_by, selectedDoc.metadata) !== 'You' ? getAuthorLabel(selectedDoc.created_by, selectedDoc.metadata) : 'your agent'} about this
										</span>
									</button>
								</div>
							</div>
						{:else}
							<!-- Read-only markdown viewer — DOM-morphed so
								 agent-driven updates land in place: scroll
								 position, text selection, and any focused
								 checkbox all survive the swap. Click events
								 are delegated on this container; morphdom
								 (childrenOnly: true) preserves the binding. -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								bind:this={mdReadonlyContainer}
								class="doc-content"
								onclick={(e) => handleContentClick(e, 'readonly')}
							></div>
						{/if}
					{:else}
						<p class="text-[var(--color-text-tertiary)] text-sm">No content available.</p>
					{/if}
				{/if}
			</div>
		{:else if viewMode === 'list'}
			<!-- List view -->
			<div class="max-w-3xl mx-auto space-y-1.5 lib-scroll-list">
				{#each libraryItems as item}
					{#if item.kind === 'media'}
						{@const m = item.media}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							onclick={() => (selectedMedia = m)}
							onkeydown={(e) => { if (e.key === 'Enter') selectedMedia = m; }}
							role="button"
							tabindex="0"
							class="flex items-start gap-2 sm:gap-3 rounded-lg sm:rounded-xl p-2.5 sm:p-3 transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] w-full text-left border-[var(--color-border)] hover:border-aurum/50 group"
						>
							<span class="flex-shrink-0 w-8 sm:w-10 flex items-center justify-center pt-0.5">
								{#if m.type === 'image'}
									<img src={m.url} alt={m.filename || 'image'} loading="lazy" class="w-8 h-8 sm:w-10 sm:h-10 rounded-md object-cover" />
								{:else if m.type === 'voice'}
									<svg class="w-5 h-5 sm:w-6 sm:h-6 text-aurum/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
								{:else}
									<svg class="w-5 h-5 sm:w-6 sm:h-6 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
								{/if}
							</span>
							<div class="flex-1 min-w-0 text-left">
								<div class="flex items-center gap-1.5 sm:gap-2 mb-0.5">
									<h3 class="text-sm sm:text-base font-medium text-[var(--color-text-primary)] truncate">{m.filename || (m.type === 'voice' ? 'Voice note' : m.type)}</h3>
									<span class="flex-shrink-0 text-[9px] font-mono uppercase tracking-wider text-aurum bg-[var(--color-elevated)] px-1.5 py-0.5 rounded">{m.type}</span>
								</div>
								{#if m.transcript || m.description}
									<p class="text-xs sm:text-sm text-[var(--color-text-secondary)] leading-snug line-clamp-2 italic">{m.transcript || m.description}</p>
								{/if}
								<p class="text-xs text-[var(--color-text-tertiary)] mt-1 sm:mt-1.5">
									{#if formatBytes(m.fileSize)}{formatBytes(m.fileSize)} &middot; {/if}{#if m.createdAt}{formatDate(m.createdAt, true)}{/if}
								</p>
							</div>
						</div>
					{:else}
						{@const doc = item.doc}
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
								{#if renamingPath === doc.path}
									<input
										bind:this={renameInputEl}
										bind:value={renameValue}
										onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') cancelRename(); }}
										onblur={commitRename}
										onclick={(e) => e.stopPropagation()}
										class="flex-1 min-w-0 text-sm sm:text-base font-medium bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-primary)] focus:outline-none"
										aria-label="Rename document"
									/>
								{:else}
									<h3 class="text-sm sm:text-base font-medium text-[var(--color-text-primary)] truncate">
										{doc.title || doc.path}
									</h3>
								{/if}
							</div>
							{#if doc.summary}
								<p class="text-xs sm:text-sm text-[var(--color-text-secondary)] leading-snug line-clamp-2">
									{doc.summary}
								</p>
							{/if}
							<p class="text-xs text-[var(--color-text-tertiary)] mt-1 sm:mt-1.5">
								{#if getAuthorLabel(doc.created_by, doc.metadata)}{getAuthorLabel(doc.created_by, doc.metadata)}{/if}
								{#if getSourceLabel(doc.source_type)}<span class="hidden sm:inline"> &middot; {getSourceLabel(doc.source_type)}</span>{/if}
								{#if getCategoryFromPath(doc.path)}<span class="hidden sm:inline"> &middot; {getCategoryFromPath(doc.path)}</span>{/if}
								{#if doc.updated_at} &middot; {formatDate(doc.updated_at, true)}{/if}
							</p>
						</div>
					</div>
					{/if}
				{/each}
			</div>
		{:else}
			<!-- Grid view -->
			<div class="grid gap-3 sm:gap-4 lib-scroll-grid" style="grid-template-columns: repeat(auto-fill, minmax({gridMinPx}px, 1fr));">
				{#each libraryItems as item}
					{#if item.kind === 'media'}
						{@const m = item.media}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							onclick={() => (selectedMedia = m)}
							onkeydown={(e) => { if (e.key === 'Enter') selectedMedia = m; }}
							role="button"
							tabindex="0"
							class="flex flex-col rounded-xl transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] text-left relative group border-[var(--color-border)] hover:border-aurum/50 overflow-hidden"
						>
							<div class="px-3 py-2 border-b border-[var(--color-border)]">
								<div class="flex items-center gap-2">
									<h3 class="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)] truncate">{m.filename || (m.type === 'voice' ? 'Voice note' : m.type)}</h3>
									<span class="flex-shrink-0 text-[9px] font-mono uppercase tracking-wider text-aurum bg-[var(--color-elevated)] px-1.5 py-0.5 rounded">{m.type}</span>
								</div>
								<p class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 truncate">
									{#if formatBytes(m.fileSize)}{formatBytes(m.fileSize)}{/if}{#if formatBytes(m.fileSize) && m.createdAt}<span class="mx-1">·</span>{/if}{#if m.createdAt}{formatDate(m.createdAt, true)}{/if}
								</p>
							</div>
							<div class="w-full aspect-[4/3] bg-[var(--color-elevated)] overflow-hidden relative flex items-center justify-center">
								{#if m.type === 'image'}
									<img src={m.url} alt={m.filename || 'image'} loading="lazy" class="w-full h-full object-cover" />
								{:else if m.type === 'voice'}
									<div class="flex flex-col items-center justify-center gap-2 w-full px-3">
										<svg class="w-7 h-7 text-aurum/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<audio controls preload="none" src={m.playbackUrl || m.url} class="w-full max-w-[240px]" onclick={(e) => e.stopPropagation()}></audio>
										{#if m.transcript}
											<p class="text-[10px] text-[var(--color-text-tertiary)] line-clamp-2 italic text-center">{m.transcript}</p>
										{/if}
									</div>
								{:else}
									<div class="flex flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
										<svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
										<span class="text-[10px]">{m.filename || 'file'}</span>
									</div>
								{/if}
							</div>
						</div>
					{:else}
						{@const doc = item.doc}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					{@const _name = (doc.path.split('/').pop() || doc.path).trim()}
					{@const _dot = _name.lastIndexOf('.')}
					{@const docTitle = doc.title || (_dot > 0 ? _name.slice(0, _dot) : _name)}
					{@const docFormat = (_dot > 0 ? _name.slice(_dot + 1).toUpperCase() : 'DOC')}
					{@const docAuthor = getAuthorLabel(doc.created_by, doc.metadata)}
					{@const docWhen = formatDate(doc.updated_at, true)}
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
						class="flex flex-col rounded-xl transition-all duration-150 cursor-pointer border bg-[var(--color-surface)] text-left relative group border-[var(--color-border)] hover:border-aurum/50 overflow-hidden {draggingDoc === doc.path ? 'opacity-40' : ''}"
					>
						<!-- Title + format header. Author + when subtitle below
						     so the card surfaces who authored it and how
						     recent it is at a glance. Pinned star sits next to
						     the format chip when set. -->
						<div class="px-3 py-2 border-b border-[var(--color-border)]">
							<div class="flex items-center gap-2">
								{#if renamingPath === doc.path}
									<input
										bind:this={renameInputEl}
										bind:value={renameValue}
										onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') cancelRename(); }}
										onblur={commitRename}
										onclick={(e) => e.stopPropagation()}
										class="flex-1 min-w-0 text-sm font-medium bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-primary)] focus:outline-none"
										aria-label="Rename document"
									/>
								{:else}
									<h3 class="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)] truncate">
										{docTitle}
									</h3>
								{/if}
								{#if doc.pinned}
									<svg class="w-3.5 h-3.5 text-aurum flex-shrink-0" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-label="Pinned">
										<path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"/>
									</svg>
								{/if}
								<span class="flex-shrink-0 text-[9px] font-mono uppercase tracking-wider text-[var(--color-text-tertiary)] bg-[var(--color-elevated)] px-1.5 py-0.5 rounded">
									{docFormat}
								</span>
							</div>
							{#if docAuthor || docWhen}
								<p class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 truncate">
									{#if docAuthor}{docAuthor}{/if}{#if docAuthor && docWhen}<span class="mx-1">·</span>{/if}{#if docWhen}{docWhen}{/if}
								</p>
							{/if}
						</div>

						<!-- Live preview — DocThumbnail picks the right render
						     by extension: HTML in iframe, markdown via marked +
						     DOMPurify, plain text monospaced. -->
						<div class="w-full aspect-[4/3] bg-[var(--color-elevated)] overflow-hidden relative">
							<DocThumbnail path={doc.path} title={docTitle} ariaLabel={docTitle || doc.path} />
						</div>
					</div>
					{/if}
				{/each}
			</div>
		{/if}
		<!-- Load-on-scroll sentinel: entering view (600px early) pulls the next
			 page. Only present in list/grid with more to load — never the doc
			 detail view, and never an eager whole-vault fill. -->
		{#if hasMore && !selectedDoc}
			<div bind:this={loadSentinel} class="h-8 flex items-center justify-center" aria-hidden="true">
				{#if loadingMore}
					<div class="w-5 h-5 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- Media detail — full preview + transcript/description + the actual file -->
{#if selectedMedia}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onclick={() => (selectedMedia = null)}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
				<h3 class="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)] truncate">{selectedMedia.filename || (selectedMedia.type === 'voice' ? 'Voice note' : selectedMedia.type)}</h3>
				<span class="text-[9px] font-mono uppercase tracking-wider text-aurum bg-[var(--color-elevated)] px-1.5 py-0.5 rounded">{selectedMedia.type}</span>
				<button class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors" onclick={() => (selectedMedia = null)} aria-label="Close">
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>
			<div class="p-4 space-y-3">
				{#if selectedMedia.type === 'image'}
					<img src={selectedMedia.url} alt={selectedMedia.filename || 'image'} class="max-h-[55vh] w-auto mx-auto rounded-lg object-contain" />
				{:else if selectedMedia.type === 'voice'}
					<audio controls preload="metadata" src={selectedMedia.playbackUrl || selectedMedia.url} class="w-full"></audio>
				{/if}
				{#if selectedMedia.transcript}
					<p class="text-sm text-[var(--color-text-secondary)] italic leading-relaxed">{selectedMedia.transcript}</p>
				{/if}
				{#if selectedMedia.description}
					<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">{selectedMedia.description}</p>
				{/if}
				<div class="flex items-center justify-between pt-1">
					<span class="text-xs text-[var(--color-text-tertiary)]">
						{#if formatBytes(selectedMedia.fileSize)}{formatBytes(selectedMedia.fileSize)}{/if}{#if formatBytes(selectedMedia.fileSize) && selectedMedia.createdAt}<span class="mx-1">·</span>{/if}{#if selectedMedia.createdAt}{formatDate(selectedMedia.createdAt, true)}{/if}
					</span>
					<a
						href={selectedMedia.url}
						download={selectedMedia.filename || 'attachment'}
						class="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-aurum/60 hover:text-[var(--color-text-primary)] transition-colors"
					>Download file</a>
				</div>
			</div>
		</div>
	</div>
{/if}

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
		{:else if showChangeLink}
			<div class="px-3 py-2">
				<p class="text-sm text-[var(--color-text-primary)] mb-1">Change link</p>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-2">The document’s address (its <code>?doc=</code> slug). Published links are unaffected.</p>
				<input
					bind:this={linkInputEl}
					bind:value={linkValue}
					onkeydown={(e) => { if (e.key === 'Enter') commitChangeLink(); else if (e.key === 'Escape') { showChangeLink = false; } }}
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
					class="w-full px-2 py-1 text-sm rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)] mb-2 font-mono"
					aria-label="New document link"
				/>
				<div class="flex items-center gap-2 justify-end">
					<button
						onclick={() => { showChangeLink = false; }}
						class="px-2.5 py-1 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] transition-colors"
					>Cancel</button>
					<button
						onclick={commitChangeLink}
						disabled={changingLink}
						class="px-2.5 py-1 text-xs rounded-md bg-[var(--color-accent)]/15 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 transition-colors disabled:opacity-50"
					>{changingLink ? 'Changing…' : 'Change'}</button>
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
			<!-- Rename (display title) -->
			<button onclick={() => startRename(contextMenu!.doc)} class="ctx-item">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
				Rename
			</button>
			<!-- Change link (path / slug — the document's identity) -->
			<button onclick={() => startChangeLink(contextMenu!.doc)} class="ctx-item">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
				Change link…
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
	/* Off-screen rows/cards skip layout+paint until scrolled near. The library
	   renders every doc+media item into the DOM (no virtualization), so on large
	   vaults scrolling was janky — content-visibility gives near-virtualization for
	   free. contain-intrinsic-size keeps the scrollbar stable by reserving an
	   estimated height for not-yet-rendered items (auto = remember last real size). */
	.lib-scroll-list > :global(*) {
		content-visibility: auto;
		contain-intrinsic-size: auto 64px;
	}
	.lib-scroll-grid > :global(*) {
		content-visibility: auto;
		contain-intrinsic-size: auto 240px;
	}

	/* HTML doc preview wrapper. `resize: horizontal` adds a native
	   browser grip on the bottom-right edge — drag-shrink to make
	   room for a side pane (second chat, portal to another VPS,
	   inspector). `min-width` keeps it usable even when shrunk;
	   `max-width: 100%` prevents the grip from dragging the iframe
	   wider than its parent column. */
	.html-preview-wrap {
		resize: horizontal;
		overflow: hidden;
		min-width: 360px;
		max-width: 100%;
	}

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
		/* App shell has overflow:hidden on every parent down to the page.
		   So we host scroll INSIDE .library-content. Header stays put (no
		   sticky needed — it's outside the scrollable area). The contextual
		   header swap (list / doc) gives us the "actions in the header"
		   benefit without fighting the shell. */
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
	.library-header {
		flex-shrink: 0;
		/* Pinned above the scroll region. It already sits outside .library-content
		   (flex sibling), so it never scrolls; sticky + an opaque page-bg is
		   belt-and-suspenders for any ancestor that does scroll, and lets the
		   title/actions stay put while the editor body scrolls underneath. */
		position: sticky;
		top: 0;
		z-index: 30;
		background: var(--color-bg);
	}
	.library-content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
	}
	/* While editing, drop the bottom padding so the sticky Done/save bar hugs the
	   very bottom of the viewport (no dead gap beneath it). */
	.editor-flush {
		padding-bottom: 0;
	}
	/* .doc-detail-view inherits flex parent; scroll handled by .library-content. */

	.line-clamp-2 {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* ── Formatting toolbar ── */
	.fmt-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
		border-radius: 0.375rem;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		transition: all 0.12s;
	}
	.fmt-btn:hover {
		background: var(--color-elevated);
		color: var(--color-text-primary);
	}
	.fmt-sep {
		width: 1px;
		height: 18px;
		background: var(--color-border);
		margin: 0 4px;
	}

	/* ── Raw editor textarea (HTML docs + power-user markdown) ── */

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
		/* Read/write parity: the reader uses the same editorial serif, size and
		   measure as the CodeMirror writing surface, so entering edit changes
		   nothing visually — you write on the page you were just reading. */
		font-family: var(--font-serif);
		line-height: 1.72;
		color: var(--color-text-primary);
		font-size: 1.0625rem;
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

	/* Paragraphs — text-wrap: pretty avoids orphans/ragged last lines for a
	   more typeset feel; headings balance across lines. */
	.doc-content :global(p) {
		margin: 0 0 1rem 0;
		text-wrap: pretty;
	}
	.doc-content :global(h1),
	.doc-content :global(h2),
	.doc-content :global(h3) {
		text-wrap: balance;
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
		font-family: var(--font-mono);
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
