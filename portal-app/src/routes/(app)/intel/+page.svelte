<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { apiGet } from '$lib/api';
	import { navigationState } from '$lib/stores/navigation';
	import * as topojson from 'topojson-client';

	// ── Types ──────────────────────────────────────────────────────────────

	interface Recommendation {
		condition_id: string;
		question: string;
		direction: string;
		current_price: number;
		confidence: number;
		edge: number;
		wallet_count: number;
		total_amount: number;
		avg_win_rate: number;
		signal_count: number;
		signals: string[];
		opposing_score: number;
		end_date: string | null;
		entity_positions: { entity_id: string; wallet_count: number; amount_yes: number; amount_no: number }[];
	}

	interface Signal {
		id: number;
		signal_type: string;
		condition_id: string;
		severity: string;
		summary: string;
		data: Record<string, unknown> | null;
		timestamp: string;
		question: string;
		current_price: number;
	}

	interface Entity {
		entity_id: string;
		wallet_count: number;
		wallets: string[];
		confidence: number;
		total_volume: number;
		total_pnl: number;
		avg_win_rate: number;
		avg_smart_score: number;
	}

	interface MarketDetail {
		condition_id: string;
		question: string;
		price_yes: number;
		price_no: number;
		active: boolean;
		end_date: string | null;
		signals: { id: number; type: string; severity: string; summary: string; timestamp: string }[];
		smart_trades: { wallet: string; side: string; outcome: string; amount: number; smart_score: number; win_rate: number }[];
		entity_positions: { entity_id: string; wallet_count: number; amount_yes: number; amount_no: number }[];
	}

	// ── State ──────────────────────────────────────────────────────────────

	let recommendations = $state<Recommendation[]>([]);
	let signals = $state<Signal[]>([]);
	let entities = $state<Entity[]>([]);
	let selectedMarket = $state<MarketDetail | null>(null);
	let situationReport = $state<string | null>(null);
	let reportLastUpdated = $state<string | null>(null);
	let reportMessage = $state('');

	interface MilitaryBase {
		name: string;
		facility_type: string;
		country: string;
		operator: string;
		lat: number;
		lng: number;
		theater: string;
		notes: string;
	}

	interface Infrastructure {
		name: string;
		infra_type: string;
		country: string;
		lat: number;
		lng: number;
		notes: string;
	}

	interface Aircraft {
		icao24: string;
		callsign: string;
		origin: string;
		lat: number;
		lng: number;
		altitude: number;
		velocity: number;
		heading: number;
		on_ground: boolean;
	}

	interface CiiEntry {
		cii_score: number;
		components: Record<string, number>;
		event_count: number;
		top_sources: string[];
		lat: number | null;
		lon: number | null;
		market_risk?: {
			total_signal: number;
			market_count: number;
			avg_probability: number;
			top_markets: { question: string; direction: string; probability: number; weighted_signal: number }[];
		};
	}

	interface GeoMarket {
		condition_id: string;
		question: string;
		direction: string;
		probability: number;
		current_price: number;
		confidence: number;
		edge: number;
		weighted_signal: number;
		wallet_count: number;
		total_amount: number;
		avg_win_rate: number;
		countries: string[];
		signals: string[];
		end_date: string | null;
	}

	interface EventFeedItem {
		id: number;
		title: string;
		source: string;
		event_type: string;
		theater: string;
		impact_score: number;
		lat: number | null;
		lng: number | null;
		published_at: string;
	}

	interface TrendingSpike {
		keyword: string;
		current_count: number;
		baseline_avg: number;
		surge_ratio: number;
		source_count: number;
		sources: string[];
		sample_titles: string[];
	}

	interface OrefAlert {
		id: number;
		title: string;
		description: string;
		impact_score: number;
		published_at: string;
	}

	interface AisVessel {
		id: number;
		title: string;
		description: string;
		impact_score: number;
		lat: number | null;
		lng: number | null;
		published_at: string;
	}

	interface GpsJamEvent {
		id: number;
		title: string;
		description: string;
		impact_score: number;
		lat: number | null;
		lng: number | null;
		published_at: string;
	}

	interface WarRoomState {
		theaters: { id: string; name: string; lat: number; lng: number; status: string; events_24h: number }[];
		actors: { id: string; name: string; lat: number; lng: number; tier: string; actor_type: string; theater: string; events_48h: number }[];
		all_actors: { id: string; name: string; lat: number; lng: number; tier: string; actor_type: string }[];
		actor_links: { actor_a: string; actor_b: string; link_type: string; strength: number; context: string }[];
		blocs: { id: string; name: string; color: string; lat: number; lng: number; members: Record<string, string> }[];
		threads: { id: number; title: string; status: string; momentum: number; theater: string }[];
		events: { id: number; title: string; lat: number; lng: number; impact_score: number; published_at: string; theater: string }[];
	}

	let warRoomState = $state<WarRoomState | null>(null);
	let mapContainer = $state<HTMLDivElement | null>(null);
	let globeContainer = $state<HTMLDivElement | null>(null);
	let mapInstance: any = null;
	let globeInstance: any = null;
	let mapMode = $state<'2d' | '3d'>('2d');
	let mapColorMode = $state<'alliances' | 'cii'>('alliances');

	// Data layers
	let militaryBases = $state<MilitaryBase[]>([]);
	let infrastructure = $state<Infrastructure[]>([]);
	let aircraft = $state<Aircraft[]>([]);
	let aircraftTime = $state<number | null>(null);

	// New data sources
	let ciiData = $state<Record<string, CiiEntry>>({});
	let eventsFeed = $state<EventFeedItem[]>([]);
	let trendingSpikes = $state<TrendingSpike[]>([]);
	let orefAlerts = $state<OrefAlert[]>([]);
	let aisVessels = $state<AisVessel[]>([]);
	let gpsJamEvents = $state<GpsJamEvent[]>([]);
	let geoMarkets = $state<GeoMarket[]>([]);

	// Layer visibility toggles
	let layers = $state({
		bases: true,
		infrastructure: true,
		events: true,
		aircraft: true,
		markets: true,
		vessels: true,
		gpsjam: true,
	});

	// Selected country intel panel
	interface CountryIntel {
		name: string;
		actorId: string | null;
		blocs: string[];
		rivalries: string[];
		allies: { name: string; type: string }[];
		bases: MilitaryBase[];
		infra: Infrastructure[];
		events: { title: string; impact_score: number; published_at: string; theater: string }[];
		bets: Recommendation[];
		topSignals: Signal[];
		actor: WarRoomState['all_actors'][0] | null;
	}
	let selectedCountry = $state<CountryIntel | null>(null);

	let loading = $state(true);
	let error = $state('');
	let expandMarkets = $state(false);
	let searchQuery = $state('');
	let searchResults = $state<{ condition_id: string; question: string; price_yes: number; active: boolean }[]>([]);
	let searching = $state(false);

	// ── Data Loading (lazy — each source renders as it arrives) ──────────

	async function loadData() {
		loading = true;
		error = '';

		// Fire all requests in parallel but update state as each resolves
		const fetches = [
			apiGet<{ report: string | null; lastUpdated?: string; message?: string }>('/portal/intel/report')
				.then(d => { situationReport = d.report; reportLastUpdated = d.lastUpdated || null; reportMessage = d.message || ''; loading = false; })
				.catch(() => { loading = false; }),
			apiGet<WarRoomState>('/portal/intel/warroom-state')
				.then(d => { warRoomState = d; })
				.catch(() => {}),
			apiGet<{ recommendations: Recommendation[] }>('/portal/intel/recommendations', { hours: '48', min_conf: '5', limit: '30' })
				.then(d => { recommendations = d.recommendations || []; })
				.catch(() => {}),
			apiGet<{ signals: Signal[] }>('/portal/intel/signals', { hours: '24', limit: '100' })
				.then(d => { signals = d.signals || []; })
				.catch(() => {}),
			apiGet<{ entities: Entity[] }>('/portal/intel/entities', { limit: '20' })
				.then(d => { entities = d.entities || []; })
				.catch(() => {}),
			apiGet<MilitaryBase[]>('/portal/intel/bases')
				.then(d => { militaryBases = Array.isArray(d) ? d : []; })
				.catch(() => {}),
			apiGet<Infrastructure[]>('/portal/intel/infrastructure')
				.then(d => { infrastructure = Array.isArray(d) ? d : []; })
				.catch(() => {}),
			apiGet<{ aircraft: Aircraft[]; time: number | null }>('/portal/intel/opensky')
				.then(d => { aircraft = d.aircraft || []; aircraftTime = d.time || null; })
				.catch(() => {}),
			apiGet<Record<string, CiiEntry>>('/portal/intel/cii')
				.then(d => { ciiData = d || {}; })
				.catch(() => {}),
			apiGet<{ events: EventFeedItem[] }>('/portal/intel/events-feed', { hours: '24', limit: '100' })
				.then(d => { eventsFeed = d.events || []; })
				.catch(() => {}),
			apiGet<{ trending: TrendingSpike[] }>('/portal/intel/trending')
				.then(d => { trendingSpikes = d.trending || []; })
				.catch(() => {}),
			apiGet<{ alerts: OrefAlert[] }>('/portal/intel/oref')
				.then(d => { orefAlerts = d.alerts || []; })
				.catch(() => {}),
			apiGet<{ vessels: AisVessel[] }>('/portal/intel/ais')
				.then(d => { aisVessels = d.vessels || []; })
				.catch(() => {}),
			apiGet<{ events: GpsJamEvent[] }>('/portal/intel/gpsjam')
				.then(d => { gpsJamEvents = d.events || []; })
				.catch(() => {}),
			apiGet<{ markets: GeoMarket[]; count: number }>('/portal/intel/markets-geo')
				.then(d => { geoMarkets = d.markets || []; })
				.catch(() => {}),
		];

		const results = await Promise.allSettled(fetches);
		const failures = results.filter(r => r.status === 'rejected');
		if (failures.length === results.length) {
			error = 'All data sources failed';
		}
		loading = false;
	}

	async function openMarket(conditionId: string) {
		try {
			const data = await apiGet<{ market: MarketDetail }>(`/portal/intel/market/${conditionId}`);
			selectedMarket = data.market;
		} catch { /* ignore */ }
	}

	async function searchMarkets() {
		if (!searchQuery.trim()) { searchResults = []; return; }
		searching = true;
		try {
			const data = await apiGet<{ markets: any[] }>('/portal/intel/markets/search', { q: searchQuery, limit: '15' });
			searchResults = data.markets || [];
		} catch { searchResults = []; }
		finally { searching = false; }
	}

	let searchTimeout: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(searchMarkets, 400);
	}

	onMount(() => {
		navigationState.setPrimaryView('intel');
		loadData();
	});

	// ── Map Rendering ─────────────────────────────────────────────────────
	// Dynamically loads Leaflet and renders the strategic map

	let leafletLoaded = $state(false);
	let L: any = null;

	async function loadLeaflet() {
		if (leafletLoaded) return;
		// Load CSS from local static assets (no CDN)
		if (!document.querySelector('link[href*="leaflet.css"]')) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = '/assets/leaflet.css';
			document.head.appendChild(link);
		}
		const leafletMod = await import('leaflet');
		L = leafletMod.default;
		leafletLoaded = true;
	}

	// ── Country → Actor ID mapping (GeoJSON name → war-room actor slug) ──
	const COUNTRY_ACTOR: Record<string, string> = {
		'United States of America': 'united-states', 'United States': 'united-states',
		'China': 'china', 'Russia': 'russia', 'Ukraine': 'ukraine',
		'Iran': 'iran', 'Israel': 'israel', 'India': 'india',
		'Saudi Arabia': 'saudi-arabia', 'North Korea': 'north-korea', 'Dem. Rep. Korea': 'north-korea',
		'Taiwan': 'taiwan', 'Turkey': 'turkey', 'Türkiye': 'turkey',
		'France': 'france', 'Germany': 'germany', 'United Kingdom': 'uk',
		'Japan': 'japan', 'South Korea': 'south-korea', 'Republic of Korea': 'south-korea', 'Korea': 'south-korea',
		'Brazil': 'brazil', 'Egypt': 'egypt', 'Pakistan': 'pakistan',
		'Australia': 'australia', 'Canada': 'canada',
		'Poland': 'poland', 'Romania': 'romania', 'Norway': 'norway',
		'Italy': 'italy', 'Spain': 'spain', 'Netherlands': 'netherlands',
		'Belgium': 'belgium', 'Greece': 'greece', 'Portugal': 'portugal',
		'Czech Republic': 'czech-republic', 'Czechia': 'czech-republic',
		'Hungary': 'hungary', 'Bulgaria': 'bulgaria',
		'Denmark': 'denmark', 'Estonia': 'estonia', 'Latvia': 'latvia', 'Lithuania': 'lithuania',
		'Croatia': 'croatia', 'Slovenia': 'slovenia', 'Slovakia': 'slovakia',
		'Finland': 'finland', 'Sweden': 'sweden',
		'Indonesia': 'indonesia', 'Mexico': 'mexico', 'Argentina': 'argentina',
		'South Africa': 'south-africa', 'Ethiopia': 'ethiopia',
		'United Arab Emirates': 'uae', 'Qatar': 'qatar',
		'Iraq': 'iraq', 'Syria': 'syria', 'Lebanon': 'lebanon', 'Yemen': 'yemen',
		'Afghanistan': 'afghanistan', 'Libya': 'libya',
	};

	// Bloc colors for country fills — 13 blocs with distinct colors
	const BLOC_COLORS: Record<string, [number, number, number]> = {
		'nato': [51, 136, 255],               // #3388ff blue
		'eu': [102, 153, 255],                // #6699ff lighter blue
		'eu-bloc': [102, 153, 255],
		'five_eyes': [170, 85, 255],          // #aa55ff purple
		'five-eyes': [170, 85, 255],
		'aukus': [119, 68, 204],              // #7744cc dark purple
		'brics': [255, 153, 51],              // #ff9933 orange
		'brics-bloc': [255, 153, 51],
		'quad': [0, 204, 136],                // #00cc88 teal
		'gcc': [221, 170, 51],                // #ddaa33 gold
		'opec_plus': [51, 170, 85],           // #33aa55 green
		'opec-bloc': [51, 170, 85],
		'axis-of-resistance': [204, 51, 51],  // #cc3333 red
		'anti-iran': [255, 85, 102],          // #ff5566 coral
		'anti-iran-coalition': [255, 85, 102],
		'asean': [51, 204, 221],              // #33ccdd cyan
		'sco': [238, 119, 68],                // #ee7744 burnt orange
		'sahel': [187, 136, 85],              // #bb8855 brown
		'sahel-alliance': [187, 136, 85],
	};

	// Alliance type → color influence
	const ALLIANCE_COLORS: Record<string, [number, number, number]> = {
		military_ally: [58, 138, 90],
		ally: [58, 138, 90],
		political_ally: [74, 124, 255],
		military_rival: [212, 48, 48],
		rival: [212, 48, 48],
		sanctions: [200, 122, 32],
	};

	function hexToRgb(hex: string): [number, number, number] {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return [r, g, b];
	}

	function blendColors(colors: [number, number, number][], weights?: number[]): string {
		if (colors.length === 0) return 'rgba(30, 30, 50, 0.1)';
		const w = weights || colors.map(() => 1);
		const totalW = w.reduce((s, v) => s + v, 0);
		let r = 0, g = 0, b = 0;
		for (let i = 0; i < colors.length; i++) {
			const ratio = w[i] / totalW;
			r += colors[i][0] * ratio;
			g += colors[i][1] * ratio;
			b += colors[i][2] * ratio;
		}
		return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
	}

	function statusColor(status: string): string {
		return { critical: '#d43030', volatile: '#c87a20', active: '#3a8a5a', calm: '#3a3a5a' }[status] || '#3a3a5a';
	}

	let geoJsonCache: any = null;
	let selectedCountryLayer: any = null; // track selected country for border highlight

	async function loadCountryGeoJson() {
		if (geoJsonCache) return geoJsonCache;
		try {
			// Load TopoJSON data + converter from local npm packages (no CDN)
			const topoMod = await import('world-atlas/countries-110m.json');
			const topoData = topoMod.default;
			geoJsonCache = topojson.feature(topoData, topoData.objects.countries);

			// Fix antimeridian crossing (Russia, Fiji, etc.)
			// Polygons that span > 180° longitude get their negative coords shifted +360
			function fixAntimeridianRing(ring: number[][]) {
				let minLng = Infinity, maxLng = -Infinity;
				for (const c of ring) { minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]); }
				if (maxLng - minLng > 180) {
					for (const c of ring) { if (c[0] < 0) c[0] += 360; }
				}
			}
			function fixGeometry(geom: any) {
				if (!geom) return;
				if (geom.type === 'Polygon') {
					for (const ring of geom.coordinates) fixAntimeridianRing(ring);
				} else if (geom.type === 'MultiPolygon') {
					for (const poly of geom.coordinates) for (const ring of poly) fixAntimeridianRing(ring);
				}
			}
			for (const feat of geoJsonCache.features) fixGeometry(feat.geometry);

			return geoJsonCache;
		} catch (e) {
			console.warn('[Map] Failed to load country boundaries:', e);
			return null;
		}
	}

	// Country name keywords for matching recommendations to countries
	const COUNTRY_KEYWORDS: Record<string, string[]> = {
		'United States of America': ['trump', 'biden', 'us ', 'united states', 'america', 'congress', 'fed ', 'federal reserve', 'pentagon'],
		'Russia': ['russia', 'putin', 'kremlin', 'moscow'],
		'China': ['china', 'beijing', 'xi jinping', 'pla'],
		'Ukraine': ['ukraine', 'zelensky', 'kyiv'],
		'Iran': ['iran', 'tehran', 'khamenei'],
		'Israel': ['israel', 'netanyahu', 'idf'],
		'Taiwan': ['taiwan', 'taipei'],
		'North Korea': ['north korea', 'pyongyang', 'kim jong'],
		'India': ['india', 'modi', 'delhi'],
		'Saudi Arabia': ['saudi', 'riyadh'],
		'Turkey': ['turkey', 'erdogan', 'ankara'], 'Türkiye': ['turkey', 'erdogan'],
		'United Kingdom': ['uk', 'britain', 'london'],
		'France': ['france', 'paris', 'macron'],
		'Germany': ['germany', 'berlin', 'scholz'],
		'Japan': ['japan', 'tokyo'],
		'South Korea': ['south korea', 'seoul'],
		'Brazil': ['brazil', 'brasilia', 'lula'],
		'Mexico': ['mexico'],
		'Canada': ['canada', 'ottawa'],
		'Pakistan': ['pakistan', 'islamabad'],
		'Egypt': ['egypt', 'cairo', 'sisi'],
		'Syria': ['syria', 'damascus', 'assad'],
		'Yemen': ['yemen', 'houthi'],
		'Iraq': ['iraq', 'baghdad'],
		'Poland': ['poland', 'warsaw'],
	};

	// Reverse: actor ID → country name
	const ACTOR_TO_COUNTRY: Record<string, string> = {};
	for (const [name, actorId] of Object.entries(COUNTRY_ACTOR)) {
		ACTOR_TO_COUNTRY[actorId] = name;
	}

	function buildCountryIntel(countryName: string): CountryIntel {
		const actorId = COUNTRY_ACTOR[countryName] || null;
		const state = warRoomState;
		const intel: CountryIntel = {
			name: countryName,
			actorId,
			blocs: [],
			rivalries: [],
			allies: [],
			bases: [],
			infra: [],
			events: [],
			bets: [],
			topSignals: [],
			actor: null,
		};

		if (!state) return intel;

		// Find actor info
		if (actorId) {
			intel.actor = state.all_actors.find(a => a.id === actorId) || null;

			// Blocs
			for (const bloc of state.blocs) {
				if (bloc.members && actorId in bloc.members) {
					intel.blocs.push(bloc.name);
				}
			}

			// Relationships
			for (const link of state.actor_links) {
				if (link.actor_a === actorId || link.actor_b === actorId) {
					const otherId = link.actor_a === actorId ? link.actor_b : link.actor_a;
					const otherName = ACTOR_TO_COUNTRY[otherId] || otherId;
					const isRival = link.link_type.includes('rival') || link.link_type === 'sanctions';
					if (isRival) {
						intel.rivalries.push(otherName);
					} else {
						intel.allies.push({ name: otherName, type: link.link_type.replace(/_/g, ' ') });
					}
				}
			}
		}

		// Bases in this country
		intel.bases = militaryBases.filter(b =>
			b.country.toLowerCase() === countryName.toLowerCase() ||
			(actorId && b.operator.toLowerCase().includes(countryName.toLowerCase().split(' ')[0]))
		);

		// Infrastructure in this country
		intel.infra = infrastructure.filter(i =>
			i.country.toLowerCase() === countryName.toLowerCase()
		);

		// Events mentioning this country
		const countryLower = countryName.toLowerCase();
		intel.events = state.events.filter(e =>
			e.title.toLowerCase().includes(countryLower) ||
			(actorId && e.title.toLowerCase().includes(actorId.replace(/-/g, ' ')))
		).slice(0, 8);

		// Smart money bets related to this country
		const keywords = COUNTRY_KEYWORDS[countryName] || [countryName.toLowerCase()];
		intel.bets = recommendations.filter(rec => {
			const q = rec.question.toLowerCase();
			return keywords.some(kw => q.includes(kw));
		});

		// Signals related to this country (by question text or summary)
		const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
		intel.topSignals = signals
			.filter(sig => {
				const text = (sig.question + ' ' + sig.summary).toLowerCase();
				return keywords.some(kw => text.includes(kw));
			})
			.sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4))
			.slice(0, 6);

		return intel;
	}

	async function initMap() {
		if (!mapContainer || !warRoomState) return;
		await loadLeaflet();

		if (mapInstance) { mapInstance.remove(); mapInstance = null; }
		selectedCountryLayer = null;

		mapInstance = L.map(mapContainer, {
			center: [25, 20],
			zoom: 3,
			minZoom: 2,
			maxZoom: 10,
			zoomControl: true,
			attributionControl: false,
			tap: false, // disable Leaflet tap handler that causes square flash
		});

		// Very dark base — we'll color countries ourselves
		L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
			subdomains: 'abcd',
		}).addTo(mapInstance);

		const state = warRoomState;

		// ── Build alliance color map for each actor ──
		// Each country-actor gets colors from: blocs it belongs to + direct alliances with US
		const actorColors: Record<string, { colors: [number, number, number][]; weights: number[]; blocs: string[]; rivalries: string[] }> = {};

		function ensureActor(id: string) {
			if (!actorColors[id]) actorColors[id] = { colors: [], weights: [], blocs: [], rivalries: [] };
		}

		// Bloc membership → primary color source
		for (const bloc of state.blocs) {
			const rgb = BLOC_COLORS[bloc.id] || hexToRgb(bloc.color || '#555555');
			for (const actorId of Object.keys(bloc.members || {})) {
				ensureActor(actorId);
				actorColors[actorId].colors.push(rgb);
				actorColors[actorId].weights.push(bloc.members[actorId] === 'leader' ? 1.5 : 1.0);
				actorColors[actorId].blocs.push(bloc.name);
			}
		}

		// Static fallback: ensure all known members get bloc colors even if war room data is sparse
		const STATIC_BLOCS: Record<string, { color: [number, number, number]; name: string; members: string[] }> = {
			nato: { color: [51, 136, 255], name: 'NATO', members: [
				'united-states', 'uk', 'france', 'germany', 'canada', 'italy', 'spain', 'turkey',
				'poland', 'romania', 'norway', 'belgium', 'netherlands', 'greece', 'portugal',
				'czech-republic', 'hungary', 'bulgaria', 'denmark', 'estonia', 'latvia', 'lithuania',
				'croatia', 'slovenia', 'slovakia', 'finland', 'sweden', 'australia',
			]},
			eu: { color: [102, 153, 255], name: 'EU', members: [
				'france', 'germany', 'italy', 'spain', 'netherlands', 'belgium', 'greece', 'portugal',
				'czech-republic', 'hungary', 'bulgaria', 'denmark', 'estonia', 'latvia', 'lithuania',
				'croatia', 'slovenia', 'slovakia', 'finland', 'sweden', 'poland', 'romania', 'ireland',
			]},
			brics: { color: [255, 153, 51], name: 'BRICS+', members: [
				'china', 'russia', 'india', 'brazil', 'south-africa', 'iran', 'egypt', 'ethiopia', 'uae', 'saudi-arabia', 'indonesia',
			]},
			five_eyes: { color: [170, 85, 255], name: 'Five Eyes', members: [
				'united-states', 'uk', 'canada', 'australia', 'new-zealand',
			]},
			aukus: { color: [119, 68, 204], name: 'AUKUS', members: ['united-states', 'uk', 'australia'] },
			quad: { color: [0, 204, 136], name: 'Quad', members: ['united-states', 'india', 'japan', 'australia'] },
			gcc: { color: [221, 170, 51], name: 'GCC', members: ['saudi-arabia', 'uae', 'qatar', 'kuwait', 'bahrain', 'oman'] },
			asean: { color: [51, 204, 221], name: 'ASEAN', members: [
				'indonesia', 'thailand', 'vietnam', 'philippines', 'malaysia', 'singapore', 'myanmar', 'cambodia', 'laos', 'brunei',
			]},
			sco: { color: [238, 119, 68], name: 'SCO', members: [
				'china', 'russia', 'india', 'pakistan', 'iran', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'tajikistan', 'belarus',
			]},
			'axis-of-resistance': { color: [204, 51, 51], name: 'Axis of Resistance', members: [
				'iran', 'syria', 'yemen', 'iraq', 'lebanon',
			]},
		};
		for (const [blocId, bloc] of Object.entries(STATIC_BLOCS)) {
			for (const actorId of bloc.members) {
				// Only add if not already assigned by war room data
				if (!actorColors[actorId] || actorColors[actorId].blocs.length === 0) {
					ensureActor(actorId);
					actorColors[actorId].colors.push(bloc.color);
					actorColors[actorId].weights.push(1.0);
					actorColors[actorId].blocs.push(bloc.name);
				} else if (!actorColors[actorId].blocs.includes(bloc.name)) {
					// Add secondary bloc membership
					actorColors[actorId].colors.push(bloc.color);
					actorColors[actorId].weights.push(0.5);
					actorColors[actorId].blocs.push(bloc.name);
				}
			}
		}

		// Direct relationships → secondary color influence
		for (const link of state.actor_links) {
			const rgb = ALLIANCE_COLORS[link.link_type];
			if (!rgb) continue;
			const isRival = link.link_type.includes('rival') || link.link_type === 'sanctions';
			for (const actorId of [link.actor_a, link.actor_b]) {
				ensureActor(actorId);
				if (isRival) {
					const other = actorId === link.actor_a ? link.actor_b : link.actor_a;
					actorColors[actorId].rivalries.push(other);
					// Add a subtle red tint for countries with active rivalries
					actorColors[actorId].colors.push([212, 48, 48]);
					actorColors[actorId].weights.push(0.3 * link.strength);
				}
			}
		}

		// ── CII score lookup by country name ──
		function ciiScoreForName(name: string): number | null {
			// Direct match
			if (ciiData[name]) return ciiData[name].cii_score;
			// Alias match
			const aliases: Record<string, string> = {
				'United States of America': 'USA', 'United States': 'USA',
				'United Kingdom': 'UK', 'Republic of Korea': 'South Korea',
				'Dem. Rep. Korea': 'North Korea', 'Türkiye': 'Turkey',
			};
			const alias = aliases[name];
			if (alias && ciiData[alias]) return ciiData[alias].cii_score;
			return null;
		}

		function ciiColor(score: number): string {
			if (score >= 75) return `rgba(212, 48, 48, ${0.3 + (score - 75) * 0.025})`;   // critical: red
			if (score >= 55) return `rgba(200, 122, 32, ${0.25 + (score - 55) * 0.012})`;  // high: orange
			if (score >= 35) return `rgba(229, 184, 76, ${0.15 + (score - 35) * 0.005})`;  // moderate: yellow
			if (score >= 15) return `rgba(58, 138, 90, ${0.10 + (score - 15) * 0.005})`;   // low: green
			return `rgba(80, 80, 120, ${0.06 + score * 0.003})`;                            // minimal: blue-grey
		}

		// ── Render country fills ──
		const countryGeoJson = await loadCountryGeoJson();
		if (countryGeoJson) {
			L.geoJSON(countryGeoJson, {
				style: (feature: any) => {
					const name = feature.properties?.name || '';

					if (mapColorMode === 'cii') {
						// CII heatmap mode
						const score = ciiScoreForName(name);
						if (score !== null && score > 5) {
							const fill = ciiColor(score);
							return {
								fillColor: fill,
								fillOpacity: 0.6,
								color: fill,
								weight: score >= 50 ? 1.5 : 0.8,
								opacity: score >= 50 ? 0.7 : 0.4,
							};
						}
						return {
							fillColor: '#1a1a2e',
							fillOpacity: 0.08,
							color: '#2a2a3e',
							weight: 0.3,
							opacity: 0.15,
						};
					}

					// Alliance mode (default)
					const actorId = COUNTRY_ACTOR[name];

					if (actorId && actorColors[actorId] && actorColors[actorId].colors.length > 0) {
						const ac = actorColors[actorId];
						const fillColor = blendColors(ac.colors, ac.weights);
						const hasRivalry = ac.rivalries.length > 0;
						return {
							fillColor,
							fillOpacity: hasRivalry ? 0.45 : 0.35,
							color: fillColor,
							weight: hasRivalry ? 1.5 : 1.0,
							opacity: hasRivalry ? 0.6 : 0.4,
						};
					}
					// Unaligned / unmapped countries
					return {
						fillColor: '#1a1a2e',
						fillOpacity: 0.08,
						color: '#2a2a3e',
						weight: 0.3,
						opacity: 0.15,
					};
				},
				onEachFeature: (feature: any, layer: any) => {
					const name = feature.properties?.name || 'Unknown';
					const cScore = ciiScoreForName(name);
					const actorId = COUNTRY_ACTOR[name];
					const ac = actorId ? actorColors[actorId] : null;
					if (mapColorMode === 'cii' && cScore !== null && cScore > 5) {
						layer.bindTooltip(`<div style="font-family:monospace;font-size:11px;"><strong>${name}</strong><br>CII: <span style="color:${cScore >= 70 ? '#d43030' : cScore >= 50 ? '#c87a20' : cScore >= 30 ? '#E5B84C' : '#3a8a5a'}">${cScore.toFixed(1)}</span></div>`, { sticky: true, className: 'cii-tooltip' });
					} else if (mapColorMode === 'alliances' && ac && ac.blocs.length > 0) {
						layer.bindTooltip(`<div style="font-family:monospace;font-size:11px;"><strong>${name}</strong><br>${ac.blocs.join(', ')}${cScore !== null && cScore > 5 ? `<br>CII: ${cScore.toFixed(1)}` : ''}</div>`, { sticky: true, className: 'cii-tooltip' });
					}
					layer.on('click', (e: any) => {
						// Deselect previous
						if (selectedCountryLayer && selectedCountryLayer !== e.target) {
							const prev = selectedCountryLayer;
							prev.setStyle({ weight: prev._origWeight || 1, opacity: prev._origOpacity || 0.4, color: prev._origColor || prev.options.color, dashArray: '' });
						}
						// Highlight selected country borders
						const t = e.target;
						t._origWeight = t.options.weight;
						t._origOpacity = t.options.opacity;
						t._origColor = t.options.color;
						t.setStyle({ weight: 3, opacity: 1, color: '#E5B84C', dashArray: '' });
						t.bringToFront();
						selectedCountryLayer = t;
						selectedCountry = buildCountryIntel(name);
					});
					// Hover highlight
					layer.on('mouseover', (e: any) => {
						if (e.target !== selectedCountryLayer) {
							e.target.setStyle({ weight: 2, opacity: 0.8 });
						}
					});
					layer.on('mouseout', (e: any) => {
						if (e.target !== selectedCountryLayer) {
							e.target.setStyle({ weight: e.target._origWeight || e.target.options.weight || 1, opacity: e.target._origOpacity || e.target.options.opacity || 0.4 });
						}
					});
				},
			}).addTo(mapInstance);
		}

		// Labels on top of fills
		L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
			subdomains: 'abcd',
			opacity: 0.5,
		}).addTo(mapInstance);

		// Build actor position index
		const actorPos: Record<string, [number, number]> = {};
		for (const a of state.all_actors) {
			if (a.lat && a.lng) actorPos[a.id] = [a.lat, a.lng];
		}

		// ── Bloc labels ──
		for (const bloc of state.blocs) {
			if (bloc.lat && bloc.lng) {
				const labelIcon = L.divIcon({
					className: '',
					html: `<span style="font-family:monospace;font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${bloc.color || '#888'};background:rgba(10,10,18,0.8);padding:2px 6px;border:1px solid ${bloc.color || '#555'}44;border-radius:3px;white-space:nowrap;">${bloc.name}</span>`,
					iconSize: [120, 18],
					iconAnchor: [60, 9],
				});
				L.marker([bloc.lat, bloc.lng], { icon: labelIcon }).addTo(mapInstance);
			}
		}

		// ── Actor markers (major actors get name labels) ──
		for (const a of state.all_actors) {
			if (!a.lat || !a.lng) continue;
			if (a.tier === 'major') {
				const ac = actorColors[a.id];
				const dotColor = ac && ac.colors.length > 0 ? blendColors(ac.colors, ac.weights) : '#E5B84C';
				const icon = L.divIcon({
					className: '',
					html: `<div style="text-align:center;">
						<div style="width:12px;height:12px;border-radius:50%;background:${dotColor};border:2px solid rgba(255,255,255,0.6);margin:0 auto;box-shadow:0 0 8px ${dotColor};"></div>
						<div style="font-family:monospace;font-size:8px;font-weight:600;color:#ccc;text-shadow:0 0 6px rgba(0,0,0,1),0 0 3px rgba(0,0,0,1);white-space:nowrap;margin-top:2px;">${a.name}</div>
					</div>`,
					iconSize: [100, 32],
					iconAnchor: [50, 8],
				});
				L.marker([a.lat, a.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${a.name}</div><div style="font-size:11px;color:#888;">${a.tier} ${a.actor_type}${ac?.blocs.length ? '<br>Blocs: ' + ac.blocs.join(', ') : ''}</div>`);
			} else if (a.actor_type === 'country') {
				const icon = L.divIcon({
					className: '',
					html: `<div style="width:6px;height:6px;border-radius:50%;background:#E5B84C;border:1px solid rgba(255,255,255,0.3);"></div>`,
					iconSize: [6, 6],
					iconAnchor: [3, 3],
				});
				L.marker([a.lat, a.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${a.name}</div><div style="font-size:11px;color:#888;">${a.tier} ${a.actor_type}</div>`);
			}
		}

		// ── Military Bases ──
		if (layers.bases && militaryBases.length > 0) {
			for (const base of militaryBases) {
				if (!base.lat || !base.lng) continue;
				const typeIcon: Record<string, string> = {
					air_base: '✈', naval_base: '⚓', missile_site: '◆', army_base: '★', radar: '◎', space: '◉',
				};
				const sym = typeIcon[base.facility_type] || '●';
				const icon = L.divIcon({
					className: '',
					html: `<div style="text-align:center;">
						<div style="width:16px;height:16px;border-radius:3px;background:rgba(100,160,255,0.2);border:1px solid rgba(100,160,255,0.6);display:flex;align-items:center;justify-content:center;font-size:9px;color:#64a0ff;margin:0 auto;">${sym}</div>
					</div>`,
					iconSize: [16, 16],
					iconAnchor: [8, 8],
				});
				L.marker([base.lat, base.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${base.name}</div><div style="font-size:11px;color:#888;">${base.facility_type.replace(/_/g, ' ')} · ${base.operator}<br>${base.country} · ${base.theater}</div><div style="font-size:10px;color:#666;margin-top:3px;">${base.notes || ''}</div>`);
			}
		}

		// ── Infrastructure (cables, pipelines, data centers) ──
		if (layers.infrastructure && infrastructure.length > 0) {
			// Group submarine cables by name to draw arcs
			const cables: Record<string, Infrastructure[]> = {};
			const otherInfra: Infrastructure[] = [];
			for (const inf of infrastructure) {
				if (!inf.lat || !inf.lng) continue;
				if (inf.infra_type === 'submarine_cable') {
					if (!cables[inf.name]) cables[inf.name] = [];
					cables[inf.name].push(inf);
				} else {
					otherInfra.push(inf);
				}
			}
			// Draw cable routes as polylines
			for (const [name, landings] of Object.entries(cables)) {
				if (landings.length < 2) continue;
				const coords = landings.map(l => [l.lat, l.lng] as [number, number]);
				L.polyline(coords, {
					color: '#06b6d4',
					weight: 1.5,
					opacity: 0.4,
					dashArray: '4 6',
				}).addTo(mapInstance).bindPopup(`<div style="font-weight:600;">${name}</div><div style="font-size:11px;color:#888;">Submarine cable · ${landings.length} landings</div>`);
				// Landing markers
				for (const l of landings) {
					const icon = L.divIcon({
						className: '',
						html: `<div style="width:5px;height:5px;border-radius:50%;background:#06b6d4;border:1px solid rgba(6,182,212,0.4);"></div>`,
						iconSize: [5, 5],
						iconAnchor: [2.5, 2.5],
					});
					L.marker([l.lat, l.lng], { icon }).addTo(mapInstance)
						.bindPopup(`<div style="font-weight:600;">${l.name}</div><div style="font-size:11px;color:#888;">${l.infra_type.replace(/_/g, ' ')} · ${l.country}</div><div style="font-size:10px;color:#666;">${l.notes || ''}</div>`);
				}
			}
			// Other infrastructure (IX points, data centers, pipeline landings)
			const infraTypeIcon: Record<string, string> = {
				internet_exchange: '⬡', data_center: '▣', pipeline_landing: '▬', port: '⊞',
			};
			for (const inf of otherInfra) {
				const sym = infraTypeIcon[inf.infra_type] || '◇';
				const icon = L.divIcon({
					className: '',
					html: `<div style="width:12px;height:12px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#a78bfa;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.4);border-radius:2px;">${sym}</div>`,
					iconSize: [12, 12],
					iconAnchor: [6, 6],
				});
				L.marker([inf.lat, inf.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${inf.name}</div><div style="font-size:11px;color:#888;">${inf.infra_type.replace(/_/g, ' ')} · ${inf.country}</div><div style="font-size:10px;color:#666;">${inf.notes || ''}</div>`);
			}
		}

		// ── Live Aircraft (OpenSky) ──
		if (layers.aircraft && aircraft.length > 0) {
			for (const ac of aircraft) {
				if (!ac.lat || !ac.lng) continue;
				const rotation = ac.heading || 0;
				const altKm = ac.altitude ? (ac.altitude / 1000).toFixed(1) : '?';
				const speedKts = ac.velocity ? Math.round(ac.velocity * 1.944) : '?';
				const icon = L.divIcon({
					className: '',
					html: `<div style="transform:rotate(${rotation}deg);width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fbbf24;filter:drop-shadow(0 0 4px rgba(251,191,36,0.6));">✈</div>`,
					iconSize: [14, 14],
					iconAnchor: [7, 7],
				});
				L.marker([ac.lat, ac.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${ac.callsign || ac.icao24}</div><div style="font-size:11px;color:#888;">${ac.origin}<br>Alt: ${altKm}km · ${speedKts}kts</div>`);
			}
		}

		// ── AIS Military Vessels ──
		if (layers.vessels && aisVessels.length > 0) {
			for (const v of aisVessels) {
				if (!v.lat || !v.lng) continue;
				const icon = L.divIcon({
					className: '',
					html: `<div style="width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#06b6d4;filter:drop-shadow(0 0 4px rgba(6,182,212,0.6));">⚓</div>`,
					iconSize: [14, 14],
					iconAnchor: [7, 7],
				});
				L.marker([v.lat, v.lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${v.title}</div><div style="font-size:11px;color:#888;">${v.description?.slice(0, 200) || ''}</div><div style="font-size:10px;color:#666;margin-top:3px;">${timeAgo(v.published_at)} ago</div>`);
			}
		}

		// ── GPS Jamming Zones ──
		if (layers.gpsjam && gpsJamEvents.length > 0) {
			for (const g of gpsJamEvents) {
				if (!g.lat || !g.lng) continue;
				const isHigh = (g.title || '').includes('HIGH');
				const color = isHigh ? '#d43030' : '#c87a20';
				const radius = isHigh ? 80000 : 50000;
				L.circle([g.lat, g.lng], {
					radius,
					color,
					fillColor: color,
					fillOpacity: 0.12,
					weight: 1,
					opacity: 0.4,
					dashArray: '4 4',
				}).addTo(mapInstance)
					.bindPopup(`<div style="font-weight:600;">${g.title}</div><div style="font-size:11px;color:#888;">${g.description?.slice(0, 200) || ''}</div>`);
			}
		}

		// ── Event pins (pulsing for high-impact) ──
		if (!layers.events) { /* skip events */ } else
		for (const e of state.events) {
			if (!e.lat || !e.lng) continue;
			const color = e.impact_score >= 60 ? '#d43030' : e.impact_score >= 40 ? '#c87a20' : '#5a5a7a';
			const size = e.impact_score >= 60 ? 10 : 7;
			const icon = L.divIcon({
				className: '',
				html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:1px solid rgba(255,255,255,0.2);box-shadow:0 0 6px ${color};${e.impact_score >= 60 ? 'animation:pulse 2s ease-in-out infinite;' : ''}"></div>`,
				iconSize: [size, size],
				iconAnchor: [size / 2, size / 2],
			});
			L.marker([e.lat, e.lng], { icon }).addTo(mapInstance)
				.bindPopup(`<div style="font-weight:600;">${e.title}</div><div style="font-size:11px;color:#888;">Impact: ${Math.round(e.impact_score)} · ${e.theater || ''}</div>`);
		}

		// ── Theater status indicators ──
		for (const t of state.theaters) {
			if (!t.lat || !t.lng) continue;
			const color = statusColor(t.status);
			const icon = L.divIcon({
				className: '',
				html: `<div style="text-align:center;pointer-events:none;">
					<div style="width:28px;height:28px;border-radius:50%;border:2px solid ${color};margin:0 auto;box-shadow:0 0 12px ${color}66;${t.status === 'critical' ? 'animation:pulse 2s ease-in-out infinite;' : ''}"></div>
				</div>`,
				iconSize: [28, 28],
				iconAnchor: [14, 14],
			});
			L.marker([t.lat, t.lng], { icon, interactive: false }).addTo(mapInstance);
		}

		// ── Smart Money / Prediction Market overlays ──
		if (layers.markets && recommendations.length > 0) {
			// Map market keywords to approximate geo positions
			const MARKET_GEO: Record<string, [number, number]> = {
				'ukraine': [48.5, 31.2], 'russia': [55.8, 37.6], 'china': [35.9, 104.2],
				'taiwan': [23.7, 121.0], 'iran': [32.4, 53.7], 'israel': [31.8, 35.2],
				'gaza': [31.5, 34.5], 'palestine': [31.9, 35.2], 'hamas': [31.5, 34.5],
				'trump': [38.9, -77.0], 'biden': [38.9, -77.0], 'us ': [38.9, -77.0],
				'united states': [38.9, -77.0], 'america': [38.9, -77.0], 'congress': [38.9, -77.0],
				'fed ': [38.9, -77.0], 'federal reserve': [38.9, -77.0],
				'nato': [50.8, 4.4], 'eu ': [50.8, 4.4], 'europe': [50.1, 14.4],
				'north korea': [39.0, 125.8], 'korea': [37.6, 127.0],
				'india': [20.6, 78.9], 'pakistan': [30.4, 69.3],
				'saudi': [24.7, 46.7], 'oil': [26.0, 50.0], 'opec': [26.0, 50.0],
				'bitcoin': [40.7, -74.0], 'crypto': [40.7, -74.0], 'btc': [40.7, -74.0],
				'syria': [35.0, 38.5], 'yemen': [15.6, 48.5], 'houthi': [15.6, 48.5],
				'uk': [51.5, -0.1], 'britain': [51.5, -0.1], 'france': [48.9, 2.3],
				'germany': [52.5, 13.4], 'japan': [35.7, 139.7], 'brazil': [-15.8, -47.9],
				'mexico': [19.4, -99.1], 'canada': [45.4, -75.7],
				'africa': [0.0, 25.0], 'sudan': [15.6, 32.5], 'ethiopia': [9.0, 38.7],
			};

			// Place top recommendations on map by keyword matching
			const topBets = recommendations.slice(0, 15);
			const usedPositions: Set<string> = new Set();

			for (const rec of topBets) {
				const q = rec.question.toLowerCase();
				let pos: [number, number] | null = null;
				for (const [kw, coords] of Object.entries(MARKET_GEO)) {
					if (q.includes(kw)) { pos = coords; break; }
				}
				if (!pos) continue;

				// Offset slightly to avoid overlap
				const posKey = `${pos[0].toFixed(0)},${pos[1].toFixed(0)}`;
				let offset = 0;
				while (usedPositions.has(`${posKey}-${offset}`)) offset++;
				usedPositions.add(`${posKey}-${offset}`);
				const lat = pos[0] + offset * 1.5;
				const lng = pos[1] + offset * 2;

				const dirColor = rec.direction === 'YES' ? '#10b981' : '#ef4444';
				const pricePct = Math.round(rec.current_price * 100);
				const confStr = rec.confidence.toFixed(0);
				const wallets = rec.wallet_count;
				const amount = rec.total_amount >= 1000000 ? `$${(rec.total_amount / 1000000).toFixed(1)}M` :
					rec.total_amount >= 1000 ? `$${(rec.total_amount / 1000).toFixed(0)}K` :
					`$${rec.total_amount.toFixed(0)}`;

				const icon = L.divIcon({
					className: '',
					html: `<div style="background:rgba(10,10,18,0.92);border:1px solid ${dirColor}55;border-radius:6px;padding:4px 7px;font-family:monospace;font-size:9px;white-space:nowrap;pointer-events:auto;min-width:100px;">
						<div style="color:${dirColor};font-weight:700;font-size:10px;margin-bottom:2px;">${rec.direction} ${pricePct}%</div>
						<div style="color:#aaa;line-height:1.3;max-width:180px;overflow:hidden;text-overflow:ellipsis;">${rec.question.slice(0, 60)}${rec.question.length > 60 ? '...' : ''}</div>
						<div style="color:#666;margin-top:2px;">${wallets}w · ${amount} · conf ${confStr}</div>
					</div>`,
					iconSize: [180, 50],
					iconAnchor: [90, 25],
				});

				L.marker([lat, lng], { icon }).addTo(mapInstance)
					.bindPopup(`<div style="max-width:280px;">
						<div style="font-weight:700;margin-bottom:4px;">${rec.question}</div>
						<div style="color:${dirColor};font-weight:600;">${rec.direction} @ ${pricePct}%</div>
						<div style="font-size:11px;color:#888;margin-top:4px;">
							Smart Money: ${wallets} wallets · ${amount}<br>
							Confidence: ${confStr} · Edge: ${(rec.edge * 100).toFixed(1)}%<br>
							Avg Win Rate: ${(rec.avg_win_rate * 100).toFixed(0)}%
						</div>
					</div>`);
			}
		}
	}

	// ── 3D Globe (globe.gl) ──────────────────────────────────────────────

	async function initGlobe() {
		if (!globeContainer || !warRoomState) return;

		// Dynamically import globe.gl
		const GlobeModule = await import('globe.gl');
		const Globe = GlobeModule.default;

		if (globeInstance) {
			try { globeInstance._destructor?.(); } catch {}
			globeInstance = null;
		}

		// Clear container
		globeContainer.innerHTML = '';

		const state = warRoomState;
		const width = globeContainer.clientWidth;
		const height = globeContainer.clientHeight;

		// Build actor color lookup (same logic as 2D)
		const actorFillColors: Record<string, string> = {};
		const actorColorData: Record<string, { colors: [number, number, number][]; weights: number[]; blocs: string[] }> = {};
		for (const bloc of state.blocs) {
			const rgb = BLOC_COLORS[bloc.id] || hexToRgb(bloc.color || '#555555');
			for (const actorId of Object.keys(bloc.members || {})) {
				if (!actorColorData[actorId]) actorColorData[actorId] = { colors: [], weights: [], blocs: [] };
				actorColorData[actorId].colors.push(rgb);
				actorColorData[actorId].weights.push(bloc.members[actorId] === 'leader' ? 1.5 : 1.0);
				actorColorData[actorId].blocs.push(bloc.name);
			}
		}
		for (const [actorId, data] of Object.entries(actorColorData)) {
			actorFillColors[actorId] = blendColors(data.colors, data.weights);
		}

		// Country name → actor ID reverse lookup
		const nameToColor: Record<string, string> = {};
		for (const [name, actorId] of Object.entries(COUNTRY_ACTOR)) {
			if (actorFillColors[actorId]) nameToColor[name] = actorFillColors[actorId];
		}

		// CII color lookup for globe
		function globeCiiColor(name: string): string | null {
			const aliases: Record<string, string> = {
				'United States of America': 'USA', 'United States': 'USA',
				'United Kingdom': 'UK', 'Republic of Korea': 'South Korea',
				'Dem. Rep. Korea': 'North Korea', 'Türkiye': 'Turkey',
			};
			const score = ciiData[name]?.cii_score ?? ciiData[aliases[name] || '']?.cii_score ?? null;
			if (score === null || score <= 5) return null;
			if (score >= 75) return `rgba(212, 48, 48, ${0.3 + (score - 75) * 0.025})`;
			if (score >= 55) return `rgba(200, 122, 32, ${0.25 + (score - 55) * 0.012})`;
			if (score >= 35) return `rgba(229, 184, 76, ${0.15 + (score - 35) * 0.005})`;
			if (score >= 15) return `rgba(58, 138, 90, ${0.10 + (score - 15) * 0.005})`;
			return `rgba(80, 80, 120, ${0.06 + score * 0.003})`;
		}

		// Load country polygons
		const countryGeoJson = await loadCountryGeoJson();

		// Prepare points data (WebGL-native — no HTML overlay to block mouse)
		const points: { lat: number; lng: number; color: string; radius: number; alt: number; label: string }[] = [];

		// Events
		if (layers.events) {
			for (const e of state.events.filter(e => e.lat && e.lng)) {
				points.push({
					lat: e.lat, lng: e.lng,
					color: e.impact_score >= 60 ? '#d43030' : e.impact_score >= 40 ? '#c87a20' : '#5a5a7a',
					radius: e.impact_score >= 60 ? 0.4 : 0.25,
					alt: 0.01,
					label: `${e.title}\nImpact: ${Math.round(e.impact_score)} · ${e.theater || ''}`,
				});
			}
		}

		// Actors
		for (const a of state.all_actors.filter(a => a.lat && a.lng && a.tier === 'major')) {
			points.push({
				lat: a.lat, lng: a.lng,
				color: actorFillColors[a.id] || '#E5B84C',
				radius: 0.5,
				alt: 0.015,
				label: a.name,
			});
		}

		// Military bases
		if (layers.bases) {
			for (const base of militaryBases.filter(b => b.lat && b.lng)) {
				points.push({
					lat: base.lat, lng: base.lng,
					color: '#64a0ff',
					radius: 0.3,
					alt: 0.008,
					label: `${base.name}\n${base.facility_type.replace(/_/g, ' ')} · ${base.operator}`,
				});
			}
		}

		// Infrastructure
		if (layers.infrastructure) {
			for (const inf of infrastructure.filter(i => i.lat && i.lng)) {
				points.push({
					lat: inf.lat, lng: inf.lng,
					color: inf.infra_type === 'submarine_cable' ? '#06b6d4' : '#a78bfa',
					radius: 0.2,
					alt: 0.005,
					label: `${inf.name}\n${inf.infra_type.replace(/_/g, ' ')} · ${inf.country}`,
				});
			}
		}

		// Live aircraft
		if (layers.aircraft) {
			for (const ac of aircraft.filter(a => a.lat && a.lng)) {
				const altKm = ac.altitude ? (ac.altitude / 1000).toFixed(1) : '?';
				points.push({
					lat: ac.lat, lng: ac.lng,
					color: '#fbbf24',
					radius: 0.35,
					alt: 0.02 + (ac.altitude || 0) / 500000, // higher altitude = higher on globe
					label: `${ac.callsign || ac.icao24}\n${ac.origin} · Alt: ${altKm}km`,
				});
			}
		}

		// Submarine cable arcs for 3D globe
		const arcsData: { startLat: number; startLng: number; endLat: number; endLng: number; color: string; label: string }[] = [];
		if (layers.infrastructure) {
			const cables: Record<string, Infrastructure[]> = {};
			for (const inf of infrastructure.filter(i => i.lat && i.lng && i.infra_type === 'submarine_cable')) {
				if (!cables[inf.name]) cables[inf.name] = [];
				cables[inf.name].push(inf);
			}
			for (const [name, landings] of Object.entries(cables)) {
				for (let i = 0; i < landings.length - 1; i++) {
					arcsData.push({
						startLat: landings[i].lat, startLng: landings[i].lng,
						endLat: landings[i + 1].lat, endLng: landings[i + 1].lng,
						color: 'rgba(6, 182, 212, 0.4)',
						label: name,
					});
				}
			}
		}

		const labels = state.all_actors
			.filter(a => a.lat && a.lng && a.tier === 'major')
			.map(a => ({ lat: a.lat, lng: a.lng, text: a.name, color: actorFillColors[a.id] || '#ccc' }));

		globeInstance = new Globe(globeContainer)
			.width(width)
			.height(height)
			.backgroundColor('#080810')
			.globeImageUrl('/assets/earth-night.jpg')
			.atmosphereColor('#334466')
			.atmosphereAltitude(0.2)
			.pointOfView({ lat: 30, lng: 20, altitude: 2.2 })
			// Country polygons
			.polygonsData(countryGeoJson?.features || [])
			.polygonCapColor((feat: any) => {
				const name = feat.properties?.name || '';
				if (mapColorMode === 'cii') {
					return globeCiiColor(name) || 'rgba(20, 20, 40, 0.2)';
				}
				return nameToColor[name] || 'rgba(20, 20, 40, 0.2)';
			})
			.polygonSideColor(() => 'rgba(20, 20, 40, 0.05)')
			.polygonStrokeColor(() => 'rgba(80, 80, 120, 0.3)')
			.polygonAltitude(0.006)
			.polygonLabel((feat: any) => {
				const name = feat.properties?.name || 'Unknown';
				const actorId = COUNTRY_ACTOR[name];
				const blocs = actorId && actorColorData[actorId] ? actorColorData[actorId].blocs.join(', ') : '';
				const aliases: Record<string, string> = {
					'United States of America': 'USA', 'United States': 'USA',
					'United Kingdom': 'UK', 'Republic of Korea': 'South Korea',
					'Dem. Rep. Korea': 'North Korea', 'Türkiye': 'Turkey',
				};
				const cScore = ciiData[name]?.cii_score ?? ciiData[aliases[name] || '']?.cii_score ?? null;
				if (mapColorMode === 'cii') {
					return `<div style="background:rgba(10,10,18,0.9);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:11px;border:1px solid rgba(100,100,140,0.3);">
						<div style="font-weight:700;color:#eee;">${name}</div>
						${cScore !== null && cScore > 5 ? `<div style="color:${cScore >= 70 ? '#d43030' : cScore >= 50 ? '#c87a20' : '#E5B84C'};font-size:10px;">CII: ${cScore.toFixed(1)}</div>` : ''}
					</div>`;
				}
				return `<div style="background:rgba(10,10,18,0.9);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:11px;border:1px solid rgba(100,100,140,0.3);">
					<div style="font-weight:700;color:#eee;">${name}</div>
					${blocs ? `<div style="color:#888;font-size:10px;">${blocs}</div>` : ''}
					${cScore !== null && cScore > 5 ? `<div style="color:#888;font-size:10px;">CII: ${cScore.toFixed(1)}</div>` : ''}
				</div>`;
			})
			.onPolygonClick((feat: any) => {
				const name = feat.properties?.name || 'Unknown';
				selectedCountry = buildCountryIntel(name);
			})
			// Points (WebGL — no overlay blocking mouse)
			.pointsData(points)
			.pointLat((d: any) => d.lat)
			.pointLng((d: any) => d.lng)
			.pointColor((d: any) => d.color)
			.pointRadius((d: any) => d.radius)
			.pointAltitude((d: any) => d.alt)
			.pointLabel((d: any) => `<div style="background:rgba(10,10,18,0.9);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:11px;border:1px solid rgba(100,100,140,0.3);white-space:pre-line;color:#eee;">${d.label}</div>`)
			// Labels (WebGL text sprites)
			.labelsData(labels)
			.labelLat((d: any) => d.lat)
			.labelLng((d: any) => d.lng)
			.labelText((d: any) => d.text)
			.labelColor((d: any) => d.color)
			.labelSize(0.6)
			.labelDotRadius(0.3)
			.labelAltitude(0.02)
			.labelResolution(3)
			// Submarine cable arcs
			.arcsData(arcsData)
			.arcStartLat((d: any) => d.startLat)
			.arcStartLng((d: any) => d.startLng)
			.arcEndLat((d: any) => d.endLat)
			.arcEndLng((d: any) => d.endLng)
			.arcColor((d: any) => d.color)
			.arcStroke(0.5)
			.arcDashLength(0.4)
			.arcDashGap(0.2)
			.arcDashAnimateTime(3000)
			.arcLabel((d: any) => `<div style="background:rgba(10,10,18,0.9);padding:4px 8px;border-radius:4px;font-family:monospace;font-size:10px;color:#06b6d4;border:1px solid rgba(6,182,212,0.3);">${d.label}</div>`);

		// Force pointer-events:none on any overlay divs globe.gl creates
		setTimeout(() => {
			if (!globeContainer) return;
			const children = globeContainer.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i] as HTMLElement;
				if (child.tagName !== 'CANVAS' && !child.querySelector('canvas')) {
					child.style.pointerEvents = 'none';
				}
			}
		}, 500);

		// Ensure globe controls work — enable orbit controls explicitly
		const controls = globeInstance.controls();
		controls.enableZoom = true;
		controls.enableRotate = true;
		controls.enablePan = true;
		controls.zoomSpeed = 1.0;
		controls.rotateSpeed = 0.8;

		// Prevent page scroll when mouse is over globe
		globeContainer.addEventListener('wheel', (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false });

		// Auto-rotate after idle
		let rotateTimeout: ReturnType<typeof setTimeout>;
		const startAutoRotate = () => {
			controls.autoRotate = true;
			controls.autoRotateSpeed = 0.3;
		};
		const stopAutoRotate = () => {
			controls.autoRotate = false;
			clearTimeout(rotateTimeout);
			rotateTimeout = setTimeout(startAutoRotate, 30000);
		};
		globeContainer.addEventListener('mousedown', stopAutoRotate);
		globeContainer.addEventListener('touchstart', stopAutoRotate);
		rotateTimeout = setTimeout(startAutoRotate, 10000);

		// Handle resize
		const ro = new ResizeObserver(() => {
			if (globeInstance && globeContainer) {
				globeInstance.width(globeContainer.clientWidth);
				globeInstance.height(globeContainer.clientHeight);
			}
		});
		ro.observe(globeContainer);
	}

	// Reactively init map/globe when data is loaded or mode changes
	$effect(() => {
		const mode = mapMode; // track reactively
		const state = warRoomState;
		const mC = mapContainer;
		const gC = globeContainer;
		if (state && browser) {
			if (mode === '2d' && mC) {
				setTimeout(() => initMap(), 150);
			} else if (mode === '3d' && gC) {
				// Longer delay for globe — DOM needs to be fully laid out
				setTimeout(() => initGlobe(), 300);
			}
		}
	});

	// ── Helpers ──────────────────────────────────────────────────────────

	function severityColor(severity: string): string {
		switch (severity) {
			case 'critical': return 'text-red-400 bg-red-500/15 border-red-500/30';
			case 'high': return 'text-orange-400 bg-orange-500/15 border-orange-500/30';
			case 'medium': return 'text-yellow-400 bg-yellow-500/15 border-yellow-500/30';
			default: return 'text-blue-400 bg-blue-500/15 border-blue-500/30';
		}
	}

	function signalIcon(type: string): string {
		switch (type) {
			case 'smart_convergence': return 'C';
			case 'whale_entry': return 'W';
			case 'stealth_whale': return 'S';
			case 'smart_accumulation': return 'A';
			case 'volume_spike': return 'V';
			case 'insider_pattern': return 'I';
			case 'pre_resolution_trade': return 'P';
			case 'cluster_movement': return 'K';
			default: return '?';
		}
	}

	function signalLabel(type: string): string {
		return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	function fmtUsd(v: number): string {
		if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
		if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
		return `$${v.toFixed(0)}`;
	}

	function fmtPct(v: number): string {
		if (v > 1) return `${v.toFixed(0)}%`;
		return `${(v * 100).toFixed(0)}%`;
	}

	function fmtAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '';
		return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
	}

	function timeAgo(iso: string): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 60_000) return 'now';
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
		return `${Math.floor(ms / 86_400_000)}d`;
	}

	function directionBadge(dir: string): string {
		return dir === 'YES'
			? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
			: 'bg-red-500/20 text-red-400 border-red-500/30';
	}

	function confidenceBar(conf: number, max = 100): number {
		return Math.min(100, (conf / max) * 100);
	}

	function tierColor(tier: string): string {
		switch (tier) {
			case 'extreme': return 'text-red-400 bg-red-500/15';
			case 'high': return 'text-orange-400 bg-orange-500/15';
			case 'moderate': return 'text-yellow-400 bg-yellow-500/15';
			default: return 'text-zinc-400 bg-zinc-500/15';
		}
	}

	function renderMarkdown(md: string): string {
		// Simple markdown to HTML — handles headers, bold, italic, lists, tables, code, hr, blockquotes, links
		let html = md
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			// Code blocks
			.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
			// Inline code
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			// Headers
			.replace(/^### (.+)$/gm, '<h3>$1</h3>')
			.replace(/^## (.+)$/gm, '<h2>$1</h2>')
			.replace(/^# (.+)$/gm, '<h1>$1</h1>')
			// HR
			.replace(/^---+$/gm, '<hr />')
			// Bold + italic
			.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>')
			// Links
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
			// Blockquotes
			.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
			// List items
			.replace(/^- (.+)$/gm, '<li>$1</li>')
			.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
			// Tables
			.replace(/^\|(.+)\|$/gm, (_, row) => {
				const cells = row.split('|').map((c: string) => c.trim());
				if (cells.every((c: string) => /^[-:]+$/.test(c))) return '';
				const tag = 'td';
				return '<tr>' + cells.map((c: string) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
			});
		// Wrap consecutive <li> in <ul>
		html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
		// Wrap consecutive <tr> in <table>
		html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');
		// Paragraphs — wrap remaining loose lines
		html = html.replace(/^(?!<[hupoltbr]|$)(.+)$/gm, '<p>$1</p>');
		// Clean up empty lines
		html = html.replace(/\n{2,}/g, '\n');
		return html;
	}

	// Top-level stats
	const criticalCount = $derived(signals.filter(s => s.severity === 'critical').length);
	const highCount = $derived(signals.filter(s => s.severity === 'high').length);
	const totalVolume = $derived(recommendations.reduce((sum, r) => sum + (r.total_amount || 0), 0));
	const topConfidence = $derived(recommendations.length > 0 ? Math.max(...recommendations.map(r => r.confidence)) : 0);

	// Intelligence summary — top 3 highest-confidence recommendations + top critical signals
	const topRecs = $derived(
		[...recommendations].sort((a, b) => b.confidence - a.confidence).slice(0, 3)
	);
	const criticalSignals = $derived(
		signals.filter(s => s.severity === 'critical' || s.severity === 'high').slice(0, 3)
	);
	const convergenceSignals = $derived(
		signals.filter(s => s.signal_type === 'smart_convergence').length
	);

	const SOURCE_COLORS: Record<string, string> = {
		rss: '#64a0ff', acled: '#d43030', gdelt: '#c87a20', telegram: '#06b6d4',
		oref: '#ef4444', ais: '#06b6d4', gpsjam: '#c87a20', finnhub: '#10b981',
		usni: '#64a0ff', polymarket: '#a78bfa', firms: '#fbbf24', adsb: '#fbbf24',
		usgs: '#8b5cf6', gdacs: '#8b5cf6', cloudflare: '#3b82f6', convergence: '#E5B84C',
	};
</script>

<svelte:head>
	<title>Intel | Mycelium</title>
</svelte:head>

<style>
	:global(.leaflet-popup-content-wrapper) {
		background: rgba(20, 20, 28, 0.95) !important;
		border: 1px solid rgba(255, 255, 255, 0.1) !important;
		border-radius: 6px !important;
		color: #e8e8e8 !important;
		font-family: system-ui, sans-serif !important;
		font-size: 12px !important;
		backdrop-filter: blur(20px);
	}
	:global(.leaflet-popup-tip) {
		background: rgba(20, 20, 28, 0.95) !important;
	}
	:global(.leaflet-control-zoom a) {
		background: rgba(20, 20, 28, 0.9) !important;
		color: #888 !important;
		border-color: rgba(255, 255, 255, 0.1) !important;
	}
	:global(.leaflet-control-zoom a:hover) {
		background: rgba(30, 30, 40, 0.95) !important;
		color: #ccc !important;
	}
	@keyframes -global-pulse {
		0%, 100% { opacity: 0.8; transform: scale(1); }
		50% { opacity: 1; transform: scale(1.15); }
	}
	:global(.cii-tooltip) {
		background: rgba(20, 20, 28, 0.95) !important;
		border: 1px solid rgba(229, 184, 76, 0.3) !important;
		border-radius: 6px !important;
		color: #e8e8e8 !important;
		font-size: 11px !important;
		padding: 4px 8px !important;
		box-shadow: none !important;
	}
	:global(.cii-tooltip::before) {
		border-top-color: rgba(229, 184, 76, 0.3) !important;
	}
	/* Suppress Leaflet's default tap/click highlight rectangle */
	:global(.leaflet-interactive) {
		outline: none !important;
		-webkit-tap-highlight-color: transparent !important;
	}
	:global(.leaflet-container) {
		-webkit-tap-highlight-color: transparent !important;
	}
	:global(.leaflet-overlay-pane svg path) {
		outline: none !important;
	}
</style>

<div class="h-full overflow-y-auto">
	<div class="max-w-[1600px] mx-auto p-6 space-y-6">

		<!-- ═══ Header: War Room Title ═══ -->
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-text-primary)] tracking-tight flex items-center gap-3">
					<span class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-red-400 text-sm font-bold">W</span>
					War Room
				</h1>
				<p class="text-sm text-[var(--color-text-tertiary)] mt-1">Geopolitical intelligence &middot; OSINT feeds &middot; Prediction markets &middot; CII heatmap</p>
			</div>
			<div class="flex items-center gap-3">
				<!-- Search -->
				<div class="relative">
					<input
						type="text"
						bind:value={searchQuery}
						oninput={onSearchInput}
						placeholder="Search markets..."
						class="w-64 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
					{#if searchResults.length > 0}
						<div class="absolute top-full mt-1 w-96 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
							{#each searchResults as m}
								<button
									onclick={() => { openMarket(m.condition_id); searchResults = []; searchQuery = ''; }}
									class="w-full text-left px-4 py-3 hover:bg-[var(--color-surface)] border-b border-[var(--color-border)] last:border-0"
								>
									<p class="text-sm text-[var(--color-text-primary)] line-clamp-2">{m.question}</p>
									<div class="flex items-center gap-2 mt-1">
										<span class="text-xs px-1.5 py-0.5 rounded {m.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400'}">
											{m.active ? 'Active' : 'Resolved'}
										</span>
										<span class="text-xs text-[var(--color-text-tertiary)]">{fmtPct(m.price_yes)} YES</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<button
					onclick={loadData}
					class="px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] transition-colors"
				>
					Refresh
				</button>
			</div>
		</div>

		<!-- ═══ OREF Alert Banner ═══ -->
		{#if orefAlerts.length > 0}
			<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-start gap-3 animate-pulse">
				<div class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-red-400 font-bold text-sm flex-shrink-0">!</div>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 mb-1">
						<span class="text-xs font-mono font-bold text-red-400 uppercase tracking-wider">Active Alerts — OREF</span>
						<span class="text-xs text-red-400/60">{orefAlerts.length} alert{orefAlerts.length > 1 ? 's' : ''} in 24h</span>
					</div>
					<div class="space-y-1">
						{#each orefAlerts.slice(0, 3) as alert}
							<div class="text-sm text-red-300">{alert.title} <span class="text-xs text-red-400/50">{timeAgo(alert.published_at)}</span></div>
						{/each}
						{#if orefAlerts.length > 3}
							<div class="text-xs text-red-400/60">+{orefAlerts.length - 3} more</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- ═══ Trending Keywords Banner ═══ -->
		{#if trendingSpikes.length > 0}
			<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4">
				<div class="flex items-center gap-2 mb-3">
					<div class="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse"></div>
					<span class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Trending</span>
					<span class="text-xs text-[var(--color-text-tertiary)]">{trendingSpikes.length} spike{trendingSpikes.length > 1 ? 's' : ''} detected</span>
				</div>
				<div class="flex flex-wrap gap-2">
					{#each trendingSpikes.slice(0, 12) as spike}
						{@const intensity = Math.min(1, spike.surge_ratio / 30)}
						<div class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors"
							style="background: rgba(229, 184, 76, {0.05 + intensity * 0.15}); border-color: rgba(229, 184, 76, {0.15 + intensity * 0.25});"
							title="{spike.current_count} mentions ({spike.surge_ratio.toFixed(1)}x baseline), {spike.source_count} sources">
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{spike.keyword}</span>
							<span class="text-xs text-[var(--color-accent)]">{spike.surge_ratio.toFixed(0)}x</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- ═══ Probability-Weighted Geo Markets ═══ -->
		{#if geoMarkets.length > 0}
			<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5">
				<div class="flex items-center gap-2 mb-4">
					<div class="w-2 h-2 rounded-full bg-emerald-400"></div>
					<h2 class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Prediction Market Intelligence</h2>
					<span class="text-xs text-[var(--color-text-tertiary)]">{geoMarkets.length} geopolitical markets, probability-weighted</span>
				</div>
				<div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
					{#each geoMarkets.slice(0, expandMarkets ? 30 : 9) as mkt}
						{@const dirColor = mkt.direction === 'YES' ? '#10b981' : '#ef4444'}
						{@const marketProb = mkt.direction === 'YES' ? mkt.current_price : 1 - mkt.current_price}
						{@const adjustedProb = Math.min(1, marketProb + mkt.edge)}
						{@const marketPct = Math.round(marketProb * 100)}
						{@const adjustedPct = Math.round(adjustedProb * 100)}
						<div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg p-3">
							<div class="flex items-center gap-2 mb-1.5">
								<span class="text-xs font-bold px-1.5 py-0.5 rounded border"
									style="color: {dirColor}; border-color: {dirColor}33; background: {dirColor}15;">
									{mkt.direction} {marketPct}%
								</span>
								<span class="text-[10px] text-[var(--color-text-tertiary)] ml-auto font-mono">ws:{mkt.weighted_signal.toFixed(0)}</span>
							</div>
							<p class="text-xs text-[var(--color-text-primary)] line-clamp-2 mb-2">{mkt.question}</p>
							<!-- Dual probability bars: Market vs Smart Money adjusted -->
							<div class="space-y-1 mb-1.5">
								<div class="flex items-center gap-2">
									<span class="text-[10px] text-[var(--color-text-tertiary)] w-12">Market</span>
									<div class="flex-1 bg-[var(--color-border)] rounded-full h-1.5">
										<div class="h-1.5 rounded-full transition-all" style="width: {marketPct}%; background: rgba(150,150,170,0.5);"></div>
									</div>
									<span class="text-[10px] font-mono text-[var(--color-text-secondary)] w-8 text-right">{marketPct}%</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-[10px] text-[var(--color-text-tertiary)] w-12">Smart $</span>
									<div class="flex-1 bg-[var(--color-border)] rounded-full h-1.5">
										<div class="h-1.5 rounded-full transition-all" style="width: {adjustedPct}%; background: {dirColor};"></div>
									</div>
									<span class="text-[10px] font-mono font-semibold w-8 text-right" style="color: {dirColor};">{adjustedPct}%</span>
								</div>
							</div>
							<div class="flex items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
								<span>{mkt.wallet_count}w</span>
								<span>{mkt.total_amount >= 1e6 ? `$${(mkt.total_amount/1e6).toFixed(1)}M` : mkt.total_amount >= 1e3 ? `$${(mkt.total_amount/1e3).toFixed(0)}K` : `$${mkt.total_amount.toFixed(0)}`}</span>
								<span>conf:{mkt.confidence.toFixed(0)}</span>
								<span>edge:{(mkt.edge * 100).toFixed(0)}%</span>
								{#if mkt.countries.length > 0}
									<span class="ml-auto text-[var(--color-accent)]">{mkt.countries.slice(0, 2).join(', ')}</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if geoMarkets.length > 9}
					<button onclick={() => expandMarkets = !expandMarkets}
						class="w-full text-center text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] py-2 mt-2 transition-colors">
						{expandMarkets ? 'Show less' : `Show all ${geoMarkets.length} markets`}
					</button>
				{/if}
			</div>
		{/if}

		{#if loading && !situationReport && recommendations.length === 0 && signals.length === 0}
			<div class="flex items-center justify-center py-20">
				<div class="flex items-center gap-3 text-[var(--color-text-tertiary)]">
					<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					<span>Loading intelligence data...</span>
				</div>
			</div>
		{:else if error}
			<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center">
				<p class="text-red-400">{error}</p>
				<p class="text-sm text-[var(--color-text-tertiary)] mt-2">Ensure the Polymarket Intelligence service is running and configured.</p>
			</div>
		{:else}

		<!-- ═══ Strategic Map (always visible) ═══ -->
		<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden relative" style="height: 65vh; min-height: 450px;">
			{#if warRoomState}
				<!-- Map controls: 2D/3D + Color mode -->
				<div class="absolute top-4 right-4 z-[600] flex flex-col gap-2 items-end">
					<div class="flex bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-lg overflow-hidden">
						<button
							onclick={() => { mapMode = '2d'; if (globeInstance) { try { globeInstance._destructor?.(); } catch {} globeInstance = null; } }}
							class="px-3 py-1.5 text-xs font-mono font-semibold transition-colors {mapMode === '2d' ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
						>2D</button>
						<button
							onclick={() => { mapMode = '3d'; if (mapInstance) { mapInstance.remove(); mapInstance = null; } }}
							class="px-3 py-1.5 text-xs font-mono font-semibold transition-colors {mapMode === '3d' ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
						>3D</button>
					</div>
					<!-- Alliance / CII toggle -->
					<div class="flex bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-lg overflow-hidden">
						<button
							onclick={() => { mapColorMode = 'alliances'; if (mapMode === '2d') setTimeout(() => initMap(), 50); else setTimeout(() => initGlobe(), 50); }}
							class="px-3 py-1.5 text-xs font-mono font-semibold transition-colors {mapColorMode === 'alliances' ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
						>Alliances</button>
						<button
							onclick={() => { mapColorMode = 'cii'; if (mapMode === '2d') setTimeout(() => initMap(), 50); else setTimeout(() => initGlobe(), 50); }}
							class="px-3 py-1.5 text-xs font-mono font-semibold transition-colors {mapColorMode === 'cii' ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
						>CII</button>
					</div>
				</div>

				<!-- Layer toggles -->
				<div class="absolute top-24 right-4 z-[600] bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-lg p-2 text-xs font-mono space-y-1">
					{#each [
						{ key: 'bases', label: 'Bases', color: '#64a0ff', count: militaryBases.length },
						{ key: 'infrastructure', label: 'Infra', color: '#a78bfa', count: infrastructure.length },
						{ key: 'events', label: 'Events', color: '#d43030', count: warRoomState?.events.filter(e => e.lat && e.lng).length || 0 },
						{ key: 'aircraft', label: 'Aircraft', color: '#fbbf24', count: aircraft.length },
						{ key: 'vessels', label: 'AIS', color: '#06b6d4', count: aisVessels.length },
						{ key: 'gpsjam', label: 'GPS Jam', color: '#c87a20', count: gpsJamEvents.length },
						{ key: 'markets', label: 'Markets', color: '#10b981', count: recommendations.length },
					] as item}
						<label class="flex items-center gap-2 cursor-pointer text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">
							<input type="checkbox" bind:checked={layers[item.key as keyof typeof layers]}
								onchange={() => { if (mapMode === '2d') setTimeout(() => initMap(), 50); else setTimeout(() => initGlobe(), 50); }}
								class="sr-only peer" />
							<div class="w-3 h-3 rounded-sm border peer-checked:border-transparent transition-colors"
								style="border-color: {item.color}40; background: {layers[item.key as keyof typeof layers] ? item.color + '40' : 'transparent'};">
							</div>
							<span>{item.label}</span>
							{#if item.count > 0}
								<span class="text-[10px] opacity-60">{item.count}</span>
							{/if}
						</label>
					{/each}
				</div>

				{#if mapMode === '2d'}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div bind:this={mapContainer} class="w-full h-full" style="background: #080810;"></div>
				{:else}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div bind:this={globeContainer} class="w-full h-full" style="background: #080810; cursor: grab; touch-action: none;"></div>
				{/if}

				<!-- Map Legend (2D only) -->
				{#if mapMode === '2d'}
				<div class="absolute bottom-4 right-4 z-[500] bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-lg p-3 text-xs font-mono max-h-[calc(65vh-40px)] overflow-y-auto">
					{#if mapColorMode === 'alliances'}
						<div class="text-[var(--color-text-secondary)] font-semibold mb-2">ALLIANCE BLOCS</div>
						{#each [
							['rgba(51,136,255,0.5)', 'NATO'],
							['rgba(102,153,255,0.5)', 'EU'],
							['rgba(170,85,255,0.5)', 'Five Eyes'],
							['rgba(119,68,204,0.5)', 'AUKUS'],
							['rgba(255,153,51,0.5)', 'BRICS+'],
							['rgba(0,204,136,0.5)', 'Quad'],
							['rgba(221,170,51,0.5)', 'GCC'],
							['rgba(51,170,85,0.5)', 'OPEC+'],
							['rgba(204,51,51,0.5)', 'Axis of Resistance'],
							['rgba(255,85,102,0.5)', 'Anti-Iran Coalition'],
							['rgba(51,204,221,0.5)', 'ASEAN'],
							['rgba(238,119,68,0.5)', 'SCO'],
							['rgba(187,136,85,0.5)', 'Sahel Alliance'],
						] as [color, label]}
							<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
								<div class="w-4 h-3 rounded-sm flex-shrink-0" style="background:{color};"></div> {label}
							</div>
						{/each}
					{:else}
						<div class="text-[var(--color-text-secondary)] font-semibold mb-2">INSTABILITY INDEX</div>
						{#each [
							['rgba(212,48,48,0.6)', '75+ Critical'],
							['rgba(200,122,32,0.5)', '55–74 High'],
							['rgba(229,184,76,0.35)', '35–54 Moderate'],
							['rgba(58,138,90,0.25)', '15–34 Low'],
							['rgba(80,80,120,0.15)', '0–14 Minimal'],
						] as [color, label]}
							<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
								<div class="w-4 h-3 rounded-sm flex-shrink-0" style="background:{color};"></div> {label}
							</div>
						{/each}
					{/if}
					<div class="text-[var(--color-text-secondary)] font-semibold mt-3 mb-2">LAYERS</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div class="w-4 h-3 rounded-sm" style="background:rgba(100,160,255,0.3);border:1px solid rgba(100,160,255,0.6);"></div> Military base
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div class="w-4 h-3 rounded-sm" style="background:rgba(6,182,212,0.3);border:1px dashed rgba(6,182,212,0.6);"></div> Submarine cable
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div class="w-4 h-3 rounded-sm" style="background:rgba(167,139,250,0.3);border:1px solid rgba(167,139,250,0.5);"></div> Infrastructure
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div style="color:#fbbf24;font-size:11px;">✈</div> Live aircraft
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div class="w-2.5 h-2.5 rounded-full bg-[#d43030]"></div> High-impact event
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div class="w-4 h-3 rounded-sm" style="background:rgba(16,185,129,0.3);border:1px solid rgba(16,185,129,0.4);"></div> Smart money bet
					</div>
					<div class="flex items-center gap-2 mb-1 text-[var(--color-text-tertiary)]">
						<div style="color:#06b6d4;font-size:11px;">⚓</div> AIS vessel
					</div>
					<div class="flex items-center gap-2 text-[var(--color-text-tertiary)]">
						<div class="w-4 h-3 rounded-sm" style="background:rgba(200,122,32,0.15);border:1px dashed rgba(200,122,32,0.5);"></div> GPS jamming
					</div>
				</div>
				{/if}

				<!-- Sidebar: Theaters + Threads (2D only) -->
				{#if mapMode === '2d' && (warRoomState.theaters.length > 0 || warRoomState.threads.length > 0)}
					<div class="absolute top-4 left-4 z-[500] w-72 bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-lg overflow-hidden max-h-[calc(65vh-80px)] flex flex-col">
						<div class="px-3 py-2 border-b border-[var(--color-border)] text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
							Theaters
						</div>
						<div class="overflow-y-auto flex-1">
							{#each warRoomState.theaters as t}
								<div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] text-sm">
									<div class="w-2 h-2 rounded-full" style="background: {statusColor(t.status)}; box-shadow: 0 0 6px {statusColor(t.status)};"></div>
									<span class="text-[var(--color-text-primary)] flex-1">{t.name}</span>
									<span class="text-xs text-[var(--color-text-tertiary)]">{t.events_24h || 0}</span>
								</div>
							{/each}
							{#if warRoomState.threads.length > 0}
								<div class="px-3 py-2 border-b border-[var(--color-border)] text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mt-1">
									Active Threads
								</div>
								{#each warRoomState.threads.slice(0, 8) as thread}
									<div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] text-sm">
										<span class="text-xs px-1.5 py-0.5 rounded font-mono
											{thread.status === 'escalating' ? 'bg-red-500/15 text-red-400' :
											 thread.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' :
											 'bg-yellow-500/15 text-yellow-400'}">
											{thread.status}
										</span>
										<span class="text-[var(--color-text-secondary)] flex-1 text-xs truncate">{thread.title}</span>
									</div>
								{/each}
							{/if}
						</div>
					</div>
				{/if}

				<!-- Country Intel Panel -->
				{#if selectedCountry}
					<div class="absolute top-0 right-0 z-[700] w-96 h-full bg-[var(--color-surface)]/95 backdrop-blur-md border-l border-[var(--color-border)] overflow-y-auto">
						<div class="sticky top-0 bg-[var(--color-surface)]/95 backdrop-blur-md border-b border-[var(--color-border)] px-4 py-3 flex items-center justify-between z-10">
							<h3 class="text-base font-bold text-[var(--color-text-primary)]">{selectedCountry.name}</h3>
							<button onclick={() => { selectedCountry = null; }} class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-lg px-2">&times;</button>
						</div>

						<div class="p-4 space-y-4 text-sm">
							<!-- Actor info + blocs -->
							{#if selectedCountry.actor}
								<div class="flex items-center gap-2">
									<span class="text-xs px-2 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] font-mono">{selectedCountry.actor.tier}</span>
									<span class="text-xs text-[var(--color-text-tertiary)]">{selectedCountry.actor.actor_type}</span>
								</div>
							{/if}
							{#if selectedCountry.blocs.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Alliances</div>
									<div class="flex flex-wrap gap-1">
										{#each selectedCountry.blocs as bloc}
											<span class="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20">{bloc}</span>
										{/each}
									</div>
								</div>
							{/if}

							{#if selectedCountry.allies.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Allies</div>
									<div class="flex flex-wrap gap-1">
										{#each selectedCountry.allies.slice(0, 10) as ally}
											<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{ally.name}</span>
										{/each}
									</div>
								</div>
							{/if}

							{#if selectedCountry.rivalries.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Rivalries</div>
									<div class="flex flex-wrap gap-1">
										{#each selectedCountry.rivalries as rival}
											<span class="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">{rival}</span>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Smart Money Bets -->
							{#if selectedCountry.bets.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Smart Money Bets</div>
									<div class="space-y-2">
										{#each selectedCountry.bets.slice(0, 6) as bet}
											<div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg p-3">
												<div class="flex items-center gap-2 mb-1">
													<span class="text-xs font-bold px-1.5 py-0.5 rounded border {directionBadge(bet.direction)}">{bet.direction} {Math.round(bet.current_price * 100)}%</span>
													<span class="text-xs text-[var(--color-text-tertiary)]">conf {bet.confidence.toFixed(0)}</span>
												</div>
												<p class="text-xs text-[var(--color-text-secondary)] line-clamp-2">{bet.question}</p>
												<div class="flex items-center gap-3 mt-1.5 text-[10px] text-[var(--color-text-tertiary)]">
													<span>{bet.wallet_count} wallets</span>
													<span>{fmtUsd(bet.total_amount)}</span>
													<span>WR {fmtPct(bet.avg_win_rate)}</span>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Trade Signals -->
							{#if selectedCountry.topSignals.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Trade Signals <span class="text-[var(--color-text-tertiary)]">({selectedCountry.topSignals.length})</span></div>
									<div class="space-y-2">
										{#each selectedCountry.topSignals as sig}
											<div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg p-3">
												<div class="flex items-center gap-2 mb-1">
													<span class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold border flex-shrink-0 {severityColor(sig.severity)}">{signalIcon(sig.signal_type)}</span>
													<span class="text-xs font-semibold text-[var(--color-text-primary)]">{sig.signal_type.replace(/_/g, ' ')}</span>
													<span class="text-[10px] text-[var(--color-text-tertiary)] ml-auto">{timeAgo(sig.timestamp)}</span>
												</div>
												<p class="text-xs text-[var(--color-text-secondary)] line-clamp-2">{sig.summary}</p>
												<div class="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--color-text-tertiary)]">
													<span class="px-1.5 py-0.5 rounded border {severityColor(sig.severity)}">{sig.severity}</span>
													<span>{Math.round(sig.current_price * 100)}¢</span>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Military Bases -->
							{#if selectedCountry.bases.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Military Bases <span class="text-[var(--color-text-tertiary)]">({selectedCountry.bases.length})</span></div>
									<div class="space-y-1">
										{#each selectedCountry.bases as base}
											<div class="flex items-center gap-2 text-xs py-1 border-b border-[var(--color-border)]">
												<span class="text-[#64a0ff]">{base.facility_type === 'air_base' ? '✈' : base.facility_type === 'naval_base' ? '⚓' : base.facility_type === 'missile_site' ? '◆' : base.facility_type === 'nuclear_facility' ? '☢' : '★'}</span>
												<div class="flex-1 min-w-0">
													<span class="text-[var(--color-text-primary)] truncate block">{base.name}</span>
													<span class="text-[var(--color-text-tertiary)]">{base.operator}</span>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Infrastructure -->
							{#if selectedCountry.infra.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Infrastructure <span class="text-[var(--color-text-tertiary)]">({selectedCountry.infra.length})</span></div>
									<div class="space-y-1">
										{#each selectedCountry.infra as inf}
											<div class="flex items-center gap-2 text-xs py-1 border-b border-[var(--color-border)]">
												<span class="text-[#a78bfa]">{inf.infra_type === 'submarine_cable' ? '~' : '◇'}</span>
												<div class="flex-1 min-w-0">
													<span class="text-[var(--color-text-primary)] truncate block">{inf.name}</span>
													<span class="text-[var(--color-text-tertiary)]">{inf.infra_type.replace(/_/g, ' ')}</span>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Recent Events -->
							{#if selectedCountry.events.length > 0}
								<div>
									<div class="text-xs font-mono font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Recent Events</div>
									<div class="space-y-1">
										{#each selectedCountry.events as evt}
											<div class="text-xs py-1.5 border-b border-[var(--color-border)]">
												<div class="flex items-center gap-2 mb-0.5">
													<div class="w-2 h-2 rounded-full flex-shrink-0" style="background: {evt.impact_score >= 60 ? '#d43030' : evt.impact_score >= 40 ? '#c87a20' : '#5a5a7a'};"></div>
													<span class="text-[var(--color-text-tertiary)]">{evt.impact_score.toFixed(0)}</span>
													<span class="text-[var(--color-text-tertiary)]">{timeAgo(evt.published_at)}</span>
												</div>
												<p class="text-[var(--color-text-secondary)] line-clamp-2">{evt.title}</p>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Empty state -->
							{#if selectedCountry.bets.length === 0 && selectedCountry.bases.length === 0 && selectedCountry.events.length === 0 && selectedCountry.blocs.length === 0}
								<div class="text-center py-6 text-[var(--color-text-tertiary)]">
									<p class="text-sm">No intelligence data available for {selectedCountry.name}</p>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Bottom stats bar -->
				<div class="absolute bottom-0 left-0 right-0 h-8 bg-[var(--color-surface)]/80 backdrop-blur-sm border-t border-[var(--color-border)] flex items-center px-4 gap-4 text-xs font-mono text-[var(--color-text-tertiary)] z-[500] pointer-events-none overflow-x-auto">
					<span>THEATERS: <strong class="text-[var(--color-text-secondary)]">{warRoomState.theaters.length}</strong></span>
					<span>ACTORS: <strong class="text-[var(--color-text-secondary)]">{warRoomState.all_actors.length}</strong></span>
					<span>EVENTS: <strong class="text-[var(--color-text-secondary)]">{warRoomState.events.length}</strong></span>
					<span>BASES: <strong class="text-[#64a0ff]">{militaryBases.length}</strong></span>
					<span>INFRA: <strong class="text-[#a78bfa]">{infrastructure.length}</strong></span>
					<span>AIRCRAFT: <strong class="text-[#fbbf24]">{aircraft.length}</strong></span>
					{#if aisVessels.length > 0}<span>AIS: <strong class="text-[#06b6d4]">{aisVessels.length}</strong></span>{/if}
					{#if gpsJamEvents.length > 0}<span>GPS JAM: <strong class="text-[#c87a20]">{gpsJamEvents.length}</strong></span>{/if}
					{#if Object.keys(ciiData).length > 0}<span>CII: <strong class="text-[#E5B84C]">{Object.keys(ciiData).length} countries</strong></span>{/if}
				</div>
			{:else}
				<div class="flex items-center justify-center h-full">
					<div class="text-center">
						<div class="w-12 h-12 rounded-xl bg-[var(--color-elevated)] flex items-center justify-center mx-auto mb-4">
							<span class="text-2xl text-[var(--color-text-tertiary)]">M</span>
						</div>
						<h3 class="text-[var(--color-text-primary)] font-medium mb-2">Strategic Map Loading...</h3>
						<p class="text-sm text-[var(--color-text-tertiary)]">Connecting to war room dashboard...</p>
					</div>
				</div>
			{/if}
		</div>



		<!-- ═══ Situation Report ═══ -->
			<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6">
				{#if situationReport}
					{#if reportLastUpdated}
						<div class="flex items-center justify-between mb-4 pb-4 border-b border-[var(--color-border)]">
							<div class="flex items-center gap-2">
								<div class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
								<span class="text-xs text-[var(--color-text-tertiary)]">Last updated {timeAgo(reportLastUpdated)} ago</span>
							</div>
							<span class="text-xs text-[var(--color-text-tertiary)] font-mono">{new Date(reportLastUpdated).toLocaleString()}</span>
						</div>
					{/if}
					<div class="prose prose-invert prose-sm max-w-none
						prose-headings:text-[var(--color-text-primary)] prose-headings:font-bold
						prose-h1:text-xl prose-h1:mb-4 prose-h1:mt-6 prose-h1:border-b prose-h1:border-[var(--color-border)] prose-h1:pb-2
						prose-h2:text-lg prose-h2:mb-3 prose-h2:mt-5 prose-h2:text-[var(--color-accent)]
						prose-h3:text-base prose-h3:mb-2 prose-h3:mt-4
						prose-p:text-[var(--color-text-secondary)] prose-p:leading-relaxed
						prose-strong:text-[var(--color-text-primary)]
						prose-li:text-[var(--color-text-secondary)]
						prose-a:text-[var(--color-accent)] prose-a:no-underline hover:prose-a:underline
						prose-code:text-[var(--color-accent)] prose-code:bg-[var(--color-elevated)] prose-code:px-1 prose-code:rounded
						prose-table:border-collapse prose-th:border prose-th:border-[var(--color-border)] prose-th:px-3 prose-th:py-2 prose-th:bg-[var(--color-elevated)] prose-th:text-[var(--color-text-primary)]
						prose-td:border prose-td:border-[var(--color-border)] prose-td:px-3 prose-td:py-2 prose-td:text-[var(--color-text-secondary)]
						prose-hr:border-[var(--color-border)]
						prose-blockquote:border-l-[var(--color-accent)] prose-blockquote:text-[var(--color-text-tertiary)]">
						{@html renderMarkdown(situationReport)}
					</div>
				{:else}
					<div class="text-center py-16">
						<div class="w-12 h-12 rounded-xl bg-[var(--color-elevated)] flex items-center justify-center mx-auto mb-4">
							<span class="text-2xl text-[var(--color-text-tertiary)]">W</span>
						</div>
						<h3 class="text-[var(--color-text-primary)] font-medium mb-2">No Situation Report Yet</h3>
						<p class="text-sm text-[var(--color-text-tertiary)] max-w-md mx-auto">
							{reportMessage || 'Apollo will generate the first situation report on the next intelligence cycle. Reports are updated every 4 hours with the latest prediction market intelligence.'}
						</p>
					</div>
				{/if}
			</div>

		{/if} <!-- end loading/error guard -->

		<!-- ═══ Market Detail Modal ═══ -->
		{#if selectedMarket}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6"
				onclick={() => selectedMarket = null}
				role="dialog"
			>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6"
					onclick={(e) => e.stopPropagation()}
				>
					<div class="flex items-start justify-between mb-4">
						<div>
							<h2 class="text-lg font-bold text-[var(--color-text-primary)]">{selectedMarket.question}</h2>
							<div class="flex items-center gap-3 mt-2 text-sm">
								<span class="px-2 py-0.5 rounded-full border {selectedMarket.active ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}">
									{selectedMarket.active ? 'Active' : 'Resolved'}
								</span>
								<span class="text-[var(--color-text-secondary)]">YES: <strong class="text-emerald-400">{fmtPct(selectedMarket.price_yes)}</strong></span>
								<span class="text-[var(--color-text-secondary)]">NO: <strong class="text-red-400">{fmtPct(selectedMarket.price_no)}</strong></span>
								{#if selectedMarket.end_date}
									<span class="text-[var(--color-text-tertiary)]">Ends {new Date(selectedMarket.end_date).toLocaleDateString()}</span>
								{/if}
							</div>
						</div>
						<button onclick={() => selectedMarket = null} class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-lg">&times;</button>
					</div>

					<!-- Signals -->
					{#if selectedMarket.signals.length > 0}
						<div class="mb-6">
							<h3 class="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">Signals ({selectedMarket.signals.length})</h3>
							<div class="space-y-2">
								{#each selectedMarket.signals.slice(0, 10) as sig}
									<div class="flex items-center gap-2 text-sm">
										<span class="w-6 h-6 rounded flex items-center justify-center text-xs font-bold border {severityColor(sig.severity)}">{signalIcon(sig.type)}</span>
										<span class="text-[var(--color-text-secondary)] flex-1">{sig.summary}</span>
										<span class="text-xs text-[var(--color-text-tertiary)]">{timeAgo(sig.timestamp)}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Smart Trades -->
					{#if selectedMarket.smart_trades.length > 0}
						<div class="mb-6">
							<h3 class="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">Smart Money Trades ({selectedMarket.smart_trades.length})</h3>
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-[var(--color-border)]">
											<th class="text-left py-2 px-2 text-[var(--color-text-tertiary)]">Wallet</th>
											<th class="text-center py-2 px-2 text-[var(--color-text-tertiary)]">Side</th>
											<th class="text-right py-2 px-2 text-[var(--color-text-tertiary)]">Amount</th>
											<th class="text-right py-2 px-2 text-[var(--color-text-tertiary)]">Score</th>
											<th class="text-right py-2 px-2 text-[var(--color-text-tertiary)]">Win Rate</th>
										</tr>
									</thead>
									<tbody>
										{#each selectedMarket.smart_trades as t}
											<tr class="border-b border-[var(--color-border)]">
												<td class="py-2 px-2 font-mono text-[var(--color-text-secondary)]">{fmtAddr(t.wallet)}</td>
												<td class="py-2 px-2 text-center">
													<span class="px-1.5 py-0.5 rounded text-xs {t.outcome === 'YES' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}">{t.outcome}</span>
												</td>
												<td class="py-2 px-2 text-right text-[var(--color-text-primary)]">{fmtUsd(t.amount)}</td>
												<td class="py-2 px-2 text-right text-[var(--color-text-secondary)]">{t.smart_score}</td>
												<td class="py-2 px-2 text-right text-[var(--color-text-secondary)]">{fmtPct(t.win_rate)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					<!-- Entity Positions -->
					{#if selectedMarket.entity_positions.length > 0}
						<div>
							<h3 class="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">Entity Alliances ({selectedMarket.entity_positions.length})</h3>
							<div class="grid grid-cols-2 gap-3">
								{#each selectedMarket.entity_positions as ep}
									{@const total = ep.amount_yes + ep.amount_no}
									{@const yesPct = total > 0 ? (ep.amount_yes / total) * 100 : 50}
									<div class="bg-[var(--color-elevated)] rounded-lg p-3">
										<div class="flex items-center justify-between mb-2">
											<span class="text-xs font-mono text-[var(--color-text-secondary)]">{fmtAddr(ep.entity_id)}</span>
											<span class="text-xs text-[var(--color-text-tertiary)]">{ep.wallet_count} wallets</span>
										</div>
										<!-- YES/NO bar -->
										<div class="w-full h-2 rounded-full overflow-hidden flex bg-red-500/30">
											<div class="h-full bg-emerald-400 transition-all" style="width: {yesPct}%"></div>
										</div>
										<div class="flex justify-between text-xs mt-1">
											<span class="text-emerald-400">{fmtUsd(ep.amount_yes)} YES</span>
											<span class="text-red-400">{fmtUsd(ep.amount_no)} NO</span>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
