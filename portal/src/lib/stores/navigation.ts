import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'mycelium_navigation';

export type PrimaryView = 'mindscape' | 'library' | 'media' | 'timeline' | 'wealth' | 'energy' | 'intel' | 'activity' | 'import' | 'agents' | 'settings' | 'profile' | 'connections' | 'contexts' | 'modules';

export interface NavigationState {
	primaryView: PrimaryView;
	sidebarOpen: boolean;
	sidebarCollapsed: boolean;
	chatOpen: boolean;

	// Mindscape context
	selectedRealmId: number | null;
	selectedThemeId: string | null;
	selectedTerritoryId: number | null;
	mindscapeViewMode: '3d' | '2d';

	// Library context
	activeFolderId: string | null;
	expandedFolderIds: string[];

	// Timeline context
	timelineZoom: 'year' | 'quarter' | 'month' | 'week';
}

const defaultState: NavigationState = {
	primaryView: 'mindscape',
	sidebarOpen: true,
	sidebarCollapsed: false,
	chatOpen: false,
	selectedRealmId: null,
	selectedThemeId: null,
	selectedTerritoryId: null,
	mindscapeViewMode: '3d',
	activeFolderId: null,
	expandedFolderIds: [],
	timelineZoom: 'quarter',
};

function loadFromStorage(): NavigationState {
	if (!browser) return defaultState;
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) return { ...defaultState, ...JSON.parse(stored) };
	} catch {}
	return defaultState;
}

function createNavigationStore() {
	const initial = loadFromStorage();
	const { subscribe, set, update } = writable<NavigationState>(initial);

	let saveTimeout: ReturnType<typeof setTimeout> | null = null;

	subscribe((state) => {
		if (!browser) return;
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}, 500);
	});

	return {
		subscribe,
		set,
		update,

		setPrimaryView(view: PrimaryView) {
			update((s) => ({ ...s, primaryView: view }));
		},

		setSidebarOpen(open: boolean) {
			update((s) => ({ ...s, sidebarOpen: open }));
		},

		toggleSidebar() {
			update((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }));
		},

		setSidebarCollapsed(collapsed: boolean) {
			update((s) => ({ ...s, sidebarCollapsed: collapsed }));
		},

		setChatOpen(open: boolean) {
			update((s) => ({ ...s, chatOpen: open }));
		},

		toggleChat() {
			update((s) => ({ ...s, chatOpen: !s.chatOpen }));
		},

		// Mindscape
		setMindscapeViewMode(mode: '3d' | '2d') {
			update((s) => ({ ...s, mindscapeViewMode: mode }));
		},
		setSelectedRealm(id: number | null) {
			update((s) => ({ ...s, selectedRealmId: id, selectedThemeId: null, selectedTerritoryId: null }));
		},
		setSelectedTheme(realmId: number, themeId: string | null) {
			update((s) => ({ ...s, selectedRealmId: realmId, selectedThemeId: themeId, selectedTerritoryId: null }));
		},
		setSelectedTerritory(id: number | null) {
			update((s) => ({ ...s, selectedTerritoryId: id }));
		},
		clearMindscapeSelection() {
			update((s) => ({ ...s, selectedRealmId: null, selectedThemeId: null, selectedTerritoryId: null }));
		},

		// Library
		setActiveFolder(id: string | null) {
			update((s) => ({ ...s, activeFolderId: id }));
		},
		toggleFolderExpanded(id: string) {
			update((s) => ({
				...s,
				expandedFolderIds: s.expandedFolderIds.includes(id)
					? s.expandedFolderIds.filter((f) => f !== id)
					: [...s.expandedFolderIds, id],
			}));
		},

		// Timeline
		setTimelineZoom(zoom: NavigationState['timelineZoom']) {
			update((s) => ({ ...s, timelineZoom: zoom }));
		},

		getState(): NavigationState {
			return get({ subscribe });
		},

		reset() {
			set(defaultState);
			if (browser) localStorage.removeItem(STORAGE_KEY);
		},
	};
}

export const navigationState = createNavigationStore();

export const primaryView = derived(navigationState, ($s) => $s.primaryView);
export const sidebarOpen = derived(navigationState, ($s) => $s.sidebarOpen);
export const chatOpen = derived(navigationState, ($s) => $s.chatOpen);
export const mindscapeViewMode = derived(navigationState, ($s) => $s.mindscapeViewMode);
export const activeFolderId = derived(navigationState, ($s) => $s.activeFolderId);
