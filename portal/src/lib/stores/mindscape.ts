import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

// 24-color palette for clusters (matching MYA-0.2)
export const CLUSTER_COLORS = [
	'#FF3B3B', '#00C49A', '#3B82F6', '#FACC15', '#E879F9', '#22D3EE',
	'#FB923C', '#A855F7', '#4ADE80', '#F472B6', '#0EA5E9', '#F59E0B',
	'#8B5CF6', '#10B981', '#EF4444', '#14B8A6', '#EC4899', '#84CC16',
	'#6366F1', '#F97316', '#06B6D4', '#D946EF', '#16A34A', '#EAB308',
];
export const NOISE_COLOR = '#4A4A4A';

// Navigation level for drilldown
export type NavigationLevel = 'realms' | 'themes' | 'territories';

// Main mindscape UI state
export interface MindscapeState {
	viewMode: '2d' | '3d';
	currentLevel: NavigationLevel;
	selectedRealmId: number | null;
	selectedSemanticThemeId: number | null;
	selectedTerritoryId: number | null;
	hoveredRealmId: number | null;
	hoveredThemeId: number | null;
	hoveredTerritoryId: number | null;
}

// Lightweight point data for 3D rendering
export interface MindscapePoint {
	id: string;
	type: 'message';
	data: {
		type: string;
		clusterId?: number | null;
		cluster3d?: number | null;
		themeId?: number | null;
		position3d: { x: number; y: number; z: number };
		timestamp?: string;
	};
}

// Meta stats from API
export interface MindscapeMeta {
	total: number;
	noise10d: number;
	noise10dPercent: string | number;
	noise3d: number;
	noise3dPercent: string | number;
	clusterCounts: Record<number, number>;
	cluster3dCounts: Record<number, number>;
}

// Theme card data from API
export interface ThemeCard {
	title: string;
	essence: string | null;
	count: number;
	exploredCount: number;
	exploredPercent: number;
	topEntities: Array<{ name: string; type: string; count: number }>;
	storyBirth: string | null;
	storyArc: string | null;
	storyPeakMoments: string[];
	storyCurrentChapter: string | null;
	uncertaintyOpenQuestions: string[];
	uncertaintyEdges: string | null;
	activity: Array<{ month: string; count: number }>;
}

// Themes lookup: { territoryId: { themeId: ThemeCard } }
export type ThemesLookup = Record<number, Record<number, ThemeCard>>;

// Territory profile data from API
export interface TerritoryProfile {
	name: string;
	essence: string | null;
	archetypeType: string | null;
	archetypeCharacter: string | null;
	realmId: number | null;
	semanticThemeId: number | null;
	count: number;
	exploredCount: number;
	exploredPercent: number;
	topEntities: Array<{ name: string; type: string; count: number }>;
	signaturePatterns: string[];
	storyBirth: string | null;
	storyArc: string | null;
	storyPeakMoments: string[];
	storyCurrentChapter: string | null;
	uncertaintyOpenQuestions: string[];
	uncertaintyEdges: string | null;
	agentExpertise: string | null;
	agentCuriousAbout: string | null;
	agentCanHelpWith: string[];
	chronicle: string | null;
	agentWouldConsult: Array<{ territory_name: string; for: string }>;
	activity: Array<{ month: string; count: number }>;
	centroid: { x: number; y: number; z: number } | null;
}

// Territories lookup: { territoryId: TerritoryProfile }
export type TerritoriesLookup = Record<number, TerritoryProfile>;

// Realm profile data from API
export interface RealmProfile {
	name: string;
	essence: string | null;
	archetypeType: string | null;
	archetypeCharacter: string | null;
	territoryCount: number;
	pointCount: number;
	topEntities: Array<{ name: string; type: string; count: number }>;
	signaturePatterns: string[];
	storyBirth: string | null;
	storyArc: string | null;
	storyPeakMoments: string[];
	storyCurrentChapter: string | null;
	uncertaintyOpenQuestions: string[];
	uncertaintyEdges: string | null;
	agentExpertise: string | null;
	agentCuriousAbout: string | null;
	agentCanHelpWith: string[];
	activity: Array<{ month: string; count: number }>;
}

// Realms lookup: { clusterId: RealmProfile }
export type RealmsLookup = Record<number, RealmProfile>;

// Semantic theme profile data from API
export interface SemanticThemeProfile {
	realmId: number;
	semanticThemeId: number;
	name: string;
	essence: string | null;
	territoryCount: number;
	messageCount: number;
	territoryIds: number[];
	includedTerritoryCount: number;
	coveragePercent: number;
	topEntities: Array<{ name: string; type: string; count: number }>;
	signaturePatterns: string[];
	storyBirth: string | null;
	storyArc: string | null;
	storyCurrentChapter: string | null;
	uncertaintyOpenQuestions: string[];
	activity: Array<{ month: string; count: number }>;
}

// Semantic themes lookup: { "realmId-semanticThemeId": SemanticThemeProfile }
export type SemanticThemesLookup = Record<string, SemanticThemeProfile>;

// Social layer types
export type ContactTier = 'inner' | 'engaged' | 'acknowledged' | 'connected' | 'noise';

export interface ContactTerritory {
	territory_id: number;
	territory_name: string | null;
	strength: number;
	centroid_3d: [number, number, number] | null;
}

export interface Contact {
	id: string;
	name: string;
	company: string | null;
	position: string | null;
	tier: ContactTier;
	interaction_count: number;
	linkedin_url: string | null;
	connected_at: string | null;
	territories: ContactTerritory[];
}

export interface TierCount {
	tier: ContactTier;
	count: number;
}

export interface SocialState {
	contacts: Contact[];
	tiers: TierCount[];
	visibleTiers: Set<ContactTier>;
	selectedContactId: string | null;
	hoveredContactId: string | null;
	socialLoading: boolean;
	showSocialLayer: boolean;
}

// Combined mindscape data + state
interface MindscapeData {
	points: MindscapePoint[];
	themes: ThemesLookup;
	territories: TerritoriesLookup;
	realms: RealmsLookup;
	semanticThemes: SemanticThemesLookup;
	meta: MindscapeMeta | null;
	loading: boolean;
	error: string | null;
}

type FullMindscapeState = MindscapeState & MindscapeData & SocialState;

const defaultState: FullMindscapeState = {
	// UI state
	viewMode: '3d',
	currentLevel: 'realms',
	selectedRealmId: null,
	selectedSemanticThemeId: null,
	selectedTerritoryId: null,
	hoveredRealmId: null,
	hoveredThemeId: null,
	hoveredTerritoryId: null,
	// Data
	points: [],
	themes: {},
	territories: {},
	realms: {},
	semanticThemes: {},
	meta: null,
	loading: true,
	error: null,
	// Social layer
	contacts: [],
	tiers: [],
	visibleTiers: new Set(['inner', 'engaged']),
	selectedContactId: null,
	hoveredContactId: null,
	socialLoading: false,
	showSocialLayer: true,
};

function createMindscapeStore() {
	const { subscribe, set, update } = writable<FullMindscapeState>(defaultState);

	return {
		subscribe,
		set,
		update,

		// Drilldown navigation
		drillIntoRealm: (realmId: number) => update(s => ({
			...s,
			currentLevel: 'themes' as NavigationLevel,
			selectedRealmId: realmId,
			selectedSemanticThemeId: null,
			selectedTerritoryId: null,
		})),

		drillIntoTheme: (realmId: number, themeId: number) => update(s => ({
			...s,
			currentLevel: 'territories' as NavigationLevel,
			selectedRealmId: realmId,
			selectedSemanticThemeId: themeId,
			selectedTerritoryId: null,
		})),

		selectTerritory: (territoryId: number | null) => update(s => ({
			...s,
			selectedTerritoryId: territoryId,
		})),

		deselectTerritory: () => update(s => ({
			...s,
			selectedTerritoryId: null,
		})),

		goBack: () => update(s => {
			if (s.selectedTerritoryId !== null) {
				return { ...s, selectedTerritoryId: null };
			}
			if (s.selectedSemanticThemeId !== null) {
				return {
					...s,
					currentLevel: 'themes' as NavigationLevel,
					selectedSemanticThemeId: null,
					selectedTerritoryId: null,
				};
			}
			if (s.selectedRealmId !== null) {
				return {
					...s,
					currentLevel: 'realms' as NavigationLevel,
					selectedRealmId: null,
					selectedSemanticThemeId: null,
					selectedTerritoryId: null,
				};
			}
			return s;
		}),

		resetNavigation: () => update(s => ({
			...s,
			currentLevel: 'realms' as NavigationLevel,
			selectedRealmId: null,
			selectedSemanticThemeId: null,
			selectedTerritoryId: null,
		})),

		// Hover actions for cross-highlighting with 3D
		setHovered: (type: 'realm' | 'theme' | 'territory', id: number | null) => update(s => ({
			...s,
			hoveredRealmId: type === 'realm' ? id : s.hoveredRealmId,
			hoveredThemeId: type === 'theme' ? id : s.hoveredThemeId,
			hoveredTerritoryId: type === 'territory' ? id : s.hoveredTerritoryId,
		})),

		setViewMode: (mode: '2d' | '3d') => update(s => ({ ...s, viewMode: mode })),

		reset: () => set(defaultState),

		async load() {
			if (!browser) return;
			update(s => ({ ...s, loading: true, error: null }));
			try {
				const res = await fetch('/portal/mindscape', { credentials: 'same-origin' });
				if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
				const data = await res.json();
				update(s => ({
					...s,
					points: data.nodes || [],
					themes: data.themes || {},
					territories: data.territories || {},
					realms: data.realms || {},
					semanticThemes: data.semanticThemes || {},
					meta: data.meta || null,
					loading: false,
					error: null,
				}));
				// Load social layer in parallel (non-blocking)
				this.loadSocial();
			} catch (e) {
				update(s => ({
					...s,
					loading: false,
					error: e instanceof Error ? e.message : 'Unknown error',
				}));
			}
		},

		// Social layer methods
		async loadSocial(tiers?: ContactTier[]) {
			if (!browser) return;
			update(s => ({ ...s, socialLoading: true }));
			try {
				const tierParam = tiers?.join(',') || 'inner,engaged,acknowledged';
				const res = await fetch(`/portal/mindscape/social?tiers=${tierParam}`, {
					credentials: 'same-origin',
				});
				if (!res.ok) throw new Error(`Social load failed: ${res.status}`);
				const data = await res.json();
				update(s => ({
					...s,
					contacts: data.contacts || [],
					tiers: data.tiers || [],
					socialLoading: false,
				}));
			} catch (e) {
				console.error('Failed to load social layer:', e);
				update(s => ({ ...s, socialLoading: false }));
			}
		},

		toggleTier(tier: ContactTier) {
			update(s => {
				const next = new Set(s.visibleTiers);
				if (next.has(tier)) next.delete(tier);
				else next.add(tier);
				return { ...s, visibleTiers: next };
			});
		},

		selectContact(contactId: string | null) {
			update(s => ({ ...s, selectedContactId: contactId }));
		},

		hoverContact(contactId: string | null) {
			update(s => ({ ...s, hoveredContactId: contactId }));
		},

		toggleSocialLayer() {
			update(s => ({ ...s, showSocialLayer: !s.showSocialLayer }));
		},
	};
}

export const mindscapeState = createMindscapeStore();

// Derived stores for convenient access
export const selectedRealmId = derived(mindscapeState, s => s.selectedRealmId);
export const selectedTerritoryId = derived(mindscapeState, s => s.selectedTerritoryId);

// Social derived stores
export const visibleContacts = derived(mindscapeState, s =>
	s.showSocialLayer ? s.contacts.filter(c => s.visibleTiers.has(c.tier)) : []
);
export const selectedContact = derived(mindscapeState, s =>
	s.selectedContactId ? s.contacts.find(c => c.id === s.selectedContactId) ?? null : null
);

// Alias for MindscapeNav compatibility (MYA-0.2 uses $mindscapePoints)
export const mindscapePoints = mindscapeState;

// Helper: get cluster color
export function getClusterColor(clusterId: number | null | undefined): string {
	if (clusterId === null || clusterId === undefined || clusterId === -1) {
		return NOISE_COLOR;
	}
	return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
}
