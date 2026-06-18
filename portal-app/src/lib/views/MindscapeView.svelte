<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { mindscapeState } from '$lib/stores/mindscape';
	import MindscapeDetail from '$lib/components/mindscape/MindscapeDetail.svelte';
	import NarrateControl from '$lib/components/mindscape/NarrateControl.svelte';
	import MeasureControl from '$lib/components/mindscape/MeasureControl.svelte';
	import MindscapeBackground from '$lib/components/mindscape/MindscapeBackground.svelte';
	import MindscapeInvite from '$lib/components/mindscape/MindscapeInvite.svelte';
	import { api, apiGet } from '$lib/api';
	import { generate, start as startGen, resume as resumeGen, reset as resetGen, cancel as cancelGen, fmtSeconds } from '$lib/generate';
	import { get } from 'svelte/store';
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

	// Auto-generate: the moment there's imported data and nothing is running, kick
	// the run automatically — start() self-drives embed-wait → cluster → done, so
	// the user never has to click "Generate". Guarded to fire once; an error leaves
	// phase !== 'idle' so it won't loop (the error state offers a manual retry).
	let autoGenTried = $state(false);
	$effect(() => {
		if (hasImportedData && $generate.phase === 'idle' && !autoGenTried) {
			autoGenTried = true;
			startGen();
		}
	});

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

		// Check generation + enrichment state
		checkGenerationState().then(() => {
			if (enrichment && enrichment.pending > 0 && get(generate).phase !== 'running') pollEnrichment();
		});

		// Resume an in-flight generate job from before a page refresh.
		resumeGen();

		// Poll for data imported AFTER mount. The tabbed workspace keeps this view
		// alive, so the one-shot onMount check missed conversations imported on the
		// Import screen — the page kept showing "Welcome" until a manual reload. Poll
		// until data is detected (then the "Generate" CTA renders on its own).
		let dataPoll: ReturnType<typeof setInterval> | null = null;
		if (!hasImportedData) {
			dataPoll = setInterval(() => {
				if (hasImportedData) { if (dataPoll) { clearInterval(dataPoll); dataPoll = null; } return; }
				if (get(generate).phase === 'running') return; // generate progress drives its own UI
				checkGenerationState();
			}, 5000);
		}
		// Re-check on refocus: catches returning to the app/tab immediately, and
		// refreshes territories so background-narrated chronicles appear.
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			checkGenerationState();
			if (territoriesLoaded) { territoriesLoaded = false; loadTerritories(); }
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			if (dataPoll) clearInterval(dataPoll);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

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
	let containerRef = $state<HTMLElement>();

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
	<!-- Pipeline/inference progress now lives ONLY in the global header activity
	     indicator (top-right) — a single source of truth. The old canvas chip was a
	     duplicate of that feed (generate surfaces via the `mycelium_generate` job row). -->

	<!-- Navigation + detail panel — only once there's a mindscape to navigate.
	     On an empty vault it would be a blank rail, so we hide it entirely. -->
	{#if msState.points && msState.points.length > 0}
	<aside class="nav-panel" style="width: {panelWidth}px;">
		<MindscapeDetail />
		<MeasureControl />
		<NarrateControl />
		<!-- Resize handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-handle"
			class:active={isResizing}
			onmousedown={startResize}
		></div>
	</aside>
	{/if}

	<!-- Main content area -->
	<main class="view-panel">

			{#if msState.loading}
				<div class="loading-3d">
					<div class="spinner"></div>
				</div>
			{:else if msState.points && msState.points.length > 0}
				{#if Mindscape3D}
			<div class="map-container">
						<Mindscape3D {active} />
					</div>
				{:else}
					<div class="loading-3d">
						<div class="spinner"></div>
					</div>
				{/if}
			{:else}
				<!-- Welcome: empty mindscape onboarding -->
				<div class="welcome">
					<!-- The living 3D mindscape (Goethe model) breathing behind the glass -->
					<MindscapeBackground />

					<!-- The invitation persists through embedding/mapping so Connect-AI &
					     the other steps stay reachable while the pipeline runs in the
					     background. Generation auto-starts (the auto-gen effect above). -->
					<div class="welcome-inner">
						<MindscapeInvite displayName={$auth.user?.displayName ?? null} onImported={checkGenerationState} />
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
	.welcome-inner {
		position: relative;
		z-index: 1;
		max-width: 560px;
		width: 100%;
		margin: 2rem 1.5rem;
		padding: 2.25rem 2rem 2rem;
		/* Frosted glass — theme-aware token so light mode is a light frosted panel,
		   the living map drifting through the blur in both modes. */
		background: var(--glass-panel-bg);
		backdrop-filter: blur(22px) saturate(150%);
		-webkit-backdrop-filter: blur(22px) saturate(150%);
		border: 1px solid var(--glass-border);
		border-radius: 16px;
		box-shadow: var(--shadow-lg);
	}
	/* Breadcrumb *//* Realm cards *//* Exploration overview *//* Live exploration log */
	.map-container {
		position: relative;
		width: 100%;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
</style>
