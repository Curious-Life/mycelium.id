<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
	import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
	import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
	import { mindscapeState, visibleContacts, selectedContact, contactMessages, contactMessagesLoading, NOISE_COLOR, timelineHealth, type MindscapePoint } from '$lib/stores/mindscape';
	import { theme } from '$lib/stores/theme';
	import { phaseColorAt, hexToRgbNormalized, type PhaseSample } from '$lib/mindscape/phase-color';
	import { api } from '$lib/api';

	// false when this Mindscape tab is backgrounded (workspace keep-alive): the
	// rAF loop stays alive for instant resume, but the expensive render is skipped.
	let { active = true } = $props();

	const SCENE_SCALE = 8;
	const isLight = $derived($theme === 'light');
	const POINT_SIZE_DARK = 0.28;
	// Light mode needs noticeably bigger dots: they're solid (not glowing), so each
	// must read as a distinct mark against the light background.
	const POINT_SIZE_LIGHT = 0.6;
	const POINT_SIZE = $derived(isLight ? POINT_SIZE_LIGHT : POINT_SIZE_DARK);
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
	let contactLabels!: THREE.Group;
	let raycaster: THREE.Raycaster;
	let mouse = new THREE.Vector2();
	let animationId: number;
	let resizeObserver: ResizeObserver;
	let contactPositions: Map<string, THREE.Vector3> = new Map();
	let coordScale = SCENE_SCALE; // updated by createPointCloud based on data range
	let showPoints = $state(true);
	// Layer-controls panel: collapsed to a tiny pill by default (per app-UI feedback)
	// so it doesn't crowd the mindscape; click to reveal the Points/Contacts toggles.
	let layersOpen = $state(false);

	// Co-firing connections state
	let cofireLines: THREE.LineSegments | null = null;
	let cofireGlows: THREE.Points | null = null;
	let cofireMaterial: THREE.ShaderMaterial | null = null;
	let cofireConnections: Array<{ territory_id: number; name: string; cofire_strength: number }> = $state([]);
	let cofireTerritoryIds: Set<number> = $state(new Set());

	// Phase halos (Mindscape Pulses — Wave M1 + M2). One glowing point
	// per territory centroid, colored by the territory's *historical*
	// phase state at the current scrub position. M2 adds the breathing
	// layer: per-territory sine oscillation (hash-seeded period + phase)
	// and a global scene breath. Only colors + amplitudes are mutated
	// on scrub change — geometry + period/phase are built once.
	let phaseHistories: Map<number, PhaseSample[]> = new Map();
	let territoryHalos: THREE.Points | null = null;
	let haloMaterial: THREE.ShaderMaterial | null = null;
	let haloColorAttr: THREE.Float32BufferAttribute | null = null;
	let haloAmpAttr: THREE.Float32BufferAttribute | null = null;
	let haloTerritoryIds: number[] = [];

	async function loadPhaseHistory() {
		try {
			const res = await api('/portal/mindscape/phase-history');
			if (!res.ok) return;
			const data = await res.json();
			const map = new Map<number, PhaseSample[]>();
			for (const t of (data.territories || [])) {
				if (Array.isArray(t.history) && t.history.length) {
					map.set(t.territory_id, t.history);
				}
			}
			phaseHistories = map;
			if (scene && msState.territories && Object.keys(msState.territories).length) {
				createPhaseHalos();
			}
		} catch { /* silent — feature degrades to no halos */ }
	}

	function createPhaseHalos() {
		if (!scene) return;
		if (territoryHalos) { scene.remove(territoryHalos); territoryHalos = null; }
		// Additive glow halos wash out on a light background — skip in light mode
		// (matches the starfield + glow-layer behaviour).
		if (isLight) return;

		const territories = msState.territories;
		const positions: number[] = [];
		const colors: number[] = [];
		// Breathing (M2): per-vertex period + phase-offset seeded by
		// hash(territory_id) so every halo is out of phase. Amplitude
		// is updated per-scrub (re-derived from vitality at that
		// historical date) by updatePhaseHaloColors.
		const periods: number[] = [];
		const phaseOffsets: number[] = [];
		const amps: number[] = [];
		haloTerritoryIds = [];

		// Cheap deterministic hash for (tid) → [0, 1)
		const hash01 = (n: number) => {
			const h = ((n * 2654435761) ^ 0x9e3779b9) >>> 0;
			return h / 4294967296;
		};

		for (const [tidStr, t] of Object.entries(territories)) {
			const tid = Number(tidStr);
			if (!t.centroid) continue;
			positions.push(
				t.centroid.x * coordScale,
				t.centroid.z * coordScale,
				t.centroid.y * coordScale,
			);
			colors.push(0.18, 0.18, 0.20);
			// Period: 2–6s mapped by hash. Phase offset: 0–2π hashed differently
			// via bit-rotation so it's independent of period.
			const r1 = hash01(tid);
			const r2 = hash01(tid ^ 0xABCDEF);
			periods.push(2.0 + r1 * 4.0);
			phaseOffsets.push(r2 * Math.PI * 2.0);
			amps.push(0.05); // placeholder — real value computed in updatePhaseHaloColors
			haloTerritoryIds.push(tid);
		}

		if (positions.length === 0) return;

		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		haloColorAttr = new THREE.Float32BufferAttribute(colors, 3);
		geo.setAttribute('color', haloColorAttr);
		geo.setAttribute('aPeriod', new THREE.Float32BufferAttribute(periods, 1));
		geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseOffsets, 1));
		haloAmpAttr = new THREE.Float32BufferAttribute(amps, 1);
		geo.setAttribute('aAmp', haloAmpAttr);

		// M2 breathing shader: each halo pulses on its own period.
		// Amplitude multiplies size + opacity. A global breath (uGlobalBreath)
		// modulates the whole scene on ~20s sine so the whole mindscape
		// inhales + exhales together.
		haloMaterial = new THREE.ShaderMaterial({
			uniforms: {
				uSize: { value: 80.0 },
				uTime: { value: 0 },
				uGlobalBreath: { value: 1.0 },
				uBreathScale: { value: 1.0 }, // M4 toggle — 0 = off, 1 = on
			},
			vertexShader: `
				attribute float aPeriod;
				attribute float aPhase;
				attribute float aAmp;
				varying vec3 vColor;
				varying float vBreath;
				uniform float uSize;
				uniform float uTime;
				uniform float uGlobalBreath;
				uniform float uBreathScale;

				void main() {
					vColor = color;
					// Per-halo sine pulse. aAmp ranges 0.02 (dormant) to 0.07
					// (peak active). uBreathScale zeros out the breathing
					// entirely when the user disables it from the Pulses lens.
					float effectiveAmp = aAmp * uBreathScale;
					float breath = 1.0 + effectiveAmp * sin(uTime * 6.2831853 / aPeriod + aPhase);
					vBreath = breath;
					vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = (uSize * breath * uGlobalBreath) / (-mvPos.z);
					gl_Position = projectionMatrix * mvPos;
				}
			`,
			fragmentShader: `
				varying vec3 vColor;
				varying float vBreath;
				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float r = length(uv) * 2.0;
					if (r > 1.0) discard;
					float glow = pow(1.0 - r, 2.5);
					// Opacity also pulses with breath — softer variation (0.6 factor).
					float opacity = 0.55 * (1.0 + (vBreath - 1.0) * 0.6);
					gl_FragColor = vec4(vColor, glow * opacity);
				}
			`,
			blending: THREE.AdditiveBlending,
			transparent: true,
			depthWrite: false,
			vertexColors: true,
		});

		territoryHalos = new THREE.Points(geo, haloMaterial);
		scene.add(territoryHalos);
		updatePhaseHaloColors();
	}

	function updatePhaseHaloColors() {
		if (!haloColorAttr || !phaseHistories.size || haloTerritoryIds.length === 0) return;
		const tMs = timeRange.min + timePosition * (timeRange.max - timeRange.min);
		if (!tMs || !isFinite(tMs)) return;

		const colorArr = haloColorAttr.array as Float32Array;
		const ampArr = haloAmpAttr?.array as Float32Array | undefined;
		for (let i = 0; i < haloTerritoryIds.length; i++) {
			const tid = haloTerritoryIds[i];
			const hist = phaseHistories.get(tid);
			if (!hist) {
				colorArr[i * 3] = 0.18; colorArr[i * 3 + 1] = 0.18; colorArr[i * 3 + 2] = 0.20;
				// Dormant: minimum breathing amplitude so dead territories
				// still subtly move — keeps the mindscape feeling alive
				// without making dormancy invisible.
				if (ampArr) ampArr[i] = 0.04;
				continue;
			}
			const pc = phaseColorAt(hist, tMs);
			const r = parseInt(pc.hex.slice(1, 3), 16) / 255;
			const g = parseInt(pc.hex.slice(3, 5), 16) / 255;
			const b = parseInt(pc.hex.slice(5, 7), 16) / 255;
			colorArr[i * 3]     = r * pc.brightness;
			colorArr[i * 3 + 1] = g * pc.brightness;
			colorArr[i * 3 + 2] = b * pc.brightness;
			// Amplitude scaled by vitality. Gentler than the initial
			// tuning — feedback was "pulsation felt unnatural", so we
			// halve the range: 0.02 (dormant) → 0.07 (peak active).
			// The breathing now whispers more than it rocks.
			if (ampArr) {
				const freqNormalized = Math.max(0, Math.min(1, (pc.brightness - 0.25) / 0.75));
				ampArr[i] = 0.02 + 0.05 * freqNormalized;
			}
		}
		haloColorAttr.needsUpdate = true;
		if (haloAmpAttr) haloAmpAttr.needsUpdate = true;
		// Freshly-computed base colors become the reference for
		// afterglow multiplication every render frame.
		captureBaseHaloColors();
	}

	function clearPhaseHalos() {
		if (territoryHalos && scene) { scene.remove(territoryHalos); territoryHalos = null; }
		haloColorAttr = null;
		haloMaterial = null;
		haloTerritoryIds = [];
	}

	// ── Firing pulses (Mindscape Pulses — Wave M3) ──────────────────
	//
	// A pulse is emitted for each consecutive-pair firing within the
	// current scrub's window. The pulse travels A→B on its own wall-
	// clock cycle (animation runs regardless of scrub position; scrub
	// position controls WHICH pulses are active). Re-rendered via a
	// single THREE.LineSegments overlay — one pair per active pulse,
	// updated only when the pulse set changes (positions are constant
	// between scrub changes; progress advances via per-vertex attribute
	// updated each frame).

	interface FiringPoint { tid: number; t: number; }
	interface ActivePulse {
		key: string;
		sourceTid: number;
		destTid: number;
		firingStart: number;   // historical t1 (ms)
		delta: number;         // t2 - t1 (ms)
		wallClockStart: number; // wall-clock ms when the current cycle began
		cycleDurationMs: number;
		sourceColor: [number, number, number]; // rgb 0..1
		destColor: [number, number, number];
		cycleArrivalFired: boolean; // true once current cycle's arrival was registered
	}

	let firingSequence: FiringPoint[] = [];
	let activePulses: Map<string, ActivePulse> = new Map();
	let pulseSegments: THREE.LineSegments | null = null;
	let pulseMaterial: THREE.ShaderMaterial | null = null;
	let pulseProgressAttr: THREE.Float32BufferAttribute | null = null;
	let pulseGeometryValid = false; // false → rebuild this frame

	// Arrival afterglow: when a pulse's progress reaches 1, record a
	// short-lived brightness spike on the destination territory's halo.
	// Multiple hits in quick succession compound additively (capped)
	// with a subtle chromatic shift toward white.
	// Key = destTid, value = last arrival wall-clock + accumulated intensity.
	let territoryAfterglow: Map<number, { lastHitMs: number; intensity: number }> = new Map();
	// Longer decay — arrivals linger and blend into each other instead
	// of hard-stopping. Feels like waves overlapping on a shore, not
	// a string of distinct flashes.
	const AFTERGLOW_DECAY_MS = 1500;
	const AFTERGLOW_PEAK = 0.8;    // added on top of base brightness 1.0
	const AFTERGLOW_CAP = 1.5;     // combined max additive boost

	function loadFiringSequence() {
		const pts = msState.points || [];
		const seq: FiringPoint[] = [];
		for (const p of pts) {
			const tid = p?.data?.cluster3d;
			const ts = p?.data?.timestamp;
			if (tid == null || tid < 0 || !ts) continue;
			const t = Date.parse(ts);
			if (!isFinite(t)) continue;
			seq.push({ tid, t });
		}
		seq.sort((a, b) => a.t - b.t);
		firingSequence = seq;
	}

	function binarySearchFiringStart(target: number): number {
		let lo = 0, hi = firingSequence.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (firingSequence[mid].t < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	function extractCurrentPulses() {
		if (!firingSequence.length || !phaseHistories.size) return;
		const scrubMs = timeRange.min + timePosition * (timeRange.max - timeRange.min);
		const spanMs = timeRange.max - timeRange.min || 1;
		const windowMs = spanMs * 0.075; // 7.5% of visible span (locked Q2)
		const windowStart = scrubMs - windowMs;

		const territories = msState.territories;
		const currentKeys = new Set<string>();
		const wallNow = performance.now();
		let changed = false;

		const startIdx = binarySearchFiringStart(windowStart);
		for (let i = startIdx; i < firingSequence.length - 1; i++) {
			const a = firingSequence[i];
			if (a.t > scrubMs) break;
			const b = firingSequence[i + 1];
			if (b.t > scrubMs) break;
			const delta = b.t - a.t;
			if (delta > windowMs) continue;
			if (a.tid === b.tid) continue;
			// Skip if we don't have centroids for both
			if (!territories[a.tid]?.centroid || !territories[b.tid]?.centroid) continue;

			const key = `${a.tid}-${b.tid}-${a.t}`;
			currentKeys.add(key);
			if (!activePulses.has(key)) {
				// New pulse — small delta = fast pulse (near-simultaneous firing).
				// Large delta (close to window) = slow drift. Durations
				// scaled up 3× from the initial tuning so arrivals feel
				// like ocean swells, not strobe flashes.
				const pulseDuration = 1500 + (delta / windowMs) * 6000;
				const aHist = phaseHistories.get(a.tid);
				const bHist = phaseHistories.get(b.tid);
				const pcA = aHist ? phaseColorAt(aHist, a.t) : null;
				const pcB = bHist ? phaseColorAt(bHist, b.t) : null;
				const sourceColor = pcA ? hexToRgbNormalized(pcA.hex) : [0.5, 0.5, 0.5] as [number, number, number];
				const destColor = pcB ? hexToRgbNormalized(pcB.hex) : [0.5, 0.5, 0.5] as [number, number, number];
				activePulses.set(key, {
					key, sourceTid: a.tid, destTid: b.tid,
					firingStart: a.t, delta,
					wallClockStart: wallNow,
					cycleDurationMs: pulseDuration,
					sourceColor, destColor,
					cycleArrivalFired: false,
				});
				changed = true;
			}
		}

		// Remove pulses that fell out of the window.
		for (const k of activePulses.keys()) {
			if (!currentKeys.has(k)) { activePulses.delete(k); changed = true; }
		}

		if (changed) pulseGeometryValid = false;
	}

	function rebuildPulseGeometry() {
		if (!scene) return;
		if (pulseSegments) { scene.remove(pulseSegments); pulseSegments = null; }
		pulseProgressAttr = null;

		if (activePulses.size === 0) { pulseGeometryValid = true; return; }

		const territories = msState.territories;
		const positions: number[] = [];
		const colors: number[] = [];
		const alphas: number[] = []; // per-vertex alpha (pair shares value)

		for (const p of activePulses.values()) {
			const a = territories[p.sourceTid]?.centroid;
			const b = territories[p.destTid]?.centroid;
			if (!a || !b) continue;
			positions.push(
				a.x * coordScale, a.z * coordScale, a.y * coordScale,
				b.x * coordScale, b.z * coordScale, b.y * coordScale,
			);
			colors.push(...p.sourceColor, ...p.destColor);
			alphas.push(0, 0); // updated per-frame
		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
		pulseProgressAttr = new THREE.Float32BufferAttribute(alphas, 1);
		geo.setAttribute('aAlpha', pulseProgressAttr);

		// Ghost trails — lines are intentionally almost-invisible.
		// Three rounds of user feedback converged on: the dots are the
		// show, the lines are just a hint that two territories just
		// fired in sequence. Normal (not additive) blending so
		// overlapping lines don't stack into bright regions. Max
		// opacity 0.04 — you have to squint to see them, which is the
		// point.
		pulseMaterial = new THREE.ShaderMaterial({
			uniforms: {},
			vertexShader: `
				attribute float aAlpha;
				varying vec3 vColor;
				varying float vAlpha;
				void main() {
					vColor = color;
					vAlpha = aAlpha;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: `
				varying vec3 vColor;
				varying float vAlpha;
				void main() {
					gl_FragColor = vec4(vColor, vAlpha * 0.04);
				}
			`,
			blending: THREE.NormalBlending,
			transparent: true,
			depthWrite: false,
			vertexColors: true,
		});

		pulseSegments = new THREE.LineSegments(geo, pulseMaterial);
		scene.add(pulseSegments);
		pulseGeometryValid = true;
	}

	function updatePulseProgressAttr() {
		if (!pulseProgressAttr || activePulses.size === 0) return;
		const arr = pulseProgressAttr.array as Float32Array;
		const wallNow = performance.now();
		let idx = 0;
		for (const p of activePulses.values()) {
			// Single-fire, no loop. Once the cycle completes the pulse
			// sits dormant in activePulses until the scrub window moves
			// past it and extractCurrentPulses drops it. The "Christmas
			// tree" feel of the old looping version came from constant
			// restarts — a scrub at rest now goes calm: arrivals happen,
			// halos bloom and fade, and the scene settles.
			const t = Math.max(0, Math.min(1, (wallNow - p.wallClockStart) / p.cycleDurationMs));
			// Long flowing envelope: fade in 0-20%, hold 20-60%, fade
			// out 60-100%. Lines are visible through most of the
			// cycle but barely so (shader alpha cap 0.04), overlapping
			// cycles blend. Ocean, not strobe.
			let alpha = 0;
			if (t < 0.2) alpha = t / 0.2;
			else if (t < 0.6) alpha = 1;
			else if (t < 1.0) alpha = 1 - (t - 0.6) / 0.4;
			// After t=1 alpha stays 0 (single-fire).
			// Arrival afterglow once per cycle at t ≈ 0.65 — signal
			// "arrives" and the destination halo blooms. Source gets a
			// smaller preview at t ≈ 0.1. registerArrival returns
			// early if we try to fire twice, via cycleArrivalFired.
			if (!p.cycleArrivalFired && t >= 0.65) {
				registerArrival(p.destTid, wallNow);
				registerArrival(p.sourceTid, wallNow - 400, 0.35);
				p.cycleArrivalFired = true;
			}
			arr[idx++] = alpha;
			arr[idx++] = alpha;
		}
		pulseProgressAttr.needsUpdate = true;
	}

	function registerArrival(tid: number, wallNow: number, peak: number = AFTERGLOW_PEAK) {
		const prev = territoryAfterglow.get(tid);
		if (!prev) {
			territoryAfterglow.set(tid, { lastHitMs: wallNow, intensity: peak });
			return;
		}
		// Decay prev intensity to now, then add new peak, capped.
		const ageMs = wallNow - prev.lastHitMs;
		const decayed = prev.intensity * Math.exp(-ageMs / AFTERGLOW_DECAY_MS);
		const combined = Math.min(AFTERGLOW_CAP, decayed + peak);
		territoryAfterglow.set(tid, { lastHitMs: wallNow, intensity: combined });
	}

	// Called every frame. Applies the decaying afterglow boost to each
	// halo's per-vertex color, on top of the base phase color written
	// by updatePhaseHaloColors. Two-step: base color is refreshed from
	// the color cache (not re-read from history; that's done in the
	// scrub effect) and then multiplied by (1 + afterglow_factor).
	let baseHaloColors: Float32Array | null = null;
	function captureBaseHaloColors() {
		if (!haloColorAttr) return;
		const arr = haloColorAttr.array as Float32Array;
		baseHaloColors = new Float32Array(arr.length);
		baseHaloColors.set(arr);
	}
	function applyAfterglowToHalos(wallNow: number) {
		if (!haloColorAttr || !baseHaloColors) return;
		const arr = haloColorAttr.array as Float32Array;
		let changed = false;
		for (let i = 0; i < haloTerritoryIds.length; i++) {
			const tid = haloTerritoryIds[i];
			const glow = territoryAfterglow.get(tid);
			if (!glow) continue;
			const ageMs = wallNow - glow.lastHitMs;
			const factor = glow.intensity * Math.exp(-ageMs / AFTERGLOW_DECAY_MS);
			if (factor < 0.01) {
				territoryAfterglow.delete(tid);
				// Restore base.
				arr[i * 3]     = baseHaloColors[i * 3];
				arr[i * 3 + 1] = baseHaloColors[i * 3 + 1];
				arr[i * 3 + 2] = baseHaloColors[i * 3 + 2];
				changed = true;
				continue;
			}
			// Multiply base by (1 + factor). Subtle chromatic shift: blend
			// toward white proportional to factor, so stacked arrivals
			// read as "being hammered" rather than just redder/oranger.
			const boost = 1 + factor;
			const whiteMix = Math.min(0.4, factor * 0.25);
			arr[i * 3]     = Math.min(1, baseHaloColors[i * 3]     * boost + whiteMix);
			arr[i * 3 + 1] = Math.min(1, baseHaloColors[i * 3 + 1] * boost + whiteMix);
			arr[i * 3 + 2] = Math.min(1, baseHaloColors[i * 3 + 2] * boost + whiteMix);
			changed = true;
		}
		if (changed) haloColorAttr.needsUpdate = true;
	}

	function clearPulses() {
		if (pulseSegments && scene) { scene.remove(pulseSegments); pulseSegments = null; }
		pulseMaterial = null;
		pulseProgressAttr = null;
		activePulses = new Map();
		firingSequence = [];
	}

	async function loadCofire(territoryId: number) {
		try {
			const res = await api(`/portal/mindscape/cofire?territory=${territoryId}&scale=daily&limit=8`);
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
		if (!scene) return;
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
			// Additive glow washes out on a light bg — show the lines only there.
			if (!isLight) {
				cofireGlows = new THREE.Points(glowGeo, cofireMaterial);
				scene.add(cofireGlows);
			}
		}
	}

	// Ticker feedback — data-driven wind chimes
	// Entropy → note range (focused = low, diverse = high)
	// Health coherence (HRV) → crystallinity (pure vs detuned)
	// Activity volume → amplitude + harmonic richness
	let audioCtx: AudioContext | null = null;
	let lastTickIndex = -1;
	let lastTickTime = 0;

	// Pentatonic scale in two octaves — wind chime tuning
	const CHIME_NOTES = [
		523.25, 587.33, 659.25, 783.99, 880.00,   // C5 D5 E5 G5 A5
		1046.50, 1174.66, 1318.51, 1567.98, 1760.00, // C6 D6 E6 G6 A6
	];

	function getHealthCoherence(tickDate: Date): number {
		if (!healthDays.length) return 0.5;
		const target = tickDate.toISOString().slice(0, 7); // YYYY-MM
		const nearby = healthDays.filter(d => d.date.startsWith(target));
		if (!nearby.length) return 0.5;
		const hrvValues = nearby.map(d => d.hrv_avg).filter(v => v != null) as number[];
		if (!hrvValues.length) return 0.5;
		const avgHrv = hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length;
		return Math.min(1, Math.max(0, (avgHrv - 20) / 60)); // 20ms=0, 80ms=1
	}

	function tickFeedback(volume: number, entropy: number) {
		const now = performance.now();
		const dt = now - lastTickTime;
		lastTickTime = now;

		const speed = Math.min(1, 80 / Math.max(dt, 1));

		if (navigator.vibrate) navigator.vibrate(speed > 0.7 ? 1 : 2);

		if (!audioCtx) {
			try { audioCtx = new AudioContext(); } catch { return; }
		}
		if (audioCtx.state === 'suspended') audioCtx.resume();
		const ctxNow = audioCtx.currentTime;

		if (speed > 0.8 && Math.random() > 0.3) return;

		// Get health coherence + chronicle signature for the current tick position
		const tickIdx = lastTickIndex >= 0 && lastTickIndex < timelineTicks.length ? lastTickIndex : 0;
		const tickDate = timelineTicks[tickIdx]?.date || new Date();
		const coherence = getHealthCoherence(tickDate);
		const chronicle = getChronicleNearDate(tickDate);

		// Signature shapes the musical character:
		// steady → consonant intervals, even spacing, gentle
		// exploring → wider note range, more randomness, bright
		// consolidating → lower notes, tighter intervals, grounded
		// fragmenting → dissonant, wider jumps, more shimmer
		const sig = chronicle?.signature || 'steady';
		const sigParams = {
			steady:        { octaveBase: 0, range: 4, jumpiness: 0.2, shimmerMul: 0.8 },
			exploring:     { octaveBase: 3, range: 7, jumpiness: 0.6, shimmerMul: 1.2 },
			consolidating: { octaveBase: 0, range: 3, jumpiness: 0.1, shimmerMul: 0.6 },
			fragmenting:   { octaveBase: 2, range: 8, jumpiness: 0.8, shimmerMul: 1.5 },
		}[sig] || { octaveBase: 0, range: 5, jumpiness: 0.3, shimmerMul: 1.0 };

		// Note selection: signature + entropy combined
		const octaveShift = sigParams.octaveBase + (entropy > 0.5 ? 2 : 0);
		const rangeWidth = Math.min(sigParams.range, CHIME_NOTES.length - octaveShift);
		const notePool = CHIME_NOTES.slice(octaveShift, octaveShift + Math.max(2, rangeWidth));
		// Jumpiness: how far apart consecutive notes can be
		const noteIdx = Math.floor(Math.random() * notePool.length * (0.5 + sigParams.jumpiness * 0.5));
		const baseFreq = notePool[Math.min(noteIdx, notePool.length - 1)];

		// Coherence drives crystallinity:
		// High coherence (high HRV) → pure, clean tone, minimal detuning
		// Low coherence (low HRV) → slightly rough, more detuning, warmer
		const detuneAmount = 0.001 + (1 - coherence) * 0.015; // 0.1-1.6% detuning
		const freq = baseFreq * (1 + (Math.random() - 0.5) * detuneAmount);

		// Volume scales with activity + coherence brightness
		const amp = (0.012 + volume * 0.02) * (0.7 + coherence * 0.3) * (1 - speed * 0.5);
		// Decay: coherent = longer ring, incoherent = shorter, muffled
		const decay = (0.3 + coherence * 0.6) + volume * 0.5 + Math.random() * 0.2;

		// Fundamental — always present
		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;
		gain.gain.setValueAtTime(amp, ctxNow);
		gain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + decay);
		osc.connect(gain);
		gain.connect(audioCtx.destination);
		osc.start(ctxNow);
		osc.stop(ctxNow + decay + 0.05);

		// Metallic partial (2.76×) — stronger when coherent (crystalline)
		const partialAmp = amp * (0.15 + coherence * 0.25); // 0.15-0.40
		const partial = audioCtx.createOscillator();
		const partialGain = audioCtx.createGain();
		partial.type = 'sine';
		partial.frequency.value = freq * 2.76;
		partialGain.gain.setValueAtTime(partialAmp, ctxNow);
		partialGain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + decay * (0.4 + coherence * 0.3));
		partial.connect(partialGain);
		partialGain.connect(audioCtx.destination);
		partial.start(ctxNow);
		partial.stop(ctxNow + decay * 0.7 + 0.05);

		// High shimmer (5.40×) — crystalline "ting", shaped by signature
		// Fragmenting periods get more shimmer (restless energy)
		// Consolidating periods get less (grounded, resolved)
		if (coherence > 0.3 || sigParams.shimmerMul > 1) {
			const shimmer = audioCtx.createOscillator();
			const shimmerGain = audioCtx.createGain();
			shimmer.type = 'sine';
			shimmer.frequency.value = freq * 5.40;
			const shimmerAmp = amp * coherence * 0.15 * sigParams.shimmerMul;
			shimmerGain.gain.setValueAtTime(shimmerAmp, ctxNow);
			shimmerGain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + decay * 0.2);
			shimmer.connect(shimmerGain);
			shimmerGain.connect(audioCtx.destination);
			shimmer.start(ctxNow);
			shimmer.stop(ctxNow + decay * 0.2 + 0.05);
		}

		// Sub-harmonic warmth — only when incoherent (adds body to muddier periods)
		if (coherence < 0.4 && volume > 0.3) {
			const sub = audioCtx.createOscillator();
			const subGain = audioCtx.createGain();
			sub.type = 'sine';
			sub.frequency.value = freq * 0.5;
			subGain.gain.setValueAtTime(amp * 0.2 * (1 - coherence), ctxNow);
			subGain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + decay * 0.5);
			sub.connect(subGain);
			subGain.connect(audioCtx.destination);
			sub.start(ctxNow);
			sub.stop(ctxNow + decay * 0.5 + 0.05);
		}
	}

	function checkTickCrossing(pos: number) {
		if (!timelineTicks.length) return;
		let nearest = 0;
		let minDist = Infinity;
		for (let i = 0; i < timelineTicks.length; i++) {
			const d = Math.abs(timelineTicks[i].pos - pos);
			if (d < minDist) { minDist = d; nearest = i; }
		}
		if (nearest !== lastTickIndex && minDist < 0.02) {
			lastTickIndex = nearest;
			tickFeedback(timelineTicks[nearest].height, timelineTicks[nearest].entropy);
		}
	}

	// Timeline state
	let timelineEnabled = $state(false);
	let timePosition = $state(1.0); // 0..1 normalized position (1 = now)
	let timeRange = $state({ min: 0, max: 0 }); // epoch ms
	let timelineTicks: Array<{ pos: number; height: number; date: Date; count: number; entropy: number; illuminated: boolean }> = $state([]);

	// Health data overlay for timeline
	interface HealthDay { date: string; sleep_duration_min: number|null; hrv_avg: number|null; resting_hr: number|null; steps: number|null; mindful_minutes: number|null; }
	let healthDays: HealthDay[] = $state([]);
	let healthLoaded = false;

	// Time chronicles for timeline display
	interface TimeChronicle { period_key: string; theme: string; signature: string; territory_count: number; message_count: number; }
	let timeChronicles: TimeChronicle[] = $state([]);
	let chroniclesLoaded = false;
	let illuminatingPeriod: string | null = $state(null);

	async function loadTimeChronicles() {
		if (chroniclesLoaded) return;
		chroniclesLoaded = true;
		try {
			const res = await api('/portal/mindscape/time-chronicles');
			if (res.ok) {
				const data = await res.json();
				timeChronicles = data.chronicles || [];
			}
		} catch {}
	}

	function getChronicleAtDate(d: Date): TimeChronicle | null {
		if (!timeChronicles.length) return null;
		const key = d.toISOString().slice(0, 10);
		return timeChronicles.find(c => c.period_key === key) || null;
	}

	function getChronicleNearDate(d: Date): TimeChronicle | null {
		if (!timeChronicles.length) return null;
		const target = d.getTime();
		let best: TimeChronicle | null = null;
		let bestDist = Infinity;
		for (const c of timeChronicles) {
			const dist = Math.abs(new Date(c.period_key).getTime() - target);
			if (dist < bestDist) { bestDist = dist; best = c; }
		}
		return best;
	}

	async function loadHealthForTimeline() {
		if (healthLoaded || timeRange.min === 0) return;
		healthLoaded = true;
		try {
			const from = new Date(timeRange.min).toISOString().split('T')[0];
			const to = new Date(timeRange.max).toISOString().split('T')[0];
			const res = await api(`/portal/health/range?from=${from}&to=${to}`);
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
	let tooltipBelow = $state(false); // true → anchor below the cursor (no room above)
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
			let saturation = isLight ? 0.45 : 0.25;
			if (t.activity && t.activity.length > 0) {
				const sorted = [...t.activity].sort((a, b) => b.month.localeCompare(a.month));
				const recent = sorted.slice(0, 3).reduce((s: number, m: { count: number }) => s + m.count, 0);
				const total = t.activity.reduce((s: number, m: { count: number }) => s + m.count, 0);
				saturation = isLight
					? 0.45 + 0.4 * (total > 0 ? recent / total : 0)   // light: vivid
					: 0.2 + 0.45 * (total > 0 ? recent / total : 0);  // dark: subtle glow
			}

			// Lightness: light mode needs medium (not too bright on light bg), dark mode needs low-to-mid
			const lightness = isLight
				? 0.35 + 0.25 * (Math.log(1 + t.count) / Math.log(1 + maxCount))  // 0.35-0.60
				: 0.15 + 0.35 * (Math.log(1 + t.count) / Math.log(1 + maxCount)); // 0.15-0.50

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
		const noiseCol = isLight ? '#C8C8D0' : NOISE_COLOR;
		if (id === -1 || id === null || id === undefined) return noiseCol;
		// Always use territory colors — fractal consistency across all zoom levels
		return dataColors.territory.get(id) || NOISE_COLOR;
	}

	function getDataBounds(arr: number[]) {
		let min = Infinity, max = -Infinity;
		for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
		return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
	}

	function getBgColor(): string {
		// Warm paper/parchment — harmonises with the light palette (--color-bg #FAF8F5,
		// surface #F5F3EE, elevated #EBE8E2), a touch deeper so the canvas reads as its
		// own surface. The dark points (createPointCloud) then sit on it like ink.
		if (isLight) return '#F2ECE1';
		const style = getComputedStyle(document.documentElement);
		return style.getPropertyValue('--color-bg').trim() || '#0A0A0C';
	}

	function createStarfield() {
		if (!scene) return;
		if (starfield) scene.remove(starfield);
		// No starfield in light mode
		if (isLight) return;

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
		if (!scene) return;
		if (glowLayer) scene.remove(glowLayer);
		// No glow halos in light mode — they don't work on light backgrounds
		if (isLight) return;

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
		renderer.toneMapping = isLight ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.1;
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		// Setup clock for animations
		clock = new THREE.Clock();

		// Setup composer — bloom in dark mode, plain render in light mode
		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		if (!isLight) {
			const bloomPass = new UnrealBloomPass(
				new THREE.Vector2(container.clientWidth, container.clientHeight),
				0.35, // strength — gentle nebula haze
				0.5,  // radius — wider spread for soft halos
				0.5   // threshold — catch glow halos, not data points
			);
			composer.addPass(bloomPass);
		}
		composer.addPass(new OutputPass());

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.05;
		controls.minDistance = 5;
		controls.maxDistance = 100;

		if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('capture')) {
			controls.autoRotate = true;
			controls.autoRotateSpeed = 2.0;
			controls.enableZoom = false;
			controls.enablePan = false;
		}

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
		if (!scene) return;
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

			// Saturation: more vivid — Hubble vibrancy. Light mode pushes clustered
			// points MORE saturated (vivid darks read on a light bg) and keeps noise
			// nearly grey so it recedes.
			const satRaw = ((px * 3.71 + py * 8.53 + pz * 5.29) % 1 + 1) % 1;
			const saturation = isLight
				? (isNoise ? 0.04 + satRaw * 0.08 : 0.55 + satRaw * 0.4)
				: (isNoise ? 0.1 + satRaw * 0.15 : 0.4 + satRaw * 0.5);

			// Lightness. Light mode INVERTS the dark-mode logic: clustered points must
			// be DARK (low lightness) to contrast the light bg, and activity makes them
			// darker/heavier (not brighter); noise is a faint light-grey that recedes.
			const litRaw = ((px * 11.13 + py * 4.87 + pz * 17.63) % 1 + 1) % 1;
			const terrData = !isNoise ? territories[tid] : null;
			const activityBoost = terrData ? computeLuminosity(terrData, maxCount) * 0.15 : 0;
			const lightness = isLight
				? (isNoise ? 0.66 + litRaw * 0.08 : 0.42 - litRaw * 0.14 - activityBoost)
				: (isNoise ? 0.08 + litRaw * 0.1 : 0.3 + litRaw * 0.3 + activityBoost);

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

			// Exploration awareness: explored territories glow brighter
			const exploredPct = (!isNoise && territories[tid]) ? (territories[tid].exploredPercent || 0) / 100 : 0;
			const awarenessBoost = 0.7 + exploredPct * 0.3; // 0.7 (unexplored) to 1.0 (fully explored)

			// Light mode needs MUCH higher opacity — solid dark dots on a light bg,
			// not faint glows. Unfocused jumps from 0.06 → 0.55 so the cloud is
			// actually visible; noise stays semi-transparent so it recedes.
			if (isLight) {
				if (isNoise) alphas[i] = hasSelection ? 0.12 : 0.4;
				else if (isInFocus) alphas[i] = 0.95 * awarenessBoost;
				else if (isCofiring) alphas[i] = 0.7 * awarenessBoost;
				else alphas[i] = 0.55 * awarenessBoost;
			} else if (isNoise) {
				alphas[i] = hasSelection ? 0.03 : 0.5;
			} else if (isInFocus) {
				alphas[i] = 0.9 * awarenessBoost;
			} else if (isCofiring) {
				alphas[i] = 0.35 * awarenessBoost;
			} else {
				alphas[i] = 0.06 * awarenessBoost;
			}

			// Normalized timestamp (0 = oldest, 1 = newest)
			const ts = p.data.timestamp ? new Date(p.data.timestamp).getTime() : tMax;
			timestamps[i] = (ts - tMin) / tSpan;
		}

		// Compute timeline ticks (monthly bins) with entropy
		const binCounts = new Map<number, number>();
		const binTerritories = new Map<number, Map<number, number>>(); // monthKey → {tid → count}
		for (let i = 0; i < nodes.length; i++) {
			const p = nodes[i];
			if (p.data.timestamp) {
				const d = new Date(p.data.timestamp!);
				const monthKey = d.getFullYear() * 12 + d.getMonth();
				binCounts.set(monthKey, (binCounts.get(monthKey) || 0) + 1);
				const tid = p.data.cluster3d ?? -1;
				if (tid >= 0) {
					if (!binTerritories.has(monthKey)) binTerritories.set(monthKey, new Map());
					const tmap = binTerritories.get(monthKey)!;
					tmap.set(tid, (tmap.get(tid) || 0) + 1);
				}
			}
		}
		// Shannon entropy per month — normalized 0..1
		let maxEntropy = 1;
		const binEntropy = new Map<number, number>();
		for (const [mk, tmap] of binTerritories) {
			const total = [...tmap.values()].reduce((a, b) => a + b, 0);
			let h = 0;
			for (const c of tmap.values()) {
				const p = c / total;
				if (p > 0) h -= p * Math.log2(p);
			}
			binEntropy.set(mk, h);
			if (h > maxEntropy) maxEntropy = h;
		}

		let maxBin = 1;
		for (const c of binCounts.values()) if (c > maxBin) maxBin = c;
		const sortedBins = [...binCounts.entries()].sort((a, b) => a[0] - b[0]);
		timelineTicks = sortedBins.map(([mk, count]) => {
			const y = Math.floor(mk / 12);
			const m = mk % 12;
			const d = new Date(y, m, 1);
			const pos = (d.getTime() - tMin) / tSpan;
			const entropy = (binEntropy.get(mk) || 0) / maxEntropy; // 0=single topic, 1=max diversity
			const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
			const illuminated = timeChronicles.some(c => c.period_key?.startsWith(monthKey));
			return { pos, height: 0.2 + 0.8 * (count / maxBin), date: d, count, entropy, illuminated };
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
				timeDayHalf: { value: 0.001 }, // half-width of 1 day in normalized time
				timeActive: { value: 0.0 },    // 0 = timeline off, 1 = on
			},
			vertexShader: `
				attribute float aAlpha;
				attribute float aTime;
				varying vec3 vColor;
				varying float vAlpha;
				uniform float pointSize;
				uniform float timeCenter;
				uniform float timeDayHalf;
				uniform float timeActive;

				void main() {
					vColor = color;

					// 3-tier temporal brightness: day > week > month > baseline
					float timeDist = abs(aTime - timeCenter);
					float dayW = timeDayHalf;
					float weekW = dayW * 7.0;
					float monthW = dayW * 30.0;

					// Day tier: full brightness
					float dayFade = 1.0 - smoothstep(dayW * 0.5, dayW, timeDist);
					// Week tier: bright
					float weekFade = (1.0 - smoothstep(weekW * 0.5, weekW, timeDist)) * 0.65;
					// Month tier: clearly visible
					float monthFade = (1.0 - smoothstep(monthW * 0.5, monthW, timeDist)) * 0.35;
					// Baseline
					float baseline = 0.06;

					float timeFade = max(max(dayFade, weekFade), max(monthFade, baseline));
					float timeAlpha = mix(1.0, timeFade, timeActive);

					// Recency brightness (always on, independent of the scrubber): newer
					// points glow brighter; older ones decay GENTLY to a generous floor,
					// relative to the dataset's own time span (aTime: 0 = oldest, 1 = now).
					// pow(.,0.55) keeps recent-ish points bright and only the oldest dim.
					float recency = clamp(aTime, 0.0, 1.0);
					// Light mode keeps a much higher floor so aged points stay readable
					// against the light bg (a 0.32 floor would vanish there).
					float recencyBright = ${isLight ? '0.7 + 0.3' : '0.32 + 0.68'} * pow(recency, 0.55);

					vAlpha = aAlpha * timeAlpha * recencyBright;
					vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = pointSize * (300.0 / -mvPos.z);
					gl_Position = projectionMatrix * mvPos;
				}
			`,
			fragmentShader: isLight ? `
				varying vec3 vColor;
				varying float vAlpha;

				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float r = length(uv);
					if (r > 0.5) discard;
					// Solid circle with subtle border for light mode
					float edge = 1.0 - smoothstep(0.4, 0.5, r);
					float border = smoothstep(0.35, 0.42, r) * 0.15;
					vec3 col = vColor * (1.0 - border);
					gl_FragColor = vec4(col, vAlpha * edge * 0.95);
				}
			` : `
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
			depthWrite: isLight,
			depthTest: true,
			vertexColors: true,
		});

		pointCloudMaterial = material;
		pointCloud = new THREE.Points(geometry, material);
		pointCloud.visible = showPoints;
		scene.add(pointCloud);
	}

	function createSocialLayer() {
		if (!scene) return;
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

		const isCaptureIntro = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('capture');
		const viewDist = Math.max(maxDist * (isCaptureIntro ? 0.5 : 1.5), isCaptureIntro ? 8 : 20);
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
		// Tooltip placement, clamped to the canvas so it never runs off-screen.
		// Horizontal: sit to the RIGHT of the cursor, but flip LEFT when that
		// would overflow the right edge. Vertical: float ABOVE the cursor
		// (translateY(-100%)), but flip BELOW when there isn't room near the top.
		// TW/TH are the max card box (max-w-[260px]); we clamp by those so a
		// narrower card is always fully inside too.
		const TW = 260, TH = 120, pad = 10;
		const cx = event.clientX - rect.left;
		const cy = event.clientY - rect.top;
		let tipX = cx + 14;
		if (tipX + TW > rect.width - pad) tipX = cx - 14 - TW; // flip to the left
		tipX = Math.max(pad, Math.min(tipX, rect.width - TW - pad));
		const below = cy - TH < pad;                            // not enough room above → drop below
		let tipY = below ? cy + 16 : cy - 10;
		tipY = Math.max(pad, Math.min(tipY, rect.height - (below ? TH : 0) - pad));
		tooltipBelow = below;

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

				// Step-by-step navigation — drill one level deeper each click
				// But if already at territory level, allow switching between territories freely
				if (msState.selectedRealmId === null) {
					mindscapeState.drillIntoRealm(clickedRealm);
				} else if (clickedRealm !== msState.selectedRealmId) {
					mindscapeState.drillIntoRealm(clickedRealm);
				} else if (msState.selectedSemanticThemeId === null) {
					if (clickedTheme != null && clickedTheme !== -1) {
						mindscapeState.drillIntoTheme(clickedRealm, clickedTheme);
					}
				} else if (clickedTheme !== msState.selectedSemanticThemeId) {
					if (clickedTheme != null && clickedTheme !== -1) {
						mindscapeState.drillIntoTheme(clickedRealm, clickedTheme);
					}
				} else if (msState.selectedTerritoryId === null) {
					if (clickedTerritory != null && clickedTerritory !== -1) {
						mindscapeState.selectTerritory(clickedTerritory);
					}
				} else if (clickedTerritory !== msState.selectedTerritoryId) {
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
		// Background tab (workspace keep-alive): keep the loop scheduled for instant
		// resume, but skip controls/uniforms/render so a hidden map doesn't burn GPU.
		if (!active || !controls) return;
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
		// M4 play-mode sweep — advance timePosition at a rate
		// proportional to the visible timeline span, scaled by speed.
		// Locked defaults: (span / 10) × speed per second. Auto-pause
		// on reaching end (Q7). Manual scrub pauses (handled in the
		// dial mousedown/wheel handlers).
		if (msState.pulsesPlaying && timeRange.max > timeRange.min) {
			const dt = clock.getDelta(); // seconds since last frame
			const span = 1.0; // normalized 0..1
			// span / 10 per second at 1× means full timeline in 10s.
			const delta = (span / 10) * msState.pulsesSpeed * dt;
			timePosition = Math.min(1, timePosition + delta);
			if (timePosition >= 1) {
				mindscapeState.setPulsesPlaying(false);
			}
		} else {
			// Drain the clock's delta so the next play start doesn't jump.
			clock.getDelta();
		}
		// M2 breathing — per-halo + global scene breath. Toggle-gated
		// via uBreathScale (0 = off, 1 = on) so amplitudes collapse to
		// exactly zero when disabled; halos render frozen-static.
		if (haloMaterial) {
			haloMaterial.uniforms.uTime.value = elapsed;
			haloMaterial.uniforms.uBreathScale.value = msState.breathingEnabled ? 1.0 : 0.0;
			haloMaterial.uniforms.uGlobalBreath.value = msState.breathingEnabled
				? (1.0 + 0.05 * Math.sin(elapsed * 0.3141))
				: 1.0;
		}
		// M3 firing pulses — rebuild when the set changes, advance per-
		// vertex alpha every frame. Visibility toggled by layer flag.
		if (!pulseGeometryValid) rebuildPulseGeometry();
		if (pulseSegments) {
			pulseSegments.visible = msState.pulsesEnabled;
			if (msState.pulsesEnabled) updatePulseProgressAttr();
		}
		// M3 arrival afterglow — each tick decay + re-apply on halo
		// colors. Cheap: only the territories currently glowing touch
		// the color buffer. Gated by phaseColor toggle (no afterglow
		// on a grey-halo mindscape).
		if (msState.phaseColorEnabled && territoryAfterglow.size > 0) {
			applyAfterglowToHalos(performance.now());
		}
		// Hide halos entirely when phase color is off AND dormant
		// visibility is off — no reason to render featureless grey dots.
		if (territoryHalos) {
			territoryHalos.visible = msState.phaseColorEnabled || msState.dormantVisible;
		}
		// Timeline uniforms — read from bridge vars (updated by $effect)
		if (pointCloudMaterial) {
			pointCloudMaterial.uniforms.timeCenter.value = _timePos;
			// Compute half-day width in normalized time (0..1)
			const span = timeRange.max - timeRange.min || 1;
			const dayMs = 86400000;
			pointCloudMaterial.uniforms.timeDayHalf.value = (dayMs / span) * 0.5;
			pointCloudMaterial.uniforms.timeActive.value = _timeEnabled ? 1.0 : 0.0;
		}

		composer.render();
	}

	// Update scene background when theme changes — and REBUILD the theme-baked
	// visuals (point colors/alpha/size are computed at creation per isLight, so a
	// toggle must rebuild them, else light-mode points stay dark-tuned + invisible).
	const currentTheme = $derived($theme);
	let themeApplied = false;
	$effect(() => {
		currentTheme; // track
		if (!scene) return;
		scene.background = new THREE.Color(getBgColor());
		if (themeApplied && pointCloud) {
			createPointCloud();
			createStarfield();   // skips itself in light mode
			createGlowLayer();   // skips itself in light mode
		}
		themeApplied = true;
	});

	// Load health data once timeline range is known
	$effect(() => {
		if (timeRange.min > 0 && !healthLoaded) loadHealthForTimeline();
	});
	// Load chronicles eagerly — they're small and needed immediately when dial is touched
	$effect(() => { if (!chroniclesLoaded) loadTimeChronicles(); });

	// When illuminating, poll for new chronicles until they arrive
	$effect(() => {
		if (!illuminatingPeriod) return;
		const period = illuminatingPeriod;
		const interval = setInterval(async () => {
			chroniclesLoaded = false;
			await loadTimeChronicles();
			if (timeChronicles.some(c => c.period_key?.startsWith(period))) {
				illuminatingPeriod = null;
				clearInterval(interval);
				// Rebuild ticks to update illumination state
				// Force re-render by touching timelineTicks
				timelineTicks = [...timelineTicks];
			}
		}, 10000);
		return () => clearInterval(interval);
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
	// Rebuilding the point cloud + social/glow/halo layers is heavy (O(points ·
	// territories) CPU + new typed arrays + GPU upload). During load the store
	// streams points in incrementally, so the effect below fires many times — and
	// rebuilding on every tick is what makes the scene jitter/lag. We coalesce:
	// data-driven rebuilds are DEBOUNCED (one rebuild once the stream settles),
	// while user navigation rebuilds promptly. Flags OR-accumulate across the
	// debounce window so nothing is dropped.
	let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingData = false;
	let pendingNav = false;
	let introPlayed = false;

	function flushRebuild() {
		rebuildTimer = null;
		if (!scene) return;
		const dataChanged = pendingData;
		const isNavChange = pendingNav;
		pendingData = false;
		pendingNav = false;
		// create* functions read the reactive stores internally — untrack so this
		// rebuild never re-subscribes the effect (would infinite-loop).
		untrack(() => {
			createPointCloud();
			const isCapture = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('capture');
			if (dataChanged && !isCapture) {
				createSocialLayer();
				createGlowLayer();
			}
			if (dataChanged && isCapture) {
				createGlowLayer();
			}
			if (dataChanged && !introPlayed && visiblePoints.length > 0) {
				introPlayed = true;
				setTimeout(() => animateIntro(), 100);
			} else if (isNavChange) {
				setTimeout(() => animateCameraToVisiblePoints(800), 50);
			}
			const territory = msState.selectedTerritoryId;
			if (territory !== null) {
				loadCofire(territory).then(() => createCofireVisuals());
			} else {
				clearCofire();
			}
			// Phase halos (Mindscape Pulses M1) + firing sequence (M3) — rebuild on
			// any data change so new/dissolved territories stay in sync.
			if (dataChanged) {
				if (phaseHistories.size === 0) {
					loadPhaseHistory();
				} else {
					createPhaseHalos();
				}
				loadFiringSequence();
				pulseGeometryValid = false;
			}
		});
	}

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
			pendingData = pendingData || dataChanged;
			pendingNav = pendingNav || isNavChange;
			// Nav is user-driven → respond on the next tick. Data is streaming in
			// during load → debounce so a burst of length changes coalesces into a
			// single rebuild instead of one-per-tick (the jitter fix).
			const delay = isNavChange ? 0 : 180;
			if (rebuildTimer) clearTimeout(rebuildTimer);
			rebuildTimer = setTimeout(flushRebuild, delay);
		}

		prevPointCount = pts.length;
		prevNavKey = navKey;
	});

	// Mindscape Pulses M1 — recolor phase halos when the scrub moves.
	// Geometry stays constant; only the color buffer is rewritten. Cheap
	// enough to run inside the scrub effect at interactive rates.
	$effect(() => {
		timePosition; // subscribe
		timeRange.min; timeRange.max; // subscribe
		untrack(() => {
			if (territoryHalos && phaseHistories.size > 0) {
				updatePhaseHaloColors();
			}
			// M3 — re-extract the current window of pulses on scrub change.
			// New pulses are added to the map, pulses that fell out of
			// window are removed. Geometry is rebuilt only if the pulse
			// set changed (pulseGeometryValid flag).
			if (firingSequence.length > 0) {
				extractCurrentPulses();
			}
		});
	});

	// Re-render social layer when visible contacts, tiers, or selection change
	const contactsSnapshot = $derived(
		[...msState.visibleTiers].sort().join(',') + ':' + $visibleContacts.length + ':' + (msState.showSocialLayer ? '1' : '0') + ':' + (msState.selectedContactId || '')
	);
	let prevContactsSnapshot = '';
	$effect(() => {
		const snap = contactsSnapshot; // track explicitly
		const isCapture = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('capture');
		if (scene && snap !== prevContactsSnapshot && !isCapture) {
			untrack(() => {
				createSocialLayer();
				if (contactCloud) contactCloud.visible = msState.showSocialLayer;
				if (contactEdges) contactEdges.visible = msState.showSocialLayer;
			});
			prevContactsSnapshot = snap;
		}
	});

	onMount(() => {
		// Data is already loaded by the parent page — this component only mounts
		// when msState.points.length > 0. Calling mindscapeState.load() here would
		// set loading=true, causing the parent to unmount us (infinite loop).
		initThree();
		createPointCloud();
		renderLoop();
	});

	onDestroy(() => {
		if (animationId) cancelAnimationFrame(animationId);
		if (composer) composer.dispose();
		clearCofire();
		clearPhaseHalos();
		clearPulses();
		if (resizeObserver) resizeObserver.disconnect();
		if (renderer) {
			renderer.domElement.removeEventListener('mousemove', handleMouseMove);
			renderer.domElement.removeEventListener('mousedown', handleMouseDown);
			renderer.domElement.removeEventListener('click', handleClick);
			renderer.dispose();
			// CRITICAL for WKWebView (the desktop shell): dispose() alone does NOT
			// release the WebGL/GPU context in WebKit. Without forceContextLoss the
			// context leaks on every unmount, and leaving the 3D map (e.g. → Profile)
			// eventually wedges the whole webview — so the next page's onMount/timers
			// never fire and it "doesn't load". Force the loss + detach the canvas.
			try { renderer.forceContextLoss(); } catch { /* backend may not support it */ }
			renderer.domElement?.parentNode?.removeChild(renderer.domElement);
			renderer = undefined as unknown as THREE.WebGLRenderer;
		}
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
				class="btn-ghost text-xs px-3 py-1.5 rounded-md ms-glass border border-[var(--color-border)]"
			>
				&larr; Back
			</button>
		{/if}
		<span class="text-xs text-[var(--color-text-tertiary)] ms-glass px-2 py-1 rounded">
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
		<div class="absolute inset-0 flex items-center justify-center ms-scrim">
			<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading Mycelium...</div>
		</div>
	{/if}

	<!-- Empty state -->
	{#if !msState.loading && msState.points.length === 0}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center">
				<p class="text-[var(--color-text-tertiary)] text-sm">No clustering data yet</p>
				<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Send more messages to build your Mycelium</p>
			</div>
		</div>
	{/if}

	<!-- Stats badge -->
	{#if msState.meta && !msState.loading}
		<div class="absolute bottom-4 left-4 text-[0.65rem] text-[var(--color-text-tertiary)] ms-glass px-2.5 py-1 rounded border border-[var(--color-border)]">
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
		<div class="absolute top-4 right-4 w-80 max-h-[calc(100%-2rem)] ms-glass rounded-lg border border-[#E5B84C]/30 shadow-lg flex flex-col overflow-hidden">
			<!-- Header -->
			<div class="p-4 pb-0">
				<div class="flex items-start justify-between mb-1">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-medium text-[var(--color-text-emphasis)] truncate">{c.name}</h3>
							{#if c.source === 'linkedin'}
								<svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
							{/if}
						</div>
						{#if c.position || c.company}
							<p class="text-[0.65rem] text-[var(--color-text-secondary)] mt-0.5 truncate">
								{[c.position, c.company].filter(Boolean).join(' · ')}
							</p>
						{/if}
					</div>
					<button
						onclick={() => mindscapeState.selectContact(null)}
						class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm leading-none ml-2 flex-shrink-0"
					>&times;</button>
				</div>

				<!-- Badges row -->
				<div class="flex items-center gap-2 mt-2 flex-wrap">
					<span class="text-[0.6rem] px-1.5 py-0.5 rounded-full border"
						style="border-color: #E5B84C; color: #E5B84C">{c.tier}</span>
					{#if c.interaction_count}
						<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">
							{c.interaction_count} msg{#if c.outbound_count} · {c.outbound_count} sent{/if}
						</span>
					{/if}
					{#if c.connected_at}
						<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">since {new Date(c.connected_at).getFullYear()}</span>
					{/if}
				</div>

				<!-- Contact info -->
				<div class="mt-2 flex flex-col gap-1">
					{#if c.email}
						<a href="mailto:{c.email}" class="text-[0.6rem] text-[var(--color-accent)] hover:underline truncate">{c.email}</a>
					{/if}
					{#if c.last_interaction_at}
						{@const lastDate = new Date(c.last_interaction_at)}
						{@const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / 86400000)}
						<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">
							Last talked {daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo < 30 ? `${daysAgo}d ago` : daysAgo < 365 ? `${Math.floor(daysAgo/30)}mo ago` : `${Math.floor(daysAgo/365)}y ago`}
						</span>
					{/if}
					{#if c.linkedin_url}
						<a href={c.linkedin_url} target="_blank" rel="noopener"
							class="text-[0.6rem] text-[#0A66C2] hover:underline">LinkedIn Profile</a>
					{/if}
				</div>

				<!-- Chronicle description -->
				{#if c.description}
					<div class="mt-3 pt-3 border-t border-[var(--color-border)]/50">
						<p class="text-[0.6rem] text-[var(--color-text-primary)] leading-relaxed">{c.description.essence}</p>
						{#if c.description.current_chapter}
							<p class="text-[0.55rem] text-[var(--color-accent-aurum)] mt-1.5 italic">{c.description.current_chapter}</p>
						{/if}
						{#if c.description.signature_topics?.length}
							<div class="flex flex-wrap gap-1 mt-1.5">
								{#each c.description.signature_topics as topic}
									<span class="text-[0.5rem] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">{topic}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				{#if c.territories.length > 0}
					<div class="mt-3">
						<p class="text-[0.55rem] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">Territories</p>
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
			</div>

			<!-- Messages -->
			<div class="mt-3 border-t border-[var(--color-border)] flex flex-col min-h-0 flex-1">
				<p class="text-[0.55rem] uppercase tracking-wider text-[var(--color-text-tertiary)] px-4 pt-2 pb-1">Messages</p>
				<div class="overflow-y-auto px-4 pb-3 flex-1" style="max-height: 240px;">
					{#if $contactMessagesLoading}
						<div class="flex items-center gap-2 py-2 text-[0.6rem] text-[var(--color-text-tertiary)]">
							<div class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
							Loading...
						</div>
					{:else if $contactMessages.length === 0}
						<p class="text-[0.6rem] text-[var(--color-text-tertiary)] py-2">No messages found</p>
					{:else}
						{#each $contactMessages as msg}
							<div class="py-1.5 border-b border-[var(--color-border)]/50 last:border-0">
								<div class="flex items-center gap-1.5 mb-0.5">
									<span class="text-[0.55rem] font-medium {msg.role === 'user' ? 'text-[var(--color-accent)]' : 'text-[var(--color-accent-aurum)]'}">
										{msg.role === 'user' ? 'You' : c.name.split(' ')[0]}
									</span>
									<span class="text-[0.5rem] text-[var(--color-text-tertiary)]">
										{new Date(msg.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}
									</span>
								</div>
								<p class="text-[0.6rem] text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<!-- Layer controls — collapsed to a tiny pill by default; expands on click. -->
	<div class="absolute bottom-4 right-4 ms-glass rounded-lg border border-[var(--color-border)] {layersOpen ? 'p-2.5 min-w-[140px] max-h-[calc(100%-7rem)] overflow-y-auto' : 'p-0'}">
		<button
			onclick={() => (layersOpen = !layersOpen)}
			class="flex items-center gap-1.5 text-[0.55rem] uppercase tracking-wider text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors w-full {layersOpen ? 'mb-1.5 px-1' : 'px-2 py-1.5'}"
			aria-expanded={layersOpen}
			title="Layers"
		>
			<span class="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)]"></span>
			Layers
			{#if layersOpen}<span class="ml-auto text-[0.6rem]">×</span>{/if}
		</button>

		{#if layersOpen}
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
				// M4: manual scrub always pauses play-mode.
				if (msState.pulsesPlaying) mindscapeState.setPulsesPlaying(false);
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
					checkTickCrossing(timePosition);
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
				if (msState.pulsesPlaying) mindscapeState.setPulsesPlaying(false);
				timelineEnabled = true;
				timePosition = Math.max(0, Math.min(1, timePosition + e.deltaX * 0.0008 + e.deltaY * 0.0008));
				checkTickCrossing(timePosition);
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
							class:illuminated={tick.illuminated}
							class:dark={!tick.illuminated}
							style="
								left: calc(50% + {xPx}px);
								height: {(6 + tick.height * 20) * cosA}px;
								opacity: {(tick.illuminated ? 0.3 + tick.height * 0.7 : 0.08 + tick.height * 0.15) * cosA * cosA};
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

			<!-- Date + chronicle label above dial -->
			{#if timelineEnabled}
				{@const currentDate = new Date(timeRange.min + timePosition * (timeRange.max - timeRange.min))}
				{@const chronicle = getChronicleNearDate(currentDate)}
				{@const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`}
				{@const isIlluminated = timeChronicles.some(c => c.period_key?.startsWith(currentMonth))}
				<div class="dial-info">
					<div class="dial-date">{currentDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
					{#if chronicle}
						<div class="dial-theme">{chronicle.theme}</div>
						<div class="dial-signature" class:sig-steady={chronicle.signature === 'steady'} class:sig-exploring={chronicle.signature === 'exploring'} class:sig-consolidating={chronicle.signature === 'consolidating'} class:sig-fragmenting={chronicle.signature === 'fragmenting'}>{chronicle.signature}</div>
					{/if}
					{#if illuminatingPeriod === currentMonth}
						<div class="dial-illuminating">
							<div class="illuminating-pulse"></div>
							<span>illuminating...</span>
						</div>
					{:else if !isIlluminated}
						<button class="dial-illuminate" onclick={() => {
							illuminatingPeriod = currentMonth;
							container?.dispatchEvent(new CustomEvent('illuminate', { detail: currentMonth, bubbles: true }));
						}}>
							illuminate
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Point tooltip -->
	{#if tooltipVisible && tooltipData}
		<div
			class="absolute pointer-events-none z-50 border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg max-w-[260px]"
			style="left: {tooltipX}px; top: {tooltipY}px; {tooltipBelow ? '' : 'transform: translateY(-100%);'} background: var(--color-surface); background: color-mix(in srgb, var(--color-surface) 94%, transparent); backdrop-filter: blur(14px) saturate(160%); -webkit-backdrop-filter: blur(14px) saturate(160%);"
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
	/* Readable glass for overlay panels/chips floating over the 3D canvas.
	   Tailwind's bg-[var(--color-surface)]/NN modifier produces NO valid rule
	   because --color-surface is a hex (#141417), not raw channels — so those
	   panels rendered fully transparent (unreadable). color-mix gives a real,
	   readable glass with a solid fallback for older WebKit (never transparent). */
	.ms-glass {
		background: var(--color-surface);
		background: color-mix(in srgb, var(--color-surface) 92%, transparent);
		-webkit-backdrop-filter: blur(14px) saturate(160%);
		backdrop-filter: blur(14px) saturate(160%);
	}
	/* Dimming scrim (loading overlay) — same fix for bg-[var(--color-bg)]/80. */
	.ms-scrim {
		background: var(--color-bg);
		background: color-mix(in srgb, var(--color-bg) 78%, transparent);
		-webkit-backdrop-filter: blur(2px);
		backdrop-filter: blur(2px);
	}

	/* Ethereal drum dial — floating ticks, no box.
	   Default opacity bumped 0.4 → 0.65 so the dial remains visible
	   over the brighter halo + afterglow layers added in M1–M3. */
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
		opacity: 0.65;
		transition: opacity 0.5s;
	}
	.timeline-dial:hover, .timeline-dial.active {
		opacity: 1;
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
		border-radius: 0.5px;
		transition: background 0.3s;
	}
	.dial-tick.illuminated {
		background: var(--color-accent-aurum);
		box-shadow: 0 0 3px rgba(229, 184, 76, 0.4);
	}
	.dial-tick.dark {
		background: rgba(255, 255, 255, 0.15);
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
	.dial-info {
		position: absolute;
		left: 50%;
		top: calc(100% + 3px);
		transform: translateX(-50%);
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		white-space: nowrap;
	}
	.dial-date {
		font-size: 0.55rem;
		font-weight: 400;
		color: var(--color-accent);
		letter-spacing: 0.05em;
		text-shadow: 0 0 12px var(--color-accent), 0 0 4px rgba(229, 184, 76, 0.5);
	}
	.dial-theme {
		font-size: 0.5rem;
		font-weight: 500;
		color: var(--color-text-primary);
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		letter-spacing: 0.02em;
		animation: chronicle-fade 0.3s ease-out;
	}
	.dial-signature {
		font-size: 0.45rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		animation: chronicle-fade 0.3s ease-out;
	}
	@keyframes chronicle-fade {
		from { opacity: 0; transform: translateY(-2px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.sig-steady { color: var(--color-accent-jade); }
	.sig-exploring { color: var(--color-accent); }
	.sig-consolidating { color: var(--color-accent-aurum); }
	.sig-fragmenting { color: var(--color-accent-coral); }
	.dial-illuminate {
		margin-top: 4px;
		padding: 2px 10px;
		border: 1px solid rgba(229, 184, 76, 0.4);
		background: rgba(229, 184, 76, 0.08);
		color: var(--color-accent-aurum);
		border-radius: 4px;
		font-size: 0.45rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		cursor: pointer;
		pointer-events: auto;
		transition: all 0.2s;
	}
	.dial-illuminate:hover {
		background: rgba(229, 184, 76, 0.2);
		border-color: var(--color-accent-aurum);
	}
	.dial-illuminating {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		font-size: 0.45rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--color-accent-aurum);
		pointer-events: none;
	}
	.illuminating-pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent-aurum);
		animation: illuminate-pulse 1.5s ease-in-out infinite;
	}
	@keyframes illuminate-pulse {
		0%, 100% { opacity: 0.3; transform: scale(0.8); }
		50% { opacity: 1; transform: scale(1.2); }
	}
</style>
