import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import { api } from '$lib/api';

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
	temporalSaliency: number | null;
	firstActive: string | null;
	lastActive: string | null;
	daysActive: number | null;
	currentVitality: number | null;
	currentPhase: 'sparse' | 'active' | 'anchor' | null;
	isAnchored: number;
	predecessorIds: number[];
	evolvedFromCount: number;
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
	exploredPercent: number;
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

export interface ContactDescription {
	essence: string;
	relationship_arc: string;
	current_chapter: string;
	signature_topics: string[];
	interaction_style: string;
	notable_moments: string[];
}

export interface Contact {
	id: string;
	name: string;
	company: string | null;
	position: string | null;
	tier: ContactTier;
	interaction_count: number;
	outbound_count: number;
	linkedin_url: string | null;
	email: string | null;
	connected_at: string | null;
	last_interaction_at: string | null;
	source: string | null;
	description: ContactDescription | null;
	territories: ContactTerritory[];
}

export interface ContactMessage {
	id: string;
	role: string;
	content: string;
	source: string | null;
	created_at: string;
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
	contactMessages: ContactMessage[];
	contactMessagesLoading: boolean;
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

// Mindscape Pulses — Wave M4 state (Pulses lens controls).
export interface PulsesState {
	pulsesPlaying: boolean;        // play-mode sweep ON/OFF
	pulsesSpeed: number;           // 0.25 | 0.5 | 1 | 2 | 4
	phaseColorEnabled: boolean;    // M1 halo color on/off
	breathingEnabled: boolean;     // M2 breathing on/off
	pulsesEnabled: boolean;        // M3 firing pulses on/off
	dormantVisible: boolean;       // show territories with no phase data
}

type FullMindscapeState = MindscapeState & MindscapeData & SocialState & PulsesState;

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
	contactMessages: [],
	contactMessagesLoading: false,
	// Pulses lens (M4)
	pulsesPlaying: false,
	pulsesSpeed: 1,
	phaseColorEnabled: true,
	breathingEnabled: true,
	pulsesEnabled: true,
	dormantVisible: true,
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
			// Pulses-lens toggles (M4) — play state is intentionally
			// NOT persisted (it's transient), but layer toggles are.
			phaseColorEnabled: prefs.phaseColorEnabled ?? true,
			breathingEnabled: prefs.breathingEnabled ?? true,
			pulsesEnabled: prefs.pulsesEnabled ?? true,
			dormantVisible: prefs.dormantVisible ?? true,
			pulsesSpeed: prefs.pulsesSpeed ?? 1,
		};
	} catch { return {}; }
}

function savePreferences(s: FullMindscapeState) {
	if (!browser) return;
	try {
		localStorage.setItem('mycelium-mindscape-prefs', JSON.stringify({
			visibleTiers: [...s.visibleTiers],
			showSocialLayer: s.showSocialLayer,
			// Pulses lens toggles — persist across sessions. Play state
			// is intentionally not saved.
			phaseColorEnabled: s.phaseColorEnabled,
			breathingEnabled: s.breathingEnabled,
			pulsesEnabled: s.pulsesEnabled,
			dormantVisible: s.dormantVisible,
			pulsesSpeed: s.pulsesSpeed,
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
				// Phase 1 — VISUALS FIRST. The points-only endpoint is served from the
				// durable points cache (it survives the narrative busts that constantly
				// invalidate the full aggregate), so the 3D geometry paints almost
				// instantly. Clear `loading` here so the scene shows while text loads.
				let phase1ok = false;
				try {
					const pres = await api('/portal/mindscape/points');
					if (pres.ok) {
						const pdata = await pres.json();
						phase1ok = true;
						update(s => ({ ...s, points: pdata.nodes || [], meta: pdata.meta || s.meta, loading: false }));
					}
				} catch { /* fall through — the full load below also carries nodes */ }

				// Phase 2 — TEXT AFTER. The full aggregate fills the territory/theme/realm
				// panels. Its `nodes` are identical to phase 1's; keep the phase-1 array
				// (same reference) so the 3D scene does NOT re-render — unless phase 1 failed.
				const res = await api('/portal/mindscape');
				if (!res.ok) {
					if (phase1ok) { update(s => ({ ...s, loading: false })); return; } // visuals up; text lagged
					throw new Error(`Failed to load: ${res.status}`);
				}
				const data = await res.json();
				update(s => ({
					...s,
					points: phase1ok ? s.points : (data.nodes || []),
					themes: data.themes || {},
					territories: data.territories || {},
					realms: data.realms || {},
					semanticThemes: data.semanticThemes || {},
					meta: data.meta || s.meta || null,
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
				const res = await api(`/portal/mindscape/social?tiers=${tierParam}`);
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
			update(s => ({ ...s, selectedContactId: contactId, contactMessages: [], contactMessagesLoading: !!contactId }));
			if (contactId && browser) {
				api(`/portal/mindscape/social/${contactId}`)
					.then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
					.then(data => {
						update(s => ({
							...s,
							contactMessages: (data.messages || []).map((m: any) => ({
								id: m.id,
								role: m.role,
								content: m.content,
								source: m.source,
								created_at: m.created_at,
							})),
							contactMessagesLoading: false,
						}));
					})
					.catch(() => {
						update(s => ({ ...s, contactMessagesLoading: false }));
					});
			}
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

		// Pulses lens (M4)
		setPulsesPlaying(playing: boolean) {
			update(s => ({ ...s, pulsesPlaying: playing }));
		},
		togglePulsesPlaying() {
			update(s => ({ ...s, pulsesPlaying: !s.pulsesPlaying }));
		},
		setPulsesSpeed(speed: number) {
			update(s => {
				const next = { ...s, pulsesSpeed: speed };
				savePreferences(next);
				return next;
			});
		},
		togglePhaseColor() {
			update(s => {
				const next = { ...s, phaseColorEnabled: !s.phaseColorEnabled };
				savePreferences(next);
				return next;
			});
		},
		toggleBreathing() {
			update(s => {
				const next = { ...s, breathingEnabled: !s.breathingEnabled };
				savePreferences(next);
				return next;
			});
		},
		togglePulsesEnabled() {
			update(s => {
				const next = { ...s, pulsesEnabled: !s.pulsesEnabled };
				savePreferences(next);
				return next;
			});
		},
		toggleDormantVisible() {
			update(s => {
				const next = { ...s, dormantVisible: !s.dormantVisible };
				savePreferences(next);
				return next;
			});
		},
	};
}

export const mindscapeState = createMindscapeStore();

// Derived stores for convenient access
export const selectedRealmId = derived(mindscapeState, s => s.selectedRealmId);
export const selectedTerritoryId = derived(mindscapeState, s => s.selectedTerritoryId);

// Social derived stores
export const visibleContacts = derived(mindscapeState, s => {
	try {
		if (!s?.showSocialLayer || !s?.contacts || !(s?.visibleTiers instanceof Set)) return [];
		return s.contacts.filter(c => s.visibleTiers.has(c.tier));
	} catch { return []; }
});
export const selectedContact = derived(mindscapeState, s => {
	try {
		if (!s?.selectedContactId || !s?.contacts) return null;
		return s.contacts.find(c => c.id === s.selectedContactId) ?? null;
	} catch { return null; }
});
export const contactMessages = derived(mindscapeState, s => s?.contactMessages ?? []);
export const contactMessagesLoading = derived(mindscapeState, s => s?.contactMessagesLoading ?? false);

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
