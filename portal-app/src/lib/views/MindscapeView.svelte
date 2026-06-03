<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { mindscapeState, timelineHealth } from '$lib/stores/mindscape';
	import MindscapeDetail from '$lib/components/mindscape/MindscapeDetail.svelte';
	import PulsesLens from '$lib/components/mindscape/PulsesLens.svelte';
	import { api, apiGet } from '$lib/api';
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
			territoriesLoaded = false; // allow the reload below to fetch the freshly-generated territories
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

	// `active` = is this the visible workspace tab (keep-alive). Threaded to the
	// 3D component so a backgrounded Mindscape pauses its render loop.
	let { active = true } = $props();

	// Lazy load 3D component (THREE.js is heavy)
	let Mindscape3D: any = $state(null);


	// Demo mindscape canvas for welcome screen
	let demoCanvas = $state<HTMLCanvasElement | undefined>();
	let demoCleanup: (() => void) | null = null;

	// Initialize demo 3D mindscape when canvas is available
	$effect(() => {
		if (!browser || !demoCanvas) return;
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

		// Lazy load 3D component (now safe under Tauri too — the window is opaque, #52).
		if (!Mindscape3D) {
			import('$lib/components/mindscape/Mindscape3D.svelte').then((module) => {
				Mindscape3D = module.default;
			});
		}

		// Load mindscape data (3D nodes) + the territory/realm data the 3D map's
		// realm-filter dropdown + lens panels read. (The old 2D-view effect used to
		// trigger loadTerritories; with 3D-only we call it directly on mount.)
		mindscapeState.load();
		loadTerritories();

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

	// Territory + realm data. `realms` powers the 3D map's exploration realm-filter;
	// the rest feed the generate/explore lifecycle below.
	let territories: any[] = $state([]);
	let realms: any[] = $state([]);
	let activations: any = $state(null);
	let territoriesLoading = $state(false);
	// Guard for loadTerritories. MUST be a boolean flag, NOT `territories.length`:
	// loadTerritories reassigns `territories = []` (a NEW ref) when a vault has 0
	// territories — guarding on territories.length would re-trigger any reader effect
	// → reload → reassign → INFINITE LOOP. A flag stays stable.
	let territoriesLoaded = $state(false);

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
		if (territoriesLoaded) return; // flag-guarded — see territoriesLoaded decl (NOT territories.length)
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
		territoriesLoaded = true; // mark loaded EVEN IF empty, so an empty result can't re-trigger the load effect
	}


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
			<Mindscape3D {active} />
		{:else}
			<div style="width:100%;height:100%;background:#0A0A0C"></div>
		{/if}
	</div>
{:else}
<div class="mindscape-layout" class:resizing={isResizing} bind:this={containerRef}>
	<!-- Navigation + detail panel (always visible) -->
	<aside class="nav-panel" style="width: {panelWidth}px;">
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
		</div>

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
						<Mindscape3D {active} />
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
							<p class="welcome-subtitle">Map your thinking in 3D.</p>
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
							<p class="welcome-subtitle">Bring your conversations to life as a living 3D map of your thinking.</p>

							<!-- Getting started — the import / connect path -->
							<div class="welcome-start">
								<ConnectionsChecklist showTitle={false} compact={true} />
							</div>
						{/if}
					</div>
				</div>
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
	}/* Hide nav-panel in territories view (full-width territory cards) *//* Mobile: hide the left detail panel, show content full-width */
	@media (max-width: 767px) {
		.nav-panel {
			display: none;
		}}

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
	}/* Welcome / empty mindscape */
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
	.welcome-start {
		margin-bottom: 2rem;
		text-align: left;
	}/* Breadcrumb *//* Realm cards *//* Exploration overview *//* Live exploration log */
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
	}/* Session report *//* 3D map exploration overlay */
	.map-container {
		position: relative;
		width: 100%;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}/* Lens bar — compact floating chips top-right of 3D */
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
	}/* Lens panel — expanded detail from chip */
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
		}}/* Territories view *//* Generation + enrichment progress */
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
