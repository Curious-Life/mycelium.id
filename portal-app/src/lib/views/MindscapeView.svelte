<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount, untrack } from 'svelte';
	import { mindscapeState } from '$lib/stores/mindscape';
	import { navigationState } from '$lib/stores/navigation';
	import MindscapeDetail from '$lib/components/mindscape/MindscapeDetail.svelte';
	import NarrateControl from '$lib/components/mindscape/NarrateControl.svelte';
	import MeasureControl from '$lib/components/mindscape/MeasureControl.svelte';
	import MeasurementHealthSection from '$lib/components/mindscape/MeasurementHealthSection.svelte';
	import MindscapeBackground from '$lib/components/mindscape/MindscapeBackground.svelte';
	import MindscapeInvite from '$lib/components/mindscape/MindscapeInvite.svelte';
	import PipelineStatus from '$lib/components/mindscape/PipelineStatus.svelte';
	import { ingest as ingestPipeline } from '$lib/pipeline';
	import { pollAction, timerArmed } from '$lib/pipeline-poll';
	import { probeExhausted } from '$lib/mind-probe-cap';

	// ── §3.7a — the invite's half of the ONE fact ────────────────────────────────
	// The invite hid on `points.length === 0` (the client STORE) while the rail hid on
	// `!generated` (/portal/mindscape's NODES). Two measurements of one idea, both true through
	// the middle of onboarding ⇒ BOTH ON SCREEN AT ONCE — map §5.1, and the whole reason §3.7a
	// exists. Now both read readiness.mindscape.generated, opposite polarity ⇒ they cannot
	// coexist. ⚠️ This ONLY holds with E2's rail flip: gating the invite alone would make the
	// rail a strict SUBSET and the overlap DETERMINISTIC. They ship together or not at all.
	// ⚠️ `null` MUST NOT MEAN `false`. My first version said "null = claim NOTHING" in this very
	// comment while the markup below did `{:else if mindGenerated === true}` — so null fell
	// through to the INVITE, i.e. it claimed not-generated. The comment stated the principle and
	// the code four lines down broke it (independent review HIGH-2, 2026-07-16).
	//
	// It is not cosmetic. `loadGenerated` only assigned on `r.ok`, and the $effect re-runs only
	// when `mindGenerated` CHANGES — so one failed read left it null FOREVER, with no retry. The
	// invite would then render permanently on a generated vault while the rail's 4s poll recovers
	// `generated=true` on its first good read ⇒ BOTH SURFACES, permanently. That is map §5.1
	// again, and it is exactly the overlap this increment claims to make unrepresentable.
	// Worse, the failures are CORRELATED: the points fetch that leaves `points` empty is the same
	// outage class — so the branch below written for "the map exists but didn't load" is disabled
	// precisely when it is needed.
	// ⇒ null renders its own honest state, and it RETRIES.
	let mindGenerated = $state<boolean | null>(null);
	let genProbeFailed = $state(false);
	// ⚠️ THE PROBE MUST NOT SPIN FOREVER. loadGenerated() re-probes every GEN_POLL_MS while the
	// answer isn't known-true; on a machine whose /readiness KEEPS failing that was an UNBOUNDED
	// "Checking your mind…" spinner — the exact hang generate.ts's `unknown` cap (#232) fixed one
	// surface over. genProbeFailCount counts CONSECUTIVE failures (a success resets it to 0);
	// past PROBE_MAX_FAILS the view stops retrying and renders a RETRYABLE "couldn't read your map"
	// state instead (see the markup). A failed read claims NOTHING — §3.2a — so the capped state is
	// never "empty/Grow your mycelium", only "couldn't read — Retry".
	let genProbeFailCount = $state(0);
	const genProbeExhausted = $derived(probeExhausted(genProbeFailCount));
	async function loadGenerated() {
		try {
			// ⚠️ RIDE THIS EXISTING POLL for the canonical `pipeline` slice too — ONE fetch, both
			// slices, NO new interval/voice (PIPELINE-TRANSPARENCY-DESIGN §"no new poll"). pipeline()
			// shares mindscape's memoized clustering_points COUNT (Unit 2's PS-COST latch), so adding
			// it costs zero extra server scans. Both PipelineStatus mounts (the invite + the built map)
			// render from the store this feeds.
			const r = await api('/portal/readiness?slices=mindscape,pipeline');
			if (!r.ok) throw new Error(`readiness ${r.status}`);
			const body = await r.json();
			const m = body?.mindscape;
			// A failed read never reaches here (we threw above), so the store's own hold-last-good
			// covers the outage (§3.2a) — we only ingest on a good read.
			ingestPipeline(body?.pipeline);
			// ⚠️ A 200 can still mean "I don't know": the slice fails soft with `unknown` rather
			// than throwing, so `r.ok` alone is not knowledge. Without this the retry apparatus
			// below never engages on the LIKELY failure — only on a whole-route 500 — and the
			// invite renders permanently over a built vault (review HIGH-4).
			if (m?.unknown === true) throw new Error('mindscape slice unknown');
			mindGenerated = m?.generated === true;
			// ── P1-A recovery + MI-1 live geometry ──────────────────────────────────────────────
			// `pointCount` is the cheap COUNT the mindscape slice already computed (shared memo — the
			// pipeline slice buys it too, so this is ZERO extra scan). Reconcile the client geometry
			// against it: pull points when the server has a map we don't (the "map built but didn't
			// load" race), or when the count changed on an already-rendered map (new points landed).
			if (mindGenerated) reconcileGeometry(Number(m?.pointCount || 0));
			genProbeFailed = false;
			genProbeFailCount = 0; // a successful read clears the failure clock (mirrors unknownSince)
		} catch {
			// Say we don't know — silence here IS the invite (see above). The RETRY is the poll
			// below: MED-9's genPollTimer already re-calls loadGenerated() every 4s until the
			// answer is known-true, which is exactly what a failed probe needs.
			// ⚠️ I kept a separate genRetryTimer alongside it, so a failing probe fired TWO requests
			// per tick — the MED-7 retry machinery was subsumed by MED-9's interval the moment I
			// added it, and I did not notice because both were "correct" in isolation (review, LOW,
			// 2026-07-16). One cadence, one timer.
			genProbeFailed = true;
			genProbeFailCount += 1; // count consecutive failures toward the cap (PROBE_MAX_FAILS)
		}
	}
	// Re-arm the probe after the cap: a manual Retry from the "couldn't read your map" state. Clears
	// the failure count so genProbeExhausted flips false and the $effect re-arms the poll below.
	function retryProbe() {
		genProbeFailCount = 0;
		genProbeFailed = false;
		void loadGenerated();
	}
	// ── Geometry reconciliation (P1-A first-load reliability + MI-1 continuous auto-update) ─────
	// The readiness poll refreshes the "generated" flag and the pipeline overview, but it does NOT
	// re-fetch the 3D point geometry — so historically a map that got built after the initial load
	// (generated via the poll, an MCP tool, a wake cycle, or an agent) rendered "map built but
	// didn't load" until a manual Retry, and new points never repainted live. This closes both:
	// on each good read we compare the server's authoritative point count to the client's.
	//   • server has points, client has none → the P1-A race. Force a FRESH (cache-busting) pull
	//     so a stale-empty durable points cache can't defeat it; the 4s poll keeps retrying until
	//     geometry arrives, so the first load succeeds on its own with no click.
	//   • the count CHANGED on an already-rendered map → MI-1 new geometry. A plain refresh suffices
	//     (the point mutation already busted the server cache). This is the ONLY thing that triggers
	//     a geometry fetch — never a fixed cadence — so it adds zero decrypt scans per hour.
	let lastPointCount = $state<number | null>(null);
	// ⚠️ CAP the recovery pull. `refreshPoints` never flips `loading`, so `st.loading` can't gate
	// the have===0 branch — and getPoints/getNoiseStats are SEPARATE queries under Promise.allSettled
	// server-side, so getPoints can persistently fail (→ []) while the COUNT succeeds (pointCount>0).
	// That would fire a cache-busting FULL-SCAN every 4s forever. Bound it exactly like the readiness
	// probe (PROBE_MAX_FAILS): after that many attempts we stop auto-pulling; the manual "Try again"
	// (load({fresh})) still works. A count CHANGE (new geometry) or geometry actually arriving
	// (have>0) resets the counter, so only a persistent getPoints outage ever reaches the cap.
	let geometryRecoveryAttempts = $state(0);
	function reconcileGeometry(pointCount: number) {
		const st = get(mindscapeState);
		const have = st.points?.length ?? 0;
		const prev = lastPointCount;
		lastPointCount = pointCount;
		if (have > 0) geometryRecoveryAttempts = 0;   // geometry present — clear the recovery clock
		if (st.loading) return; // a full load() is already in flight — let it settle
		if (pointCount > 0 && have === 0) {
			if (probeExhausted(geometryRecoveryAttempts)) return;   // capped — stop the 4s full-scans
			geometryRecoveryAttempts += 1;
			void mindscapeState.refreshPoints({ fresh: true });
		} else if (prev !== null && pointCount !== prev && have > 0) {
			void mindscapeState.refreshPoints();   // MI-1: new geometry on a rendered map (uncapped, cheap)
		}
	}
	// ⚠️ THE VIEW MUST POLL, BECAUSE THE RAIL DOES. `mindGenerated` froze after its first
	// successful read — the $effect re-ran only while null — so a `false` was NEVER re-probed,
	// while the rail re-reads the same fact every 4s. One fact, TWO CLIENTS, DIFFERENT REFRESH
	// SEMANTICS ⇒ "cannot render together by construction" was OVERSTATED. Deterministic repro,
	// no timing luck: two windows (Tauri + a browser on :8787). Generate in A. In B the view is
	// frozen `false` ⇒ INVITE, and B's rail polls ⇒ `true` ⇒ RAIL. Both, same viewport, both
	// titled "Grow your mycelium" — map §5.1 exactly. Same for a generate from ANY path this
	// view's store cannot see: the MCP tool surface, a wake cycle, an agent
	// (independent review MED-9, 2026-07-16).
	// ⇒ Poll on the SAME cadence until the answer is known-true. `slices=mindscape` is a cheap
	// COUNT (§3.2b), and once generated it never goes back, so the poll stops on its own.
	// ⚠️ RESIDUAL, stated not hidden: convergence is ONE POLL PERIOD PLUS A ROUND-TRIP (~4s + RTT),
	// not "≤4s" — the tick ISSUES the request at +4s; the invite clears when it RETURNS. I wrote
	// "≤4s" first, which is the same shape of overclaim I was asked to watch for.
	// Two things make it better than the bound suggests: a FAILED view probe holds `null` ⇒ the
	// "Checking…" branch, NOT the invite, so an outage produces no overlap at all; and the generate
	// store's 1500ms poll normally beats the rail's 4000ms, so the happy path never overlaps.
	// Killing the window entirely needs ONE shared store — a bigger unit than E2.
	const GEN_POLL_MS = 4000;
	let genPollTimer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (mindGenerated === null && !genProbeFailed && !genProbeExhausted) void loadGenerated();
		// ⚠️ ONE timer, and it now OUTLIVES mindGenerated===true — the Unit-5 built-map live-feed fix
		// (PIPELINE-TRANSPARENCY-DESIGN, the Unit-3 deferred MED). This timer is the SOLE feeder of the
		// `pipeline` store; the old code cleared it the instant the map existed, so a re-import or a
		// model-approval that re-opened embed/categorize left the built-map overview FROZEN (held, never
		// blank — §3.2a — but stale). Now the SAME timer keeps ticking and pollAction() picks what each
		// tick fetches: the full mindscape,pipeline convergence poll while the map's existence is still
		// unknown, then ONLY the cheap pipeline slice once it is built — no new interval, no new scan
		// (the pipeline slice reuses the SWR-cached counts, Unit 2's PS-COST). It stops ONLY when the
		// probe cap trips (timerArmed=false): the "couldn't read your map" state owns retry from there.
		if (timerArmed(genProbeExhausted) && !genPollTimer) {
			genPollTimer = setInterval(() => {
				genProbeFailed = false;   // the poll IS the retry — let a failed probe try again
				const act = pollAction(mindGenerated, genProbeExhausted);
				// Both actions now call loadGenerated(): it fetches slices=mindscape,pipeline in ONE
				// request (the pipeline slice already computes the mindscape count via the shared
				// memo, so 'pipeline' costs the same as before) and ingests the pipeline overview to
				// keep it LIVE — while also reading pointCount to reconcile geometry (MI-1 + P1-A).
				// The 'converge' vs 'pipeline' split is preserved for the probe-cap contract
				// (pipeline-poll.ts); the built-map tick no longer needs the pipeline-only refresh.
				if (act === 'converge' || act === 'pipeline') void loadGenerated();
			}, GEN_POLL_MS);
		}
		if (!timerArmed(genProbeExhausted) && genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
	});
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

	// Auto-generate: the moment there's imported data and nothing is running, kick the run
	// automatically — start() self-drives embed-wait → cluster → done, so the user never has
	// to click "Generate".
	//
	// ⚠️ THE GUARD IS `autoGenTried`, AND IT ALWAYS WAS. The old comment claimed the no-loop
	// property came from the phase — "an error leaves phase !== 'idle' so it won't loop" —
	// which made a FALSE ERROR load-bearing: on a populated vault this POST always returns
	// 200 {jobId:null,status:'skipped'} (the route's own debounce exists because THIS effect
	// re-POSTs on every load), the client called that success an error, and the comment then
	// cited the error as the safety mechanism. Now that `skipped` maps to 'up-to-date', the
	// phase is non-idle either way — but the latch is what actually holds, and it holds for
	// both. Documented rather than assumed: X1 drives this effect twice and asserts ONE POST.
	// @see the distillation-surface design §2b.
	let autoGenTried = $state(false);
	$effect(() => {
		if (hasImportedData && $generate.phase === 'idle' && !autoGenTried) {
			autoGenTried = true;
			startGen();
		}
	});

	// React to the shared store reporting completion: reload the map, then clear.
	//
	// ⚠️ THIS EFFECT RE-ENTERED ITSELF ~18,000 TIMES A SECOND, AND THAT IS D-028's SECOND HALF —
	// the operator's "it laggs and restarts reload multiple times… the jittery restarting loading
	// icon looks very broken", reported THREE TIMES. Measured, not reasoned:
	// `portal-app/test/mount-mindscape-loading.mjs` drives the real post-generate sequence and
	// counted 20,001 mindscapeState.load() calls in 1,106 ms, creating and destroying 19,999
	// separate `.loading-3d` elements. Every one of those is a spinner torn down and rebuilt —
	// a CSS animation restarting from t=0 — while the main thread and the network are pinned.
	//
	// THE MECHANISM. A Svelte 5 `$effect` tracks every reactive read that happens during its
	// synchronous run — INCLUDING reads inside the functions it calls. `loadTerritories()` opens
	// with `if (territoriesLoaded) return;`, so this effect silently took a dependency on
	// `territoriesLoaded` — which the effect itself writes (`= false`) and which loadTerritories
	// writes again (`= true`). Writing a signal the effect depends on re-invalidates the effect ⇒
	// re-run ⇒ `mindscapeState.load()` ⇒ `loading` true→false ⇒ the loading node is destroyed and
	// rebuilt ⇒ round and round. Bounded ONLY by resetGen()'s 4s timer, which the loop itself
	// starves. Proven by experiment: deleting the `loadTerritories()` call took the count from
	// 20,001 to 3.
	//
	// TWO INDEPENDENT DEFENCES, because one of them is a rule about a framework's tracking
	// behaviour and rules like that get re-broken by the next edit (CLAUDE.md §2):
	//   1. `doneHandled` — a PLAIN `let`, deliberately NOT `$state` (a reactive latch would itself
	//      be a dependency). The body runs once per false→true edge of `phase === 'done'` no matter
	//      what anything reads. Re-armed when the phase leaves 'done', so a SECOND generate run
	//      still gets its reload — the latch bounds re-entry, it does not consume the event.
	//   2. `untrack()` — the body's reads (and its callees') no longer become dependencies, so the
	//      effect depends on exactly one thing: the generate phase. That is what it always meant.
	let doneHandled = false;
	$effect(() => {
		const isDone = $generate.phase === 'done';
		if (!isDone) { doneHandled = false; return; }   // re-arm for the NEXT completed run
		if (doneHandled) return;
		doneHandled = true;
		untrack(() => {
			territories = []; realms = [];
			territoriesLoaded = false; // allow the reload below to fetch the freshly-generated territories
			mindscapeState.load();
			loadTerritories();
			mindGenerated = true;   // we just watched it happen — no need to re-probe
			setTimeout(() => resetGen(), 4000);
		});
	});

	// The "Your mycelium is ready — explore your mind" reveal popup was REMOVED (D-033):
	// clicking it did nothing observable. Its only body (`goto('/mindscape')`) was already
	// dropped when it moved here — the user is already on /mindscape — leaving a button that
	// merely dismissed itself, identical to its own × control (review MED-6). Operator's call
	// was to remove the popup rather than wire it up. Nothing depended on the `justGenerated`
	// state or the `exploreMind` handler; both are gone with the markup below.

	// Cleanup timers on unmount
	$effect(() => {
		return () => {
			if (enrichPollTimer) clearTimeout(enrichPollTimer);
			if (genPollTimer) clearInterval(genPollTimer);     // the convergence poll (MED-9)
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

	// ── The ONE waiting state (D-028 part 2) ────────────────────────────────────────────────
	// Which "we are not showing you a map yet" state are we in, if any? This is a TRANSCRIPTION
	// of the {#if}/{:else if} chain that used to live in the markup — same predicates, same
	// order, same precedence — lifted out so the template can render ONE stable `.loading-3d`
	// element whose COPY varies, instead of five separate elements that destroy and recreate the
	// spinner (and restart its CSS animation) on every transition. See the markup comment.
	//   null ⇒ not waiting: either the map renders (points + the 3D module) or the welcome invite.
	// ⚠️ ORDER IS LOAD-BEARING and matches the old chain exactly:
	//   1. the store is loading                       → bare spinner
	//   2. points exist but the 3D module has not     → bare spinner ('module')
	//   3. existence UNKNOWN and the probe capped     → 'capped'  (no spinner, Retry)
	//   4. existence UNKNOWN, still probing           → 'checking'
	//   5. map exists, this client has no geometry    → 'built-not-loaded'
	//   6. otherwise                                  → null (map, or the welcome invite)
	// `mindGenerated === false` MUST fall through to null so the welcome invite still renders on a
	// genuinely empty vault — null here never means "empty", it means "this element is not the
	// thing on screen".
	type LoadArm = 'store' | 'module' | 'capped' | 'checking' | 'built-not-loaded';
	const loadArm = $derived<LoadArm | null>(
		msState.loading ? 'store'
		: (msState.points && msState.points.length > 0) ? (Mindscape3D ? null : 'module')
		: (mindGenerated === null && genProbeExhausted) ? 'capped'
		: mindGenerated === null ? 'checking'
		: mindGenerated === true ? 'built-not-loaded'
		: null
	);

	// Deep-link from Curious Life → a specific territory. CuriousLifeView stashes
	// the territory id in navigation state and routes here; once the 3D map's
	// points are actually loaded we apply the selection (the map's own effect then
	// filters + flies the camera to it) and clear the pending id so it fires once.
	// The id space matches: vitality territory_id === mindscape cluster3d/territory id.
	let deepLinkApplied = $state(false);
	$effect(() => {
		const pending = $navigationState.selectedTerritoryId;
		const ready = (msState.points?.length ?? 0) > 0;
		if (pending == null || !ready || deepLinkApplied) return;
		deepLinkApplied = true;
		mindscapeState.selectTerritory(pending);
		// Clear so a later manual deselect (or revisit) isn't overridden, and a
		// fresh visit without a deep-link starts clean.
		navigationState.setSelectedTerritory(null);
	});

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
		<!-- ⚠️ D-034 ↻1 — THE ONE SCROLL PORT FOR THE WHOLE RAIL.
		     The rail is FIVE stacked sections, and until now `.nav-panel` was a plain block with
		     `overflow: hidden`: the sections simply ran off the bottom and were clipped. #350 fixed
		     the trap one level too deep (`.nav-content` INSIDE MindscapeDetail), which is why the
		     operator still saw "only partially scrollable" — the inner box scrolled, but the inner
		     box's own bottom edge was already below the clip line, and the three sections BELOW
		     MindscapeDetail were unreachable at any scroll position.
		     Measured in a real browser before the fix (portal-app/test/browser-mindscape-rail.mjs):
		     `.nav-panel` clientHeight 860 / scrollHeight 1830 with `overflow-y: hidden` ⇒ 970px
		     permanently unreachable.
		     Now there is exactly ONE scroller for the rail, at the level that governs every
		     section and every drill level, and it carries the bottom padding so the last line of
		     the last section can be scrolled clear of the edge. Do NOT re-introduce a nested
		     `overflow-y: auto` on a section root — verify:mindscape-rail S4 fails the build if you do. -->
		<div class="nav-rail" data-testid="nav-rail">
			<!-- The canonical pipeline overview on the BUILT map — the same `pipeline` store the fresh-vault
			     invite reads, so the two surfaces are one voice. ⚠️ NOW LIVE (Unit 5): the genPollTimer
			     OUTLIVES mindGenerated===true and refreshes the cheap pipeline slice each tick (pollAction →
			     'pipeline'; see the $effect at ~:110), so a re-import or a model-approval that re-opens
			     embed/categorize updates this panel WITHOUT a second poll or a new interval — one timer, one
			     voice. A failed refresh holds the last good stages (§3.2a). The detailed
			     MeasureControl/NarrateControl views below stay; this is the at-a-glance overview
			     (PIPELINE-TRANSPARENCY-DESIGN §"Risks": overview, not a replacement of detail). -->
			<PipelineStatus />
			<MindscapeDetail />
			<MeasureControl />
			<MeasurementHealthSection />
			<NarrateControl />
		</div>
		<!-- Resize handle — a direct child of the panel, NOT of the scroller: it is the panel's
		     full-height edge affordance and must not scroll away with the content. -->
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

			<!-- ⚠️ ONE loading element, not five — D-028's other half.
			     This chain USED to spell each waiting state as its own `<div class="loading-3d">`
			     inside a separate `{:else if}` arm. Semantically fine; visually broken. Each arm is
			     a DIFFERENT DOM node, so every transition between them DESTROYED one element and
			     CREATED another, and a CSS keyframe animation on a brand-new element starts at
			     t=0 — the spinner visibly snapped back to its start angle on each hop. Measured on
			     the real post-generate sequence (`portal-app/test/mount-mindscape-loading.mjs`):
			     THREE distinct `.loading-3d` nodes created and destroyed for ONE map landing, with
			     no reload of any kind involved. That is the "restarting loading icon" the operator
			     described, and it is invisible to any assertion that only reads text.
			     ⇒ The ARM is now a value (`loadArm`), and the element is a constant. Svelte keeps
			     the same `.loading-3d` node while `loadArm` stays truthy, so the spinner animates
			     CONTINUOUSLY across store-loading → checking → built-not-loaded → module-loading.
			     Only the COPY changes — which is the honest thing to change, because only the copy
			     ever differed. Every arm's meaning is preserved verbatim below; nothing was merged
			     away. NOT a slower animation, NOT a delay, NOT a fade: the same states, one node. -->
			{#if loadArm}
				<div class="loading-3d">
					<!-- The cap is the one waiting state that is NOT waiting: the probe has given up
					     and retry is the user's move, so a spinner there would be a lie. -->
					{#if loadArm !== 'capped'}<div class="spinner"></div>{/if}

					{#if loadArm === 'capped'}
						<!-- ⚠️ THE CAP. The readiness probe has failed PROBE_MAX_FAILS times (~20s): stop the
						     spinner and offer a way forward. Still claims nothing about the map (§3.2a) — a
						     failed read is "couldn't look", never "empty" — so this is NOT the invite and NOT
						     a false "Grow your mycelium"; it is an actionable retry. retryProbe() clears the
						     count so the poll re-arms. Mirrors generate.ts's capped-`unknown` retryable state. -->
						<p class="load-fail">Couldn’t read your map just yet.</p>
						<p class="load-fail sub">This is usually temporary.</p>
						<button class="load-retry" onclick={retryProbe}>Retry</button>
					{:else if loadArm === 'checking'}
						<!-- ⚠️ We do not KNOW whether a map exists — the readiness probe failed and is
						     retrying. Falling through to the invite here would tell an owner with a built
						     mindscape to "Grow your mycelium", AND would put the invite on screen next to
						     the rail (which polls independently and recovers first) — the very overlap
						     this increment exists to make impossible. Claim nothing; say so.
						     Bounded: past PROBE_MAX_FAILS this yields to the capped state ABOVE. -->
						<p class="load-fail sub">Checking your mind…</p>
					{:else if loadArm === 'built-not-loaded'}
						<!-- ⚠️ The map EXISTS (the server counted points) but this client has none — the
						     points fetch raced clustering, or the durable points cache held a stale-empty
						     bundle. A LOAD FAILURE IS NOT AN EMPTY VAULT — §3.2a's rule, one surface over.
						     P1-A: the readiness poll's reconcileGeometry() now auto-pulls the geometry with a
						     cache-busting fetch every ~4s until it arrives, so this recovers ON ITS OWN with
						     no click. We render it as an ACTIVE loading state (spinner + honest copy), not a
						     dead end — and keep a manual "Try again" that forces a fresh fetch for impatience
						     or a persistent stale cache. `{ fresh: true }` guarantees the retry can never be
						     defeated by the same cached empty result that made the old button look dead. -->
						<p class="load-fail">Your map is built — finishing loading it…</p>
						{#if msState.error}<p class="load-fail sub">{msState.error}</p>{/if}
						<button class="load-retry" onclick={() => mindscapeState.load({ fresh: true })}>Try again</button>
					{/if}
				</div>
			{:else if msState.points && msState.points.length > 0}
				<!-- `loadArm` is null here ⇒ Mindscape3D has resolved (see loadArm's 'module' arm),
				     so this branch is only ever reached with a component to mount. -->
				<div class="map-container">
					<Mindscape3D {active} />
				</div>
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
		/* D-034 ↻1. The OUTER half of the same flex trap #350 fixed one level deeper. As a flex
		   item of `.mindscape-layout`, `.nav-panel` defaults to `min-height: auto`, so it grows to
		   its content instead of shrinking to the layout's height — measured `min-height: auto`
		   with clientHeight 860 vs scrollHeight 1830. `min-height: 0` + a flex column is what
		   gives `.nav-rail` below a DEFINITE height to be `flex: 1` of. Without it, `.nav-rail`
		   would grow with its content too and `overflow-y: auto` would again have nothing to do. */
		min-height: 0;
		display: flex;
		flex-direction: column;
		/* Stays `hidden`: the panel is the CLIP, `.nav-rail` is the SCROLL PORT. Two boxes, two
		   jobs — the panel must never scroll, or the resize handle would scroll with it. */
		overflow: hidden;
		border-right: 1px solid var(--color-border);
		background: var(--color-surface);
		z-index: 10;
		position: relative;
	}

	/* The rail's ONE scroll port — every section, at every drill level, scrolls here. */
	.nav-rail {
		flex: 1;
		/* Same rule, third time, and it is load-bearing at every level: a `flex: 1` child with
		   the default `min-height: auto` cannot shrink below its content, so it never overflows
		   and `overflow-y: auto` is inert. This is the exact shape of D-034 and of its ↻1. */
		min-height: 0;
		overflow-y: auto;
		/* A rail that has run out of scroll must not start scrolling the page/canvas behind it. */
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.6rem 0.6rem 4rem;
		/* THE OPERATOR'S OTHER HALF: "must scroll all the way to the bottom of that padding".
		   Bottom padding on a scroll container IS included in scrollHeight, so the 4rem above is
		   genuinely reachable — but only if nothing clips it. `box-sizing` is global here; stated
		   so a later edit does not "tidy" the padding into a margin, which collapses out of
		   scrollHeight and would silently restore the cut-off. */
		box-sizing: border-box;
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

	.load-fail { font-size: 0.82rem; color: var(--color-text-secondary); margin: 0 0 0.5rem; text-align: center; }
	.load-fail.sub { font-size: 0.7rem; color: var(--color-text-tertiary); margin-bottom: 0.8rem; }
	.load-retry {
		padding: 0.45rem 1rem; border-radius: 8px; border: 1px solid var(--glass-border);
		background: var(--glass-card-bg); color: var(--color-text-primary);
		font-size: 0.75rem; cursor: pointer; font-family: inherit;
	}
	.load-retry:hover { border-color: var(--color-accent-aurum); }

	.loading-3d {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
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
