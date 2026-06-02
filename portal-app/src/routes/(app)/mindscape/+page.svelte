<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { mindscapeState, timelineHealth } from '$lib/stores/mindscape';
	import MindscapeDetail from '$lib/components/mindscape/MindscapeDetail.svelte';
	import Sparkline from '$lib/components/mindscape/Sparkline.svelte';
	import PulsesLens from '$lib/components/mindscape/PulsesLens.svelte';
	import { api, apiGet, apiPut } from '$lib/api';
	import { generate, start as startGen, resume as resumeGen, reset as resetGen, cancel as cancelGen, fmtSeconds } from '$lib/generate';
	import { get } from 'svelte/store';
	import ConnectionsChecklist from '$lib/components/ConnectionsChecklist.svelte';
	import { auth } from '$lib/stores/auth';

	// ── Generation + enrichment state ──
	// Generate lifecycle (start / progress / ETA / errors) lives in the shared store
	// `$lib/generate`: it handles the REAL server contract (esp. the 409 "still
	// embedding" → wait + auto-start) so this page and the onboarding card never
	// diverge or show "Failed to start" on a 409.
	let enrichment: { total: number; enriched: number; pending: number; rate?: string } | null = $state(null);
	let hasImportedData = $state(false);
	let enrichPollTimer: ReturnType<typeof setTimeout> | null = null;

	let aiReady = $state(true);

	async function checkGenerationState() {
		try {
			const status = await apiGet<any>('/portal/onboarding/status');
			if (status.steps?.data) {
				const { messageCount = 0, enrichedCount = 0, enrichmentPending = 0 } = status.steps.data;
				hasImportedData = messageCount > 0;
				if (messageCount > 0) {
					enrichment = { total: messageCount, enriched: enrichedCount, pending: enrichmentPending };
				}
			}
			aiReady = status.aiModelsReady !== false;
		} catch { /* silent */ }
	}

	let enrichTriggering = $state(false);

	async function triggerEnrichment() {
		enrichTriggering = true;
		try {
			const res = await api('/portal/enrichment/trigger', { method: 'POST', body: JSON.stringify({ batchSize: 200 }) });
			if (res.ok) {
				setTimeout(pollEnrichment, 2000);
			}
		} catch { /* silent */ }
		enrichTriggering = false;
	}

	async function pollEnrichment() {
		if (get(generate).phase === 'running') return;
		try {
			const res = await api('/portal/enrichment/status');
			if (res.ok) {
				const data = await res.json();
				const serviceRate = data.service?.rate ? parseFloat(data.service.rate) : 0;
				const msgPerMin = serviceRate > 0 ? Math.round(serviceRate * 60) : 0;
				enrichment = { total: data.messages.total, enriched: data.messages.enriched + (data.messages.embedded || 0), pending: data.messages.pending, rate: msgPerMin > 0 ? `${msgPerMin}` : undefined };
				if (data.messages.pending > 0) {
					// Auto-trigger bulk pipeline if no active job is running.
					// The single-message poll loop processes ~2 msg/min; the bulk
					// pipeline does 300+ msg/min via batch embedding.
					if (!data.activeJob && !enrichTriggering) {
						triggerEnrichment();
					}
					enrichPollTimer = setTimeout(pollEnrichment, 5_000);
					return;
				}
			}
		} catch { /* silent */ }
		enrichPollTimer = null;
	}

	// React to the shared store reporting completion: reload the map, then clear.
	$effect(() => {
		if ($generate.phase === 'done') {
			territories = []; realms = [];
			mindscapeState.load();
			loadTerritories();
			setTimeout(() => resetGen(), 4000);
		}
	});

	// Cleanup timers on unmount
	$effect(() => {
		return () => {
			if (enrichPollTimer) clearTimeout(enrichPollTimer);
		};
	});

	// Health data for body state bar
	interface HealthDay { date: string; sleep_duration_min: number|null; sleep_efficiency: number|null; hrv_avg: number|null; resting_hr: number|null; steps: number|null; }
	interface HealthSummary { today: HealthDay|null; averages: Record<string, number|null>; trends: Record<string, string>; days: HealthDay[]; }
	let healthData = $state<HealthSummary|null>(null);
	// Fisher trajectory summary (Phase 5). Renders as a Movement pill in the
	// top bar alongside health metrics. Null until pipeline produces data.
	let trajectorySummary = $state<any>(null);

	const isCaptureMode = browser && new URLSearchParams(window.location.search).has('capture');

	// Lazy load 3D component (THREE.js is heavy)
	let Mindscape3D: any = $state(null);

	// The desktop (Tauri) shell is a TRANSPARENT + vibrancy WKWebView; WebGL/THREE
	// inside it HANGS the webview (frozen spinner, no input — the whole UI locks).
	// Detect Tauri and gate every 3D/WebGL surface off there, defaulting to the
	// fully-functional 2D Territories view. (The 3D map still works in a browser.)
	const isTauriEnv = () => typeof window !== 'undefined' && (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);
	let isTauri = $state(false);

	// Demo mindscape canvas for welcome screen
	let demoCanvas = $state<HTMLCanvasElement | undefined>();
	let demoCleanup: (() => void) | null = null;

	// Initialize demo 3D mindscape when canvas is available
	$effect(() => {
		if (!browser || !demoCanvas || isTauriEnv()) return; // no WebGL under Tauri — it hangs the webview
		// Lazy import to avoid loading THREE until needed
		(async () => {
			const THREE = await import('three');
			const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

			const canvas = demoCanvas!;
			const parent = canvas.parentElement!;
			const scene = new THREE.Scene();
			// Transparent — the CSS background shows through
			const camera = new THREE.PerspectiveCamera(55, parent.clientWidth / parent.clientHeight, 0.1, 500);
			camera.position.set(100, 65, 100);

			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
			renderer.setClearColor(0x000000, 0);
			renderer.setSize(parent.clientWidth, parent.clientHeight);
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

			const controls = new OrbitControls(camera, renderer.domElement);
			controls.enableDamping = true;
			controls.dampingFactor = 0.04;
			controls.enableZoom = false;
			controls.enablePan = false;
			controls.autoRotate = true;
			controls.autoRotateSpeed = 0.3;

			// Load demo data
			try {
				const res = await fetch('/demo-mindscape.json');
				if (!res.ok) return;
				const pts: number[][] = await res.json();
				const count = pts.length;
				const positions = new Float32Array(count * 3);
				const colors = new Float32Array(count * 3);

				let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
				for (const p of pts) {
					if (p[0] < xMin) xMin = p[0]; if (p[0] > xMax) xMax = p[0];
					if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1];
					if (p[2] < zMin) zMin = p[2]; if (p[2] > zMax) zMax = p[2];
				}
				const maxSpan = Math.max(xMax - xMin, yMax - yMin, zMax - zMin) || 1;
				const scale = 50 / maxSpan;

				for (let i = 0; i < count; i++) {
					const p = pts[i];
					positions[i * 3] = p[0] * scale;
					positions[i * 3 + 1] = p[2] * scale;
					positions[i * 3 + 2] = p[1] * scale;

					const hue = ((p[0] * 7.31 + p[1] * 13.17 + p[2] * 23.41) % 1 + 1) % 1;
					const satBase = ((p[0] * 3.71 + p[1] * 8.53 + p[2] * 5.29) % 1 + 1) % 1;
					const litBase = ((p[0] * 11.13 + p[1] * 4.87 + p[2] * 17.63) % 1 + 1) % 1;
					const sat = 0.35 + satBase * 0.45;
					let lit = 0.25 + litBase * 0.3;
					if (p[3] === -1) lit = 0.08;
					const col = new THREE.Color().setHSL(hue, sat, lit);
					colors[i * 3] = col.r;
					colors[i * 3 + 1] = col.g;
					colors[i * 3 + 2] = col.b;
				}

				const geo = new THREE.BufferGeometry();
				geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
				geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

				const mat = new THREE.PointsMaterial({
					size: 0.22,
					vertexColors: true,
					transparent: true,
					opacity: 0.85,
					sizeAttenuation: true,
					depthWrite: false,
				});

				scene.add(new THREE.Points(geo, mat));
				const cx = (xMax + xMin) / 2 * scale;
				const cy = (zMax + zMin) / 2 * scale;
				const cz = (yMax + yMin) / 2 * scale;
				controls.target.set(cx, cy, cz);
				camera.lookAt(cx, cy, cz);

				// Starfield
				const starGeo = new THREE.BufferGeometry();
				const starPos = new Float32Array(800 * 3);
				for (let i = 0; i < 800; i++) {
					const r = 180, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
					starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
					starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
					starPos[i * 3 + 2] = r * Math.cos(ph);
				}
				starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
				scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
					size: 0.6, color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false
				})));
			} catch { /* demo data not available — blank canvas is fine */ }

			let animId: number;
			function animate() {
				animId = requestAnimationFrame(animate);
				controls.update();
				renderer.render(scene, camera);
			}
			animate();

			const ro = new ResizeObserver(() => {
				const w = parent.clientWidth;
				const h = parent.clientHeight;
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
				renderer.setSize(w, h);
			});
			ro.observe(parent);

			demoCleanup = () => {
				cancelAnimationFrame(animId);
				ro.disconnect();
				renderer.dispose();
			};
		})();

		return () => {
			if (demoCleanup) {
				demoCleanup();
				demoCleanup = null;
			}
		};
	});

	// Load everything on mount — avoids $effect async state mutation issues in Svelte 5
	onMount(() => {
		if (!browser) return;
		isTauri = isTauriEnv();

		// Lazy load 3D component — but NOT under Tauri (WebGL hangs the desktop webview).
		if (!Mindscape3D && !isTauri) {
			import('$lib/components/mindscape/Mindscape3D.svelte').then((module) => {
				Mindscape3D = module.default;
			});
		}

		// Load mindscape data
		mindscapeState.load();

		// Load health summary
		apiGet<HealthSummary>('/portal/health/summary', { days: '7' })
			.then(d => { healthData = d; })
			.catch(() => {});

		// Load Fisher trajectory summary (cognitive movement). Failure is silent —
		// the pill just doesn't render until the pipeline produces data.
		apiGet<any>('/portal/trajectory/summary', { period: 'month', level: 'realm' })
			.then(d => { trajectorySummary = d?.summary || null; })
			.catch(() => {});

		// Check generation + enrichment state
		checkGenerationState().then(() => {
			if (enrichment && enrichment.pending > 0 && get(generate).phase !== 'running') pollEnrichment();
		});

		// Resume an in-flight generate job from before a page refresh.
		resumeGen();

		// Resume explore polling + SSE
		const savedExplore = sessionStorage.getItem('mycelium_explore_job');
		if (savedExplore) { exploreJobId = savedExplore; connectExploreSSE(savedExplore); pollExplore(); }

		// Always load exploration status (needed for 3D view overlay)
		loadExplorationStatus();
		// Re-check every 30s to pick up externally triggered explorations
		const statusInterval = setInterval(loadExplorationStatus, 30000);
		return () => clearInterval(statusInterval);
	});

	const th = $derived($timelineHealth);

	let viewMode: '3d' | 'territories' = $state(isTauriEnv() ? 'territories' : '3d');

	// Territory profiles + activations + realms
	let territories: any[] = $state([]);
	let realms: any[] = $state([]);
	let activations: any = $state(null);
	let territoriesLoading = $state(false);
	let selectedTerritory: any = $state(null);
	let selectedRealmId: number | null = $state(null);

	let noiseStats: { total: number; noise: number; noisePct: string } | null = $state(null);
	let fingerprint: { depth_score: number; breadth_score: number; coherence_score: number; exploration_score: number } | null = $state(null);
	let complexity: { global_complexity: number | null; territories: Array<{ id: number; name: string; complexity: number }>; realms: Array<{ id: number; name: string; complexity: number }> } | null = $state(null);

	// Exploration status + control
	let explorationStatus: {
		globalExploredPercent: number; territoriesWithChronicles: number; totalTerritories: number;
		totalMessages: number; messagesAnalyzed: number; lastRunAt: string | null;
		explorationRunning: boolean; explorationJobId: string | null;
	} | null = $state(null);
	let exploreJobId: string | null = $state(null);
	let exploreJob: { status: string; step: number; totalSteps: number; stageLabel: string; error: string | null } | null = $state(null);
	let exploreCooldownSec = $state(0);
	let exploreError = $state('');
	let exploreLimit = $state(20);
	let exploreShowOptions = $state(false);
	let lensExpanded = $state<'explore' | 'pulses' | null>(null);
	let pulsesLensExpanded = $state(false);
	let exploreRealm = $state<number | null>(null);
	let explorePeriod = $state('');
	let exploreEvents: Array<{ type: string; [key: string]: any }> = $state([]);
	let exploreReport: any = $state(null);
	let exploreEventSource: EventSource | null = null;

	function relativeTime(iso: string | null): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		const min = Math.floor(ms / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min}m ago`;
		const hrs = Math.floor(min / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
	}

	async function loadExplorationStatus() {
		try {
			const res = await api('/portal/mindscape/exploration-status');
			if (res.ok) {
				explorationStatus = await res.json();
				if (explorationStatus?.explorationRunning && explorationStatus?.explorationJobId) {
					exploreJobId = explorationStatus.explorationJobId;
					lensExpanded = 'explore';
					if (!exploreEventSource) connectExploreSSE(exploreJobId);
					pollExplore();
				}
			}
		} catch {}
	}

	async function startExplore() {
		exploreError = '';
		exploreEvents = [];
		exploreReport = null;
		try {
			const body: any = { limit: exploreLimit };
		if (exploreRealm != null) body.realm = exploreRealm;
		if (explorePeriod) body.period = explorePeriod;
		const res = await api('/portal/mindscape/explore', { method: 'POST', body: JSON.stringify(body) });
			if (res.status === 429) {
				const data = await res.json();
				exploreCooldownSec = data.retryAfter || 60;
				const timer = setInterval(() => {
					exploreCooldownSec--;
					if (exploreCooldownSec <= 0) clearInterval(timer);
				}, 1000);
				return;
			}
			if (!res.ok) { exploreError = 'Failed to start exploration'; return; }
			const data = await res.json();
			exploreJobId = data.jobId;
			if (browser) sessionStorage.setItem('mycelium_explore_job', data.jobId);
			connectExploreSSE(data.jobId);
			pollExplore();
			lensExpanded = 'explore';
		} catch {
			exploreError = 'Failed to start exploration';
		}
	}

	let sseRetries = 0;
	function connectExploreSSE(jobId: string) {
		if (exploreEventSource) { exploreEventSource.close(); exploreEventSource = null; }
		try {
			const es = new EventSource(`/portal/mindscape/explore/stream/${jobId}`);
			exploreEventSource = es;
			es.onopen = () => { sseRetries = 0; };
			es.onmessage = (e) => {
				try {
					const event = JSON.parse(e.data);
					exploreEvents = [...exploreEvents, event];
					if (event.type === 'territory_done' || event.type === 'territory_skip' || event.type === 'territory_error') {
						const step = exploreEvents.filter(ev => ['territory_done','territory_skip','territory_error'].includes(ev.type)).length;
						if (exploreJob) exploreJob = { ...exploreJob, step };
					}
					if (event.type === 'job_done') {
						es.close();
						exploreEventSource = null;
					}
				} catch {}
			};
			es.onerror = () => {
				es.close();
				exploreEventSource = null;
				if (sseRetries < 5 && exploreJob?.status === 'running') {
					sseRetries++;
					setTimeout(() => connectExploreSSE(jobId), 2000 * sseRetries);
				}
			};
		} catch {}
	}

	async function loadExploreReport(jobId: string) {
		try {
			const res = await api(`/portal/mindscape/explore/report/${jobId}`);
			if (res.ok) exploreReport = await res.json();
		} catch {}
	}

	let pollFailures = 0;
	async function pollExplore() {
		if (!exploreJobId) return;
		try {
			const res = await api(`/portal/mindscape/explore/status/${exploreJobId}`);
			if (!res.ok) {
				pollFailures++;
				if (pollFailures > 5) { exploreJobId = null; exploreJob = null; return; }
				setTimeout(pollExplore, 5000);
				return;
			}
			pollFailures = 0;
			exploreJob = await res.json();

			if (exploreJob!.status === 'done') {
				sessionStorage.removeItem('mycelium_explore_job');
				if (exploreEventSource) { exploreEventSource.close(); exploreEventSource = null; }
				await loadExploreReport(exploreJobId!);
				lensExpanded = 'explore';
				territories = []; realms = [];
				loadTerritories();
				loadExplorationStatus();
				return;
			}
			if (exploreJob!.status === 'error' || exploreJob!.status === 'abandoned') {
				exploreError = exploreJob!.error || 'Exploration failed';
				sessionStorage.removeItem('mycelium_explore_job');
				if (exploreEventSource) { exploreEventSource.close(); exploreEventSource = null; }
				setTimeout(() => { exploreJobId = null; exploreJob = null; }, 5000);
				return;
			}
			setTimeout(pollExplore, 5000);
		} catch {
			pollFailures++;
			setTimeout(pollExplore, 8000);
		}
	}

	function dismissExploreReport() {
		exploreReport = null;
		exploreEvents = [];
		exploreJobId = null;
		exploreJob = null;
	}

	async function loadTerritories() {
		if (territories.length > 0) return;
		territoriesLoading = true;
		try {
			const [terrRes, actRes, realmRes, noiseRes, fpRes, cxRes] = await Promise.all([
				api('/portal/mindscape/territories'),
				api('/portal/mindscape/activations'),
				api('/portal/mindscape/realms'),
				api('/portal/mindscape/noise-stats'),
				api('/portal/mindscape/fingerprint'),
				api('/portal/mindscape/complexity'),
			]);
			if (terrRes.ok) {
				const data = await terrRes.json();
				territories = data.territories || [];
			}
			if (actRes.ok) {
				activations = await actRes.json();
			}
			if (realmRes.ok) {
				const data = await realmRes.json();
				realms = data.realms || [];
			}
			if (noiseRes.ok) {
				noiseStats = await noiseRes.json();
			}
			if (fpRes.ok) {
				const data = await fpRes.json();
				fingerprint = data.fingerprint || null;
			}
			if (cxRes.ok) {
				complexity = await cxRes.json();
			}
			// Load exploration status in parallel (non-blocking)
			loadExplorationStatus();
		} catch (e) {
			console.error('Failed to load territories:', e);
		}
		territoriesLoading = false;
	}

	// Merge activation + complexity data into territory profiles
	const enrichedTerritories = $derived(() => {
		if (!territories.length) return [];
		const actMap = new Map<number, any>();
		if (activations?.active) {
			for (const a of activations.active) {
				actMap.set(a.territory_id, a);
			}
		}
		const cxMap = new Map<number, number>();
		if (complexity?.territories) {
			for (const c of complexity.territories) {
				cxMap.set(c.id, c.complexity);
			}
		}
		let filtered = territories.map(t => ({
			...t,
			activation: actMap.get(t.territory_id) || null,
			lz_complexity: cxMap.get(t.territory_id) ?? null,
		}));

		// Filter by selected realm if drilled in
		if (selectedRealmId !== null) {
			filtered = filtered.filter(t => t.realm_id === selectedRealmId);
		}

		const seen = new Set<number>();
		return filtered.filter(t => { if (seen.has(t.territory_id)) return false; seen.add(t.territory_id); return true; })
			.sort((a, b) => {
				const aAct = a.activation ? 1000 + Math.abs(a.activation.surprise) : (a.energy || 0);
				const bAct = b.activation ? 1000 + Math.abs(b.activation.surprise) : (b.energy || 0);
				return bAct - aAct;
			});
	});

	// Derive activity status from timeline
	function activityStatus(timeline: any[]): 'active' | 'steady' | 'dormant' {
		if (!timeline || timeline.length < 2) return 'steady';
		const last = timeline[timeline.length - 1]?.count || 0;
		const prev = timeline[timeline.length - 2]?.count || 0;
		const avg = timeline.reduce((s: number, d: any) => s + (d.count || 0), 0) / timeline.length;
		if (last === 0 && prev === 0) return 'dormant';
		if (last > avg * 1.2) return 'active';
		return 'steady';
	}

	// Enrich realms with territory counts, activation data, complexity, and activity status
	const enrichedRealms = $derived(() => {
		if (!realms.length) return [];
		const realmTerritoryCount = new Map<number, number>();
		const realmMessageCount = new Map<number, number>();
		const realmTodayCount = new Map<number, number>();
		const realmComplexity = new Map<number, number>();
		if (complexity?.realms) {
			for (const c of complexity.realms) realmComplexity.set(c.id, c.complexity);
		}
		for (const t of territories) {
			if (t.realm_id != null) {
				realmTerritoryCount.set(t.realm_id, (realmTerritoryCount.get(t.realm_id) || 0) + 1);
				realmMessageCount.set(t.realm_id, (realmMessageCount.get(t.realm_id) || 0) + (t.message_count || 0));
			}
		}
		// Aggregate today's activations by realm
		if (activations?.active) {
			for (const a of activations.active) {
				if (a.realm_id != null) {
					realmTodayCount.set(a.realm_id, (realmTodayCount.get(a.realm_id) || 0) + (a.today_count || 0));
				}
			}
		}
		const seen = new Set<number>();
		return realms.map(r => ({
			...r,
			territory_count: r.territory_count || realmTerritoryCount.get(r.realm_id) || 0,
			total_messages: r.total_messages || realmMessageCount.get(r.realm_id) || 0,
			today_count: realmTodayCount.get(r.realm_id) || 0,
			status: activityStatus(r.activity_timeline),
			lz_complexity: realmComplexity.get(r.realm_id) ?? null,
		})).filter(r => { if (seen.has(r.realm_id)) return false; seen.add(r.realm_id); return true; })
		  .sort((a, b) => (b.total_messages || 0) - (a.total_messages || 0));
	});

	function drillIntoRealm(realmId: number) {
		selectedRealmId = realmId;
		selectedTerritory = null;
	}

	function goBackToRealms() {
		selectedRealmId = null;
		selectedTerritory = null;
	}

	const selectedRealmName = $derived(() => {
		if (selectedRealmId === null) return '';
		return realms.find(r => r.realm_id === selectedRealmId)?.name || `Realm ${selectedRealmId}`;
	});

	$effect(() => {
		if (viewMode === 'territories' && browser) loadTerritories();
	});

	const msState = $derived($mindscapeState);

	// Resizable panel state
	let panelWidth = $state(320);
	let isResizing = $state(false);
	let containerRef: HTMLElement;

	// Load saved width from localStorage
	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-detail-width');
			if (saved) {
				const parsed = parseInt(saved);
				if (parsed >= 250 && parsed <= 600) {
					panelWidth = parsed;
				}
			}
		}
	});

	// Resize handlers
	function startResize(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		window.addEventListener('mousemove', onResize);
		window.addEventListener('mouseup', stopResize);
	}

	function onResize(e: MouseEvent) {
		if (!isResizing || !containerRef) return;
		const containerRect = containerRef.getBoundingClientRect();
		const newWidth = e.clientX - containerRect.left;
		panelWidth = Math.max(250, Math.min(600, newWidth));
	}

	function stopResize() {
		isResizing = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		window.removeEventListener('mousemove', onResize);
		window.removeEventListener('mouseup', stopResize);
		if (browser) {
			localStorage.setItem('mycelium-detail-width', panelWidth.toString());
		}
	}
</script>

<svelte:head>
	<title>Mycelium</title>
</svelte:head>

{#if isCaptureMode}
	<div class="capture-canvas">
		{#if Mindscape3D}
			<Mindscape3D />
		{:else}
			<div style="width:100%;height:100%;background:#0A0A0C"></div>
		{/if}
	</div>
{:else}
<div class="mindscape-layout" class:resizing={isResizing} bind:this={containerRef}>
	<!-- Navigation + detail panel (always visible) -->
	<aside class="nav-panel" class:hidden-panel={viewMode === 'territories'} style="width: {panelWidth}px;">
		<MindscapeDetail />
		<!-- Resize handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-handle"
			class:active={isResizing}
			onmousedown={startResize}
		></div>
	</aside>

	<!-- Main content area -->
	<main class="view-panel">
		<!-- Top bar: health metrics left, view toggle right -->
		<div class="top-bar">
			<div class="top-bar-metrics">
				{#if th.active}
					{#if th.sleep != null}
						{@const h = Math.floor(th.sleep / 60)}
						{@const m = th.sleep % 60}
						<span class="hb-metric" title="Sleep avg">
							<span class="hb-icon" style="color: #818cf8;">&#9790;</span>
							{h}h{m.toString().padStart(2,'0')}m
						</span>
					{/if}
					{#if th.hrv != null}
						<span class="hb-metric" title="HRV avg">
							<span class="hb-icon" style="color: #4ade80;">&#9829;</span>
							{th.hrv}ms
						</span>
					{/if}
					{#if th.rhr != null}
						<span class="hb-metric" title="RHR avg">
							<span class="hb-icon" style="color: #f87171;">&#9829;</span>
							{th.rhr}bpm
						</span>
					{/if}
					{#if th.steps != null}
						<span class="hb-metric" title="Steps avg">
							<span class="hb-icon" style="color: #fb923c;">&#x1F6B6;</span>
							{th.steps.toLocaleString()}
						</span>
					{/if}
					{#if th.mindful != null}
						<span class="hb-metric" title="Mindfulness avg">
							<span class="hb-icon" style="color: #a78bfa;">&#x1F9D8;</span>
							{th.mindful}m
						</span>
					{/if}
				{:else if healthData?.today || healthData?.days?.length}
					{@const raw = healthData.today}
					{@const yesterday = healthData.days?.length >= 2 ? healthData.days[healthData.days.length - 2] : null}
					{@const t = {
						sleep_duration_min: raw?.sleep_duration_min ?? yesterday?.sleep_duration_min ?? null,
						sleep_efficiency: raw?.sleep_efficiency ?? yesterday?.sleep_efficiency ?? null,
						hrv_avg: raw?.hrv_avg ?? yesterday?.hrv_avg ?? null,
						resting_hr: raw?.resting_hr ?? yesterday?.resting_hr ?? null,
						steps: raw?.steps ?? null,
					}}
					{#if t.sleep_duration_min != null}
						{@const h = Math.floor(t.sleep_duration_min / 60)}
						{@const m = Math.round(t.sleep_duration_min % 60)}
						<span class="hb-metric" title="Sleep">
							<span class="hb-icon" style="color: #818cf8;">&#9790;</span>
							{h}h{m.toString().padStart(2,'0')}m
							{#if t.sleep_efficiency != null}<span class="hb-sub">{Math.round(t.sleep_efficiency * 100)}%</span>{/if}
						</span>
					{/if}
					{#if t.hrv_avg != null}
						<span class="hb-metric" title="HRV">
							<span class="hb-icon" style="color: #4ade80;">&#9829;</span>
							{Math.round(t.hrv_avg)}ms
						</span>
					{/if}
					{#if t.resting_hr != null}
						<span class="hb-metric" title="Resting HR">
							<span class="hb-icon" style="color: #f87171;">&#9829;</span>
							{Math.round(t.resting_hr)}bpm
						</span>
					{/if}
					{#if t.steps != null}
						<span class="hb-metric" title="Steps">
							<span class="hb-icon" style="color: #fb923c;">&#x1F6B6;</span>
							{t.steps.toLocaleString()}
						</span>
					{/if}
					{#if healthData.trends}
						{#each Object.entries(healthData.trends) as [k, v]}
							{#if v && v !== 'insufficient'}
								{@const label = k === 'sleep_duration_min' ? 'Sleep' : k === 'hrv_avg' ? 'HRV' : k === 'resting_hr' ? 'RHR' : k === 'steps' ? 'Steps' : null}
								{#if label}
									{@const arrow = v === 'improving' ? '\u2197' : v === 'declining' ? '\u2198' : '\u2192'}
									{@const clr = v === 'improving' ? '#4ade80' : v === 'declining' ? '#f87171' : 'var(--color-text-tertiary)'}
									<span class="hb-trend" style="color: {clr}">{arrow}{label}</span>
								{/if}
							{/if}
						{/each}
					{/if}
				{/if}
				{#if trajectorySummary?.phase}
					{@const phaseColors: Record<string, string> = {
						cycling: '#fb923c', exploring: '#f59e0b',
						transforming: '#06b6d4', stable: '#4ade80',
					}}
					{@const phaseColor = phaseColors[trajectorySummary.phase] || '#6B6B75'}
					<a class="hb-metric movement-pill" href="/vitality" title="Cognitive Movement: {trajectorySummary.phase}{trajectorySummary.exploration_ratio != null ? ` (R = ${trajectorySummary.exploration_ratio.toFixed(2)})` : ''}. Past 30 days.">
						<span class="hb-icon" style="color: {phaseColor};">&#x223F;</span>
						<span class="movement-phase" style="color: {phaseColor};">{trajectorySummary.phase}</span>
						{#if trajectorySummary.exploration_ratio != null}
							<span class="movement-r">R={trajectorySummary.exploration_ratio.toFixed(2)}</span>
						{/if}
					</a>
				{/if}
			</div>
			<div class="view-toggle">
				<button class:active={viewMode === 'territories'} onclick={() => viewMode = 'territories'}>Territories</button>
				<button class:active={viewMode === '3d'} disabled={isTauri} title={isTauri ? 'The 3D map runs in the browser version (open localhost:8787 in your browser)' : ''} onclick={() => { if (!isTauri) viewMode = '3d'; }}>3D Map</button>
			</div>
		</div>

		{#if viewMode === 'territories'}
			<div class="territories-view">
				{#if territoriesLoading}
					<div class="loading-3d"><div class="spinner"></div></div>
				{:else if territories.length === 0 && realms.length === 0}
					<div class="empty-state">
						{#if $generate.phase === 'starting' || $generate.phase === 'running'}
							<div class="gen-progress">
								<h3 class="gen-heading">Growing your mindscape…</h3>
								<p class="gen-stage">{$generate.stageLabel || 'Starting…'} &mdash; step {$generate.step} of {$generate.totalSteps}</p>
								<div class="gen-bar"><div class="gen-fill" style="width: {Math.max(4, ($generate.step / Math.max(1, $generate.totalSteps)) * 100)}%"></div></div>
								<p class="gen-hint">{fmtSeconds($generate.elapsedMs / 1000)} elapsed{#if $generate.etaSeconds != null} &middot; ~{fmtSeconds($generate.etaSeconds)} left{/if}</p>
								{#if $generate.stalled}
									<p class="gen-hint" style="color: #d9a441;">Still working on this step — it's taking longer than usual.</p>
								{/if}
								<p class="gen-hint">This keeps running if you navigate away.</p>
								<button class="gen-button" style="margin-top: 12px; opacity: 0.7;" onclick={() => cancelGen()}>Cancel</button>
							</div>
						{:else if $generate.phase === 'embedding'}
							<div class="gen-progress">
								<h3 class="gen-heading">Processing your conversations…</h3>
								<p class="gen-stage">{$generate.embedded.toLocaleString()} / {$generate.total.toLocaleString()} ready</p>
								<div class="gen-bar"><div class="gen-fill" style="width: {$generate.total > 0 ? ($generate.embedded / $generate.total) * 100 : 0}%"></div></div>
								{#if $generate.embedder?.status === 'loading'}
									<p class="gen-hint">Warming up the embedding engine…</p>
								{:else}
									<p class="gen-hint">Generation starts automatically as soon as enough is ready.</p>
								{/if}
								<button class="gen-button" style="margin-top: 12px; opacity: 0.7;" onclick={() => cancelGen()}>Cancel</button>
							</div>
						{:else if $generate.phase === 'done'}
							<div class="gen-progress">
								<h3 class="gen-heading">Mycelium generated</h3>
								<p class="gen-hint">Loading your territories…</p>
							</div>
						{:else if $generate.phase === 'error'}
							<div class="gen-progress">
								<h3 class="gen-heading">Generation hit a snag</h3>
								<p class="gen-error">{$generate.error}</p>
								<button class="gen-button" style="margin-top: 12px;" onclick={() => startGen()}>Try again</button>
							</div>
						{:else if enrichment && enrichment.pending > 0}
							{@const pct = enrichment.total > 0 ? (enrichment.enriched / enrichment.total) * 100 : 0}
							{@const msgPerMin = enrichment.rate ? parseInt(enrichment.rate) : 0}
							{@const remaining = enrichment.total - enrichment.enriched}
							{@const etaMin = msgPerMin > 0 ? Math.round(remaining / msgPerMin) : 0}
							<div class="gen-progress">
								<h3 class="gen-heading">Preparing your data...</h3>
								<p class="gen-stage">{enrichment.enriched.toLocaleString()} / {enrichment.total.toLocaleString()} messages embedded</p>
								<div class="gen-bar"><div class="gen-fill" style="width: {pct}%"></div></div>
								{#if enrichment.enriched === 0 && !enrichTriggering}
									<button class="gen-button" onclick={triggerEnrichment} disabled={enrichTriggering} style="margin-top: 12px;">
										Start Processing
									</button>
								{:else if msgPerMin > 0}
									<p class="gen-hint" style="margin-top: 6px;">
										{msgPerMin} msg/min
										{#if etaMin > 0}
											&middot; ~{etaMin < 60 ? `${etaMin} min` : `${Math.floor(etaMin / 60)}h ${etaMin % 60}m`} remaining
										{/if}
									</p>
								{/if}
								<p class="gen-hint">Once embedding completes, you can generate your Mycelium.</p>
							</div>
						{:else if hasImportedData}
							<h3 class="gen-heading">Your data is ready</h3>
							{#if !aiReady}
								<p class="gen-hint">AI models are still being set up on your server. Generation will be available in a few minutes.</p>
							{:else}
								<p>Generate your mindscape to discover territories, realms, and semantic connections.</p>
								<button class="gen-button" onclick={() => startGen()}>Generate Mycelium</button>
							{/if}
						{:else}
							<p>Import conversations first, then generate your mindscape here.</p>
						{/if}
					</div>
				{:else}
					<!-- Breadcrumb -->
					{#if selectedRealmId !== null}
						<div class="breadcrumb">
							<button class="breadcrumb-link" onclick={goBackToRealms}>Mycelium</button>
							<span class="breadcrumb-sep">/</span>
							<span class="breadcrumb-current">{selectedRealmName()}</span>
						</div>
					{/if}

					<div class="activation-summary">
						{#if activations?.total_messages}
							<span class="act-stat">{activations.total_messages} messages today</span>
							<span class="act-stat">{activations.active?.length || 0} territories active</span>
							{#if activations.silent?.length}
								<span class="act-stat silent">{activations.silent.length} usually-active silent</span>
							{/if}
						{/if}
						{#if noiseStats}
							<span class="act-stat">{noiseStats.total.toLocaleString()} points</span>
							{#if noiseStats.noise > 0}
								<span class="act-stat unclustered">{noiseStats.noise.toLocaleString()} unclustered ({noiseStats.noisePct}%)</span>
							{/if}
						{/if}
					</div>

					<!-- Cognitive fingerprint + global complexity -->
					{#if selectedRealmId === null && (fingerprint || complexity?.global_complexity != null)}
						<div class="fingerprint-bar">
							{#if fingerprint}
								{#each [
									{ label: 'Depth', value: fingerprint.depth_score, color: '#818cf8' },
									{ label: 'Breadth', value: fingerprint.breadth_score, color: '#5B9FE8' },
									{ label: 'Coherence', value: fingerprint.coherence_score, color: '#E5B84C' },
									{ label: 'Exploration', value: fingerprint.exploration_score, color: '#4ADE80' },
								] as s}
									<div class="fp-score" title="{s.label}: {((s.value || 0) * 100).toFixed(0)}%">
										<span class="fp-label">{s.label}</span>
										<div class="fp-track">
											<div class="fp-fill" style="width: {(s.value || 0) * 100}%; background: {s.color};"></div>
										</div>
										<span class="fp-value" style="color: {s.color}">{((s.value || 0) * 100).toFixed(0)}</span>
									</div>
								{/each}
							{/if}
							{#if complexity?.global_complexity != null}
								<div class="fp-score" title="Compression complexity: {((complexity.global_complexity) * 100).toFixed(0)}% — higher = more novel thinking">
									<span class="fp-label">Novelty</span>
									<div class="fp-track">
										<div class="fp-fill" style="width: {complexity.global_complexity * 100}%; background: #f472b6;"></div>
									</div>
									<span class="fp-value" style="color: #f472b6">{(complexity.global_complexity * 100).toFixed(0)}</span>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Exploration panel -->
					{#if (explorationStatus || exploreReport) && selectedRealmId === null}
						<div class="exploration-overview">
							{#if exploreReport}
								<div class="explore-report-header">
									<span class="explore-detail">
										{exploreReport.territories.length} explored{#if exploreReport.finishedAt && exploreReport.startedAt} &middot; {Math.round((new Date(exploreReport.finishedAt).getTime() - new Date(exploreReport.startedAt).getTime()) / 60000)}m{/if}
									</span>
									<button class="explore-dismiss" onclick={dismissExploreReport}>&times;</button>
								</div>
								<div class="explore-report-list">
									{#each exploreReport.territories as t}
										<details class="explore-report-item">
											<summary class="explore-report-summary">
												<span class="report-name">{t.name}</span>
												<span class="report-meta">{t.coverage?.toFixed(0)}%</span>
											</summary>
											<div class="explore-report-body">
												<p class="report-notes">{t.notes}</p>
												{#if t.keyEntities?.length}
													<div class="report-entities">{#each t.keyEntities as e}<span class="entity-pill-sm">{e}</span>{/each}</div>
												{/if}
											</div>
										</details>
									{/each}
								</div>
								<button class="explore-button" onclick={dismissExploreReport} style="margin-top: 6px; width: 100%;">Done</button>

							{:else if exploreJob?.status === 'running'}
								{@const doneCount = exploreEvents.filter(e => e.type === 'territory_done').length}
								{@const skipCount = exploreEvents.filter(e => e.type === 'territory_skip').length}
								{@const currentEvent = [...exploreEvents].reverse().find(e => e.type === 'territory_start' || e.type === 'synthesis_start')}
								{@const lastDone = [...exploreEvents].reverse().find(e => e.type === 'territory_done')}
								<div class="gen-bar"><div class="gen-fill" style="width: {(exploreJob.step / exploreJob.totalSteps) * 100}%; background: var(--color-accent-jade);"></div></div>
								<div class="explore-live-status">
									<span class="explore-live-count">{doneCount} done{#if skipCount > 0} &middot; {skipCount} skipped{/if} &middot; {exploreJob.totalSteps} total</span>
								</div>
								{#if currentEvent}
									<div class="explore-live-current">
										<span class="log-icon spin" style="color: var(--color-accent);">&#9679;</span>
										<span>{currentEvent.type === 'synthesis_start' ? `Synthesizing from ${currentEvent.passes} passes` : `Sampling ${currentEvent.unseen} points`}...</span>
									</div>
								{/if}
								{#if lastDone}
									<div class="explore-live-last">
										<span class="log-icon" style="color: var(--color-accent-jade);">&#10003;</span>
										<span>{lastDone.name || `T${lastDone.id}`}{#if lastDone.result === 'pass'} &rarr; {lastDone.coverage}%{/if}</span>
										{#if lastDone.entities?.length}<span class="log-entities">{lastDone.entities.slice(0, 3).join(', ')}</span>{/if}
									</div>
								{/if}

							{:else if explorationStatus}
								<div class="explore-stats-row">
									<div class="explore-bar-section">
										<div class="explore-bar-track"><div class="explore-bar-fill" style="width: {explorationStatus.globalExploredPercent}%"></div></div>
										<span class="explore-pct">{explorationStatus.globalExploredPercent.toFixed(0)}% explored</span>
									</div>
									{#if exploreShowOptions}
										<div class="explore-controls">
											<select bind:value={exploreLimit} class="explore-select">
												<option value={10}>10</option>
												<option value={20}>20</option>
												<option value={50}>50</option>
												<option value={100}>100</option>
											</select>
											<button class="explore-button" onclick={() => { exploreShowOptions = false; startExplore(); }} disabled={exploreCooldownSec > 0}>
												{exploreCooldownSec > 0 ? `${exploreCooldownSec}s` : 'Go'}
											</button>
										</div>
									{:else}
										<button class="explore-button" onclick={() => exploreShowOptions = true} disabled={exploreCooldownSec > 0}>
											{exploreCooldownSec > 0 ? `${exploreCooldownSec}s` : 'Explore'}
										</button>
									{/if}
								</div>
								<p class="explore-detail">
									{explorationStatus.territoriesWithChronicles} / {explorationStatus.totalTerritories} described
									{#if explorationStatus.lastRunAt}&middot; last {relativeTime(explorationStatus.lastRunAt)}{/if}
								</p>
								{#if exploreError}<p class="explore-error">{exploreError}</p>{/if}
							{/if}
						</div>
					{/if}

					<!-- Realm cards (top level) -->
					{#if selectedRealmId === null && enrichedRealms().length > 0}
						<div class="realm-list">
							{#each enrichedRealms() as r (r.realm_id)}
								<button class="realm-card" onclick={() => drillIntoRealm(r.realm_id)}>
									<div class="realm-header">
										<span class="realm-name">{r.name || `Realm ${r.realm_id}`}</span>
										<div class="realm-badges">
											{#if r.archetype_type}
												<span class="badge archetype">{r.archetype_type}</span>
											{/if}
											{#if r.status === 'active'}
												<span class="badge active">Active</span>
											{:else if r.status === 'dormant'}
												<span class="badge dormant">Dormant</span>
											{/if}
											{#if r.today_count > 0}
												<span class="badge today-badge">{r.today_count} today</span>
											{/if}
										</div>
									</div>
									<span class="realm-count">{r.point_count?.toLocaleString() || 0} points · {r.territory_count} territories</span>
									{#if r.essence}
										<p class="realm-essence">{r.essence}</p>
									{/if}
									{#if r.story_current_chapter}
										<p class="realm-chapter">{r.story_current_chapter}</p>
									{/if}
									{#if r.top_entities?.length}
										<div class="realm-entities">
											{#each (Array.isArray(r.top_entities) ? r.top_entities : []).slice(0, 4) as entity}
												<span class="entity-pill-sm">{typeof entity === 'string' ? entity : entity.text || entity.name || entity}</span>
											{/each}
										</div>
									{/if}
									<div class="realm-footer">
										<span class="realm-msgs">{(r.total_messages || 0).toLocaleString()} msgs</span>
										{#if r.explored_percent > 0}
											<span class="realm-explored" title="Percentage of content analyzed by Claude">
												<span class="cx-bar-track realm-cx-track">
													<span class="cx-bar-fill" style="width: {r.explored_percent}%; background: var(--color-accent-jade);"></span>
												</span>
												<span class="explored-value">{r.explored_percent.toFixed(0)}%</span>
											</span>
										{/if}
										{#if r.lz_complexity != null}
											<span class="realm-complexity" title="LZ compression complexity — higher = more novel thinking patterns">
												<span class="cx-label">novelty</span>
												<span class="cx-bar-track realm-cx-track">
													<span class="cx-bar-fill" style="width: {r.lz_complexity * 100}%"></span>
												</span>
												<span class="cx-value">{(r.lz_complexity * 100).toFixed(0)}</span>
											</span>
										{/if}
										{#if r.activity_timeline?.length}
											<Sparkline data={r.activity_timeline} width={120} height={24} />
										{/if}
									</div>
								</button>
							{/each}
						</div>
					{/if}

					<!-- Territory list (within a realm or flat if no realms) -->
					{#if selectedRealmId !== null || enrichedRealms().length === 0}
						<div class="territory-list">
							{#each enrichedTerritories() as t (t.territory_id)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="territory-card"
									class:active-today={t.activation}
									class:selected={selectedTerritory?.territory_id === t.territory_id}
									onclick={() => selectedTerritory = selectedTerritory?.territory_id === t.territory_id ? null : t}
								>
									<div class="terr-header">
										<span class="terr-name">{t.name || `Territory ${t.territory_id}`}</span>
										<div class="terr-badges">
											<button
												type="button"
												class="badge visibility-badge"
												class:vis-public={t.visibility === 'public'}
												class:vis-friends={t.visibility === 'friends'}
												onclick={(e: MouseEvent) => {
													e.stopPropagation();
													const next = t.visibility === 'private' ? 'public' : t.visibility === 'public' ? 'friends' : 'private';
													apiPut(`/portal/mindscape/territory/${t.territory_id}/visibility`, { visibility: next }).then(() => {
														t.visibility = next;
													}).catch(() => {});
												}}
												title={`Visibility: ${t.visibility || 'private'} (click to cycle)`}
											>
												{t.visibility === 'public' ? '\u{1F310}' : t.visibility === 'friends' ? '\u{1F465}' : '\u{1F512}'}
											</button>
											{#if t.archetype_type}
												<span class="badge archetype">{t.archetype_type}</span>
											{/if}
											{#if t.activation}
												{#if t.activation.surprise > 0.5}
													<span class="badge surge">SURGE</span>
												{:else if t.activation.surprise < -0.3}
													<span class="badge quiet">QUIET</span>
												{:else}
													<span class="badge active">ACTIVE</span>
												{/if}
											{:else if t.activity_timeline?.length >= 2 && (t.activity_timeline[t.activity_timeline.length - 1]?.count || 0) === 0 && (t.activity_timeline[t.activity_timeline.length - 2]?.count || 0) === 0}
												<span class="badge dormant">Dormant</span>
											{/if}
											{#if t.growth_state === 'growing'}
												<span class="badge growing">growing</span>
											{/if}
										</div>
									</div>

									{#if t.essence}
										<p class="terr-essence">{t.essence}</p>
									{/if}

									<div class="terr-metrics">
										<span class="metric">
											<span class="metric-label">msgs</span>
											<span class="metric-value">{(t.message_count || 0).toLocaleString()}</span>
										</span>
										<span class="metric">
											<span class="metric-label">energy</span>
											<span class="metric-value">{((t.energy || 0) * 100).toFixed(1)}%</span>
										</span>
										<span class="metric cx-metric" title="{t.explored_count || 0} of {t.message_count || 0} messages explored">
											<span class="metric-label">explored</span>
											<span class="cx-bar-track territory-cx-track">
												<span class="cx-bar-fill" style="width: {t.explored_percent || 0}%; background: var(--color-accent-jade);"></span>
											</span>
											<span class="metric-value" style="color: var(--color-accent-jade)">{(t.explored_percent || 0).toFixed(0)}</span>
										</span>
										{#if t.lz_complexity != null}
											<span class="metric cx-metric" title="LZ compression complexity — higher = more novel thinking patterns">
												<span class="metric-label">novelty</span>
												<span class="cx-bar-track">
													<span class="cx-bar-fill" style="width: {t.lz_complexity * 100}%"></span>
												</span>
												<span class="metric-value" style="color: #f472b6">{(t.lz_complexity * 100).toFixed(0)}</span>
											</span>
										{/if}
										{#if t.activation}
											<span class="metric today">
												<span class="metric-label">today</span>
												<span class="metric-value">{t.activation.today_count}</span>
											</span>
										{/if}
										{#if t.activity_timeline?.length}
											<Sparkline data={t.activity_timeline} />
										{/if}
									</div>
									{#if t.top_entities?.length}
										<div class="terr-entities">
											{#each (t.top_entities || []).slice(0, 3) as entity}
												<span class="entity-pill-sm">{typeof entity === 'string' ? entity : entity.text || entity.name || entity}</span>
											{/each}
										</div>
									{/if}

									{#if selectedTerritory?.territory_id === t.territory_id}
										<div class="terr-detail">
											{#if t.chronicle}
												<div class="detail-section">
													<h4>Chronicle</h4>
													<p class="chronicle-text">{t.chronicle}</p>
												</div>
											{:else if t.story_arc}
												<div class="detail-section">
													<h4>Story</h4>
													<p>{t.story_arc}</p>
												</div>
											{/if}
											{#if t.story_current_chapter}
												<div class="detail-section">
													<h4>Current Chapter</h4>
													<p>{t.story_current_chapter}</p>
												</div>
											{/if}

											<!-- Activity timeline (larger version) -->
											{#if t.activity_timeline?.length > 2}
												<div class="detail-section">
													<h4>Activity</h4>
													<div class="detail-timeline">
														<Sparkline data={t.activity_timeline} width={200} height={32} />
													</div>
												</div>
											{/if}

											<!-- Key entities -->
											{#if t.top_entities?.length}
												<div class="detail-section">
													<h4>Key Entities</h4>
													<div class="entity-pills">
														{#each t.top_entities.slice(0, 10) as entity}
															<span class="entity-pill">{typeof entity === 'string' ? entity : entity.name || entity}</span>
														{/each}
													</div>
												</div>
											{/if}

											<!-- Connected regions -->
											{#if t.uncertainty_edges}
												<div class="detail-section">
													<h4>Connected Regions</h4>
													<p class="connected-regions">{t.uncertainty_edges}</p>
												</div>
											{/if}
											{#if t.agent_would_consult?.length}
												<div class="detail-section">
													<h4>Cross-References</h4>
													<div class="cross-refs">
														{#each t.agent_would_consult as ref}
															<span class="cross-ref-pill">
																{typeof ref === 'string' ? ref : ref.territory_name || ref.for || JSON.stringify(ref)}
															</span>
														{/each}
													</div>
												</div>
											{/if}

											{#if t.signature_patterns?.length}
												<div class="detail-section">
													<h4>Patterns</h4>
													<ul>{#each t.signature_patterns as p}<li>{p}</li>{/each}</ul>
												</div>
											{/if}
											{#if t.uncertainty_open_questions?.length}
												<div class="detail-section">
													<h4>Open Threads</h4>
													<ul>{#each t.uncertainty_open_questions as q}<li>{q}</li>{/each}</ul>
												</div>
											{/if}
											{#if t.activation?.agents?.length}
												<div class="detail-section">
													<h4>Active Agents Today</h4>
													<p>{t.activation.agents.join(', ')}</p>
												</div>
											{/if}
											{#if t.explored_percent}
												<div class="detail-section explored-note">
													<span>{t.explored_count || 0} of {t.message_count || 0} messages analyzed ({t.explored_percent}%)</span>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{:else if viewMode === '3d'}
			{#if msState.loading}
				<div class="loading-3d">
					<div class="spinner"></div>
				</div>
			{:else if msState.points && msState.points.length > 0}
				{#if Mindscape3D}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="map-container" onilluminate={(e) => {
						const period = e.detail;
						if (period && !exploreJob) {
							exploreError = '';
							exploreEvents = [];
							exploreReport = null;
							api('/portal/mindscape/explore', { method: 'POST', body: JSON.stringify({ limit: 20, period }) })
								.then(async (res) => {
									if (res.ok) {
										const data = await res.json();
										exploreJobId = data.jobId;
										if (browser) sessionStorage.setItem('mycelium_explore_job', data.jobId);
										connectExploreSSE(data.jobId);
										pollExplore();
									}
								}).catch(() => {});
						}
					}}>
						<Mindscape3D />
					</div>
					<!-- Lens bar (floats top-right of 3D map) -->
					<div class="lens-bar">
						<!-- Pulses lens (M4) — play/pause + layer toggles + sparkline -->
						<PulsesLens bind:expanded={pulsesLensExpanded} />
						<!-- Exploration lens -->
						{#if explorationStatus}
							{@const isExploring = exploreJob?.status === 'running' || explorationStatus.explorationRunning}
							<button class="lens-chip" class:lens-active={isExploring} onclick={() => { lensExpanded = lensExpanded === 'explore' ? null : 'explore'; }}>
								<span class="lens-ring" style="background: conic-gradient(var(--color-accent-jade) {explorationStatus.globalExploredPercent}%, transparent {explorationStatus.globalExploredPercent}%);"></span>
								{#if isExploring}
									<span class="lens-pct lens-pulse">{exploreJob ? `${exploreJob.step}/${exploreJob.totalSteps}` : '...'}</span>
								{:else}
									<span class="lens-pct">{explorationStatus.globalExploredPercent.toFixed(0)}%</span>
								{/if}
							</button>
						{/if}
					</div>

					<!-- Exploration detail (expands from lens) -->
					{#if lensExpanded === 'explore' && explorationStatus}
						<div class="lens-panel">
							{#if exploreReport}
								<div class="lens-panel-header">
									<span class="lens-panel-title">Explored {exploreReport.territories.length} territories</span>
									<button class="lens-dismiss" onclick={dismissExploreReport}>&times;</button>
								</div>
								<div class="explore-log" style="max-height: 400px;">
									{#each exploreReport.territories as t}
										<div class="log-item done">
											<span class="log-icon">&#10003;</span>
											<div>
												<span class="log-text">{t.name}</span>
												<span class="log-entities">{t.coverage?.toFixed(0)}%{#if t.keyEntities?.length} · {t.keyEntities.slice(0, 3).join(', ')}{/if}</span>
											</div>
										</div>
									{/each}
								</div>
							{:else if exploreJob?.status === 'running'}
								<div class="lens-panel-header">
									<span class="lens-panel-title">{exploreJob.step} / {exploreJob.totalSteps}</span>
								</div>
								<div class="gen-bar" style="margin-bottom: 6px;"><div class="gen-fill" style="width: {(exploreJob.step / exploreJob.totalSteps) * 100}%; background: var(--color-accent-jade);"></div></div>
								<div class="explore-log" style="max-height: 400px;">
									{#each exploreEvents as ev}
										{#if ev.type === 'territory_done'}
											<div class="log-item done">
												<span class="log-icon">&#10003;</span>
												<div class="log-content">
													<span class="log-text">{ev.name || `T${ev.id}`}{#if ev.coverage < 100} · {ev.coverage}%{/if}</span>
													{#if ev.insight}
														<span class="log-insight">{ev.insight}</span>
													{/if}
												</div>
											</div>
										{:else if ev.type === 'territory_start'}
											<div class="log-item active">
												<span class="log-icon spin">&#9679;</span>
												<span class="log-text">{ev.name || `T${ev.id}`}</span>
											</div>
										{/if}
									{/each}
								</div>
							{:else}
								<div class="lens-panel-header">
									<span class="lens-panel-title">{explorationStatus.territoriesWithChronicles} / {explorationStatus.totalTerritories} territories</span>
									{#if explorationStatus.lastRunAt}
										<span class="lens-panel-meta">last {relativeTime(explorationStatus.lastRunAt)}</span>
									{/if}
								</div>
								<div class="lens-filters">
									<select bind:value={exploreRealm} class="lens-select">
										<option value={null}>All realms</option>
										{#each realms as r}
											<option value={r.realm_id}>{r.name}</option>
										{/each}
									</select>
									<input type="month" bind:value={explorePeriod} class="lens-input" />
								</div>
								<div class="lens-explore-controls">
									<select bind:value={exploreLimit} class="lens-select">
										<option value={10}>10</option>
										<option value={20}>20</option>
										<option value={50}>50</option>
										<option value={100}>100</option>
									</select>
									<button class="lens-explore-btn" onclick={startExplore} disabled={exploreCooldownSec > 0}>
										{exploreCooldownSec > 0 ? `${exploreCooldownSec}s` : 'Explore'}
									</button>
								</div>
							{/if}
						</div>
					{/if}
				{:else}
					<div class="loading-3d">
						<div class="spinner"></div>
					</div>
				{/if}
			{:else}
				<!-- Welcome: empty mindscape onboarding -->
				<div class="welcome">
					<!-- 3D demo mindscape background -->
					<canvas class="welcome-canvas" bind:this={demoCanvas}></canvas>

					<div class="welcome-inner">
						{#if $generate.phase === 'starting' || $generate.phase === 'running'}
							<!-- Generation in progress — overlay on demo canvas -->
							<h2 class="welcome-title">Growing your mindscape…</h2>
							<p class="gen-stage">{$generate.stageLabel || 'Starting…'} &mdash; step {$generate.step} of {$generate.totalSteps}</p>
							<div class="gen-bar"><div class="gen-fill" style="width: {Math.max(4, ($generate.step / Math.max(1, $generate.totalSteps)) * 100)}%"></div></div>
							<div class="gen-dots">
								{#each Array($generate.totalSteps) as _, i}
									<span class="gen-dot" class:done={i < $generate.step} class:active={i === $generate.step}></span>
								{/each}
							</div>
							<p class="gen-hint">{fmtSeconds($generate.elapsedMs / 1000)} elapsed{#if $generate.etaSeconds != null} &middot; ~{fmtSeconds($generate.etaSeconds)} left{/if}</p>
							{#if $generate.stalled}
								<p class="gen-hint" style="color: #d9a441;">Still working on this step — it's taking longer than usual.</p>
							{/if}
							<p class="gen-hint">This keeps running if you navigate away.</p>
							<button class="gen-button" style="margin-top: 12px; opacity: 0.7;" onclick={() => cancelGen()}>Cancel</button>
						{:else if $generate.phase === 'embedding'}
							<h2 class="welcome-title">Processing your conversations…</h2>
							<p class="gen-stage">{$generate.embedded.toLocaleString()} / {$generate.total.toLocaleString()} ready</p>
							<div class="gen-bar"><div class="gen-fill" style="width: {$generate.total > 0 ? ($generate.embedded / $generate.total) * 100 : 0}%"></div></div>
							{#if $generate.embedder?.status === 'loading'}
								<p class="gen-hint">Warming up the embedding engine…</p>
							{:else}
								<p class="gen-hint">Generation starts automatically as soon as enough is ready.</p>
							{/if}
							<button class="gen-button" style="margin-top: 12px; opacity: 0.7;" onclick={() => cancelGen()}>Cancel</button>
						{:else if $generate.phase === 'done'}
							<h2 class="welcome-title">Mycelium generated</h2>
							<p class="gen-hint">Loading your 3D map…</p>
						{:else if $generate.phase === 'error'}
							<h2 class="welcome-title">Generation hit a snag</h2>
							<p class="gen-error">{$generate.error}</p>
							<button class="gen-button" style="margin-top: 12px;" onclick={() => startGen()}>Try again</button>
						{:else if enrichment && enrichment.pending > 0}
							{@const mpm = enrichment.rate ? parseInt(enrichment.rate) : 0}
							{@const rem2 = enrichment.total - enrichment.enriched}
							{@const eta2 = mpm > 0 ? Math.round(rem2 / mpm) : 0}
							<!-- Enrichment running — show progress over demo canvas -->
							<h2 class="welcome-title">Preparing your data...</h2>
							<p class="gen-stage">{enrichment.enriched.toLocaleString()} / {enrichment.total.toLocaleString()} messages embedded</p>
							<div class="gen-bar"><div class="gen-fill" style="width: {enrichment.total > 0 ? (enrichment.enriched / enrichment.total) * 100 : 0}%"></div></div>
							{#if enrichment.enriched === 0 && !enrichTriggering}
								<button class="gen-button" onclick={triggerEnrichment} disabled={enrichTriggering} style="margin-top: 12px;">
									Start Processing
								</button>
							{:else if mpm > 0}
								<p class="gen-hint" style="margin-top: 6px;">
									{mpm} msg/min
									{#if eta2 > 0}
										&middot; ~{eta2 < 60 ? `${eta2} min` : `${Math.floor(eta2 / 60)}h ${eta2 % 60}m`} remaining
									{/if}
								</p>
							{/if}
							<p class="gen-hint">Once embedding completes, you can generate your Mycelium.</p>
						{:else if hasImportedData}
							<!-- Data ready, show generate CTA over demo canvas -->
							<h2 class="welcome-title">
								{#if $auth.user?.displayName}
									{$auth.user.displayName}, your data is ready
								{:else}
									Your data is ready
								{/if}
							</h2>
							<p class="welcome-subtitle">Generate your mindscape to see your thinking mapped in 3D — territories, realms, and semantic connections.</p>
							<button class="gen-button" onclick={() => startGen()}>Generate Mycelium</button>
						{:else}
							<!-- Welcome text -->
							<h2 class="welcome-title">
								{#if $auth.user?.displayName}
									Welcome, {$auth.user.displayName}
								{:else}
									Welcome to Mycelium
								{/if}
							</h2>
							<p class="welcome-subtitle">Your personal intelligence system. Encrypted end-to-end, living on your server, growing with every conversation.</p>

							<!-- What Mycelium does -->
							<div class="welcome-outcomes">
								<div class="outcome">
									<span class="outcome-icon" style="color: var(--color-accent-aurum);">&#x25C9;</span>
									<div>
										<span class="outcome-label">Living knowledge</span>
										<span class="outcome-desc">Every conversation, document, and note feeds a 3D map of your thinking. Territories form, chronicles evolve, patterns surface. Your data compounds for you.</span>
									</div>
								</div>
								<div class="outcome">
									<span class="outcome-icon" style="color: var(--color-accent-amethyst);">&#x25C8;</span>
									<div>
										<span class="outcome-label">Real connections</span>
										<span class="outcome-desc">Find people with overlapping interests and thinking. Connect based on genuine intellectual resonance, not followers and likes. Privacy-preserving by design.</span>
									</div>
								</div>
								<div class="outcome">
									<span class="outcome-icon" style="color: var(--color-accent-jade);">&#x25CE;</span>
									<div>
										<span class="outcome-label">Intelligence on your terms</span>
										<span class="outcome-desc">Define your own information streams. Geopolitical briefings, prediction markets, OSINT feeds. Scored with probabilities, not filtered by an algorithm.</span>
									</div>
								</div>
							</div>

							<!-- Modules -->
							<div class="welcome-modules">
								<span class="module-pill">Wealth tracking</span>
								<span class="module-pill">Voice &amp; transcription</span>
								<span class="module-pill">Publishing</span>
								<span class="module-pill">Research</span>
								<span class="module-pill">Activity &amp; health</span>
							</div>

							<!-- Getting started -->
							<div class="welcome-start">
								<h3 class="start-heading">Plant the first threads</h3>
								<p class="start-desc">Provide substrate &mdash; connect an AI, bring your conversations. Spawn your agents. Watch your Mycelium come to life.</p>
								<ConnectionsChecklist showTitle={false} compact={true} />
							</div>

							<p class="welcome-footer">Everything is encrypted end-to-end. Your data lives on your server, not ours.</p>
						{/if}
					</div>
				</div>
			{/if}
		{/if}
	</main>
</div>
{/if}

<style>
	.capture-canvas {
		width: 100vw;
		height: 100vh;
		overflow: hidden;
		background: #0A0A0C;
	}

	.top-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 12px;
		min-height: 36px;
		background: var(--color-surface);
		border-bottom: 1px solid var(--color-border);
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		flex-shrink: 0;
		z-index: 5;
		position: relative;
	}
	.top-bar-metrics {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: nowrap;
		overflow: hidden;
		min-width: 0;
	}
	.hb-metric {
		display: flex;
		align-items: center;
		gap: 3px;
		white-space: nowrap;
	}
	.hb-icon { font-size: 0.8rem; }
	.hb-sub { font-size: 0.6rem; color: var(--color-text-tertiary); }
	.hb-trend {
		font-size: 0.6rem;
		font-weight: 500;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(255,255,255,0.05);
	}
	.movement-pill {
		text-decoration: none;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.06);
		transition: background 0.15s, border-color 0.15s;
		cursor: pointer;
	}
	.movement-pill:hover {
		background: rgba(255,255,255,0.08);
		border-color: rgba(255,255,255,0.12);
	}
	.movement-phase {
		font-weight: 700;
		text-transform: capitalize;
	}
	.movement-r {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
	}

	.mindscape-layout {
		display: flex;
		width: 100%;
		height: 100%;
		position: relative;
	}

	.mindscape-layout.resizing {
		user-select: none;
	}

	.nav-panel {
		flex-shrink: 0;
		height: 100%;
		overflow: hidden;
		border-right: 1px solid var(--color-border);
		background: var(--color-surface);
		z-index: 10;
		position: relative;
	}

	/* Hide nav-panel in territories view (full-width territory cards) */
	.nav-panel.hidden-panel {
		display: none;
	}

	/* Mobile: hide the left detail panel, show content full-width */
	@media (max-width: 767px) {
		.nav-panel {
			display: none;
		}
	}

	.view-panel {
		flex: 1;
		height: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 4px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		transition: background 0.15s;
		z-index: 20;
	}

	.resize-handle:hover,
	.resize-handle.active {
		background: var(--color-accent);
	}

	.loading-3d {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		flex: 1;
		min-height: 0;
		background: var(--color-bg);
	}

	.spinner {
		width: 32px;
		height: 32px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.view-toggle {
		display: flex;
		gap: 2px;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 2px;
		flex-shrink: 0;
	}
	.view-toggle button {
		padding: 6px 14px;
		border: none;
		background: transparent;
		color: var(--color-muted);
		font-size: 12px;
		font-weight: 500;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
	}
	.view-toggle button.active {
		background: var(--color-accent);
		color: var(--color-bg);
	}

	/* Welcome / empty mindscape */
	.welcome {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		height: 100%;
		overflow-y: auto;
		padding: 0;
	}
	.welcome-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: 0;
	}
	.welcome-inner {
		position: relative;
		z-index: 1;
		max-width: 560px;
		width: 100%;
		margin: 2rem 1.5rem;
		padding: 2.25rem 2rem 2rem;
		background: rgba(10, 10, 12, 0.72);
		backdrop-filter: blur(20px) saturate(140%);
		-webkit-backdrop-filter: blur(20px) saturate(140%);
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 16px;
	}
	:global([data-theme="light"]) .welcome-inner {
		background: rgba(250, 248, 245, 0.78);
	}
	.welcome-title {
		font-size: 1.35rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 0.6rem;
	}
	.welcome-subtitle {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.65;
		margin-bottom: 2rem;
	}
	.welcome-outcomes {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 2.25rem;
	}
	.outcome {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.85rem;
		border-radius: 8px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
	}
	.outcome-icon {
		font-size: 1rem;
		flex-shrink: 0;
		margin-top: 1px;
	}
	.outcome-label {
		display: block;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 2px;
	}
	.outcome-desc {
		display: block;
		font-size: 0.72rem;
		color: var(--color-text-tertiary);
		line-height: 1.55;
	}
	.welcome-modules {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: -0.5rem;
		margin-bottom: 1.75rem;
	}
	.module-pill {
		font-size: 0.65rem;
		font-weight: 500;
		padding: 0.25rem 0.65rem;
		border-radius: 100px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary);
		white-space: nowrap;
	}
	.welcome-start {
		margin-bottom: 2rem;
		text-align: left;
	}
	.start-heading {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 0.35rem;
	}
	.start-desc {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.55;
		margin-bottom: 1rem;
	}
	.welcome-footer {
		font-size: 0.68rem;
		color: var(--color-text-tertiary);
		line-height: 1.5;
		text-align: center;
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border);
	}
	.empty-state {
		color: var(--color-muted);
		font-size: 14px;
		text-align: center;
		padding: 48px 24px;
	}
	/* Breadcrumb */
	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 12px;
		font-size: 13px;
	}
	.breadcrumb-link {
		color: var(--color-accent);
		background: none;
		border: none;
		cursor: pointer;
		font-size: 13px;
		font-family: inherit;
		padding: 0;
	}
	.breadcrumb-link:hover {
		text-decoration: underline;
	}
	.breadcrumb-sep {
		color: var(--color-muted);
	}
	.breadcrumb-current {
		color: var(--color-text);
		font-weight: 600;
	}

	/* Realm cards */
	.realm-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 8px;
		margin-bottom: 16px;
	}
	.realm-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 16px;
		background: var(--color-surface);
		border: 1px solid transparent;
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}
	.realm-card:hover {
		border-color: var(--color-accent);
		transform: translateY(-1px);
		box-shadow: 0 0 20px rgba(229, 184, 76, 0.1), 0 4px 12px rgba(0, 0, 0, 0.3);
	}
	.realm-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 4px;
	}
	.realm-badges {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		flex-shrink: 0;
	}
	.realm-name {
		font-weight: 600;
		font-size: 15px;
		color: var(--color-text);
	}
	.realm-count {
		font-size: 11px;
		color: var(--color-muted);
		margin-bottom: 4px;
	}
	.realm-essence {
		font-size: 13px;
		color: var(--color-muted);
		line-height: 1.4;
		margin: 0 0 4px;
	}
	.realm-chapter {
		font-size: 12px;
		color: var(--color-accent-aurum);
		font-style: italic;
		line-height: 1.4;
		margin: 0 0 6px;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.realm-entities {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-bottom: 8px;
	}
	.fingerprint-bar {
		display: flex;
		gap: 16px;
		padding: 12px 16px;
		background: var(--color-surface);
		border-radius: 8px;
		margin-bottom: 16px;
	}
	.fp-score {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.fp-label {
		font-size: 11px;
		color: var(--color-text-tertiary);
		white-space: nowrap;
		width: 70px;
		flex-shrink: 0;
	}
	.fp-track {
		flex: 1;
		height: 4px;
		background: var(--color-elevated);
		border-radius: 2px;
		overflow: hidden;
		min-width: 40px;
	}
	.fp-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.4s ease-out;
	}
	.fp-value {
		font-size: 11px;
		font-family: var(--font-mono);
		font-weight: 600;
		width: 24px;
		text-align: right;
		flex-shrink: 0;
	}
	@media (max-width: 767px) {
		.fingerprint-bar {
			flex-direction: column;
			gap: 8px;
		}
	}
	.entity-pill-sm {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(91, 159, 232, 0.1);
		color: var(--color-accent);
		white-space: nowrap;
	}
	.realm-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.realm-msgs {
		font-size: 12px;
		color: var(--color-muted);
		font-family: var(--font-mono);
	}
	.realm-complexity {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
	}
	.cx-label {
		color: var(--color-text-tertiary);
	}
	.cx-value {
		color: #f472b6;
		font-family: var(--font-mono);
		font-weight: 500;
	}
	/* Exploration overview */
	.exploration-overview {
		padding: 14px 16px;
		background: var(--color-surface);
		border-radius: 8px;
		margin-bottom: 16px;
	}
	.explore-stats-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.explore-bar-section {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.explore-bar-track {
		flex: 1;
		height: 6px;
		background: var(--color-elevated);
		border-radius: 3px;
		overflow: hidden;
	}
	.explore-bar-fill {
		height: 100%;
		background: var(--color-accent-jade);
		border-radius: 3px;
		transition: width 0.6s ease-out;
	}
	.explore-pct {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-accent-jade);
		white-space: nowrap;
		min-width: 90px;
	}
	.explore-detail {
		font-size: 11px;
		color: var(--color-text-tertiary);
		margin-top: 6px;
	}
	.explore-hint {
		font-size: 12px;
		color: var(--color-text-secondary);
		margin-top: 8px;
		line-height: 1.4;
	}
	.explore-error {
		font-size: 12px;
		color: var(--color-accent-coral);
		margin-top: 4px;
	}
	.explore-button {
		padding: 6px 16px;
		border: 1px solid var(--color-accent-jade);
		color: var(--color-accent-jade);
		background: transparent;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.explore-button:hover:not(:disabled) {
		background: rgba(74, 222, 128, 0.1);
	}
	.explore-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.explore-live-status {
		margin-top: 4px;
	}
	.explore-live-count {
		font-size: 11px;
		color: var(--color-text-tertiary);
	}
	.explore-live-current {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-secondary);
		margin-top: 6px;
	}
	.explore-live-last {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-primary);
		margin-top: 4px;
	}
	.explore-controls {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-shrink: 0;
	}
	.explore-select {
		padding: 4px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-elevated);
		color: var(--color-text-primary);
		font-size: 12px;
		cursor: pointer;
	}
	/* Live exploration log */
	.explore-live {
		max-height: 300px;
		overflow-y: auto;
	}
	.explore-log {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
	}
	.log-item {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font-size: 12px;
		padding: 4px 0;
	}
	.log-icon {
		flex-shrink: 0;
		width: 16px;
		text-align: center;
	}
	.log-item.done .log-icon { color: var(--color-accent-jade); }
	.log-item.active .log-icon { color: var(--color-accent); }
	.log-item.skip .log-icon { color: var(--color-text-tertiary); }
	.log-item.error .log-icon { color: var(--color-accent-coral); }
	.log-icon.spin { animation: spin 1s linear infinite; }
	.log-text {
		color: var(--color-text-secondary);
		min-width: 0;
	}
	.log-item.done .log-text { color: var(--color-text-primary); }
	.log-content {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.log-insight {
		font-size: 10px;
		color: var(--color-text-tertiary);
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.log-entities {
		font-size: 10px;
		color: var(--color-text-tertiary);
		margin-left: auto;
		white-space: nowrap;
	}
	/* Session report */
	.explore-report-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.explore-dismiss {
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		font-size: 18px;
		cursor: pointer;
		padding: 4px;
		line-height: 1;
	}
	.explore-dismiss:hover { color: var(--color-text-primary); }
	.explore-report-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 8px;
		max-height: 350px;
		overflow-y: auto;
	}
	.explore-report-item {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}
	.explore-report-summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 10px;
		cursor: pointer;
		font-size: 12px;
		user-select: none;
	}
	.explore-report-summary:hover {
		background: var(--color-elevated);
	}
	.report-name {
		font-weight: 500;
		color: var(--color-text-primary);
	}
	.report-meta {
		font-size: 11px;
		color: var(--color-text-tertiary);
		white-space: nowrap;
		margin-left: 8px;
	}
	.explore-report-body {
		padding: 8px 10px;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg);
	}
	.report-notes {
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-bottom: 6px;
		white-space: pre-wrap;
	}
	.report-entities {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-bottom: 4px;
	}
	.report-patterns {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-bottom: 4px;
	}
	.pattern-pill {
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(167, 139, 250, 0.12);
		color: var(--color-accent-amethyst);
	}
	.report-time {
		font-size: 10px;
		color: var(--color-text-tertiary);
	}
	.territory-cx-track {
		width: 50px;
	}
	/* 3D map exploration overlay */
	.map-container {
		position: relative;
		width: 100%;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	/* Lens bar — compact floating chips top-right of 3D */
	.lens-bar {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 30;
		display: flex;
		gap: 6px;
		pointer-events: auto;
	}
	.lens-chip {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		border-radius: 20px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(20, 20, 23, 0.7);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		cursor: pointer;
		transition: all 0.2s;
		color: var(--color-text-secondary);
		font: inherit;
	}
	.lens-chip:hover {
		background: rgba(30, 30, 35, 0.85);
		border-color: rgba(255, 255, 255, 0.15);
	}
	.lens-chip.lens-active {
		border-color: rgba(74, 222, 128, 0.4);
	}
	:global([data-theme='light']) .lens-chip {
		background: rgba(255, 255, 255, 0.8);
		border-color: rgba(0, 0, 0, 0.08);
	}
	.lens-ring {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: block;
		position: relative;
	}
	.lens-ring::after {
		content: '';
		position: absolute;
		inset: 3px;
		border-radius: 50%;
		background: rgba(20, 20, 23, 0.9);
	}
	:global([data-theme='light']) .lens-ring::after {
		background: rgba(255, 255, 255, 0.95);
	}
	.lens-pct {
		font-size: 11px;
		font-weight: 600;
		font-family: var(--font-mono);
		color: var(--color-text-primary);
	}
	.lens-pulse {
		animation: lens-pulse-anim 2s ease-in-out infinite;
		color: var(--color-accent-jade);
	}
	@keyframes lens-pulse-anim {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
	/* Lens panel — expanded detail from chip */
	.lens-panel {
		position: absolute;
		top: 48px;
		right: 12px;
		z-index: 30;
		width: 300px;
		max-height: 60vh;
		overflow-y: auto;
		padding: 12px 14px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(20, 20, 23, 0.88);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		pointer-events: auto;
		animation: lens-in 0.15s ease-out;
	}
	:global([data-theme='light']) .lens-panel {
		background: rgba(255, 255, 255, 0.92);
		border-color: rgba(0, 0, 0, 0.1);
	}
	@keyframes lens-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.lens-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.lens-panel-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
	}
	.lens-panel-meta {
		font-size: 10px;
		color: var(--color-text-tertiary);
	}
	.lens-dismiss {
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		font-size: 16px;
		cursor: pointer;
		padding: 0 2px;
		line-height: 1;
	}
	.lens-dismiss:hover { color: var(--color-text-primary); }
	.lens-explore-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.lens-select {
		flex: 1;
		padding: 5px 8px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 11px;
		cursor: pointer;
	}
	.lens-explore-btn {
		padding: 5px 14px;
		border: none;
		border-radius: 6px;
		background: var(--color-accent-jade);
		color: var(--color-bg);
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.15s;
		white-space: nowrap;
	}
	.lens-explore-btn:hover:not(:disabled) { opacity: 0.85; }
	.lens-explore-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.lens-filters {
		display: flex;
		gap: 6px;
		margin-bottom: 8px;
	}
	.lens-input {
		flex: 1;
		padding: 5px 8px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 11px;
		font-family: var(--font-mono);
	}
	.lens-input::-webkit-calendar-picker-indicator {
		filter: invert(0.6);
	}

	@media (max-width: 767px) {
		.lens-bar {
			top: 8px;
			right: 8px;
		}
		.lens-panel {
			top: 44px;
			right: 8px;
			left: 8px;
			width: auto;
		}
	}
	.realm-explored {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
	}
	.explored-value {
		color: var(--color-accent-jade);
		font-family: var(--font-mono);
		font-weight: 500;
	}
	.cx-bar-track {
		width: 40px;
		height: 4px;
		background: var(--color-elevated);
		border-radius: 2px;
		overflow: hidden;
		display: inline-block;
		vertical-align: middle;
	}
	.realm-cx-track {
		width: 50px;
	}
	.cx-bar-fill {
		display: block;
		height: 100%;
		background: #f472b6;
		border-radius: 2px;
		transition: width 0.4s ease-out;
	}
	.cx-metric {
		align-items: center;
		gap: 4px !important;
	}

	/* Territories view */
	.territories-view {
		padding: 16px 24px 24px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		background: var(--color-bg);
	}
	.activation-summary {
		display: flex;
		gap: 16px;
		padding: 12px 16px;
		background: var(--color-surface);
		border-radius: 8px;
		margin-bottom: 16px;
		font-size: 13px;
	}
	.act-stat {
		color: var(--color-text);
		font-weight: 500;
	}
	.act-stat.silent {
		color: var(--color-warning, #f59e0b);
	}
	.act-stat.unclustered {
		color: var(--color-muted);
		font-style: italic;
	}
	.territory-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.territory-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 14px 16px;
		background: var(--color-surface);
		border: 1px solid transparent;
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}
	.territory-card:hover {
		border-color: var(--color-border);
		box-shadow: 0 0 16px rgba(229, 184, 76, 0.08), 0 2px 8px rgba(0, 0, 0, 0.2);
	}
	.territory-card.selected {
		border-color: var(--color-accent);
		box-shadow: 0 0 24px rgba(229, 184, 76, 0.15), 0 4px 12px rgba(0, 0, 0, 0.3);
	}
	.territory-card.active-today {
		border-left: 3px solid var(--color-accent);
		box-shadow: inset 2px 0 0 var(--color-accent), 0 0 12px rgba(229, 184, 76, 0.05);
	}
	.terr-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}
	.terr-name {
		font-weight: 600;
		font-size: 14px;
		color: var(--color-text);
	}
	.terr-badges {
		display: flex;
		gap: 4px;
	}
	.badge {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		border: 1px solid transparent;
	}
	.badge.surge {
		background: rgba(229, 184, 76, 0.2);
		color: var(--color-accent);
		border-color: rgba(229, 184, 76, 0.3);
		box-shadow: 0 0 8px rgba(229, 184, 76, 0.1);
	}
	.badge.quiet {
		background: rgba(245, 158, 11, 0.15);
		color: var(--color-warning, #f59e0b);
		border-color: rgba(245, 158, 11, 0.25);
	}
	.badge.active {
		background: rgba(16, 185, 129, 0.15);
		color: var(--color-success, #10b981);
		border-color: rgba(16, 185, 129, 0.25);
	}
	.badge.growing {
		background: rgba(59, 130, 246, 0.15);
		color: var(--color-info, #3b82f6);
		border-color: rgba(59, 130, 246, 0.25);
	}
	.badge.dormant {
		background: rgba(107, 107, 117, 0.15);
		color: var(--color-text-tertiary);
		border-color: rgba(107, 107, 117, 0.2);
	}
	.badge.archetype {
		background: rgba(167, 139, 250, 0.12);
		color: var(--color-accent-amethyst);
		border-color: rgba(167, 139, 250, 0.2);
		text-transform: none;
		font-weight: 500;
	}
	.badge.today-badge {
		background: rgba(74, 222, 128, 0.12);
		color: var(--color-accent-jade);
		border-color: rgba(74, 222, 128, 0.2);
	}
	.visibility-badge {
		cursor: pointer;
		font-size: 11px;
		padding: 1px 4px;
		background: transparent;
		border: 1px solid var(--color-border);
		opacity: 0.5;
		transition: opacity 0.15s;
	}
	.visibility-badge:hover { opacity: 1; }
	.visibility-badge.vis-public {
		border-color: rgba(74, 222, 128, 0.3);
		opacity: 0.8;
	}
	.visibility-badge.vis-friends {
		border-color: rgba(91, 159, 232, 0.3);
		opacity: 0.8;
	}
	.terr-essence {
		font-size: 13px;
		color: var(--color-muted);
		margin: 6px 0 0;
		line-height: 1.4;
	}
	.terr-entities {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 6px;
	}
	.terr-metrics {
		display: flex;
		gap: 14px;
		margin-top: 8px;
	}
	.metric {
		display: flex;
		gap: 4px;
		align-items: baseline;
		font-size: 12px;
	}
	.metric-label {
		color: var(--color-muted);
		font-size: 11px;
	}
	.metric-value {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-weight: 500;
	}
	.metric.today .metric-value {
		color: var(--color-accent);
	}
	.terr-detail {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--color-border);
	}
	.detail-section {
		margin-bottom: 10px;
	}
	.detail-section h4 {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 4px;
	}
	.detail-section p {
		font-size: 13px;
		color: var(--color-text);
		line-height: 1.5;
	}
	.detail-section ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.detail-section li {
		font-size: 13px;
		color: var(--color-text);
		padding: 2px 0;
	}
	.detail-section li::before {
		content: '- ';
		color: var(--color-muted);
	}
	.chronicle-text {
		white-space: pre-wrap;
		line-height: 1.5;
	}
	.explored-note {
		font-size: 12px;
		color: var(--color-muted);
		border-top: 1px solid rgba(255,255,255,0.05);
		padding-top: 8px;
		margin-top: 4px;
	}
	.detail-timeline {
		padding: 4px 0;
	}
	.entity-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.entity-pill {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 4px;
		background: var(--color-accent);
		background: rgba(91, 159, 232, 0.12);
		color: var(--color-accent);
		white-space: nowrap;
	}
	.connected-regions {
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}
	.cross-refs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.cross-ref-pill {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 4px;
		background: rgba(229, 184, 76, 0.12);
		color: var(--color-accent-aurum);
		white-space: nowrap;
	}

	/* Generation + enrichment progress */
	.gen-progress {
		max-width: 400px;
		margin: 0 auto;
	}
	.gen-heading {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text);
		margin-bottom: 8px;
	}
	.gen-stage {
		font-size: 13px;
		color: var(--color-text-secondary);
		margin-bottom: 12px;
	}
	.gen-bar {
		height: 6px;
		background: var(--color-surface);
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 8px;
	}
	.gen-fill {
		height: 100%;
		background: linear-gradient(90deg, #E5B84C, #D4A23C);
		border-radius: 3px;
		transition: width 0.5s ease;
	}
	.gen-dots {
		display: flex;
		justify-content: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.gen-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-border);
		transition: all 0.3s;
	}
	.gen-dot.done {
		background: #E5B84C;
	}
	.gen-dot.active {
		background: #E5B84C;
		box-shadow: 0 0 8px rgba(229, 184, 76, 0.5);
	}
	.gen-hint {
		font-size: 12px;
		color: var(--color-text-tertiary);
		margin-top: 8px;
	}
	.gen-button {
		display: inline-block;
		margin-top: 16px;
		padding: 10px 28px;
		background: linear-gradient(135deg, #E5B84C, #D4A23C);
		color: #0A0A0C;
		border: none;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}
	.gen-button:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 0 20px rgba(229, 184, 76, 0.3);
	}
	.gen-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.gen-error {
		color: var(--color-error, #ef4444);
		font-size: 13px;
		margin-top: 8px;
	}
</style>
