<script lang="ts">
	// MindscapeBackground — the living 3D point cloud from the mycelium.id site
	// (Goethe's mindscape), ported natively onto three@0.182. Used behind the
	// empty-mindscape invitation + anywhere we want the "alive, growing" backdrop.
	//
	// Self-contained: auto-rotating OrbitControls, a periodic pulse wave that
	// ripples brightness outward from a random node, and a dark-mode starfield.
	// Reads /mindscape-data.json (static): an array of [x, y, z, clusterId].
	// Cleans up its RAF + renderer + observer on destroy (no leaks on view switch).
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { canUseWebGL } from '$lib/utils/webgl';

	let { interactive = false }: { interactive?: boolean } = $props();

	let canvas = $state<HTMLCanvasElement | undefined>();
	let raf = 0;
	let cleanup: (() => void) | null = null;

	onMount(() => {
		if (!browser || !canvas) return;
		let disposed = false;

		(async () => {
			// Decorative-only: if WebGL is unavailable, skip silently (no crash, no
			// fallback UI — it's a background). The 3D mindscape view itself shows a
			// proper fallback (Mindscape3D.svelte).
			if (!canUseWebGL()) return;
			const THREE = await import('three');
			const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
			if (disposed || !canvas) return;

			const parent = canvas.parentElement!;
			// Follow the APP theme ([data-theme]) not the OS scheme, so the cloud
			// matches a manually-toggled light/dark app.
			const themeAttr = document.documentElement.getAttribute('data-theme');
			const dark = themeAttr ? themeAttr === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;

			const scene = new THREE.Scene();
			let w = parent.clientWidth || 1;
			let h = parent.clientHeight || 1;
			const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 500);
			camera.position.set(121, 77, 121);

			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
			renderer.setClearColor(0x000000, 0);
			renderer.setSize(w, h);
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

			const controls = new OrbitControls(camera, renderer.domElement);
			controls.enableDamping = true;
			controls.dampingFactor = 0.04;
			controls.enableZoom = false;
			controls.enablePan = false;
			controls.autoRotate = true;
			controls.autoRotateSpeed = 0.4;
			// A background by default — only steal pointer events when explicitly interactive.
			controls.enabled = interactive;
			renderer.domElement.style.pointerEvents = interactive ? 'auto' : 'none';

			let pulse: (() => void) | null = null;

			try {
				const res = await fetch('/mindscape-data.json');
				const pts: number[][] = await res.json();
				if (disposed) { renderer.dispose(); return; }

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
					positions[i * 3 + 1] = p[2] * scale; // y/z swap
					positions[i * 3 + 2] = p[1] * scale;
					const hue = (((p[0] * 7.31 + p[1] * 13.17 + p[2] * 23.41) % 1) + 1) % 1;
					const satBase = (((p[0] * 3.71 + p[1] * 8.53 + p[2] * 5.29) % 1) + 1) % 1;
					const litBase = (((p[0] * 11.13 + p[1] * 4.87 + p[2] * 17.63) % 1) + 1) % 1;
					let sat: number, lit: number;
					if (dark) {
						sat = 0.35 + satBase * 0.45;
						lit = 0.25 + litBase * 0.3;
						if (p[3] === -1) lit = 0.08;
					} else {
						sat = 0.55 + satBase * 0.35;
						lit = 0.35 + litBase * 0.2;
						if (p[3] === -1) lit = 0.75;
					}
					const col = new THREE.Color().setHSL(hue, sat, lit);
					colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
				}

				const geo = new THREE.BufferGeometry();
				geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
				geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
				const mat = new THREE.PointsMaterial({
					size: dark ? 0.22 : 0.32, vertexColors: true, transparent: true,
					opacity: dark ? 0.85 : 0.92, sizeAttenuation: true, depthWrite: !dark,
				});
				scene.add(new THREE.Points(geo, mat));

				const cx = ((xMax + xMin) / 2) * scale, cy = ((zMax + zMin) / 2) * scale, cz = ((yMax + yMin) / 2) * scale;
				controls.target.set(cx, cy, cz);
				camera.lookAt(cx, cy, cz);

				const baseColors = new Float32Array(colors);
				// Neuron-like firing: instead of one synchronized wave, many points fire
				// at random times and fade on their own decay timers — sparse, organic,
				// asynchronous (brain activity, not a strobe). Only active firings are
				// touched each frame (cheap), and each restores to its base colour as it
				// dies, so the cloud never drifts brighter over time.
				type Firing = { i: number; age: number; tau: number; peak: number };
				const firings: Firing[] = [];
				const MAX_FIRINGS = 110;
				const setHot = (cols: Float32Array, i: number, b: number) => {
					const o = i * 3;
					if (dark) {
						cols[o] = baseColors[o] + (1.0 - baseColors[o]) * b;
						cols[o + 1] = baseColors[o + 1] + (0.9 - baseColors[o + 1]) * b;
						cols[o + 2] = baseColors[o + 2] + (0.5 - baseColors[o + 2]) * b * 0.6;
					} else {
						cols[o] = baseColors[o] * (1 - b * 0.3) + 0.72 * b;
						cols[o + 1] = baseColors[o + 1] * (1 - b * 0.4) + 0.52 * b;
						cols[o + 2] = baseColors[o + 2] * (1 - b * 0.5) + 0.04 * b;
					}
				};
				const restore = (cols: Float32Array, i: number) => {
					const o = i * 3; cols[o] = baseColors[o]; cols[o + 1] = baseColors[o + 1]; cols[o + 2] = baseColors[o + 2];
				};
				pulse = () => {
					const colAttr = geo.getAttribute('color') as any;
					const cols = colAttr.array as Float32Array;
					// Spawn: most frames ignite a small local "bloom" (a seed point + a few
					// nearby indices), each with a randomized decay so they desync quickly.
					if (Math.random() < 0.55 && firings.length < MAX_FIRINGS) {
						const seed = Math.floor(Math.random() * count);
						const burst = 2 + Math.floor(Math.random() * 4);
						for (let b = 0; b < burst && firings.length < MAX_FIRINGS; b++) {
							const i = Math.min(count - 1, Math.max(0, seed + Math.floor((Math.random() - 0.5) * 16)));
							firings.push({ i, age: -Math.floor(Math.random() * 6), tau: 22 + Math.random() * 55, peak: 0.55 + Math.random() * 0.45 });
						}
					}
					let changed = false;
					for (let k = firings.length - 1; k >= 0; k--) {
						const f = firings[k];
						f.age++;
						if (f.age <= 0) continue; // brief random stagger before it lights
						const b = f.peak * Math.exp(-f.age / f.tau);
						if (b < 0.03) { restore(cols, f.i); firings.splice(k, 1); changed = true; continue; }
						setHot(cols, f.i, b);
						changed = true;
					}
					if (changed) colAttr.needsUpdate = true;
				};
			} catch { /* no data file → still render the starfield/empty scene */ }

			if (dark) {
				const starGeo = new THREE.BufferGeometry();
				const starPos = new Float32Array(1500 * 3);
				for (let i = 0; i < 1500; i++) {
					const r = 200, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
					starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
					starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
					starPos[i * 3 + 2] = r * Math.cos(ph);
				}
				starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
				scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
					size: 0.8, color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false,
				})));
			}

			const loop = () => {
				raf = requestAnimationFrame(loop);
				if (pulse) pulse();
				controls.update();
				renderer.render(scene, camera);
			};
			loop();

			const ro = new ResizeObserver(() => {
				w = parent.clientWidth || 1; h = parent.clientHeight || 1;
				camera.aspect = w / h; camera.updateProjectionMatrix();
				renderer.setSize(w, h);
			});
			ro.observe(parent);

			cleanup = () => {
				cancelAnimationFrame(raf);
				ro.disconnect();
				controls.dispose();
				renderer.dispose();
				scene.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
			};
		})();

		return () => { disposed = true; };
	});

	onDestroy(() => { cleanup?.(); });
</script>

<canvas bind:this={canvas} class="mindscape-bg-canvas"></canvas>

<style>
	.mindscape-bg-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
