<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { theme } from '$lib/stores/theme';

	// Cleanup for the living backdrop (rAF loops, listeners, store subscription).
	let bgTeardown: (() => void) | null = null;

	let mode: 'loading' | 'operator' | 'enroll' = $state('loading');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let passwordInput = $state('');
	let userHandle = $state<string | null>(null);
	let requirePasskey = $state(false);
	let telegramAvailable = $state(false);
	let telegramRedirecting = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/auth/setup-status', { credentials: 'same-origin' });
			if (res.ok) {
				const data = await res.json();
				userHandle = data.handle || null;
				// When the vault requires a passkey for web sign-in, hide the password
				// path and lead with the passkey button (the server also enforces this).
				requirePasskey = data.requirePasskey === true;
			}
			// V1 self-hosted: a networked client (over the relay) signs in with the
			// operator password; loopback never reaches /login (the shim authorizes
			// it). Returning users can use an enrolled passkey from the operator
			// screen. Always land on the operator sign-in.
			mode = 'operator';
		} catch {
			mode = 'operator';
		}

		// Discover available channel verifiers (e.g. telegram-widget). Best-effort —
		// any failure just hides the alternative-auth buttons, no error to user.
		try {
			const r = await fetch('/portal/auth/channel/methods', { credentials: 'same-origin' });
			if (r.ok) {
				const data = await r.json();
				const methods = Array.isArray(data?.methods) ? data.methods : [];
				telegramAvailable = methods.some((m: { kind?: string }) => m?.kind === 'telegram-widget');
			}
		} catch { /* hide button silently */ }

		// Living backdrop — hyphae network + hover-grown starfield, theme-reactive.
		bgTeardown = initBackground();
	});

	onDestroy(() => { bgTeardown?.(); bgTeardown = null; });

	// Continue with Telegram — V5 redirect-flow (per IDENTITY-CHANNELS.md OD3).
	// Calls /portal/auth/channel/telegram-widget/start to get the oauth.telegram.org
	// URL (built server-side with bot_id + portal-origin), then full-redirects.
	// Telegram will redirect back to /login/telegram-callback with auth fields.
	async function handleTelegramLogin() {
		if (telegramRedirecting) return;
		telegramRedirecting = true;
		error = null;
		try {
			const res = await fetch('/portal/auth/channel/telegram-widget/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ payload: {} }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.error || 'Telegram login is currently unavailable');
			}
			const { oauth_url } = await res.json();
			if (typeof oauth_url !== 'string' || !/^https:\/\/oauth\.telegram\.org\//.test(oauth_url)) {
				throw new Error('Invalid Telegram redirect URL');
			}
			window.location.href = oauth_url;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Telegram login failed';
			telegramRedirecting = false;
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	//  LIVING BACKDROP — hyphae network + hover-grown starfield (ported from the
	//  marketing site), made fully theme-reactive to the app's theme STORE.
	//
	//  The recurring bug this kills: the site reads its palette from
	//  prefers-color-scheme vars ONCE at init and only relearns the theme from a
	//  custom `themechange` event the site itself dispatches. Our app uses the
	//  `theme` store + `data-theme` attribute, so a verbatim port never re-themes.
	//
	//  Decisive fix — three inputs, one full reset, no cached palette:
	//   • readPalette() reads LIVE CSS vars (getComputedStyle) every theme change
	//   • theme.subscribe()  — canonical signal
	//   • MutationObserver on data-theme — defensive backstop
	//  → applyTheme() FULLY resets the canvas (refill bg + reseed), so no buffer
	//    can be left half-painted in the old palette.
	// ════════════════════════════════════════════════════════════════════════
	function initBackground(): () => void {
		const hCanvas = document.getElementById('hyphae-canvas') as HTMLCanvasElement | null;
		const sCanvas = document.getElementById('starfield') as HTMLCanvasElement | null;
		const markEl = document.getElementById('login-mark');
		if (!hCanvas) return () => {};
		const hctx = hCanvas.getContext('2d');
		if (!hctx) return () => {};

		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const PHI_INV = 0.6180339887;

		// ── live, never-frozen palette ──────────────────────────────────────
		function parseColor(c: string): [number, number, number] | null {
			c = c.trim();
			if (c.startsWith('#')) {
				const h = c.slice(1);
				const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
				if (f.length >= 6) return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
			}
			const m = c.match(/(\d+\.?\d*)/g);
			if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
			return null;
		}
		interface Palette { dark: boolean; rgb: [number, number, number]; hue: number; sat: number; light: number; baseAlpha: number; }
		function readPalette(): Palette {
			const cs = getComputedStyle(document.documentElement);
			const dark = document.documentElement.getAttribute('data-theme') !== 'light';
			const bg = cs.getPropertyValue('--color-bg').trim();
			const rgb: [number, number, number] = parseColor(bg) || (dark ? [10, 10, 12] : [250, 248, 245]);
			// Line colour is theme-derived: pale-warm on dark, darker-warm on light
			// so the fine lines stay visible on a cream background (the site's fixed
			// pale line is near-invisible on light — that was part of the breakage).
			return dark
				? { dark, rgb, hue: 36, sat: 24, light: 60, baseAlpha: 0.32 }
				: { dark, rgb, hue: 34, sat: 32, light: 40, baseAlpha: 0.20 };
		}
		let pal = readPalette();
		const bgFill = (a = 1) => `rgba(${pal.rgb[0]},${pal.rgb[1]},${pal.rgb[2]},${a})`;

		// ── hyphae engine ───────────────────────────────────────────────────
		const P = {
			curvJitter: 0.008, curvDecay: 0.97, curvMax: 0.022, angleJitter: 0.012,
			stepLenVar: 0.2, branchProb: 0.13, branchMinSpace: 7, branchAngleBase: 0.4,
			maxDepth: 22, childSpeedRatio: 0.95, dichotomyProb: 0.03, dichotomyMaxDepth: 8,
			dichotomySplay: PHI_INV * 0.18, anastProb: 0.18, anastRadius: 14, anastLineWidth: 0.35,
			baseWidth: 0.55, hueVar: 8, seedLife: 1500, seedLifeVar: 200, seedSpeed: 0.28,
			seedSpeedVar: 0.06, chemoStrength: 0.095, chemoRadius: 65, seekRange: 35,
			seekStrength: 0.21, lateralProb: 0.022, lateralAngleVar: 0.4, maxTurnRate: 0.04,
		};
		const GRID = 15;
		let W = 0, H = 0, time = 0;
		const persist = document.createElement('canvas');
		const pctx = persist.getContext('2d');
		let grid: Record<string, Array<{ x: number; y: number; c: number }>> = {};
		let density: Record<string, number> = {};
		let nextColony = 0;
		let spores: Array<{ x: number; y: number; colony: number }> = [];
		let seedN = 137;
		const rng = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };

		const gridKey = (x: number, y: number) => `${Math.floor(x / GRID)},${Math.floor(y / GRID)}`;
		function addToGrid(x: number, y: number, colony: number) {
			const jx = x + (rng() - 0.5) * 2, jy = y + (rng() - 0.5) * 2, k = gridKey(x, y);
			if (!grid[k]) grid[k] = [];
			grid[k].push({ x: jx, y: jy, c: colony });
			density[k] = (density[k] || 0) + 1;
		}
		function findNearby(x: number, y: number, radius: number) {
			const cx = Math.floor(x / GRID), cy = Math.floor(y / GRID), r = Math.ceil(radius / GRID);
			const cand: Array<{ x: number; y: number; c: number }> = [];
			for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
				const cell = grid[`${cx + dx},${cy + dy}`];
				if (!cell) continue;
				for (const p of cell) { const d = Math.hypot(p.x - x, p.y - y); if (d > 4 && d < radius) cand.push(p); }
			}
			return cand.length ? cand[Math.floor(rng() * cand.length)] : null;
		}
		function chemoGradient(x: number, y: number) {
			const cx = Math.floor(x / GRID), cy = Math.floor(y / GRID);
			let gx = 0, gy = 0;
			const r = Math.ceil(P.chemoRadius / GRID);
			for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
				if (dx === 0 && dy === 0) continue;
				const d = density[`${cx + dx},${cy + dy}`] || 0;
				if (d === 0) continue;
				const dist = Math.sqrt(dx * dx + dy * dy), wgt = d / (dist * dist + 1);
				gx += dx * wgt; gy += dy * wgt;
			}
			return Math.sqrt(gx * gx + gy * gy) < 0.01 ? 0 : Math.atan2(gy, gx);
		}
		const hWidth = (depth: number) => Math.max(0.35, P.baseWidth * Math.pow(PHI_INV, depth * 0.3));
		const hAlpha = (depth: number) => Math.max(0.1, pal.baseAlpha * Math.pow(PHI_INV, depth * 0.15));

		interface Hypha {
			x: number; y: number; ox: number; oy: number; angle: number;
			targetAngle: number | null; curvature: number; speed: number;
			life: number; maxLife: number; depth: number; dead: boolean; age: number;
			lastBranch: number; hue: number; gridAge: number; colony: number; scout: boolean;
			update(): void; draw(c: CanvasRenderingContext2D): void;
		}
		// Factory, not a class — avoids declaring a class below top-level scope
		// (svelte perf_avoid_nested_class) while keeping the same per-tip behaviour.
		function makeHypha(x: number, y: number, angle: number, speed: number, life: number, depth: number, targetAngle?: number, colony?: number): Hypha {
			return {
			x, y, ox: x, oy: y, angle,
			targetAngle: targetAngle !== undefined ? targetAngle : null,
			curvature: (rng() - 0.5) * 0.003, speed,
			life, maxLife: life, depth, dead: false, age: 0,
			lastBranch: 0, hue: pal.hue + (rng() - 0.5) * P.hueVar, gridAge: 0,
			colony: colony !== undefined ? colony : nextColony++, scout: rng() < 0.4,
			update() {
				if (this.dead) return;
				this.age++; this.lastBranch++; this.gridAge++;
				if (this.targetAngle !== null && this.age < 30) {
					let diff = this.targetAngle - this.angle;
					while (diff > Math.PI) diff -= Math.PI * 2;
					while (diff < -Math.PI) diff += Math.PI * 2;
					this.angle += diff * 0.06;
				} else this.targetAngle = null;
				const angleStart = this.angle;
				this.curvature += (rng() - 0.5) * P.curvJitter;
				this.curvature *= P.curvDecay;
				this.curvature = Math.max(-P.curvMax, Math.min(P.curvMax, this.curvature));
				this.angle += this.curvature + (rng() - 0.5) * P.angleJitter;
				if (this.age > 20 && this.age % 8 === 0) {
					const ca = chemoGradient(this.x, this.y);
					if (ca !== 0) {
						let diff = ca - this.angle;
						while (diff > Math.PI) diff -= Math.PI * 2;
						while (diff < -Math.PI) diff += Math.PI * 2;
						this.angle += diff * (this.scout ? -P.chemoStrength * 1.5 : P.chemoStrength);
					}
				}
				const margin = 8;
				let edge = 0;
				if (this.x < margin) edge = (margin - this.x) / margin;
				else if (this.x > W - margin) edge = (this.x - (W - margin)) / margin;
				if (this.y < margin) edge = Math.max(edge, (margin - this.y) / margin);
				else if (this.y > H - margin) edge = Math.max(edge, (this.y - (H - margin)) / margin);
				if (edge > 0) {
					const toC = Math.atan2(H / 2 - this.y, W / 2 - this.x);
					let diff = toC - this.angle;
					while (diff > Math.PI) diff -= Math.PI * 2;
					while (diff < -Math.PI) diff += Math.PI * 2;
					this.angle += diff * 0.08 * edge;
				}
				let turn = this.angle - angleStart;
				while (turn > Math.PI) turn -= Math.PI * 2;
				while (turn < -Math.PI) turn += Math.PI * 2;
				if (Math.abs(turn) > P.maxTurnRate) this.angle = angleStart + Math.sign(turn) * P.maxTurnRate;
				if (this.life < 200 && this.depth > 1 && this.age % 4 === 0) {
					const tgt = findNearby(this.x, this.y, P.seekRange + this.depth * 4);
					if (tgt) {
						const sa = Math.atan2(tgt.y - this.y, tgt.x - this.x);
						let diff = sa - this.angle;
						while (diff > Math.PI) diff -= Math.PI * 2;
						while (diff < -Math.PI) diff += Math.PI * 2;
						this.angle += diff * P.seekStrength * ((200 - this.life) / 200);
					}
				}
				this.ox = this.x; this.oy = this.y;
				const sl = this.speed * (1 - P.stepLenVar / 2 + rng() * P.stepLenVar);
				this.x += Math.cos(this.angle) * sl; this.y += Math.sin(this.angle) * sl;
				this.life--;
				if (this.gridAge >= 3) { this.gridAge = 0; addToGrid(this.x, this.y, this.colony); }
				const k = gridKey(this.x, this.y), localD = density[k] || 0;
				if (this.age % 8 === 0) {
					if (localD > 10) this.life -= (3 + this.depth * 2);
					else if (localD > 4) this.life += 2;
					else if (localD === 0) this.life += this.scout ? 3 : 1;
					else if (localD < 2 && !this.scout && this.life > 100) this.life -= 1;
				}
				const depthFactor = Math.min(2.4, 1 + this.depth * 0.35);
				const minSpacing = Math.floor(P.branchMinSpace / depthFactor);
				const bProb = P.branchProb * depthFactor;
				if (localD < 8 && this.lastBranch > minSpacing && this.depth < P.maxDepth && rng() < bProb) {
					this.lastBranch = 0;
					const side = rng() > 0.5 ? 1 : -1;
					const ba = side * P.branchAngleBase * Math.pow(PHI_INV, this.depth * 0.15) * (0.7 + rng() * 0.6);
					const childSpeed = this.speed * P.childSpeedRatio;
					const childLife = rng() < 0.5 ? P.seedLife * (0.7 + rng() * 0.4) : Math.max(600, this.life * 0.75 * (0.85 + rng() * 0.3));
					tips.push(makeHypha(this.x, this.y, this.angle, childSpeed, childLife, this.depth + 1, this.angle + ba, this.colony));
					nodes.push({ x: this.x, y: this.y });
					if (this.depth < P.dichotomyMaxDepth && rng() < P.dichotomyProb) {
						const splay = P.dichotomySplay * Math.pow(PHI_INV, this.depth * 0.1) * (0.8 + rng() * 0.4);
						tips.push(makeHypha(this.x, this.y, this.angle, childSpeed, Math.max(600, childLife * 0.9), this.depth + 1, this.angle + splay, this.colony));
						tips.push(makeHypha(this.x, this.y, this.angle, childSpeed, Math.max(600, childLife * 0.9), this.depth + 1, this.angle - splay, this.colony));
						this.dead = true;
						nodes.push({ x: this.x, y: this.y });
					}
				}
				if (this.depth < 6 && localD < 7 && this.age > 25 && rng() < P.lateralProb) {
					const side = rng() > 0.5 ? 1 : -1;
					const la = this.angle + side * (Math.PI / 2 + (rng() - 0.5) * P.lateralAngleVar);
					tips.push(makeHypha(this.x, this.y, this.angle, this.speed * 0.85, 800 + rng() * 400, this.depth + 2, la, this.colony));
					nodes.push({ x: this.x, y: this.y });
				}
				if (this.age > 25 && this.age % 12 === 0 && localD < 8) {
					const near = findNearby(this.x, this.y, P.anastRadius);
					if (near && rng() < P.anastProb) {
						const dist = Math.hypot(near.x - this.x, near.y - this.y);
						if (dist > 4 && pctx) {
							const inter = near.c !== this.colony;
							const perpX = -(near.y - this.y) / dist, perpY = (near.x - this.x) / dist;
							const bulge = (rng() - 0.5) * dist * 0.6;
							const mx = (this.x + near.x) / 2 + perpX * bulge, my = (this.y + near.y) / 2 + perpY * bulge;
							pctx.strokeStyle = `hsla(${this.hue}, ${pal.sat}%, ${pal.light}%, ${inter ? 0.25 : 0.15})`;
							pctx.lineWidth = inter ? P.anastLineWidth * 1.5 : P.anastLineWidth;
							pctx.lineCap = 'round';
							pctx.beginPath(); pctx.moveTo(this.x, this.y); pctx.quadraticCurveTo(mx, my, near.x, near.y); pctx.stroke();
							nodes.push({ x: mx, y: my });
							if (inter) {
								const jk = gridKey(mx, my);
								density[jk] = (density[jk] || 0) + 6;
								const fa = Math.atan2(near.y - this.y, near.x - this.x);
								const cnt = 1 + Math.floor(rng() * 2);
								for (let i = 0; i < cnt; i++) tips.push(makeHypha(mx, my, fa, P.seedSpeed * 0.8, P.seedLife * 0.4 + 150, 2, fa + (Math.PI / 2) * (i % 2 === 0 ? 1 : -1) + (rng() - 0.5) * 0.4, this.colony));
								let close = false;
								for (const sp of spores) if (Math.hypot(sp.x - mx, sp.y - my) < 100) { close = true; break; }
								if (!close && spores.length < 30) spores.push({ x: mx, y: my, colony: nextColony++ });
							}
						}
					}
				}
				if (this.life <= 0) this.dead = true;
				if (this.x < -20 || this.x > W + 20 || this.y < -20 || this.y > H + 20) this.dead = true;
			},
			draw(c: CanvasRenderingContext2D) {
				const localD = density[gridKey(this.x, this.y)] || 0;
				c.strokeStyle = `hsla(${this.hue}, ${pal.sat}%, ${pal.light}%, ${(hAlpha(this.depth) + Math.min(0.06, localD * 0.004)).toFixed(3)})`;
				c.lineWidth = hWidth(this.depth);
				c.lineCap = 'round'; c.lineJoin = 'round';
				c.beginPath(); c.moveTo(this.ox, this.oy); c.lineTo(this.x, this.y); c.stroke();
			},
			};
		}
		let tips: Hypha[] = [];
		let nodes: Array<{ x: number; y: number }> = [];

		function seedHyphae() {
			const positions = [[0.05, 0.92], [0.92, 0.7], [0.5, 0.1]];
			for (const [px, py] of positions) {
				const colony = nextColony++;
				const x = W * px + (rng() - 0.5) * W * 0.02, y = H * py + (rng() - 0.5) * H * 0.02;
				spores.push({ x, y, colony });
				const count = 5 + Math.floor(rng() * 3);
				for (let j = 0; j < count; j++) tips.push(makeHypha(x, y, (Math.PI * 2 / count) * j + (rng() - 0.5) * 0.3, P.seedSpeed + rng() * P.seedSpeedVar, P.seedLife + rng() * P.seedLifeVar, 0, undefined, colony));
				nodes.push({ x, y });
			}
		}
		const TARGET_ALIVE = 55;
		function maybeSpawn() {
			const alive = tips.filter((t) => !t.dead).length;
			const spawnChance = 0.12 * (1 - Math.min(1, alive / TARGET_ALIVE) * 0.7);
			if (nodes.length > 0 && rng() < spawnChance) {
				const n = nodes[Math.floor(rng() * nodes.length)], target = rng() * Math.PI * 2;
				tips.push(makeHypha(n.x, n.y, target + Math.PI / 2, P.seedSpeed + rng() * P.seedSpeedVar, P.seedLife * 0.6 + rng() * P.seedLifeVar, 1, target));
			}
			if (spores.length > 0 && time % 30 === 0) {
				const sp = spores[Math.floor(rng() * spores.length)];
				if (!tips.some((t) => !t.dead && Math.hypot(t.x - sp.x, t.y - sp.y) < 60)) {
					const count = 2 + Math.floor(rng() * 3), baseA = rng() * Math.PI * 2;
					for (let i = 0; i < count; i++) { const target = baseA + (Math.PI * 2 / count) * i + (rng() - 0.5) * 0.3; tips.push(makeHypha(sp.x, sp.y, target + Math.PI / 2, P.seedSpeed, P.seedLife * 0.7, 0, target, sp.colony)); }
				}
			}
			if (rng() < spawnChance * 0.25) {
				const e = Math.floor(rng() * 4);
				const x = e === 2 ? -5 : e === 3 ? W + 5 : rng() * W, y = e === 0 ? -5 : e === 1 ? H + 5 : rng() * H;
				tips.push(makeHypha(x, y, Math.atan2(H / 2 - y, W / 2 - x) + (rng() - 0.5) * 0.5, P.seedSpeed, P.seedLife, 0));
			}
		}

		function sizeHyphae() {
			W = window.innerWidth; H = window.innerHeight;
			hCanvas!.width = W * dpr; hCanvas!.height = H * dpr;
			hCanvas!.style.width = W + 'px'; hCanvas!.style.height = H + 'px';
			persist.width = W * dpr; persist.height = H * dpr;
			hctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
			pctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		function resetHyphae() {
			tips = []; nodes = []; grid = {}; density = {}; spores = []; nextColony = 0; seedN = 137; time = 0;
			if (pctx) { pctx.fillStyle = bgFill(1); pctx.fillRect(0, 0, W, H); }
			seedHyphae();
			if (pctx) { hctx!.clearRect(0, 0, W, H); hctx!.drawImage(persist, 0, 0); }
		}

		let hRaf = 0, hStop = false;
		const H_FRAME_CAP = 4200;
		function hAnimate() {
			if (hStop) return;
			if (time > H_FRAME_CAP) return; // network has stabilized; final frame persists
			hRaf = requestAnimationFrame(hAnimate);
			time++;
			if (!pctx) return;
			if (time > 500 && time % 6 === 0) { pctx.fillStyle = bgFill(0.0005); pctx.fillRect(0, 0, W, H); }
			for (const t of tips) { t.update(); if (!t.dead) t.draw(pctx); }
			hctx!.clearRect(0, 0, W, H); hctx!.drawImage(persist, 0, 0);
			maybeSpawn();
			tips = tips.filter((t) => !t.dead);
			if (tips.length > 800) tips = tips.slice(-600);
			if (nodes.length > 800) nodes = nodes.slice(-600);
			if (time % 200 === 0) for (const k of Object.keys(density)) { density[k] = Math.floor(density[k] * 0.8); if (density[k] <= 0) delete density[k]; }
			if (time % 2000 === 0) { const keys = Object.keys(grid); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 300)) delete grid[k]; }
		}
		function startHyphae() { if (hStop) return; cancelAnimationFrame(hRaf); hRaf = requestAnimationFrame(hAnimate); }

		// ── starfield (Milky-Way bloom from the mushroom mark on hover) ──────
		let sctx: CanvasRenderingContext2D | null = sCanvas ? sCanvas.getContext('2d') : null;
		let sW = 0, sH = 0, sdpr = 1, ox = 0, oy = 0, maxR = 1, sRaf = 0;
		let reveal = 0, hover = false, sRunning = false, gal: HTMLCanvasElement | null = null;
		let twinkles: Array<{ x: number; y: number; r: number; ph: number; sp: number; big: boolean; col: number[] }> = [];
		const feather = () => (pal.dark ? { edgeBlur: 24, halo: 1.5, core: 0.82 } : { edgeBlur: 16, halo: 1.0, core: 1.0 });
		function markOrigin(): [number, number] {
			if (markEl) { const r = markEl.getBoundingClientRect(); return [(r.left + r.width / 2) * sdpr, (r.top + r.height / 2) * sdpr]; }
			return [sW / 2, sH * 0.32];
		}
		function buildGalaxy() {
			if (!sCanvas) return;
			sdpr = Math.min(window.devicePixelRatio || 1, 1.5);
			sW = sCanvas.width = window.innerWidth * sdpr; sH = sCanvas.height = window.innerHeight * sdpr;
			sCanvas.style.width = window.innerWidth + 'px'; sCanvas.style.height = window.innerHeight + 'px';
			[ox, oy] = markOrigin();
			maxR = Math.hypot(Math.max(ox, sW - ox), Math.max(oy, sH - oy)) * 1.12;
			gal = document.createElement('canvas'); gal.width = sW; gal.height = sH;
			const g = gal.getContext('2d'); if (!g) return;
			const cx = sW / 2, cy = sH / 2, ang = -0.42, ca = Math.cos(ang), sa = Math.sin(ang);
			const L = Math.hypot(sW, sH) * 0.62, bandW = Math.min(sW, sH) * 0.16, mind = Math.min(sW, sH);
			const pt = (u: number, v: number): [number, number] => [cx + u * L * ca - v * sa, cy + u * L * sa + v * ca];
			const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
			const bg = g.createRadialGradient(cx, cy, 0, cx, cy, L);
			bg.addColorStop(0, '#0c1019'); bg.addColorStop(0.55, '#070a12'); bg.addColorStop(1, '#04050a');
			g.fillStyle = bg; g.fillRect(0, 0, sW, sH);
			g.globalCompositeOperation = 'lighter';
			const cols = [[58, 92, 170], [128, 84, 168], [176, 138, 86], [44, 132, 150], [150, 70, 110]];
			for (let i = 0; i < 70; i++) {
				const [x, y] = pt(Math.random() * 2 - 1, gauss() * bandW * 1.5), rad = mind * (0.05 + Math.random() * 0.16), col = cols[(Math.random() * cols.length) | 0], a = (0.04 + Math.random() * 0.07).toFixed(3);
				const rg = g.createRadialGradient(x, y, 0, x, y, rad);
				rg.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`); rg.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
				g.fillStyle = rg; g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
			}
			{ const [x, y] = pt(Math.random() * 0.6 - 0.3, 0), rad = mind * 0.5, rg = g.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, 'rgba(230,220,200,0.07)'); rg.addColorStop(1, 'rgba(230,220,200,0)'); g.fillStyle = rg; g.fillRect(0, 0, sW, sH); }
			g.globalCompositeOperation = 'source-over';
			for (let i = 0; i < 22; i++) { const [x, y] = pt(Math.random() * 2 - 1, gauss() * bandW * 0.7), rad = mind * (0.04 + Math.random() * 0.1), rg = g.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, 'rgba(4,5,9,0.5)'); rg.addColorStop(1, 'rgba(4,5,9,0)'); g.fillStyle = rg; g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill(); }
			const N = Math.min(3000, Math.floor(window.innerWidth * window.innerHeight / 650));
			for (let i = 0; i < N; i++) {
				let x: number, y: number;
				if (Math.random() < 0.62) { [x, y] = pt(Math.random() * 2 - 1, gauss() * bandW); } else { x = Math.random() * sW; y = Math.random() * sH; }
				if (x < 0 || x > sW || y < 0 || y > sH) continue;
				const r = (Math.random() > 0.985 ? 1.8 + Math.random() * 1.4 : 0.35 + Math.random() * 0.95) * sdpr, cm = Math.random();
				const col = cm < 0.68 ? [255, 255, 255] : (cm < 0.85 ? [196, 212, 255] : (cm < 0.96 ? [255, 226, 168] : [255, 176, 158])), a = 0.3 + Math.random() * 0.6;
				if (r > 1.6 * sdpr) { const gl = g.createRadialGradient(x, y, 0, x, y, r * 4); gl.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${(a * 0.6).toFixed(3)})`); gl.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`); g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 4, 0, 6.2832); g.fill(); }
				g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
			}
			twinkles = [];
			for (let i = 0; i < 90; i++) {
				let x: number, y: number; if (Math.random() < 0.6) { [x, y] = pt(Math.random() * 2 - 1, gauss() * bandW); } else { x = Math.random() * sW; y = Math.random() * sH; }
				const big = Math.random() < 0.2;
				twinkles.push({ x, y, r: (big ? 1.4 + Math.random() * 1.2 : 0.5 + Math.random() * 0.9) * sdpr, ph: Math.random() * 6.28, sp: 0.5 + Math.random() * 1.1, big, col: Math.random() < 0.78 ? [255, 255, 255] : (Math.random() < 0.5 ? [214, 226, 255] : [255, 226, 168]) });
			}
		}
		function blobPath(c: CanvasRenderingContext2D, R: number, amp: number, t: number) {
			const seg = 60; c.beginPath();
			for (let i = 0; i <= seg; i++) { const a = i / seg * 6.2832, w = 1 + amp * (0.6 * Math.sin(2 * a + t) + 0.4 * Math.sin(3 * a - t * 0.6)), rr = R * w, x = ox + Math.cos(a) * rr, y = oy + Math.sin(a) * rr; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }
			c.closePath();
		}
		function sFrame(ts: number) {
			if (!sctx || !gal) return;
			if (document.hidden) { sRaf = requestAnimationFrame(sFrame); return; }
			const tgt = hover ? 1 : 0;
			reveal += (tgt - reveal) * (reduce ? 1 : (tgt > reveal ? 0.022 : 0.16));
			sctx.clearRect(0, 0, sW, sH);
			if (reveal < 0.004 && tgt === 0) { sRunning = false; return; }
			if (markEl) { const r = markEl.getBoundingClientRect(); ox = (r.left + r.width / 2) * sdpr; oy = (r.top + r.height / 2) * sdpr; maxR = Math.hypot(Math.max(ox, sW - ox), Math.max(oy, sH - oy)) * 1.12; }
			const f = feather(), t = ts / 1000, R = reveal * maxR, amp = 0.12 * Math.max(0, 1 - reveal);
			sctx.drawImage(gal, 0, 0);
			for (const s of twinkles) {
				if (Math.hypot(s.x - ox, s.y - oy) > R) continue;
				const tw = 0.5 + 0.5 * Math.sin(s.ph + t * s.sp), c = `${s.col[0]},${s.col[1]},${s.col[2]}`;
				if (s.big) {
					const gr = s.r * (2.4 + 1.6 * tw) * f.halo;
					const gl = sctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gr);
					gl.addColorStop(0, `rgba(${c},${((0.5 * tw + 0.12) * f.core).toFixed(3)})`); gl.addColorStop(1, `rgba(${c},0)`);
					sctx.fillStyle = gl; sctx.beginPath(); sctx.arc(s.x, s.y, gr, 0, 6.2832); sctx.fill();
					sctx.globalAlpha = (0.6 + 0.4 * tw) * f.core; sctx.fillStyle = `rgb(${c})`; sctx.beginPath(); sctx.arc(s.x, s.y, s.r * 0.9, 0, 6.2832); sctx.fill();
				} else {
					sctx.globalAlpha = (0.35 + 0.6 * tw) * f.core; sctx.fillStyle = `rgb(${c})`; sctx.beginPath(); sctx.arc(s.x, s.y, s.r, 0, 6.2832); sctx.fill();
				}
				sctx.globalAlpha = 1;
			}
			sctx.globalCompositeOperation = 'destination-in';
			sctx.filter = `blur(${f.edgeBlur * sdpr}px)`;
			sctx.fillStyle = '#fff'; blobPath(sctx, R, amp, t); sctx.fill();
			sctx.filter = 'none'; sctx.globalCompositeOperation = 'source-over';
			sRaf = requestAnimationFrame(sFrame);
		}
		function kickStars() { if (!sRunning && sctx && gal) { sRunning = true; cancelAnimationFrame(sRaf); sRaf = requestAnimationFrame(sFrame); } }
		const onEnter = () => { hover = true; kickStars(); };
		const onLeave = () => { hover = false; kickStars(); };

		// ── theme reactivity — the decisive fix ─────────────────────────────
		function applyTheme() {
			pal = readPalette();
			resetHyphae();
			startHyphae();
			if (sCanvas) { buildGalaxy(); if (reveal > 0.004 || hover) kickStars(); }
		}
		let lastTheme = document.documentElement.getAttribute('data-theme') || 'dark';
		function onThemeMaybeChanged() {
			const cur = document.documentElement.getAttribute('data-theme') || 'dark';
			if (cur === lastTheme) return;
			lastTheme = cur;
			applyTheme();
		}
		let first = true;
		const unsub = theme.subscribe(() => { if (first) { first = false; return; } onThemeMaybeChanged(); });
		const observer = new MutationObserver(onThemeMaybeChanged);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

		// ── resize (debounced full reset — simplest correct behaviour) ──────
		let rt: ReturnType<typeof setTimeout> | undefined;
		const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { sizeHyphae(); resetHyphae(); if (sCanvas) { buildGalaxy(); if (reveal > 0.004 || hover) kickStars(); } }, 200); };

		// ── boot ────────────────────────────────────────────────────────────
		sizeHyphae();
		resetHyphae();
		startHyphae();
		if (sCanvas) { sctx = sCanvas.getContext('2d'); buildGalaxy(); }
		if (markEl) { markEl.addEventListener('mouseenter', onEnter); markEl.addEventListener('mouseleave', onLeave); }
		window.addEventListener('resize', onResize);

		return () => {
			hStop = true;
			cancelAnimationFrame(hRaf); cancelAnimationFrame(sRaf);
			unsub(); observer.disconnect();
			window.removeEventListener('resize', onResize);
			if (markEl) { markEl.removeEventListener('mouseenter', onEnter); markEl.removeEventListener('mouseleave', onLeave); }
			clearTimeout(rt);
		};
	}



	// Operator-password sign-in (V1 self-hosted, reached over the relay). The vault
	// is single-user, so there is no email to ask for — we POST only the password to
	// the server-side shim /api/auth/operator-login (same-origin to this webview,
	// relay-routed to :4711), which injects the canonical operator identity and calls
	// better-auth server-side. On success better-auth sets the HttpOnly session
	// cookie; the app's /auth/session check then passes, so we reload into the app.
	async function handleOperatorLogin() {
		const password = passwordInput;
		if (!password) { error = 'Enter your operator password'; return; }
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/operator-login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ password }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				if (data?.error === 'passkey_required') {
					// Policy turned on (server enforces it) — switch to passkey-only.
					requirePasskey = true;
					throw new Error(data?.message || 'This vault requires a passkey for web sign-in.');
				}
				throw new Error(data?.message || data?.error || 'Sign-in failed — check your password');
			}
			// Signed in. Offer a passkey for next time (skippable).
			mode = 'enroll';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			loading = false;
		}
	}

	// V1 passkey LOGIN via @better-auth/passkey. GET options → Face ID →
	// POST verify. The challenge round-trips in the better-auth cookie, so
	// credentials:'same-origin' is required. Auth-only (no PRF — V1 keys are
	// server-side). Endpoints are relay-routed to :4711 (step 1.3).
	async function handleV1PasskeyLogin() {
		loading = true;
		error = null;
		try {
			const optRes = await fetch('/api/auth/passkey/generate-authenticate-options', { credentials: 'same-origin' });
			if (!optRes.ok) throw new Error('No passkey is set up on this vault yet — use your password.');
			const options = await optRes.json();
			const credential = await startAuthentication({ optionsJSON: options });
			const response: Record<string, unknown> = { ...(credential as unknown as Record<string, unknown>) };
			delete response.clientExtensionResults;
			const verRes = await fetch('/api/auth/passkey/verify-authentication', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
				body: JSON.stringify({ response }),
			});
			if (!verRes.ok) throw new Error('Passkey sign-in failed');
			window.location.assign('/');
		} catch (e) {
			error = (e instanceof Error && e.name === 'NotAllowedError') ? 'Passkey sign-in cancelled' : (e instanceof Error ? e.message : 'Passkey sign-in failed');
		} finally {
			loading = false;
		}
	}

	// V1 passkey ENROLLMENT — offered after operator-password login (needs the
	// session). GET options (authed) → Face ID → POST verify → into the app.
	async function handleV1PasskeyEnroll() {
		loading = true;
		error = null;
		try {
			const optRes = await fetch('/api/auth/passkey/generate-register-options', { credentials: 'same-origin' });
			if (!optRes.ok) throw new Error('Could not start passkey setup');
			const options = await optRes.json();
			const credential = await startRegistration({ optionsJSON: options });
			const response: Record<string, unknown> = { ...(credential as unknown as Record<string, unknown>) };
			delete response.clientExtensionResults;
			const verRes = await fetch('/api/auth/passkey/verify-registration', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
				body: JSON.stringify({ response, name: 'This device' }),
			});
			if (!verRes.ok) throw new Error('Passkey setup failed');
			window.location.assign('/');
		} catch (e) {
			error = (e instanceof Error && e.name === 'NotAllowedError') ? 'Passkey setup cancelled' : (e instanceof Error ? e.message : 'Passkey setup failed');
		} finally {
			loading = false;
		}
	}

</script>

<svelte:head>
	<title>Enter - Mycelium</title>
</svelte:head>

<div class="min-h-screen flex flex-col login-page" class:ready={mode !== 'loading'}>
	<!-- Living backdrop: hyphae network + hover-grown starfield. Both fixed,
	     full-screen, pointer-transparent, theme-reactive (see initBackground). -->
	<canvas id="hyphae-canvas" class="bg-canvas" aria-hidden="true"></canvas>
	<canvas id="starfield" class="bg-canvas" aria-hidden="true"></canvas>
	<div class="absolute inset-0 bg-gradient-to-br from-azure/5 via-transparent to-amethyst/5 pointer-events-none" style="z-index:2"></div>

	<main class="flex-1 flex items-center justify-center p-6 relative overflow-y-auto" style="z-index:10">
		<div class="w-full max-w-md">
			<div class="text-center mb-6">
				<!-- Gold mushroom mark (app logo). Hover it to bloom the starfield. -->
				<button type="button" id="login-mark" class="login-mark" aria-label="Mycelium">
					<svg viewBox="176 64 672 800" xmlns="http://www.w3.org/2000/svg" fill="var(--color-accent-aurum)">
						<path d="M256,512 L768,512 A64,64 0 0 0 832,448 C832,88 192,88 192,448 A64,64 0 0 0 256,512 Z"/>
						<path d="M412,560 L612,560 A32,32 0 0 1 644,592 L672,800 A48,48 0 0 1 624,848 L400,848 A48,48 0 0 1 352,800 L380,592 A32,32 0 0 1 412,560 Z"/>
					</svg>
				</button>
				<h1 class="text-3xl font-light text-[var(--color-text-primary)] mb-2 lowercase tracking-wide text-center">mycelium</h1>
				<p class="text-aurum text-3xl font-semibold uppercase mb-2 text-center" style="letter-spacing: 0.45em; padding-left: 0.45em;">Vault</p>
				{#if userHandle}
					<p class="text-sm text-[var(--color-text-tertiary)] text-center mt-1 font-mono">@{userHandle}</p>
				{/if}
			</div>

			{#if error}
				<div class="mb-6 p-4 bg-coral/10 border border-coral/30 rounded-lg text-[var(--color-text-primary)] text-sm">
					{error}
				</div>
			{/if}

			{#if mode === 'loading'}
				<div class="h-48"></div>

			{:else if mode === 'operator'}
				<!-- V1 self-hosted: operator-password sign-in (over the relay). The
				     shared error block above renders any failure. -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							{#if userHandle}
								<p class="text-lg font-medium text-[var(--color-text-primary)]">@{userHandle}</p>
							{/if}
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Sign in to your vault</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								{#if requirePasskey}
									This vault requires a passkey for web sign-in. Use Touch ID, Face ID, or your security key.
								{:else}
									Enter your operator password to reach your vault on this device.
								{/if}
							</p>
						</div>

						{#if !requirePasskey}
							<form class="space-y-3" onsubmit={(e) => { e.preventDefault(); handleOperatorLogin(); }}>
								<input
									bind:value={passwordInput}
									type="password"
									placeholder="operator password"
									autocomplete="current-password"
									class="input w-full text-sm"
								/>
								<button
									type="submit"
									disabled={loading || !passwordInput}
									class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
								>
									{#if loading}
										<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
										<span>Signing in…</span>
									{:else}
										<span>Sign in</span>
									{/if}
								</button>
							</form>
						{/if}

						<!-- Passkey (Touch ID / Face ID / security key). The primary path when a
						     passkey is required; otherwise a returning-user shortcut (fails
						     gracefully to the password if none is enrolled). -->
						<div class="pt-4 {requirePasskey ? '' : 'border-t border-[var(--color-border)]'}">
							<button
								onclick={handleV1PasskeyLogin}
								disabled={loading}
								class="w-full btn py-3 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
							>
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" /></svg>
								<span>Sign in with passkey</span>
							</button>
						</div>

						{#if telegramAvailable}
							<div class="pt-4 border-t border-[var(--color-border)] space-y-3">
								<p class="text-center text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider">or</p>
								<button
									onclick={handleTelegramLogin}
									disabled={telegramRedirecting}
									class="w-full btn py-3 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 border border-[var(--color-border)] hover:border-[#0088CC]/50 transition-colors"
								>
									{#if telegramRedirecting}
										<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
										<span>Redirecting…</span>
									{:else}
										<svg class="w-5 h-5" viewBox="0 0 24 24" fill="#0088CC" aria-hidden="true">
											<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
										</svg>
										<span>Continue with Telegram</span>
									{/if}
								</button>
							</div>
						{/if}

						<!-- Fallback for new devices -->
						<div class="pt-4 border-t border-[var(--color-border)]">
							<button
								onclick={() => goto('/setup')}
								class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2"
							>
								New device? Restore from your recovery key
							</button>
						</div>
					</div>
				</div>

			{:else if mode === 'enroll'}
				<!-- Post-login: offer passkey enrolment for next time. Platform-neutral
				     copy — the authenticator is Touch ID on a Mac, Face ID on iPhone,
				     Windows Hello, or a security key. -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Set up a passkey?</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								Sign in faster next time with a passkey — Touch ID, Face ID, or a security key on this device. Your password still works as a backup.
							</p>
						</div>
						<button
							onclick={handleV1PasskeyEnroll}
							disabled={loading}
							class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{#if loading}
								<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
								<span>Setting up…</span>
							{:else}
								<span>Set up passkey</span>
							{/if}
						</button>
						<button
							onclick={() => window.location.assign('/')}
							disabled={loading}
							class="w-full btn py-2.5 text-sm text-[var(--color-text-secondary)] disabled:opacity-50"
						>
							Not now
						</button>
					</div>
				</div>

			{/if}

			<div class="mt-8 text-center">
				<p class="text-xs text-[var(--color-text-tertiary)]">
					<span class="opacity-40">Secured with WebAuthn</span> &middot; mycelium.id &middot; Your rights preserved.
				</p>
			</div>
		</div>
	</main>
</div>


<style>
	.login-page {
		opacity: 0;
		transition: opacity 0.3s ease;
		position: relative;
		isolation: isolate; /* own stacking context so z-index of children is local */
	}
	.login-page.ready {
		opacity: 1;
	}

	/* Full-screen living backdrop canvases. Fixed so they cover the viewport
	   behind the card; pointer-transparent so they never block the form. */
	:global(#hyphae-canvas),
	:global(#starfield) {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		display: block;
	}
	:global(#hyphae-canvas) {
		z-index: 0;
		/* Fade the fine lines out toward the centred card over the solid page
		   background. Banding-free by construction: the field colour equals the
		   page bg, so only the sparse lines fade — no colour gradient to quantize. */
		-webkit-mask-image: radial-gradient(ellipse 80% 90% at 50% 48%, transparent 16%, rgba(0,0,0,0.5) 50%, #000 86%);
		mask-image: radial-gradient(ellipse 80% 90% at 50% 48%, transparent 16%, rgba(0,0,0,0.5) 50%, #000 86%);
	}
	:global(#starfield) {
		z-index: 1;
	}

	/* Gold mushroom mark — the app logo; hover origin for the starfield bloom. */
	.login-mark {
		display: block;
		width: 96px;
		height: 96px;
		margin: 0 auto 1.1rem;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		opacity: 0;
		filter: drop-shadow(0 10px 28px rgba(184, 134, 11, 0.28));
		animation: markAppear 0.9s ease-out 0.15s forwards;
		transition: transform 0.4s var(--ease-out, ease), filter 0.4s ease;
	}
	.login-mark svg { display: block; width: 100%; height: 100%; }
	.login-mark:hover {
		transform: translateY(-2px) scale(1.04);
		filter: drop-shadow(0 14px 36px rgba(184, 134, 11, 0.42));
	}
	.login-mark:focus-visible {
		outline: 2px solid var(--color-accent-aurum);
		outline-offset: 6px;
		border-radius: 16px;
	}
	@media (max-width: 520px) {
		.login-mark { width: 80px; height: 80px; }
	}
	@keyframes markAppear {
		0% { opacity: 0; transform: translateY(8px) scale(0.96); }
		100% { opacity: 1; transform: translateY(0) scale(1); }
	}

	/* Prevent iOS zoom on input focus */
	@media screen and (max-width: 768px) {
		:global(.login-page input) {
			font-size: 16px !important;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.login-mark { animation: none; opacity: 1; }
	}
</style>
