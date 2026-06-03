// lib/workspace/store.ts — the workspace state: which tabs are open, which is
// active, and recents. THE single entry point is openOrFocus() — idempotent, so
// the route intents, the sidebar, and tab clicks can all call it without loops.
//
// Phase A = one pane. Persisted to localStorage; restored + validated against the
// registry on load (tabs for removed views are dropped). Keeps navigation.ts's
// primaryView in sync so the sidebar/header highlight keeps working.
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { getView, viewExists, tabKey } from './registry';
import { navigationState, type PrimaryView } from '$lib/stores/navigation';
import type { Tab, LeafPane, RecentItem, WorkspaceState } from './types';

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

function defaultState(): WorkspaceState {
	const t = makeTab(DEFAULT_VIEW);
	const pane: LeafPane = { kind: 'leaf', id: uid(), tabs: [t], activeTabId: t.id };
	return { root: pane, focusedPaneId: pane.id, recents: [] };
}

/** Validate a restored blob; drop tabs for views that no longer exist. */
function sanitize(raw: unknown): WorkspaceState | null {
	try {
		const s = raw as WorkspaceState;
		if (!s || !s.root || s.root.kind !== 'leaf') return null;
		const tabs: Tab[] = (s.root.tabs || [])
			.filter((t) => t && viewExists(t.viewId))
			.map((t) => {
				const v = getView(t.viewId)!;
				return { id: String(t.id || uid()), viewId: t.viewId, params: t.params || {}, title: v.title, icon: v.icon, closable: true };
			});
		if (!tabs.length) return null;
		const paneId = String(s.root.id || uid());
		const activeTabId = tabs.some((t) => t.id === s.root.activeTabId) ? s.root.activeTabId : tabs[0].id;
		const recents: RecentItem[] = (s.recents || [])
			.filter((r) => r && viewExists(r.viewId))
			.slice(0, MAX_RECENTS);
		return { root: { kind: 'leaf', id: paneId, tabs, activeTabId }, focusedPaneId: paneId, recents };
	} catch {
		return null;
	}
}

function loadInitial(): WorkspaceState {
	if (!browser) return defaultState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const s = sanitize(JSON.parse(raw));
			if (s) return s;
		}
	} catch { /* fall through */ }
	return defaultState();
}

function activeTabOf(s: WorkspaceState): Tab | undefined {
	return s.root.tabs.find((t) => t.id === s.root.activeTabId);
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
		// Persist (debounced, like navigation.ts).
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
		}, 400);
		// Mirror the focused tab into navigation.primaryView (sidebar/header highlight).
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

	const api = {
		subscribe,

		/** THE entry point. Focus an existing tab for (viewId, params) or open one. */
		openOrFocus(viewId: string, params: Record<string, unknown> = {}) {
			if (!viewExists(viewId)) return;
			update((s) => {
				const key = tabKey(viewId, params);
				const existing = s.root.tabs.find((t) => tabKey(t.viewId, t.params) === key);
				if (existing) {
					// Refresh params for keyed views (e.g. Library doc) without duplicating.
					existing.params = params;
					s.root.activeTabId = existing.id;
				} else {
					const t = makeTab(viewId, params);
					s.root.tabs = [...s.root.tabs, t];
					s.root.activeTabId = t.id;
				}
				return { ...s, root: { ...s.root, tabs: [...s.root.tabs] } };
			});
		},

		/** Called by the thin route pages on mount. */
		openFromRoute(viewId: string, params: Record<string, unknown> = {}) {
			api.openOrFocus(viewId, params);
		},

		focusTab(tabId: string) {
			update((s) => (s.root.tabs.some((t) => t.id === tabId) ? { ...s, root: { ...s.root, activeTabId: tabId } } : s));
		},

		closeTab(tabId: string) {
			update((s) => {
				const idx = s.root.tabs.findIndex((t) => t.id === tabId);
				if (idx < 0) return s;
				pushRecent(s, s.root.tabs[idx]);
				let tabs = s.root.tabs.filter((t) => t.id !== tabId);
				let activeTabId = s.root.activeTabId;
				if (activeTabId === tabId) activeTabId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].id : null;
				if (!tabs.length) {
					// Never leave an empty workspace — fall back to the default view.
					const t = makeTab(DEFAULT_VIEW);
					tabs = [t];
					activeTabId = t.id;
				}
				return { ...s, root: { ...s.root, tabs, activeTabId }, recents: [...s.recents] };
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
