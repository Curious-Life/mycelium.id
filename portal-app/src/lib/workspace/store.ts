// lib/workspace/store.ts — the workspace state: a TREE of split nodes + leaf
// panes, which leaf is focused (new tabs land there), and recents.
//
// THE entry point is openOrFocus() — idempotent, so the route intents, the
// sidebar, and tab clicks can all call it without loops. A view with a singleton
// key is focused wherever it already lives (never duplicated). Persisted to
// localStorage; restored + validated against the registry (tabs for removed views
// dropped). Keeps navigation.primaryView in sync so the sidebar/header highlight
// keeps working.
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { getView, viewExists, tabKey } from './registry';
import { navigationState, type PrimaryView } from '$lib/stores/navigation';
import type { Tab, LeafPane, SplitNode, WsNode, RecentItem, WorkspaceState } from './types';

const STORAGE_KEY = 'mycelium-workspace';
const MAX_RECENTS = 12;
const DEFAULT_VIEW = 'mindscape';

const uid = () =>
	browser && typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

function makeTab(viewId: string, params: Record<string, unknown> = {}): Tab {
	const v = getView(viewId)!;
	return { id: uid(), viewId, params, title: v.title, icon: v.icon, closable: true };
}

function leaf(tabs: Tab[], activeTabId: string | null): LeafPane {
	return { kind: 'leaf', id: uid(), tabs, activeTabId };
}

function defaultState(): WorkspaceState {
	const t = makeTab(DEFAULT_VIEW);
	const root = leaf([t], t.id);
	return { root, focusedPaneId: root.id, recents: [] };
}

// ── tree helpers (immutable) ────────────────────────────────────────────────
function allLeaves(node: WsNode): LeafPane[] {
	return node.kind === 'leaf' ? [node] : [...allLeaves(node.children[0]), ...allLeaves(node.children[1])];
}
function findLeaf(node: WsNode, id: string): LeafPane | null {
	if (node.kind === 'leaf') return node.id === id ? node : null;
	return findLeaf(node.children[0], id) || findLeaf(node.children[1], id);
}
function firstLeaf(node: WsNode): LeafPane {
	return node.kind === 'leaf' ? node : firstLeaf(node.children[0]);
}
function leafWithTab(node: WsNode, tabId: string): LeafPane | null {
	if (node.kind === 'leaf') return node.tabs.some((t) => t.id === tabId) ? node : null;
	return leafWithTab(node.children[0], tabId) || leafWithTab(node.children[1], tabId);
}
/** Return a new tree with leaf `id` replaced by fn(leaf). */
function updateLeaf(node: WsNode, id: string, fn: (l: LeafPane) => LeafPane): WsNode {
	if (node.kind === 'leaf') return node.id === id ? fn(node) : node;
	return { ...node, children: [updateLeaf(node.children[0], id, fn), updateLeaf(node.children[1], id, fn)] };
}
/** Return a new tree with split `id` replaced by fn(split). */
function updateSplit(node: WsNode, id: string, fn: (s: SplitNode) => SplitNode): WsNode {
	if (node.kind === 'leaf') return node;
	if (node.id === id) return fn(node);
	return { ...node, children: [updateSplit(node.children[0], id, fn), updateSplit(node.children[1], id, fn)] };
}
/** Replace leaf `id` with an arbitrary node (used to split it). */
function replaceLeaf(node: WsNode, id: string, replacement: WsNode): WsNode {
	if (node.kind === 'leaf') return node.id === id ? replacement : node;
	return { ...node, children: [replaceLeaf(node.children[0], id, replacement), replaceLeaf(node.children[1], id, replacement)] };
}
/** Remove leaf `id`; its parent split collapses (the sibling takes the space).
 *  Returns the new root, or null if `id` was the only leaf. */
function removeLeaf(node: WsNode, id: string): WsNode | null {
	if (node.kind === 'leaf') return node.id === id ? null : node;
	const a = removeLeaf(node.children[0], id);
	const b = removeLeaf(node.children[1], id);
	if (a === null) return b;
	if (b === null) return a;
	return { ...node, children: [a, b] };
}

/** Recursively validate a restored tree; drop tabs for removed views. */
function sanitizeNode(node: any): WsNode | null {
	if (!node) return null;
	if (node.kind === 'split' && Array.isArray(node.children) && node.children.length === 2) {
		const a = sanitizeNode(node.children[0]);
		const b = sanitizeNode(node.children[1]);
		if (a && b) {
			const sizes = Array.isArray(node.sizes) && node.sizes.length === 2 ? node.sizes : [50, 50];
			return { kind: 'split', id: String(node.id || uid()), dir: node.dir === 'v' ? 'v' : 'h', children: [a, b], sizes };
		}
		return a || b; // a split with one dead child collapses to the survivor
	}
	// leaf
	const tabs: Tab[] = (node.tabs || [])
		.filter((t: any) => t && viewExists(t.viewId))
		.map((t: any) => {
			const v = getView(t.viewId)!;
			return { id: String(t.id || uid()), viewId: t.viewId, params: t.params || {}, title: v.title, icon: v.icon, closable: true };
		});
	const activeTabId = tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : tabs[0]?.id ?? null;
	return { kind: 'leaf', id: String(node.id || uid()), tabs, activeTabId };
}

function loadInitial(): WorkspaceState {
	if (!browser) return defaultState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			const root = sanitizeNode(parsed.root);
			if (root && allLeaves(root).some((l) => l.tabs.length)) {
				const leaves = allLeaves(root);
				const focusedPaneId = leaves.some((l) => l.id === parsed.focusedPaneId) ? parsed.focusedPaneId : firstLeaf(root).id;
				const recents: RecentItem[] = (parsed.recents || []).filter((r: any) => r && viewExists(r.viewId)).slice(0, MAX_RECENTS);
				return { root, focusedPaneId, recents };
			}
		}
	} catch { /* fall through */ }
	return defaultState();
}

function activeTabOf(s: WorkspaceState): Tab | undefined {
	const focus = findLeaf(s.root, s.focusedPaneId) ?? firstLeaf(s.root);
	return focus.tabs.find((t) => t.id === focus.activeTabId);
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>) {
	return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function createWorkspace() {
	const store = writable<WorkspaceState>(loadInitial());
	const { subscribe, set, update } = store;

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPrimary: string | null = null;

	subscribe((s) => {
		if (!browser) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
		}, 400);
		const active = activeTabOf(s);
		if (active && active.viewId !== lastPrimary) {
			lastPrimary = active.viewId;
			navigationState.setPrimaryView(active.viewId as PrimaryView);
		}
	});

	function pushRecent(s: WorkspaceState, tab: Tab) {
		const r: RecentItem = { viewId: tab.viewId, params: tab.params, title: tab.title, icon: tab.icon, at: Date.now() };
		s.recents = [r, ...s.recents.filter((x) => !(x.viewId === r.viewId && sameParams(x.params, r.params)))].slice(0, MAX_RECENTS);
	}

	/** Focus an existing (singleton-keyed) tab anywhere, else open in `paneId`. */
	function openIn(s: WorkspaceState, paneId: string, viewId: string, params: Record<string, unknown>): WorkspaceState {
		if (!viewExists(viewId)) return s;
		const key = tabKey(viewId, params);
		for (const l of allLeaves(s.root)) {
			const ex = l.tabs.find((t) => tabKey(t.viewId, t.params) === key);
			if (ex) {
				ex.params = params;
				return { ...s, root: updateLeaf(s.root, l.id, (lf) => ({ ...lf, activeTabId: ex.id, tabs: [...lf.tabs] })), focusedPaneId: l.id };
			}
		}
		const target = findLeaf(s.root, paneId) ?? findLeaf(s.root, s.focusedPaneId) ?? firstLeaf(s.root);
		const t = makeTab(viewId, params);
		return { ...s, root: updateLeaf(s.root, target.id, (lf) => ({ ...lf, tabs: [...lf.tabs, t], activeTabId: t.id })), focusedPaneId: target.id };
	}

	const api = {
		subscribe,

		/** THE entry point. Open/focus in the currently-focused pane. */
		openOrFocus(viewId: string, params: Record<string, unknown> = {}) {
			update((s) => openIn(s, s.focusedPaneId, viewId, params));
		},
		/** Open/focus explicitly in a given pane (an empty split's launcher). */
		openInPane(paneId: string, viewId: string, params: Record<string, unknown> = {}) {
			update((s) => openIn(s, paneId, viewId, params));
		},
		openFromRoute(viewId: string, params: Record<string, unknown> = {}) {
			api.openOrFocus(viewId, params);
		},

		focusTab(tabId: string) {
			update((s) => {
				const l = leafWithTab(s.root, tabId);
				if (!l) return s;
				return { ...s, root: updateLeaf(s.root, l.id, (lf) => ({ ...lf, activeTabId: tabId })), focusedPaneId: l.id };
			});
		},
		focusPane(paneId: string) {
			update((s) => (s.focusedPaneId === paneId ? s : { ...s, focusedPaneId: paneId }));
		},

		closeTab(tabId: string) {
			update((s) => {
				const l = leafWithTab(s.root, tabId);
				if (!l) return s;
				const idx = l.tabs.findIndex((t) => t.id === tabId);
				pushRecent(s, l.tabs[idx]);
				const tabs = l.tabs.filter((t) => t.id !== tabId);
				if (tabs.length) {
					const activeTabId = l.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)].id : l.activeTabId;
					return { ...s, root: updateLeaf(s.root, l.id, (lf) => ({ ...lf, tabs, activeTabId })), recents: [...s.recents] };
				}
				// leaf now empty
				if (allLeaves(s.root).length === 1) {
					const t = makeTab(DEFAULT_VIEW); // never leave the whole workspace empty
					return { ...s, root: updateLeaf(s.root, l.id, (lf) => ({ ...lf, tabs: [t], activeTabId: t.id })), recents: [...s.recents] };
				}
				const newRoot = removeLeaf(s.root, l.id)!; // collapse the empty leaf
				return { ...s, root: newRoot, focusedPaneId: firstLeaf(newRoot).id, recents: [...s.recents] };
			});
		},

		/** Split a pane into two; the new (empty) leaf shows a launcher + is focused. */
		splitPane(paneId: string, dir: 'h' | 'v' = 'h') {
			update((s) => {
				const l = findLeaf(s.root, paneId);
				if (!l || allLeaves(s.root).length >= 4) return s; // cap at 4 panes (sane for one window)
				const fresh = leaf([], null);
				const split: SplitNode = { kind: 'split', id: uid(), dir, children: [l, fresh], sizes: [50, 50] };
				return { ...s, root: replaceLeaf(s.root, paneId, split), focusedPaneId: fresh.id };
			});
		},
		resizeSplit(splitId: string, sizes: [number, number]) {
			update((s) => ({ ...s, root: updateSplit(s.root, splitId, (sp) => ({ ...sp, sizes })) }));
		},
		/** Close an empty launcher pane without opening anything. */
		closePane(paneId: string) {
			update((s) => {
				if (allLeaves(s.root).length <= 1) return s;
				const newRoot = removeLeaf(s.root, paneId);
				if (!newRoot) return s;
				return { ...s, root: newRoot, focusedPaneId: firstLeaf(newRoot).id };
			});
		},

		getState(): WorkspaceState {
			return get(store);
		},
		reset() {
			set(defaultState());
			if (browser) localStorage.removeItem(STORAGE_KEY);
		},
	};

	return api;
}

export const workspace = createWorkspace();
