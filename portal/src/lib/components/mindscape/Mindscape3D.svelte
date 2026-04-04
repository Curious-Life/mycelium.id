<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
	import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
	import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
	import { mindscapeState, visibleContacts, selectedContact, NOISE_COLOR, timelineHealth, type MindscapePoint } from '$lib/stores/mindscape';
	import { theme } from '$lib/stores/theme';

	const SCENE_SCALE = 8;
	const POINT_SIZE = 0.28;
	const CONTACT_SIZE = 0.9;
	const CONTACT_COLOR = '#E5B84C'; // Aurum/Gold — brand color

	let container: HTMLDivElement;
	let scene: THREE.Scene;
	let camera: THREE.PerspectiveCamera;
	let renderer: THREE.WebGLRenderer;
	let controls: OrbitControls;
	let composer: EffectComposer;
	let clock: THREE.Clock;
	let pointCloud: THREE.Points;
	let starfield: THREE.Points;
	let glowLayer: THREE.Points;
	let starfieldMaterial: THREE.ShaderMaterial;
	let glowMaterial: THREE.ShaderMaterial;
	let pointCloudMaterial: THREE.ShaderMaterial;
	let contactCloud: THREE.Points;
	let contactEdges: THREE.LineSegments;
	let contactLabels: THREE.Group;
	let raycaster: THREE.Raycaster;
	let mouse = new THREE.Vector2();
	let animationId: number;
	let resizeObserver: ResizeObserver;
	let contactPositions: Map<string, THREE.Vector3> = new Map();
	let coordScale = SCENE_SCALE; // updated by createPointCloud based on data range
	let showPoints = $state(true);

	// Co-firing connections state
	let cofireLines: THREE.LineSegments | null = null;
	let cofireGlows: THREE.Points | null = null;
	let cofireMaterial: THREE.ShaderMaterial | null = null;
	let cofireConnections: Array<{ territory_id: number; name: string; cofire_strength: number }> = $state([]);
	let cofireTerritoryIds: Set<number> = $state(new Set());

	async function loadCofire(territoryId: number) {
		try {
			const res = await fetch(`/portal/mindscape/cofire?territory=${territoryId}&scale=daily&limit=8`, { credentials: 'include' });
			if (res.ok) {
				const data = await res.json();
				cofireConnections = data.connections || [];
				cofireTerritoryIds = new Set(cofireConnections.map((c: any) => c.territory_id));
			}
		} catch { cofireConnections = []; cofireTerritoryIds = new Set(); }
	}

	function clearCofire() {
		cofireConnections = [];
		cofireTerritoryIds = new Set();
		if (cofireLines) { scene.remove(cofireLines); cofireLines = null; }
		if (cofireGlows) { scene.remove(cofireGlows); cofireGlows = null; }
		cofireMaterial = null;
	}

	function createCofireVisuals() {
		if (cofireLines) scene.remove(cofireLines);
		if (cofireGlows) scene.remove(cofireGlows);

		if (!cofireConnections.length || msState.selectedTerritoryId === null) return;

		const territories = msState.territories;
		const selectedT = territories[msState.selectedTerritoryId];
		if (!selectedT?.centroid) return;

		const sc = selectedT.centroid;
		const sx = sc.x * coordScale;
		const sy = sc.z * coordScale;
		const sz = sc.y * coordScale;

		const linePositions: number[] = [];
		const lineStrengths: number[] = [];
		const glowPositions: number[] = [];
		const glowColors: number[] = [];
		const glowStrengths: number[] = [];

		for (const conn of cofireConnections) {
			const t = territories[conn.territory_id];
			if (!t?.centroid) continue;

			const tx = t.centroid.x * coordScale;
			const ty = t.centroid.z * coordScale;
			const tz = t.centroid.y * coordScale;

			linePositions.push(sx, sy, sz, tx, ty, tz);
			lineStrengths.push(conn.cofire_strength, conn.cofire_strength);

			glowPositions.push(tx, ty, tz);
			// Use the territory's data-derived color
			const hue = ((t.centroid.x * 7.31 + t.centroid.y * 13.17 + t.centroid.z * 23.41) % 1 + 1) % 1;
			const col = new THREE.Color().setHSL(hue, 0.6, 0.5);
			glowColors.push(col.r, col.g, col.b);
			glowStrengths.push(conn.cofire_strength);
		}

		// Connection lines
		if (linePositions.length > 0) {
			const lineGeo = new THREE.BufferGeometry();
			lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

			const lineMat = new THREE.LineBasicMaterial({
				color: new THREE.Color('#E5B84C'),
				transparent: true,
				opacity: 0.25,
				depthWrite: false,
			});
			cofireLines = new THREE.LineSegments(lineGeo, lineMat);
			scene.add(cofireLines);
		}

		// Pulsing glow points at connected territory centroids
		if (glowPositions.length > 0) {
			const glowGeo = new THREE.BufferGeometry();
			glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
			glowGeo.setAttribute('color', new THREE.Float32BufferAttribute(glowColors, 3));
			glowGeo.setAttribute('aStrength', new THREE.Float32BufferAttribute(glowStrengths, 1));
			glowGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(
				new Float32Array(glowStrengths.length).map(() => Math.random() * Math.PI * 2), 1
			));

			cofireMaterial = new THREE.ShaderMaterial({
				uniforms: { time: { value: 0 } },
				vertexShader: `
					attribute float aStrength;
					attribute float aPhase;
					varying vec3 vColor;
					varying float vIntensity;
					uniform float time;

					void main() {
						vColor = color;
						float pulse = 0.6 + 0.4 * sin(time * 1.5 + aPhase);
						vIntensity = aStrength * pulse;
						float size = 20.0 + aStrength * 40.0;
						size *= pulse * 0.5 + 0.5;
						vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
						gl_PointSize = size / (-mvPos.z);
						gl_Position = projectionMatrix * mvPos;
					}
				`,
				fragmentShader: `
					varying vec3 vColor;
					varying float vIntensity;

					void main() {
						vec2 uv = gl_PointCoord - vec2(0.5);
						float r = length(uv) * 2.0;
						if (r > 1.0) discard;
						float glow = pow(1.0 - r, 2.5);
						gl_FragColor = vec4(vColor, glow * vIntensity * 0.5);
					}
				`,
				blending: THREE.AdditiveBlending,
				transparent: true,
				depthWrite: false,
				vertexColors: true,
			});
			cofireGlows = new THREE.Points(glowGeo, cofireMaterial);
			scene.add(cofireGlows);
		}
	}

	// Timeline state
	let timelineEnabled = $state(false);
	let timePosition = $state(1.0); // 0..1 normalized position (1 = now)
	let timeRange = $state({ min: 0, max: 0 }); // epoch ms
	let timelineTicks: Array<{ pos: number; height: number; date: Date; count: number }> = $state([]);

	// Health data overlay for timeline
	interface HealthDay { date: string; sleep_duration_min: number|null; hrv_avg: number|null; resting_hr: number|null; steps: number|null; mindful_minutes: number|null; }
	let healthDays: HealthDay[] = $state([]);
	let healthLoaded = false;

	async function loadHealthForTimeline() {
		if (healthLoaded || timeRange.min === 0) return;
		healthLoaded = true;
		try {
			const from = new Date(timeRange.min).toISOString().split('T')[0];
			const to = new Date(timeRange.max).toISOString().split('T')[0];
			const res = await fetch(`/portal/health/range?from=${from}&to=${to}`, { credentials: 'include' });
			if (res.ok) {
				const data = await res.json();
				healthDays = data.days || [];
			}
		} catch { /* silent */ }
	}

	// Compute health summary around needle position (±7 days)
	const healthAtNeedle = $derived.by(() => {
		if (!timelineEnabled || !healthDays.length || timeRange.min === 0) return null;
		const centerMs = timeRange.min + timePosition * (timeRange.max - timeRange.min);
		const windowMs = 7 * 24 * 60 * 60 * 1000; // 7 days
		const from = centerMs - windowMs;
		const to = centerMs + windowMs;

		let sleepSum = 0, sleepN = 0;
		let hrvSum = 0, hrvN = 0;
		let rhrSum = 0, rhrN = 0;
		let stepsSum = 0, stepsN = 0;
		let mindfulSum = 0, mindfulN = 0;

		for (const d of healthDays) {
			const t = new Date(d.date).getTime();
			if (t < from || t > to) continue;
			if (d.sleep_duration_min != null) { sleepSum += d.sleep_duration_min; sleepN++; }
			if (d.hrv_avg != null) { hrvSum += d.hrv_avg; hrvN++; }
			if (d.resting_hr != null) { rhrSum += d.resting_hr; rhrN++; }
			if (d.steps != null) { stepsSum += d.steps; stepsN++; }
			if (d.mindful_minutes != null) { mindfulSum += d.mindful_minutes; mindfulN++; }
		}

		if (!sleepN && !hrvN && !rhrN && !stepsN && !mindfulN) return null;
		return {
			sleep: sleepN ? Math.round(sleepSum / sleepN) : null,
			hrv: hrvN ? Math.round(hrvSum / hrvN) : null,
			rhr: rhrN ? Math.round(rhrSum / rhrN) : null,
			steps: stepsN ? Math.round(stepsSum / stepsN) : null,
			mindful: mindfulN ? Math.round(mindfulSum / mindfulN) : null,
		};
	});

	// Tooltip state
	let tooltipVisible = $state(false);
	let tooltipX = $state(0);
	let tooltipY = $state(0);
	let tooltipData = $state<{ realm?: string; territory?: string; essence?: string; type?: string; date?: string } | null>(null);
	let hoveredIdx = -1;

	const msState = $derived($mindscapeState);

	// Always show all points — the universe doesn't disappear when you zoom in.
	// Selection changes brightness, not visibility.
	const visiblePoints = $derived.by(() => {
		return msState.points;
	});

	// Always return real territory ID — colors never change on drill-down.
	function getClusterId(p: MindscapePoint): number {
		return p.data.cluster3d ?? -1;
	}

	// Derive colors from territory data — the universe paints itself.
	// Hue = semantic position (centroid angle — nearby = similar color)
	// Saturation = activity temperature (active = vivid, dormant = muted)
	// Lightness = mass (log message count — bigger = brighter)
	const dataColors = $derived.by(() => {
		const territories = msState.territories;
		const tids = Object.keys(territories).map(Number);
		if (!tids.length) return { territory: new Map<number, string>(), realm: new Map<number, string>() };

		// Find global max count for lightness normalization
		let maxCount = 1;
		for (const tid of tids) maxCount = Math.max(maxCount, territories[tid]?.count || 1);

		// Compute per-territory colors
		const terrColors = new Map<number, string>();
		for (const tid of tids) {
			const t = territories[tid];
			const c = t.centroid;
			if (!c) { terrColors.set(tid, NOISE_COLOR); continue; }

			// Hue: spatial hash across all 3 centroid dimensions
			// Irrational multipliers spread hue across the full spectrum
			// while keeping some spatial correlation (nearby ≈ similar-ish)
			const hue = ((c.x * 7.31 + c.y * 13.17 + c.z * 23.41) % 1 + 1) % 1;

			// Saturation: activity temperature
			// Active = richer color, dormant = dusty
			let saturation = 0.25;
			if (t.activity && t.activity.length > 0) {
				const sorted = [...t.activity].sort((a, b) => b.month.localeCompare(a.month));
				const recent = sorted.slice(0, 3).reduce((s: number, m: { count: number }) => s + m.count, 0);
				const total = t.activity.reduce((s: number, m: { count: number }) => s + m.count, 0);
				saturation = 0.2 + 0.45 * (total > 0 ? recent / total : 0);
			}

			// Lightness: wider range for more contrast (small=dim, large=brighter)
			const lightness = 0.15 + 0.35 * (Math.log(1 + t.count) / Math.log(1 + maxCount));

			const col = new THREE.Color().setHSL(hue, saturation, lightness);
			terrColors.set(tid, '#' + col.getHexString());
		}

		// Compute realm colors: weighted centroid of territory colors
		// Dominant territory's hue, blended slightly, desaturated for distance
		const realmTerritories = new Map<number, number[]>();
		for (const tid of tids) {
			const rid = territories[tid]?.realmId;
			if (rid == null) continue;
			if (!realmTerritories.has(rid)) realmTerritories.set(rid, []);
			realmTerritories.get(rid)!.push(tid);
		}

		const realmColors = new Map<number, string>();
		for (const [rid, terrIds] of realmTerritories) {
			// Sort by count — dominant territory's color leads
			const sorted = terrIds.sort((a, b) => (territories[b]?.count || 0) - (territories[a]?.count || 0));
			const dominantCol = new THREE.Color(terrColors.get(sorted[0]) || NOISE_COLOR);

			// Tint 15% toward runner-up if exists
			if (sorted.length > 1) {
				const runnerUp = new THREE.Color(terrColors.get(sorted[1]) || NOISE_COLOR);
				dominantCol.lerp(runnerUp, 0.15);
			}

			// Soften for the "seen from distance" feel
			const hsl = { h: 0, s: 0, l: 0 };
			dominantCol.getHSL(hsl);
			dominantCol.setHSL(hsl.h, hsl.s * 0.8, hsl.l * 0.9);

			realmColors.set(rid, '#' + dominantCol.getHexString());
		}

		return { territory: terrColors, realm: realmColors };
	});

	function getColor(id: number): string {
		if (id === -1 || id === null || id === undefined) return NOISE_COLOR;
		// Always use territory colors — fractal consistency across all zoom levels
		return dataColors.territory.get(id) || NOISE_COLOR;
	}

	function getDataBounds(arr: number[]) {
		let min = Infinity, max = -Infinity;
		for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
		return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
	}

	function getBgColor(): string {
		const style = getComputedStyle(document.documentElement);
		return style.getPropertyValue('--color-bg').trim() || '#0A0A0C';
	}

	function createStarfield() {
		if (starfield) scene.remove(starfield);

		// Stars (3000) + distant galaxy points (200)
		const starCount = 3000;
		const galaxyCount = 200;
		const count = starCount + galaxyCount;
		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);
		const phases = new Float32Array(count);
		const sizes = new Float32Array(count);

		for (let i = 0; i < starCount; i++) {
			const r = 350 + Math.random() * 100;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);

			positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
			positions[i * 3 + 2] = r * Math.cos(phi);

			// Hubble spectral class colors
			const roll = Math.random();
			if (roll < 0.35) {
				colors[i * 3] = 0.75 + Math.random() * 0.1;
				colors[i * 3 + 1] = 0.82 + Math.random() * 0.1;
				colors[i * 3 + 2] = 1.0;
			} else if (roll < 0.55) {
				colors[i * 3] = 1.0;
				colors[i * 3 + 1] = 0.9 + Math.random() * 0.06;
				colors[i * 3 + 2] = 0.7 + Math.random() * 0.1;
			} else if (roll < 0.7) {
				colors[i * 3] = 1.0;
				colors[i * 3 + 1] = 0.8 + Math.random() * 0.1;
				colors[i * 3 + 2] = 0.85 + Math.random() * 0.1;
			} else if (roll < 0.85) {
				colors[i * 3] = 0.6 + Math.random() * 0.1;
				colors[i * 3 + 1] = 0.9 + Math.random() * 0.08;
				colors[i * 3 + 2] = 0.92 + Math.random() * 0.08;
			} else {
				colors[i * 3] = 1.0;
				colors[i * 3 + 1] = 1.0;
				colors[i * 3 + 2] = 1.0;
			}

			phases[i] = Math.random() * Math.PI * 2;
			sizes[i] = 1.0 + Math.random() * 0.5;
		}

		// Distant galaxy points — slightly larger, warmer, further out
		for (let i = starCount; i < count; i++) {
			const r = 250 + Math.random() * 200;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);

			positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
			positions[i * 3 + 2] = r * Math.cos(phi);

			// Distant galaxy colors — warm smudges like Hubble Deep Field
			const groll = Math.random();
			if (groll < 0.35) {
				// Amber elliptical
				colors[i * 3] = 0.85 + Math.random() * 0.1;
				colors[i * 3 + 1] = 0.65 + Math.random() * 0.15;
				colors[i * 3 + 2] = 0.3 + Math.random() * 0.15;
			} else if (groll < 0.6) {
				// Blue spiral
				colors[i * 3] = 0.45 + Math.random() * 0.15;
				colors[i * 3 + 1] = 0.55 + Math.random() * 0.15;
				colors[i * 3 + 2] = 0.85 + Math.random() * 0.1;
			} else if (groll < 0.8) {
				// Rose irregular
				colors[i * 3] = 0.75 + Math.random() * 0.1;
				colors[i * 3 + 1] = 0.45 + Math.random() * 0.1;
				colors[i * 3 + 2] = 0.55 + Math.random() * 0.1;
			} else {
				// Pale smudge
				colors[i * 3] = 0.7 + Math.random() * 0.1;
				colors[i * 3 + 1] = 0.7 + Math.random() * 0.1;
				colors[i * 3 + 2] = 0.75 + Math.random() * 0.1;
			}

			phases[i] = Math.random() * Math.PI * 2;
			sizes[i] = 2.0 + Math.random() * 2.0; // larger than stars
		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
		geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

		starfieldMaterial = new THREE.ShaderMaterial({
			uniforms: { time: { value: 0 } },
			vertexShader: `
				attribute float aPhase;
				attribute float aSize;
				varying float vBrightness;
				varying vec3 vStarColor;
				uniform float time;

				void main() {
					vStarColor = color;
					vBrightness = 0.3 + 0.15 * sin(time * 0.4 + aPhase);
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = aSize;
				}
			`,
			fragmentShader: `
				varying float vBrightness;
				varying vec3 vStarColor;

				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float r = length(uv);
					if (r > 0.5) discard;
					// Softer edge for larger points (galaxy smudges)
					float edge = 1.0 - smoothstep(0.2, 0.5, r);
					gl_FragColor = vec4(vStarColor, vBrightness * edge * 0.4);
				}
			`,
			blending: THREE.AdditiveBlending,
			transparent: true,
			depthWrite: false,
			vertexColors: true,
		});

		starfield = new THREE.Points(geo, starfieldMaterial);
		scene.add(starfield);
	}

	// Stellar luminosity model for territories
	// Like real stars: absolute magnitude (intrinsic mass) is the primary driver,
	// recency adds a surface brightness boost — a supernova flare on top of base glow.
	//
	// L_apparent = L_absolute * (1 + recency_boost)
	//
	// L_absolute  = log(1 + count) / log(1 + maxCount)  — logarithmic, like stellar magnitude
	// recency     = Σ(month_i * 1/(i+1)²) / (Σ + k)    — inverse-square time decay, sigmoid-normalized
	//
	// Combined:    luminosity = absolute * 0.7  +  recency * 0.3
	//              (mass dominates, recency adds sparkle)
	function computeLuminosity(
		t: { count: number; activity?: Array<{ month: string; count: number }> },
		maxCount: number
	): number {
		// Absolute magnitude — logarithmic scale (a territory with 1000 msgs
		// is not 10x brighter than one with 100, more like 1.5x)
		const absolute = Math.log(1 + t.count) / Math.log(1 + maxCount);

		// Recency boost — recent months weighted by inverse-square time decay
		let recency = 0;
		if (t.activity && t.activity.length > 0) {
			const sorted = [...t.activity].sort((a, b) => b.month.localeCompare(a.month));
			let weighted = 0;
			for (let i = 0; i < Math.min(sorted.length, 6); i++) {
				const decay = 1 / ((i + 1) * (i + 1));
				weighted += sorted[i].count * decay;
			}
			recency = weighted / (weighted + 30); // sigmoid normalization
		}

		// Combined: mass dominates (0.7), recency adds flare (0.3)
		const raw = absolute * 0.7 + recency * 0.3;

		// Floor at 0.08 so even quiet territories have a faint presence
		return Math.max(0.08, raw);
	}

	function createGlowLayer() {
		if (glowLayer) scene.remove(glowLayer);

		const territories = msState.territories;
		const tids = Object.keys(territories)
			.map(Number)
			.filter((tid) => {
				const t = territories[tid];
				return t.centroid != null && t.count > 0;
			});

		if (tids.length === 0) return;

		const positions = new Float32Array(tids.length * 3);
		const colors = new Float32Array(tids.length * 3);
		const luminosities = new Float32Array(tids.length);

		let maxCount = 1;
		for (const tid of tids) maxCount = Math.max(maxCount, territories[tid].count);

		for (let i = 0; i < tids.length; i++) {
			const tid = tids[i];
			const t = territories[tid];

			// Position with coord swap (same as point cloud)
			const centroid = t.centroid!;
			positions[i * 3] = centroid.x * coordScale;
			positions[i * 3 + 1] = centroid.z * coordScale;
			positions[i * 3 + 2] = centroid.y * coordScale;

			// Use data-derived territory color (same as point cloud)
			const terrColorHex = dataColors.territory.get(tid);
			const glowCol = terrColorHex ? new THREE.Color(terrColorHex) : new THREE.Color(0.5, 0.5, 0.6);
			colors[i * 3] = glowCol.r;
			colors[i * 3 + 1] = glowCol.g;
			colors[i * 3 + 2] = glowCol.b;

			// Recency-weighted luminosity
			luminosities[i] = computeLuminosity(t, maxCount);
		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geo.setAttribute('aLuminosity', new THREE.BufferAttribute(luminosities, 1));
		geo.setAttribute(
			'aPhase',
			new THREE.BufferAttribute(new Float32Array(tids.map(() => Math.random() * Math.PI * 2)), 1)
		);

		glowMaterial = new THREE.ShaderMaterial({
			uniforms: {
				time: { value: 0 },
			},
			vertexShader: `
				attribute float aLuminosity;
				attribute float aPhase;
				varying vec3 vColor;
				varying float vGlowIntensity;
				uniform float time;

				void main() {
					vColor = color;

					// Slow, gentle breathing — brighter territories pulse slightly faster
					float freq = 0.3 + aLuminosity * 0.4;
					float breath = 0.85 + 0.15 * sin(time * freq + aPhase);

					// Luminosity drives both intensity and size
					vGlowIntensity = aLuminosity * breath;

					// Size: proportional to luminosity (dim = small, bright = larger)
					float size = 20.0 + aLuminosity * 50.0;
					size *= breath;

					vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = size / (-mvPos.z);
					gl_Position = projectionMatrix * mvPos;
				}
			`,
			fragmentShader: `
				varying vec3 vColor;
				varying float vGlowIntensity;

				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float r = length(uv) * 2.0;
					if (r > 1.0) discard;

					// Soft radial falloff
					float glow = pow(1.0 - r, 2.5);
					float alpha = glow * vGlowIntensity * 0.4;

					gl_FragColor = vec4(vColor * (0.6 + vGlowIntensity * 0.4), alpha);
				}
			`,
			blending: THREE.AdditiveBlending,
			transparent: true,
			depthWrite: false,
			vertexColors: true,
		});

		glowLayer = new THREE.Points(geo, glowMaterial);
		scene.add(glowLayer);
	}

	function initThree() {
		if (!container) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(getBgColor());

		camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
		// Start far away — the intro animation will drift in
		camera.position.set(80, 50, 80);

		renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setSize(container.clientWidth, container.clientHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		container.appendChild(renderer.domElement);

		// Tone mapping for bloom — balanced exposure so points stay visible
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.1;
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		// Setup clock for animations
		clock = new THREE.Clock();

		// Setup composer for bloom — soft nebula glow
		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		const bloomPass = new UnrealBloomPass(
			new THREE.Vector2(container.clientWidth, container.clientHeight),
			0.35, // strength — gentle nebula haze
			0.5,  // radius — wider spread for soft halos
			0.5   // threshold — catch glow halos, not data points
		);
		composer.addPass(bloomPass);
		composer.addPass(new OutputPass());

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.05;
		controls.minDistance = 5;
		controls.maxDistance = 100;

		raycaster = new THREE.Raycaster();
		raycaster.params.Points = { threshold: 0.3 };

		const ambient = new THREE.AmbientLight(0xffffff, 0.6);
		const directional = new THREE.DirectionalLight(0xffffff, 0.4);
		directional.position.set(10, 10, 10);
		scene.add(ambient, directional);

		// Create starfield (behind everything)
		createStarfield();

		renderer.domElement.addEventListener('mousemove', handleMouseMove);
		renderer.domElement.addEventListener('mousedown', handleMouseDown);
		renderer.domElement.addEventListener('click', handleClick);
		resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(container);
	}

	function createPointCloud() {
		if (pointCloud) scene.remove(pointCloud);
		const nodes = visiblePoints;
		if (!nodes.length) return;

		const xs = nodes.map(p => p.data.position3d.x);
		const ys = nodes.map(p => p.data.position3d.y);
		const zs = nodes.map(p => p.data.position3d.z);
		const bx = getDataBounds(xs);
		const by = getDataBounds(ys);
		const bz = getDataBounds(zs);
		// Scale so the largest axis span maps to ~60 units, preserving natural shape
		const maxSpan = Math.max(bx.max - bx.min, by.max - by.min, bz.max - bz.min) || 1;
		const scale = 60 / maxSpan;
		coordScale = scale;

		const positions = new Float32Array(nodes.length * 3);
		const colors = new Float32Array(nodes.length * 3);
		const alphas = new Float32Array(nodes.length);
		const timestamps = new Float32Array(nodes.length);

		// Compute time range from point timestamps
		let tMin = Infinity, tMax = -Infinity;
		for (const p of nodes) {
			if (p.data.timestamp) {
				const t = new Date(p.data.timestamp).getTime();
				if (t < tMin) tMin = t;
				if (t > tMax) tMax = t;
			}
		}
		if (tMin === Infinity) { tMin = 0; tMax = 1; }
		timeRange = { min: tMin, max: tMax };
		const tSpan = tMax - tMin || 1;

		// Precompute territory and realm base hues from their centroids.
		// Each region has a dominant "emission line" — its signature tint.
		const territoryHues = new Map<number, number>();
		const realmHues = new Map<number, number>();
		const territories = msState.territories;
		let maxCount = 1;
		for (const t of Object.values(territories)) maxCount = Math.max(maxCount, t.count || 1);
		for (const [tidStr, t] of Object.entries(territories)) {
			const tid = Number(tidStr);
			if (t.centroid) {
				const tc = t.centroid;
				territoryHues.set(tid, ((tc.x * 7.31 + tc.y * 13.17 + tc.z * 23.41) % 1 + 1) % 1);
			}
		}
		// Realm hue = average of its territories' hues (circular mean)
		const realmSinSum = new Map<number, number>();
		const realmCosSum = new Map<number, number>();
		const realmCount = new Map<number, number>();
		for (const [tidStr, t] of Object.entries(territories)) {
			const rid = t.realmId;
			if (rid == null) continue;
			const th = territoryHues.get(Number(tidStr));
			if (th == null) continue;
			realmSinSum.set(rid, (realmSinSum.get(rid) || 0) + Math.sin(th * Math.PI * 2));
			realmCosSum.set(rid, (realmCosSum.get(rid) || 0) + Math.cos(th * Math.PI * 2));
			realmCount.set(rid, (realmCount.get(rid) || 0) + 1);
		}
		for (const [rid, count] of realmCount) {
			const avgAngle = Math.atan2(realmSinSum.get(rid)! / count, realmCosSum.get(rid)! / count);
			realmHues.set(rid, ((avgAngle / (Math.PI * 2)) + 1) % 1);
		}

		for (let i = 0; i < nodes.length; i++) {
			const p = nodes[i];
			const cx = p.data.position3d.x * scale;
			const cy = p.data.position3d.z * scale;
			const cz = p.data.position3d.y * scale;

			positions[i * 3] = cx;
			positions[i * 3 + 1] = cy;
			positions[i * 3 + 2] = cz;

			const px = p.data.position3d.x;
			const py = p.data.position3d.y;
			const pz = p.data.position3d.z;
			const tid = p.data.cluster3d ?? -1;
			const rid = p.data.clusterId ?? -1;
			const isNoise = tid === -1;

			// Per-point hue: local spatial variation
			const pointHue = ((px * 7.31 + py * 13.17 + pz * 23.41) % 1 + 1) % 1;

			// Territory and realm tints
			const terrHue = territoryHues.get(tid);
			const realmHue = realmHues.get(rid);

			// Blend: territory tint dominates (50%), point variation (35%), realm undertone (15%)
			// Noise points just use their own position hue
			let hue: number;
			if (isNoise || terrHue == null) {
				hue = pointHue;
			} else {
				const rh = realmHue ?? terrHue;
				// Circular interpolation for hue blending
				const blend = (target: number, source: number, weight: number) => {
					let diff = target - source;
					if (diff > 0.5) diff -= 1;
					if (diff < -0.5) diff += 1;
					return ((source + diff * weight) + 1) % 1;
				};
				hue = blend(terrHue, pointHue, 0.5);
				hue = blend(rh, hue, 0.15);
			}

			// Saturation: more vivid — Hubble vibrancy
			const satRaw = ((px * 3.71 + py * 8.53 + pz * 5.29) % 1 + 1) % 1;
			const saturation = isNoise
				? 0.1 + satRaw * 0.15
				: 0.4 + satRaw * 0.5;

			// Lightness: base from spatial variation + activity boost
			const litRaw = ((px * 11.13 + py * 4.87 + pz * 17.63) % 1 + 1) % 1;
			// Active territories get a brightness boost (luminosity from activity timeline)
			const terrData = !isNoise ? territories[tid] : null;
			const activityBoost = terrData ? computeLuminosity(terrData, maxCount) * 0.15 : 0;
			const lightness = isNoise
				? 0.08 + litRaw * 0.1
				: 0.3 + litRaw * 0.3 + activityBoost;

			const color = new THREE.Color().setHSL(hue, saturation, lightness);
			colors[i * 3] = color.r;
			colors[i * 3 + 1] = color.g;
			colors[i * 3 + 2] = color.b;

			// Per-point focus alpha — all navigation levels
			// Use territory's semanticThemeId (not point's themeId, which is a different concept)
			const terrSemanticTheme = !isNoise && territories[tid] ? territories[tid].semanticThemeId : null;
			const inSelectedRealm = msState.selectedRealmId === null || rid === msState.selectedRealmId;
			const inSelectedTheme = msState.selectedSemanticThemeId === null || terrSemanticTheme === msState.selectedSemanticThemeId;
			const inSelectedTerritory = msState.selectedTerritoryId === null || tid === msState.selectedTerritoryId;
			const isInFocus = inSelectedRealm && inSelectedTheme && inSelectedTerritory;
			const hasSelection = msState.selectedRealmId !== null;

			// Co-firing territories glow at medium alpha when source is selected
			const isCofiring = cofireTerritoryIds.has(tid);

			if (isNoise) {
				alphas[i] = hasSelection ? 0.03 : 0.5;
			} else if (isInFocus) {
				alphas[i] = 0.9;
			} else if (isCofiring) {
				alphas[i] = 0.35; // visible but secondary
			} else {
				alphas[i] = 0.06;
			}

			// Normalized timestamp (0 = oldest, 1 = newest)
			const ts = p.data.timestamp ? new Date(p.data.timestamp).getTime() : tMax;
			timestamps[i] = (ts - tMin) / tSpan;
		}

		// Compute timeline ticks (monthly bins)
		const binCounts = new Map<number, number>();
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].data.timestamp) {
				const d = new Date(nodes[i].data.timestamp!);
				const monthKey = d.getFullYear() * 12 + d.getMonth();
				binCounts.set(monthKey, (binCounts.get(monthKey) || 0) + 1);
			}
		}
		let maxBin = 1;
		for (const c of binCounts.values()) if (c > maxBin) maxBin = c;
		const sortedBins = [...binCounts.entries()].sort((a, b) => a[0] - b[0]);
		timelineTicks = sortedBins.map(([mk, count]) => {
			const y = Math.floor(mk / 12);
			const m = mk % 12;
			const d = new Date(y, m, 1);
			const pos = (d.getTime() - tMin) / tSpan;
			return { pos, height: 0.2 + 0.8 * (count / maxBin), date: d, count };
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
		geometry.setAttribute('aTime', new THREE.BufferAttribute(timestamps, 1));

		const material = new THREE.ShaderMaterial({
			uniforms: {
				pointSize: { value: POINT_SIZE },
				timeCenter: { value: 1.0 },   // scrub position (0..1)
				timeWindow: { value: 1.0 },    // visible window half-width
				timeActive: { value: 0.0 },    // 0 = timeline off, 1 = on
			},
			vertexShader: `
				attribute float aAlpha;
				attribute float aTime;
				varying vec3 vColor;
				varying float vAlpha;
				uniform float pointSize;
				uniform float timeCenter;
				uniform float timeWindow;
				uniform float timeActive;

				void main() {
					vColor = color;

					// Timeline dimming: fade points outside the time window
					float timeDist = abs(aTime - timeCenter);
					float timeFade = 1.0 - smoothstep(timeWindow * 0.5, timeWindow, timeDist);
					float timeAlpha = mix(1.0, timeFade, timeActive);

					vAlpha = aAlpha * timeAlpha;
					vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = pointSize * (300.0 / -mvPos.z);
					gl_Position = projectionMatrix * mvPos;
				}
			`,
			fragmentShader: `
				varying vec3 vColor;
				varying float vAlpha;

				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float r = length(uv);
					if (r > 0.5) discard;
					float edge = 1.0 - smoothstep(0.3, 0.5, r);
					gl_FragColor = vec4(vColor, vAlpha * edge);
				}
			`,
			transparent: true,
			depthWrite: false,
			depthTest: true,
			vertexColors: true,
		});

		pointCloudMaterial = material;
		pointCloud = new THREE.Points(geometry, material);
		pointCloud.visible = showPoints;
		scene.add(pointCloud);
	}

	function createSocialLayer() {
		// Remove existing social objects
		if (contactCloud) scene.remove(contactCloud);
		if (contactEdges) scene.remove(contactEdges);
		if (contactLabels) scene.remove(contactLabels);
		contactPositions.clear();

		const contacts = $visibleContacts;
		if (!contacts.length) return;

		// Compute contact positions: weighted average of territory centroids,
		// or random scatter for contacts without linked territories
		const positions = new Float32Array(contacts.length * 3);
		const colors = new Float32Array(contacts.length * 3);
		const edgePositions: number[] = [];
		const tierSizes: Record<string, number> = {
			inner: 1.0, engaged: 0.7, acknowledged: 0.5, connected: 0.3, noise: 0.2,
		};

		// Compute scene center from point cloud for fallback positioning
		let cx = 0, cy = 0, cz = 0;
		const pts = visiblePoints;
		if (pts.length > 0) {
			for (const p of pts) {
				cx += p.data.position3d.x; cy += p.data.position3d.z; cz += p.data.position3d.y;
			}
			cx = (cx / pts.length) * coordScale;
			cy = (cy / pts.length) * coordScale;
			cz = (cz / pts.length) * coordScale;
		}

		for (let i = 0; i < contacts.length; i++) {
			const c = contacts[i];
			let wx = 0, wy = 0, wz = 0, totalWeight = 0;

			for (const t of c.territories) {
				if (!t.centroid_3d) continue;
				const w = t.strength || 0.5;
				wx += t.centroid_3d[0] * coordScale * w;
				wy += t.centroid_3d[2] * coordScale * w;
				wz += t.centroid_3d[1] * coordScale * w;
				totalWeight += w;
			}

			if (totalWeight > 0) {
				wx /= totalWeight;
				wy /= totalWeight;
				wz /= totalWeight;
			} else {
				// No linked territory — scatter around scene center
				const r = 15 + Math.random() * 20;
				const theta = Math.random() * Math.PI * 2;
				const phi = Math.acos(2 * Math.random() - 1);
				wx = cx + r * Math.sin(phi) * Math.cos(theta);
				wy = cy + r * Math.sin(phi) * Math.sin(theta);
				wz = cz + r * Math.cos(phi);
			}

			// Small jitter to prevent overlap
			wx += (Math.random() - 0.5) * 1.5;
			wy += (Math.random() - 0.5) * 1.5;
			wz += (Math.random() - 0.5) * 1.5;

			positions[i * 3] = wx;
			positions[i * 3 + 1] = wy;
			positions[i * 3 + 2] = wz;

			const pos = new THREE.Vector3(wx, wy, wz);
			contactPositions.set(c.id, pos);

			// Color: gold with brightness based on tier
			const color = new THREE.Color(CONTACT_COLOR);
			const mult = tierSizes[c.tier] || 0.5;
			colors[i * 3] = Math.min(1, color.r * mult);
			colors[i * 3 + 1] = Math.min(1, color.g * mult);
			colors[i * 3 + 2] = Math.min(1, color.b * mult);

			// Edges: lines from contact to each linked territory centroid
			for (const t of c.territories) {
				if (!t.centroid_3d) continue;
				edgePositions.push(
					wx, wy, wz,
					t.centroid_3d[0] * coordScale,
					t.centroid_3d[2] * coordScale,
					t.centroid_3d[1] * coordScale,
				);
			}
		}

		// Contact particles
		const contactGeo = new THREE.BufferGeometry();
		contactGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		contactGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const contactMat = new THREE.PointsMaterial({
			size: CONTACT_SIZE,
			vertexColors: true,
			transparent: false,
			depthWrite: true,
			depthTest: true,
			sizeAttenuation: true,
		});

		contactCloud = new THREE.Points(contactGeo, contactMat);
		scene.add(contactCloud);
		renderedContacts = contacts;

		// Edge lines
		if (edgePositions.length > 0) {
			const edgeGeo = new THREE.BufferGeometry();
			edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

			const edgeMat = new THREE.LineBasicMaterial({
				color: new THREE.Color(CONTACT_COLOR),
				transparent: true,
				opacity: 0.15,
				depthWrite: false,
				depthTest: true,
			});

			contactEdges = new THREE.LineSegments(edgeGeo, edgeMat);
			scene.add(contactEdges);
		}
	}

	function animateCameraToVisiblePoints(duration = 800) {
		// Zoom to the focused subset (selected realm/territory), not all points
		// Filter to focused subset for camera framing
		// Use territory's semanticThemeId for theme-level filtering
		const territories = msState.territories;
		let nodes = visiblePoints;
		if (msState.selectedTerritoryId !== null) {
			nodes = nodes.filter(p => p.data.cluster3d === msState.selectedTerritoryId);
		} else if (msState.selectedSemanticThemeId !== null) {
			nodes = nodes.filter(p => {
				const tid = p.data.cluster3d ?? -1;
				const t = tid >= 0 ? territories[tid] : null;
				return t?.semanticThemeId === msState.selectedSemanticThemeId && p.data.clusterId === msState.selectedRealmId;
			});
		} else if (msState.selectedRealmId !== null) {
			nodes = nodes.filter(p => p.data.clusterId === msState.selectedRealmId);
		}
		if (!nodes.length) return;

		let sx = 0, sy = 0, sz = 0;
		for (const p of nodes) {
			sx += p.data.position3d.x * coordScale;
			sy += p.data.position3d.z * coordScale;
			sz += p.data.position3d.y * coordScale;
		}
		const tx = sx / nodes.length;
		const ty = sy / nodes.length;
		const tz = sz / nodes.length;

		let maxDist = 0;
		for (const p of nodes) {
			const dx = p.data.position3d.x * coordScale - tx;
			const dy = p.data.position3d.z * coordScale - ty;
			const dz = p.data.position3d.y * coordScale - tz;
			maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
		}

		// Glide from current position toward the target centroid
		const target = new THREE.Vector3(tx, ty, tz);
		const frameDist = Math.max(maxDist * 0.9, 3);

		// Direction: from camera's current position toward the new target
		const toTarget = target.clone().sub(camera.position).normalize();
		// End position: frameDist away from target, along the line from camera to target
		const endPos = target.clone().sub(toTarget.clone().multiplyScalar(frameDist));
		const endTarget = target.clone();
		const startPos = camera.position.clone();
		const startTarget = controls.target.clone();
		const startTime = performance.now();

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			// Smooth ease-in-out for effortless feel
			const ease = t < 0.5
				? 4 * t * t * t
				: 1 - Math.pow(-2 * t + 2, 3) / 2;
			camera.position.lerpVectors(startPos, endPos, ease);
			controls.target.lerpVectors(startTarget, endTarget, ease);
			controls.update();
			if (t < 1) requestAnimationFrame(animate);
		}
		animate();
	}

	let introCancelled = false;

	function cancelIntro() { introCancelled = true; }

	function animateIntro() {
		const nodes = visiblePoints;
		if (!nodes.length) return;
		introCancelled = false;

		// Cancel on any user interaction
		const cancel = () => { cancelIntro(); cleanup(); };
		const cleanup = () => {
			renderer?.domElement.removeEventListener('mousedown', cancel);
			renderer?.domElement.removeEventListener('wheel', cancel);
			renderer?.domElement.removeEventListener('touchstart', cancel);
		};
		renderer.domElement.addEventListener('mousedown', cancel, { once: true });
		renderer.domElement.addEventListener('wheel', cancel, { once: true });
		renderer.domElement.addEventListener('touchstart', cancel, { once: true });

		let sx = 0, sy = 0, sz = 0;
		for (const p of nodes) {
			sx += p.data.position3d.x * coordScale;
			sy += p.data.position3d.z * coordScale;
			sz += p.data.position3d.y * coordScale;
		}
		const cx = sx / nodes.length;
		const cy = sy / nodes.length;
		const cz = sz / nodes.length;

		let maxDist = 0;
		for (const p of nodes) {
			const dx = p.data.position3d.x * coordScale - cx;
			const dy = p.data.position3d.z * coordScale - cy;
			const dz = p.data.position3d.y * coordScale - cz;
			maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
		}

		const viewDist = Math.max(maxDist * 1.5, 20);
		const endPos = new THREE.Vector3(
			cx + viewDist * 0.65,
			cy + viewDist * 0.4,
			cz + viewDist * 0.65,
		);
		const endTarget = new THREE.Vector3(cx, cy, cz);
		const startPos = camera.position.clone();
		const startTarget = controls.target.clone();
		const startTime = performance.now();
		const duration = 2500;

		function animate() {
			if (introCancelled) { cleanup(); return; }
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = 1 - Math.pow(1 - t, 4);

			camera.position.lerpVectors(startPos, endPos, ease);
			controls.target.lerpVectors(startTarget, endTarget, ease);

			const angle = ease * 0.26;
			const rotated = camera.position.clone().sub(controls.target);
			rotated.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
			camera.position.copy(controls.target).add(rotated);

			controls.update();
			if (t < 1) requestAnimationFrame(animate);
			else cleanup();
		}
		animate();
	}

	// Ordered list of contacts matching the contact cloud indices (set by createSocialLayer)
	let renderedContacts: typeof $visibleContacts = [];

	function handleMouseMove(event: MouseEvent) {
		const rect = container.getBoundingClientRect();
		mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

		raycaster.setFromCamera(mouse, camera);
		const tipX = event.clientX - rect.left + 12;
		const tipY = event.clientY - rect.top - 10;

		// Check contacts first (they're on top visually)
		if (contactCloud && contactCloud.visible && renderedContacts.length > 0) {
			const hits = raycaster.intersectObject(contactCloud);
			if (hits.length > 0 && hits[0].index != null && hits[0].index < renderedContacts.length) {
				const c = renderedContacts[hits[0].index];
				tooltipData = {
					territory: c.name || 'Unknown',
					essence: [c.position, c.company].filter(Boolean).join(' · ') || undefined,
					type: c.tier,
					date: c.connected_at ? new Date(c.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
				};
				tooltipX = tipX;
				tooltipY = tipY;
				tooltipVisible = true;
				hoveredIdx = -1;
				return;
			}
		}

		// Then check clustering points
		if (pointCloud && pointCloud.visible) {
			const intersects = raycaster.intersectObject(pointCloud);
			if (intersects.length > 0 && intersects[0].index != null) {
				const idx = intersects[0].index;
				if (idx !== hoveredIdx && idx < visiblePoints.length) {
					hoveredIdx = idx;
					const p = visiblePoints[idx];
					const realmId = p.data.clusterId;
					const territoryId = p.data.cluster3d;
					const realm = realmId != null && realmId >= 0 ? msState.realms[realmId] : null;
					const territory = territoryId != null && territoryId >= 0 ? msState.territories[territoryId] : null;
					tooltipData = {
						realm: realm?.name ?? (realmId === -1 ? 'Noise' : `Realm ${realmId}`),
						territory: territory?.name ?? (territoryId === -1 ? 'Unclustered' : `Territory ${territoryId}`),
						essence: territory?.essence || realm?.essence || undefined,
						type: p.data.type,
						date: p.data.timestamp ? new Date(p.data.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
					};
				}
				tooltipX = tipX;
				tooltipY = tipY;
				tooltipVisible = true;
				return;
			}
		}

		tooltipVisible = false;
		hoveredIdx = -1;
	}

	// Track mousedown position to distinguish click from drag
	let mouseDownPos = { x: 0, y: 0 };
	function handleMouseDown(event: MouseEvent) {
		mouseDownPos = { x: event.clientX, y: event.clientY };
	}

	function handleClick(event: MouseEvent) {
		// Ignore if mouse moved more than 5px — it was a drag, not a click
		const dx = event.clientX - mouseDownPos.x;
		const dy = event.clientY - mouseDownPos.y;
		if (dx * dx + dy * dy > 25) return;

		raycaster.setFromCamera(mouse, camera);

		// Check contact clicks first
		if (contactCloud && contactCloud.visible && renderedContacts.length > 0) {
			const contactHits = raycaster.intersectObject(contactCloud);
			if (contactHits.length > 0 && contactHits[0].index != null && contactHits[0].index < renderedContacts.length) {
				const contact = renderedContacts[contactHits[0].index];
				// Toggle selection — clicking same contact deselects
				const newId = msState.selectedContactId === contact.id ? null : contact.id;
				mindscapeState.selectContact(newId);
				return;
			}
		}

		// Point cloud clicks — step-by-step navigation
		// Clicking always navigates to the next level down for whatever you clicked on.
		// If you click something in a different region, it first navigates to that
		// region's parent level, like walking through the territory step by step.
		if (!pointCloud) return;
		const intersects = raycaster.intersectObject(pointCloud);
		if (intersects.length > 0) {
			const idx = intersects[0].index;
			if (idx != null && idx < visiblePoints.length) {
				const p = visiblePoints[idx];
				const clickedRealm = p.data.clusterId;
				const clickedTheme = p.data.themeId;
				const clickedTerritory = p.data.cluster3d;

				if (clickedRealm === -1 || clickedRealm == null) return; // noise

				// Step-by-step: navigate one level deeper each click
				if (msState.selectedRealmId === null) {
					// Top level → open realm
					mindscapeState.drillIntoRealm(clickedRealm);
				} else if (clickedRealm !== msState.selectedRealmId) {
					// Clicked a different realm → switch to that realm
					mindscapeState.drillIntoRealm(clickedRealm);
				} else if (msState.selectedSemanticThemeId === null) {
					// Inside a realm, no theme selected → open theme
					if (clickedTheme != null && clickedTheme !== -1) {
						mindscapeState.drillIntoTheme(clickedRealm, clickedTheme);
					}
				} else if (clickedTheme !== msState.selectedSemanticThemeId) {
					// Inside a theme, clicked different theme → switch theme
					if (clickedTheme != null && clickedTheme !== -1) {
						mindscapeState.drillIntoTheme(clickedRealm, clickedTheme);
					}
				} else if (msState.selectedTerritoryId === null) {
					// Inside a theme, no territory selected → open territory
					if (clickedTerritory != null && clickedTerritory !== -1) {
						mindscapeState.selectTerritory(clickedTerritory);
					}
				} else if (clickedTerritory !== msState.selectedTerritoryId) {
					// Inside a territory, clicked different territory → switch
					if (clickedTerritory != null && clickedTerritory !== -1) {
						mindscapeState.selectTerritory(clickedTerritory);
					}
				}
			}
		} else {
			// Click on empty space → go back one level
			if (msState.selectedContactId) {
				mindscapeState.selectContact(null);
			} else {
				mindscapeState.goBack();
			}
		}
	}

	function handleResize() {
		if (!container || !renderer || !camera) return;
		camera.aspect = container.clientWidth / container.clientHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(container.clientWidth, container.clientHeight);
		if (composer) {
			composer.setSize(container.clientWidth, container.clientHeight);
		}
	}

	function renderLoop() {
		animationId = requestAnimationFrame(renderLoop);
		controls.update();

		// Update shader uniforms with elapsed time
		const elapsed = clock.getElapsedTime();
		if (starfieldMaterial) {
			starfieldMaterial.uniforms.time.value = elapsed;
		}
		if (glowMaterial) {
			glowMaterial.uniforms.time.value = elapsed;
		}
		if (cofireMaterial) {
			cofireMaterial.uniforms.time.value = elapsed;
		}
		// Timeline uniforms — read from bridge vars (updated by $effect)
		if (pointCloudMaterial) {
			pointCloudMaterial.uniforms.timeCenter.value = _timePos;
			pointCloudMaterial.uniforms.timeWindow.value = 0.15;
			pointCloudMaterial.uniforms.timeActive.value = _timeEnabled ? 1.0 : 0.0;
		}

		composer.render();
	}

	// Update scene background when theme changes
	const currentTheme = $derived($theme);
	$effect(() => {
		// Track the theme to re-run when it changes
		currentTheme;
		if (scene) {
			scene.background = new THREE.Color(getBgColor());
		}
	});

	// Load health data once timeline range is known
	$effect(() => {
		if (timeRange.min > 0 && !healthLoaded) loadHealthForTimeline();
	});

	function togglePoints() {
		showPoints = !showPoints;
		if (pointCloud) pointCloud.visible = showPoints;
	}

	// Bridge reactive $state to plain vars the render loop can read
	let _timePos = 1.0;
	let _timeEnabled = false;
	$effect(() => {
		_timePos = timePosition;
		_timeEnabled = timelineEnabled;
		// Push health to store for the page health bar
		const h = healthAtNeedle;
		const d = new Date(timeRange.min + timePosition * (timeRange.max - timeRange.min));
		timelineHealth.set({
			active: timelineEnabled,
			date: timelineEnabled ? d : null,
			sleep: h?.sleep ?? null,
			hrv: h?.hrv ?? null,
			rhr: h?.rhr ?? null,
			steps: h?.steps ?? null,
			mindful: h?.mindful ?? null,
		});
	});

	let prevPointCount = 0;
	let prevNavKey = '';

	$effect(() => {
		const pts = visiblePoints;
		const realm = msState.selectedRealmId;
		const territory = msState.selectedTerritoryId;
		const theme = msState.selectedSemanticThemeId;

		if (!scene) return;

		// Track all navigation state as a single key
		const navKey = `${realm}:${theme}:${territory}`;
		const isNavChange = navKey !== prevNavKey;
		const dataChanged = pts.length !== prevPointCount;

		if (isNavChange || dataChanged) {
			// Rebuild point cloud (alphas update for focus)
			createPointCloud();
			if (dataChanged) {
				createSocialLayer();
				createGlowLayer();
			}
			if (dataChanged && prevPointCount === 0 && pts.length > 0) {
				// First load: cinematic drift-in from afar with gentle rotation
				setTimeout(() => animateIntro(), 100);
			} else if (isNavChange) {
				setTimeout(() => animateCameraToVisiblePoints(800), 50);
			}
			// Co-firing connections: load when a territory is selected
			if (territory !== null) {
				loadCofire(territory).then(() => createCofireVisuals());
			} else {
				clearCofire();
			}
		}

		prevPointCount = pts.length;
		prevNavKey = navKey;
	});

	// Re-render social layer when visible contacts, tiers, or selection change
	const contactsSnapshot = $derived(
		[...msState.visibleTiers].sort().join(',') + ':' + $visibleContacts.length + ':' + (msState.showSocialLayer ? '1' : '0') + ':' + (msState.selectedContactId || '')
	);
	let prevContactsSnapshot = '';
	$effect(() => {
		const snap = contactsSnapshot; // track explicitly
		if (scene && snap !== prevContactsSnapshot) {
			createSocialLayer();
			// Also toggle visibility of existing objects immediately
			if (contactCloud) contactCloud.visible = msState.showSocialLayer;
			if (contactEdges) contactEdges.visible = msState.showSocialLayer;
			prevContactsSnapshot = snap;
		}
	});

	onMount(async () => {
		await mindscapeState.load();
		initThree();
		createPointCloud();
		renderLoop();
	});

	onDestroy(() => {
		if (animationId) cancelAnimationFrame(animationId);
		if (renderer) {
			renderer.domElement.removeEventListener('mousemove', handleMouseMove);
			renderer.domElement.removeEventListener('mousedown', handleMouseDown);
			renderer.domElement.removeEventListener('click', handleClick);
			renderer.dispose();
		}
		if (composer) composer.dispose();
		clearCofire();
		if (resizeObserver) resizeObserver.disconnect();
	});
</script>

<div class="relative w-full h-full">
	<div bind:this={container} class="w-full h-full"></div>

	<!-- Breadcrumb nav -->
	<div class="absolute top-4 left-4 flex items-center gap-2">
		{#if msState.selectedRealmId !== null}
			<button
				onclick={() => {
					if (msState.selectedTerritoryId !== null) {
						mindscapeState.selectTerritory(null);
					} else {
						mindscapeState.goBack();
					}
				}}
				class="btn-ghost text-xs px-3 py-1.5 rounded-md bg-[var(--color-surface)]/80 backdrop-blur-sm border border-[var(--color-border)]"
			>
				&larr; Back
			</button>
		{/if}
		<span class="text-xs text-[var(--color-text-tertiary)] bg-[var(--color-surface)]/80 backdrop-blur-sm px-2 py-1 rounded">
			{#if msState.selectedRealmId === null}
				All Realms
			{:else}
				{@const realm = msState.realms[msState.selectedRealmId]}
				{realm?.name || `Realm ${msState.selectedRealmId}`}
				{#if msState.selectedTerritoryId !== null}
					{@const territory = msState.territories[msState.selectedTerritoryId]}
					&gt; {territory?.name || `Territory ${msState.selectedTerritoryId}`}
				{/if}
			{/if}
		</span>
	</div>

	<!-- Loading overlay -->
	{#if msState.loading}
		<div class="absolute inset-0 flex items-center justify-center bg-[var(--color-bg)]/80">
			<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading Mindscape...</div>
		</div>
	{/if}

	<!-- Empty state -->
	{#if !msState.loading && msState.points.length === 0}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center">
				<p class="text-[var(--color-text-tertiary)] text-sm">No clustering data yet</p>
				<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Send more messages to build your Mindscape</p>
			</div>
		</div>
	{/if}

	<!-- Stats badge -->
	{#if msState.meta && !msState.loading}
		<div class="absolute bottom-4 left-4 text-[0.65rem] text-[var(--color-text-tertiary)] bg-[var(--color-surface)]/80 backdrop-blur-sm px-2.5 py-1 rounded border border-[var(--color-border)]">
			{msState.meta.total.toLocaleString()} points &middot;
			{Object.keys(msState.realms).length} realms &middot;
			{Object.keys(msState.territories).length} territories
			{#if $visibleContacts.length > 0}
				&middot; {$visibleContacts.length} contacts
			{/if}
		</div>
	{/if}

	<!-- Contact detail panel -->
	{#if $selectedContact}
		{@const c = $selectedContact}
		<div class="absolute top-4 right-4 w-72 bg-[var(--color-surface)]/95 backdrop-blur-sm rounded-lg border border-[#E5B84C]/30 p-4 shadow-lg">
			<div class="flex items-start justify-between mb-2">
				<div>
					<h3 class="text-sm font-medium text-[var(--color-text-emphasis)]">{c.name}</h3>
					{#if c.position || c.company}
						<p class="text-[0.65rem] text-[var(--color-text-secondary)] mt-0.5">
							{[c.position, c.company].filter(Boolean).join(' · ')}
						</p>
					{/if}
				</div>
				<button
					onclick={() => mindscapeState.selectContact(null)}
					class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm leading-none"
				>&times;</button>
			</div>

			<div class="flex items-center gap-2 mb-3">
				<span class="text-[0.6rem] px-1.5 py-0.5 rounded-full border"
					style="border-color: #E5B84C; color: #E5B84C">{c.tier}</span>
				{#if c.interaction_count}
					<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">{c.interaction_count} messages</span>
				{/if}
				{#if c.connected_at}
					<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">since {new Date(c.connected_at).getFullYear()}</span>
				{/if}
			</div>

			{#if c.territories.length > 0}
				<div class="mb-3">
					<p class="text-[0.6rem] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">Territories</p>
					<div class="flex flex-wrap gap-1">
						{#each c.territories.slice(0, 6) as t}
							<span class="text-[0.55rem] px-1.5 py-0.5 rounded bg-[var(--color-elevated)] text-[var(--color-text-secondary)]">
								{t.territory_name || `T${t.territory_id}`}
								<span class="opacity-50">({(t.strength * 100).toFixed(0)}%)</span>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			{#if c.linkedin_url}
				<a href={c.linkedin_url} target="_blank" rel="noopener"
					class="text-[0.6rem] text-[#0A66C2] hover:underline">LinkedIn Profile</a>
			{/if}
		</div>
	{/if}

	<!-- Layer controls -->
	<div class="absolute bottom-4 right-4 bg-[var(--color-surface)]/90 backdrop-blur-sm rounded-lg border border-[var(--color-border)] p-2.5 min-w-[140px]">
		<div class="text-[0.55rem] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5 px-1">Layers</div>

		<!-- Points layer -->
		<button
			onclick={togglePoints}
			class="flex items-center gap-2 text-[0.65rem] px-1.5 py-1 rounded w-full transition-colors"
			class:text-[var(--color-text-primary)]={showPoints}
			class:text-[var(--color-text-tertiary)]={!showPoints}
			class:opacity-40={!showPoints}
		>
			<span class="w-2 h-2 rounded-full" style="background: {showPoints ? '#3B82F6' : 'var(--color-border)'}"></span>
			Points
			<span class="ml-auto text-[0.55rem] opacity-60">{visiblePoints.length.toLocaleString()}</span>
		</button>

		<!-- Contacts layer -->
		<button
			onclick={() => mindscapeState.toggleSocialLayer()}
			class="flex items-center gap-2 text-[0.65rem] px-1.5 py-1 rounded w-full transition-colors"
			class:text-[#E5B84C]={msState.showSocialLayer}
			class:text-[var(--color-text-tertiary)]={!msState.showSocialLayer}
			class:opacity-40={!msState.showSocialLayer}
		>
			<span class="w-2 h-2 rounded-full" style="background: {msState.showSocialLayer ? '#E5B84C' : 'var(--color-border)'}"></span>
			Contacts
			<span class="ml-auto text-[0.55rem] opacity-60">{msState.contacts.length}</span>
		</button>

		<!-- Tier filters (when contacts visible) -->
		{#if msState.showSocialLayer && msState.tiers.length > 0}
			<div class="flex flex-col gap-0.5 mt-1 pt-1 border-t border-[var(--color-border)] pl-4">
				{#each msState.tiers.filter(t => ['inner', 'engaged', 'acknowledged'].includes(t.tier)) as t}
					<button
						onclick={() => mindscapeState.toggleTier(t.tier)}
						class="flex items-center gap-1.5 text-[0.55rem] px-1 py-0.5 rounded w-full transition-colors"
						class:text-[var(--color-text-primary)]={msState.visibleTiers.has(t.tier)}
						class:text-[var(--color-text-tertiary)]={!msState.visibleTiers.has(t.tier)}
						class:opacity-40={!msState.visibleTiers.has(t.tier)}
					>
						<span class="w-1.5 h-1.5 rounded-full" style="background: {msState.visibleTiers.has(t.tier) ? '#E5B84C' : 'var(--color-border)'}"></span>
						{t.tier} ({t.count})
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Radio drum dial — ticks on a barrel surface -->
	{#if visiblePoints.length > 0}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="timeline-dial"
			class:active={timelineEnabled}
			onmousedown={(e) => {
				e.stopPropagation();
				e.preventDefault();
				const startX = e.clientX;
				const startPos = timePosition;
				const rect = e.currentTarget.getBoundingClientRect();
				const sensitivity = 1.5 / rect.width;
				timelineEnabled = true;
				document.body.style.userSelect = 'none';
				document.body.style.cursor = 'ew-resize';
				const onMove = (ev: MouseEvent) => {
					ev.preventDefault();
					const dx = startX - ev.clientX;
					timePosition = Math.max(0, Math.min(1, startPos + dx * sensitivity));
				};
				const onUp = () => {
					document.body.style.userSelect = '';
					document.body.style.cursor = '';
					window.removeEventListener('mousemove', onMove);
					window.removeEventListener('mouseup', onUp);
				};
				window.addEventListener('mousemove', onMove);
				window.addEventListener('mouseup', onUp);
			}}
			onwheel={(e) => {
				e.preventDefault();
				timelineEnabled = true;
				timePosition = Math.max(0, Math.min(1, timePosition + e.deltaX * 0.0008 + e.deltaY * 0.0008));
			}}
			ondblclick={(e) => { e.stopPropagation(); timelineEnabled = false; timePosition = 1.0; }}
		>
			<div class="dial-drum">
				<!-- Ticks positioned on a cylinder surface -->
				{#each timelineTicks as tick}
					{@const relPos = tick.pos - timePosition}
					{@const angle = relPos * 90}
					{@const absAngle = Math.abs(angle)}
					{#if absAngle < 75}
						{@const rad = angle * Math.PI / 180}
						{@const xPx = Math.sin(rad) * 220}
						{@const cosA = Math.cos(rad)}
						<div
							class="dial-tick"
							style="
								left: calc(50% + {xPx}px);
								height: {(6 + tick.height * 20) * cosA}px;
								opacity: {(0.15 + tick.height * 0.55) * cosA * cosA};
								transform: translateX(-50%) scaleX({cosA});
							"
						></div>
					{/if}
				{/each}

				<!-- Year labels on the drum -->
				{#each [...new Set(timelineTicks.map(t => t.date.getFullYear()))] as year}
					{@const yearStart = new Date(year, 0, 1).getTime()}
					{@const yearPos = (yearStart - timeRange.min) / (timeRange.max - timeRange.min)}
					{@const relPos = yearPos - timePosition}
					{@const angle = relPos * 90}
					{@const absAngle = Math.abs(angle)}
					{#if absAngle < 60}
						{@const rad = angle * Math.PI / 180}
						{@const xPx = Math.sin(rad) * 220}
						{@const cosA = Math.cos(rad)}
						<div
							class="dial-year"
							style="
								left: calc(50% + {xPx}px);
								opacity: {0.25 * cosA * cosA};
								transform: translateX(-50%) scaleX({cosA});
							"
						>{year}</div>
					{/if}
				{/each}
			</div>

			<!-- Fixed center needle -->
			<div class="dial-needle"></div>

			<!-- Date label above dial -->
			{#if timelineEnabled}
				{@const currentDate = new Date(timeRange.min + timePosition * (timeRange.max - timeRange.min))}
				<div class="dial-date">{currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
			{/if}
		</div>
	{/if}

	<!-- Point tooltip -->
	{#if tooltipVisible && tooltipData}
		<div
			class="absolute pointer-events-none z-50 bg-[var(--color-surface)]/95 backdrop-blur-sm border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg max-w-[260px]"
			style="left: {tooltipX}px; top: {tooltipY}px; transform: translateY(-100%);"
		>
			{#if tooltipData.territory}
				<div class="text-[0.7rem] font-medium text-[var(--color-text-primary)] leading-tight">{tooltipData.territory}</div>
			{/if}
			{#if tooltipData.essence}
				<div class="text-[0.6rem] text-[var(--color-text-secondary)] leading-snug mt-0.5 line-clamp-2 italic">{tooltipData.essence}</div>
			{/if}
			<div class="flex items-center gap-2 mt-1 text-[0.55rem] text-[var(--color-text-tertiary)]">
				{#if tooltipData.realm}
					<span>{tooltipData.realm}</span>
				{/if}
				{#if tooltipData.type}
					<span class="capitalize">{tooltipData.type}</span>
				{/if}
				{#if tooltipData.date}
					<span>{tooltipData.date}</span>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	/* Ethereal drum dial — floating ticks, no box */
	.timeline-dial {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		width: 380px;
		max-width: 45%;
		height: 32px;
		cursor: ew-resize;
		z-index: 30;
		opacity: 0.4;
		transition: opacity 0.5s;
	}
	.timeline-dial:hover, .timeline-dial.active {
		opacity: 0.9;
	}
	.dial-drum {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		/* Radial fade mask — ticks dissolve at the edges */
		-webkit-mask-image: linear-gradient(
			to right,
			transparent 0%,
			rgba(0,0,0,0.3) 10%,
			rgba(0,0,0,1) 30%,
			rgba(0,0,0,1) 70%,
			rgba(0,0,0,0.3) 90%,
			transparent 100%
		);
		mask-image: linear-gradient(
			to right,
			transparent 0%,
			rgba(0,0,0,0.3) 10%,
			rgba(0,0,0,1) 30%,
			rgba(0,0,0,1) 70%,
			rgba(0,0,0,0.3) 90%,
			transparent 100%
		);
	}
	.dial-tick {
		position: absolute;
		bottom: 2px;
		width: 1px;
		background: rgba(255, 255, 255, 0.45);
		border-radius: 0.5px;
	}
	.dial-needle {
		position: absolute;
		left: 50%;
		top: 0;
		bottom: -4px;
		width: 1px;
		margin-left: -0.5px;
		background: linear-gradient(
			to bottom,
			transparent,
			var(--color-accent) 20%,
			var(--color-accent) 80%,
			transparent
		);
		box-shadow: 0 0 6px rgba(229, 184, 76, 0.4);
		pointer-events: none;
		z-index: 2;
	}
	.dial-year {
		position: absolute;
		bottom: 2px;
		font-size: 0.38rem;
		color: rgba(255, 255, 255, 0.15);
		white-space: nowrap;
		pointer-events: none;
		letter-spacing: 0.06em;
	}
	.dial-date {
		position: absolute;
		left: 50%;
		top: calc(100% + 3px);
		transform: translateX(-50%);
		font-size: 0.55rem;
		font-weight: 400;
		color: var(--color-accent);
		white-space: nowrap;
		pointer-events: none;
		letter-spacing: 0.05em;
		text-shadow: 0 0 12px var(--color-accent), 0 0 4px rgba(229, 184, 76, 0.5);
	}
</style>
