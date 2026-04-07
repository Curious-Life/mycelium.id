import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

// Realm-level palette — muted nebula regions, harmonious like a single gas cloud
// Soft enough to feel natural at overview, distinct enough to tell apart
export const REALM_COLORS = [
	'#4A7A8F', // deep teal haze
	'#8F6A7A', // dusty mauve
	'#7A8A5A', // sage mist
	'#6A6A9A', // twilight blue
	'#9A7A5A', // amber dust
	'#5A8A7A', // ocean deep
	'#8A6A8A', // heather
	'#7A8A9A', // slate fog
	'#8A7A6A', // sandstone
	'#6A8A6A', // moss cloud
	'#7A6A8A', // dusk violet
	'#8A8A6A', // pale olive
];

// Hubble-inspired palette — narrowband emission + deep field colors
// Used at territory level (drilled into a realm) — richer, more distinct
export const CLUSTER_COLORS = [
	'#4DA6C9', // OIII teal — Eagle Nebula pillars
	'#C76B85', // Hα rose — Carina emission
	'#D9AD4D', // SII amber — Pillars of Creation gold
	'#7359B8', // deep violet — Orion reflection nebula
	'#3FB89A', // seafoam — Veil Nebula filaments
	'#B84D62', // crimson — Rosette Nebula core
	'#8DC0D9', // pale cyan — Ring Nebula halo
	'#CC8C40', // warm gold — Lagoon Nebula
	'#6180C7', // steel blue — Witch Head Nebula
	'#A659A0', // mauve — Tarantula Nebula
	'#5BA8A0', // jade — Crab Nebula filaments
	'#D4856A', // salmon — Flame Nebula
	'#8B7EC8', // lavender — Horsehead reflection
	'#4EB87D', // emerald — Bubble Nebula
	'#C9986B', // copper — Omega Nebula
	'#6B9ED4', // cornflower — Pleiades reflection
	'#BF6B8A', // dusty rose — Trifid emission
	'#7DB88C', // sage — Dumbbell Nebula
	'#9B85B8', // wisteria — Helix Nebula
	'#D4A85B', // antique gold — Sombrero halo
	'#5B8FB8', // cadet blue — Whirlpool arms
	'#B87070', // terracotta — Ant Nebula
	'#6BC4B0', // aqua — Butterfly Nebula
	'#C4A06B', // chamois — Owl Nebula glow
];
export const NOISE_COLOR = '#2A2A35';

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
	visibility: 'private' | 'friends' | 'public';
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
	visibleTiers: new Set(['inner']),
	selectedContactId: null,
	hoveredContactId: null,
	socialLoading: false,
	showSocialLayer: true,
};

// Restore preferences from localStorage
function loadPreferences(): Partial<FullMindscapeState> {
	if (!browser) return {};
	try {
		const saved = localStorage.getItem('mycelium-mindscape-prefs');
		if (!saved) return {};
		const prefs = JSON.parse(saved);
		return {
			visibleTiers: new Set(prefs.visibleTiers || ['inner']),
			showSocialLayer: prefs.showSocialLayer ?? true,
		};
	} catch { return {}; }
}

function savePreferences(s: FullMindscapeState) {
	if (!browser) return;
	try {
		localStorage.setItem('mycelium-mindscape-prefs', JSON.stringify({
			visibleTiers: [...s.visibleTiers],
			showSocialLayer: s.showSocialLayer,
		}));
	} catch {}
}

function createMindscapeStore() {
	const initialState = { ...defaultState, ...loadPreferences() };
	const { subscribe, set, update } = writable<FullMindscapeState>(initialState);

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
				const newState = { ...s, visibleTiers: next };
				savePreferences(newState);
				return newState;
			});
		},

		selectContact(contactId: string | null) {
			update(s => ({ ...s, selectedContactId: contactId }));
		},

		hoverContact(contactId: string | null) {
			update(s => ({ ...s, hoveredContactId: contactId }));
		},

		toggleSocialLayer() {
			update(s => {
				const newState = { ...s, showSocialLayer: !s.showSocialLayer };
				savePreferences(newState);
				return newState;
			});
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

// Timeline health — written by Mindscape3D, read by the page health bar
export interface TimelineHealth {
	active: boolean;
	date: Date | null;
	sleep: number | null;
	hrv: number | null;
	rhr: number | null;
	steps: number | null;
	mindful: number | null;
}
export const timelineHealth = writable<TimelineHealth>({
	active: false, date: null, sleep: null, hrv: null, rhr: null, steps: null, mindful: null,
});

// Helper: get cluster color
export function getClusterColor(clusterId: number | null | undefined): string {
	if (clusterId === null || clusterId === undefined || clusterId === -1) {
		return NOISE_COLOR;
	}
	return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
}
