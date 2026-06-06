<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	// $effect / $state / $derived are Svelte 5 compiler runes — no import.
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { navigationState } from '$lib/stores/navigation';
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

	let documents = $state<DocListItem[]>([]);
	let folders = $state<Folder[]>([]);
	let selectedDoc = $state<DocFull | null>(null);
	let loadingDoc = $state(false);
	let searchQuery = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
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
		editContent = selectedDoc.content || '';
		editing = true;
		showRawMarkdown = true;
		agentUpdatedWhileEditing = false;
	}

	function cancelEditing() {
		editing = false;
		editContent = '';
		showRawMarkdown = false;
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
				// Self-write echo guard: the live broadcaster will fire
				// a `doc-updated` event for this very write within 100ms;
				// flagging the path tells our SSE handler to ignore it
				// for ~300ms so we don't redraw what we already have.
				markSelfWrite(selectedDoc.path);
				selectedDoc = { ...selectedDoc, content: editContent };
				editing = false;
				agentUpdatedWhileEditing = false;
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
	let mdEditorPreviewContainer = $state<HTMLDivElement | null>(null);

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

	$effect(() => {
		if (!mdEditorPreviewContainer || !editing || showRawMarkdown) return;
		applyMorph(mdEditorPreviewContainer, renderMarkdown(editContent, true));
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
	<div class="library-header px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)]">
		{#if selectedDoc}
			<!-- ═══ DOC MODE ═══ -->
			<div class="flex items-start justify-between gap-3">
				<div class="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
					<button
						onclick={() => { selectedDoc = null; editing = false; setParams?.({ doc: null }); }}
						class="p-1.5 -ml-1.5 mt-0.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] transition-colors flex-shrink-0"
						aria-label="Back to library"
						title="Back to library"
					>
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<div class="min-w-0 flex-1">
						<h1 class="text-lg sm:text-xl font-medium text-[var(--color-text-primary)] truncate">
							{selectedDoc.title || selectedDoc.path}
						</h1>
						<div class="flex items-center gap-2 sm:gap-3 mt-0.5 flex-wrap text-xs text-[var(--color-text-tertiary)]">
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
					<!-- Download with format dropdown (PR 5.3). stopPropagation
						 keeps the global onclick (which closes the menu when
						 clicking outside) from also firing on the trigger. -->
					<div class="relative" onclick={(e) => e.stopPropagation()} role="presentation">
						<button
							onclick={(e) => { e.stopPropagation(); downloadMenuOpen = !downloadMenuOpen; }}
							class="p-2 hover:bg-azure/20 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-azure flex items-center"
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
		{:else}
			<!-- ═══ LIST MODE ═══ -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2 sm:gap-3 min-w-0">
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
			<!-- Document detail view — title + actions live in the sticky
				 header above. This block is just the body, which scrolls
				 with the page. (PR 5.2) -->
			<div class="doc-detail-view {isHtmlPreview ? 'w-full' : 'max-w-4xl mx-auto'}">
				{#if loadingDoc}
					<div class="flex items-center justify-center py-12">
						<div class="w-8 h-8 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
					</div>
				{:else if editing}
					<!-- ═══ EDITOR MODE ═══ -->
					<div class="flex flex-col gap-3">
						{#if agentUpdatedWhileEditing}
							<!-- Live-update guard: an agent rewrote this doc
								 while you were editing. The morph was paused
								 to preserve your buffer; this banner offers
								 a one-click discard-and-reload. Discarding
								 IS destructive (your unsaved edits are lost),
								 hence the explicit affordance instead of a
								 silent overwrite. -->
							<div class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-aurum/40 bg-aurum/10 text-[13px]">
								<span class="text-[var(--color-text-secondary)]">
									An agent updated this document while you were editing.
								</span>
								<button
									type="button"
									onclick={discardEditAndReload}
									class="px-3 py-1 text-xs rounded-md border border-aurum/60 text-aurum hover:bg-aurum/15 transition-colors"
								>
									Discard my edits &amp; reload
								</button>
							</div>
						{/if}
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
						{:else if isHtmlDoc(selectedDoc?.path, editContent)}
							<iframe
								title={selectedDoc?.title || selectedDoc?.path || 'preview'}
								srcdoc={wrapHtmlForLive(editContent)}
								sandbox="allow-scripts allow-popups"
								class="w-full border-0 rounded-lg"
								style="min-height: 60vh; background: Canvas;"
							></iframe>
						{:else}
							<!-- Editor preview — DOM-morphed so the live re-
								 render as you type doesn't blow away cursor
								 selection / scroll inside the preview.
								 Click is delegated on the parent div, which
								 morphdom preserves (childrenOnly: true). -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								bind:this={mdEditorPreviewContainer}
								class="doc-content"
								onclick={(e) => handleContentClick(e, 'editor')}
							></div>
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
								{#if getAuthorLabel(doc.created_by, doc.metadata)}{getAuthorLabel(doc.created_by, doc.metadata)}{/if}
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
			<div class="grid gap-3 sm:gap-4" style="grid-template-columns: repeat(auto-fill, minmax({gridMinPx}px, 1fr));">
				{#each filteredDocs as doc}
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
								<h3 class="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)] truncate">
									{docTitle}
								</h3>
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
	}
	.library-content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
	}
	/* .doc-detail-view inherits flex parent; scroll handled by .library-content. */

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
