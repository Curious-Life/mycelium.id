<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';

	let mode: 'loading' | 'setup' | 'passkey' | 'key' = $state('loading');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let masterKeyInput = $state('');
	let setupTokenInput = $state('');
	let displayNameInput = $state('');
	let userHandle = $state<string | null>(null);

	onMount(async () => {
		try {
			const res = await fetch('/auth/setup-status', { credentials: 'same-origin' });
			if (res.ok) {
				const data = await res.json();
				userHandle = data.handle || null;
				if (data.setupRequired) {
					mode = 'setup';
				} else if (data.hasPasskeys === false) {
					mode = 'key';
				} else {
					mode = 'passkey';
				}
			} else {
				mode = 'passkey';
			}
		} catch {
			mode = 'passkey';
		}

		// Draw mycelium tree
		drawMyceliumTree();
	});

	// Configurable mycelium renderer with live controls
	const CFG = {
		seed: 137, frames: 1750, numSeeds: 7, seedSpread: 0.7,
		seedLife: 500, seedLifeVar: 120, seedSpeed: 0.9, seedSpeedVar: 0.4,
		curvJitter: 0.024, curvDecay: 0.92, curvMax: 0.06, angleJitter: 0.06,
		stepLenVar: 0.6, curveWobble: 0.5,
		branchProb: 0.045, branchMinSpace: 6, branchAngleMin: 0.3, branchAngleRange: 0.3,
		maxDepth: 10, childLifeRatio: 0.62, childSpeedRatio: 0.9,
		dichotomyProb: 0.08, dichotomyMaxDepth: 4, dichotomySplay: 0.21,
		anastProb: 0.26, anastRadius: 8, anastLineWidth: 0.3, anastCurve: 6,
		hue: 34, hueVar: 10, sat: 40, light: 44,
		baseWidth: 1.2, widthDecay: 0.4, baseAlpha: 0.35, alphaDecay: 0.25,
		nodeGlow: 0.06, nodeSize: 0.7,
	};

	function drawMyceliumTree() {
		const canvas = document.getElementById('tree-canvas') as HTMLCanvasElement;
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		// HiDPI: render at device pixel ratio for sharp lines
		const dpr = window.devicePixelRatio || 1;
		const cssW = canvas.width;
		const cssH = canvas.height;
		canvas.width = cssW * dpr;
		canvas.height = cssH * dpr;
		canvas.style.width = cssW + 'px';
		canvas.style.height = cssH + 'px';
		ctx.scale(dpr, dpr);

		const W = cssW;
		const H = cssH;
		const cx = W / 2;
		const cy = H - 5;
		const c = ctx;
		const P = CFG;
		const PHI_INV = 0.6180339887;

		ctx.clearRect(0, 0, W, H);

		let seed = P.seed;
		function rng() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

		const GRID = 10;
		const grid: Record<string, Array<{x: number; y: number}>> = {};
		function addGrid(x: number, y: number) {
			const k = `${Math.floor(x/GRID)},${Math.floor(y/GRID)}`;
			if (!grid[k]) grid[k] = [];
			grid[k].push({x, y});
		}
		function findNear(x: number, y: number, r: number) {
			const gx = Math.floor(x/GRID), gy = Math.floor(y/GRID), s = Math.ceil(r/GRID);
			for (let dx = -s; dx <= s; dx++) for (let dy = -s; dy <= s; dy++) {
				const cell = grid[`${gx+dx},${gy+dy}`];
				if (!cell) continue;
				for (const p of cell) { const d = Math.hypot(p.x-x, p.y-y); if (d > 2 && d < r) return p; }
			}
			return null;
		}

		interface Tip { x: number; y: number; angle: number; curv: number; speed: number; life: number; maxLife: number; depth: number; hue: number; age: number; lastBranch: number; }
		const tips: Tip[] = [];
		const nodes: Array<{x: number; y: number}> = [];

		function hWidth(depth: number) { return 0.3 + Math.max(0, P.baseWidth * Math.pow(PHI_INV, depth * P.widthDecay)); }
		function hAlpha(depth: number) { return Math.max(0.05, P.baseAlpha * Math.pow(PHI_INV, depth * P.alphaDecay)); }

		function spawn(x: number, y: number, angle: number, speed: number, life: number, depth: number) {
			tips.push({ x, y, angle, curv: (rng()-0.5)*0.01, speed, life, maxLife: life, depth, hue: P.hue+(rng()-0.5)*P.hueVar, age: 0, lastBranch: 0 });
		}

		for (let i = 0; i < P.numSeeds; i++) {
			const a = -Math.PI * (0.5 + P.seedSpread/2) + (Math.PI * P.seedSpread / Math.max(1, P.numSeeds - 1)) * i + (rng()-0.5)*0.1;
			spawn(cx, cy, a, P.seedSpeed + rng()*P.seedSpeedVar, P.seedLife + rng()*P.seedLifeVar, 0);
		}

		for (let frame = 0; frame < P.frames; frame++) {
			for (let ti = tips.length - 1; ti >= 0; ti--) {
				const t = tips[ti];
				if (t.life <= 0) continue;
				t.age++; t.lastBranch++; t.life--;

				t.curv += (rng()-0.5) * P.curvJitter;
				t.curv *= P.curvDecay;
				t.curv = Math.max(-P.curvMax, Math.min(P.curvMax, t.curv));
				t.angle += t.curv + (rng()-0.5) * P.angleJitter;

				const ox = t.x, oy = t.y;
				const stepLen = t.speed * (1 - P.stepLenVar/2 + rng() * P.stepLenVar);
				t.x += Math.cos(t.angle) * stepLen;
				t.y += Math.sin(t.angle) * stepLen;

				// Kill if out of canvas or below origin point
				// Hard bounds
				if (t.x < 5 || t.x > W-5 || t.y < 5 || t.y > cy) { t.life = 0; continue; }
				// Soft repulsion from edges — curve inward
				if (t.y < H * 0.15) t.angle += 0.04;
				if (t.x < W * 0.1) t.angle += 0.03;
				if (t.x > W * 0.9) t.angle -= 0.03;

				const lifeT = t.life / t.maxLife;
				const w = hWidth(t.depth) * (0.5 + lifeT * 0.5);
				const alpha = hAlpha(t.depth) * (0.5 + lifeT * 0.5);
				c.strokeStyle = `hsla(${t.hue}, ${P.sat}%, ${P.light}%, ${alpha})`;
				c.lineWidth = w;
				c.lineCap = 'round';
				const cpx = (ox + t.x)/2 + (rng()-0.5) * stepLen * P.curveWobble;
				const cpy = (oy + t.y)/2 + (rng()-0.5) * stepLen * P.curveWobble * 0.8;
				c.beginPath(); c.moveTo(ox, oy); c.quadraticCurveTo(cpx, cpy, t.x, t.y); c.stroke();

				if (t.age % 3 === 0) addGrid(t.x, t.y);

				const minSpace = Math.floor(P.branchMinSpace * Math.pow(1/PHI_INV, t.depth * 0.3));
				const bProb = P.branchProb * Math.pow(PHI_INV, t.depth * 0.3);

				if (t.lastBranch > minSpace && t.depth < P.maxDepth && rng() < bProb) {
					t.lastBranch = 0;
					const side = rng() > 0.5 ? 1 : -1;
					const ba = side * (P.branchAngleMin + rng() * P.branchAngleRange);
					const childLife = t.life * P.childLifeRatio * (0.8 + rng() * 0.4);
					const childSpeed = t.speed * P.childSpeedRatio * (0.95 + rng() * 0.1);
					spawn(t.x, t.y, t.angle + ba, childSpeed, childLife, t.depth + 1);
					nodes.push({x: t.x, y: t.y});

					if (t.depth < P.dichotomyMaxDepth && rng() < P.dichotomyProb) {
						const splay = P.dichotomySplay * (0.7 + rng() * 0.6);
						spawn(t.x, t.y, t.angle + splay, childSpeed, childLife * 0.8, t.depth + 1);
						spawn(t.x, t.y, t.angle - splay, childSpeed, childLife * 0.8, t.depth + 1);
						t.life = 0;
						nodes.push({x: t.x, y: t.y});
					}
				}

				if (t.age > 12 && t.age % 4 === 0) {
					const near = findNear(t.x, t.y, P.anastRadius);
					if (near && rng() < P.anastProb) {
						c.strokeStyle = `hsla(${t.hue}, ${P.sat}%, ${P.light}%, 0.1)`;
						c.lineWidth = P.anastLineWidth;
						const mx = (t.x+near.x)/2 + (rng()-0.5)*P.anastCurve;
						const my = (t.y+near.y)/2 + (rng()-0.5)*P.anastCurve;
						c.beginPath(); c.moveTo(t.x, t.y); c.quadraticCurveTo(mx, my, near.x, near.y); c.stroke();
						nodes.push({x: mx, y: my});
					}
				}
			}
		}

		for (const n of nodes) {
			c.beginPath();
			c.arc(n.x, n.y, P.nodeSize, 0, Math.PI * 2);
			c.fillStyle = `rgba(184, 134, 11, ${P.nodeGlow})`;
			c.fill();
		}
	}



	// Master key verification → passkey registration → logged in
	async function handleKeyLogin() {
		const key = masterKeyInput.trim().replace(/\s/g, '');
		if (!key || key.length !== 64) {
			error = 'Enter your 64-character master encryption key';
			return;
		}

		loading = true;
		error = null;

		try {
			const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
			const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

			const res = await fetch('/auth/first-login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ keyHash }),
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Verification failed');
			}

			const { registrationCode } = await res.json();

			// Key verified — now register passkey
			await registerPasskey(registrationCode);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Verification failed';
			loading = false;
		}
	}

	// Passkey login (returning user)
	async function handlePasskeyLogin() {
		loading = true;
		error = null;

		try {
			const optionsRes = await fetch('/auth/passkey/login/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
			});
			if (!optionsRes.ok) throw new Error('Failed to get authentication options');

			const options = await optionsRes.json();
			const credential = await startAuthentication(options);

			const verifyRes = await fetch('/auth/passkey/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ credential }),
			});
			if (!verifyRes.ok) {
				const data = await verifyRes.json().catch(() => ({}));
				throw new Error(data.error || data.message || 'Authentication failed');
			}

			await loadSessionAndRedirect();
		} catch (e) {
			if (e instanceof Error) {
				error = e.name === 'NotAllowedError' ? 'Authentication was cancelled' : e.message;
			} else {
				error = 'Authentication failed';
			}
		} finally {
			loading = false;
		}
	}

	// Register passkey with a registration code
	async function registerPasskey(code: string) {
		try {
			const optionsRes = await fetch('/auth/passkey/register/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ registrationCode: code }),
			});
			if (!optionsRes.ok) {
				const data = await optionsRes.json().catch(() => ({}));
				throw new Error(data.error || 'Failed to start registration');
			}

			const options = await optionsRes.json();
			const credential = await startRegistration(options);

			const verifyRes = await fetch('/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ registrationCode: code, credential }),
			});
			if (!verifyRes.ok) {
				const data = await verifyRes.json().catch(() => ({}));
				throw new Error(data.error || 'Registration failed');
			}

			await loadSessionAndRedirect();
		} catch (e) {
			if (e instanceof Error) {
				if (e.name === 'NotAllowedError') error = 'Passkey creation was cancelled. Try again.';
				else if (e.name === 'InvalidStateError') error = 'This device is already registered';
				else error = e.message;
			} else {
				error = 'Registration failed';
			}
			loading = false;
		}
	}

	async function loadSessionAndRedirect() {
		const sessionRes = await fetch('/auth/session', { credentials: 'same-origin' });
		if (sessionRes.ok) {
			const { user } = await sessionRes.json();
			auth.setUser(user);
		}
		goto('/mindscape');
	}

	// Self-hosted first-run setup
	async function handleSetup() {
		if (!setupTokenInput.trim()) { error = 'Enter the setup token from your server logs'; return; }
		loading = true;
		error = null;
		try {
			const res = await fetch('/auth/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ token: setupTokenInput.trim(), displayName: displayNameInput.trim() || undefined }),
			});
			if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Setup failed'); }
			const { registrationCode } = await res.json();
			await registerPasskey(registrationCode);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Setup failed';
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Enter - Mycelium</title>
</svelte:head>

<div class="min-h-screen flex flex-col bg-[var(--color-bg)] login-page" class:ready={mode !== 'loading'}>
	<div class="absolute inset-0 bg-gradient-to-br from-azure/5 via-transparent to-amethyst/5 pointer-events-none"></div>

	<main class="flex-1 flex items-center justify-center p-6 relative">
		<div class="w-full max-w-md">
			<div class="text-center mb-6">
				<div class="mycelium-tree">
					<canvas id="tree-canvas" width="600" height="340" style="max-width: 100%;"></canvas>
					<div class="tree-keyline">
						<svg class="keyline-needle" viewBox="0 0 200 6" preserveAspectRatio="none">
							<polygon points="0,3 200,0 200,6" fill="#666"/>
						</svg>
						<span class="tree-rhombus">&#x25C6;</span>
						<svg class="keyline-needle" viewBox="0 0 200 6" preserveAspectRatio="none">
							<polygon points="0,0 0,6 200,3" fill="#666"/>
						</svg>
					</div>
				</div>
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

			{:else if mode === 'key'}
				<!-- First login: verify master key → create passkey -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							<div class="mb-4">
								<svg width="48" height="48" viewBox="0 0 64 64" fill="none" class="mx-auto">
									<circle cx="20" cy="20" r="14" stroke="currentColor" stroke-width="2.5" fill="none" class="text-aurum"/>
									<circle cx="20" cy="20" r="6" stroke="currentColor" stroke-width="1.5" fill="none" class="text-aurum" opacity="0.4"/>
									<line x1="34" y1="20" x2="58" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="text-aurum"/>
									<line x1="50" y1="20" x2="50" y2="28" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-aurum"/>
									<line x1="56" y1="20" x2="56" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-aurum"/>
								</svg>
							</div>
							{#if userHandle}
								<p class="text-lg font-medium text-[var(--color-text-primary)]">@{userHandle}</p>
							{/if}
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Welcome to your vault</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								Paste your master encryption key to verify your identity and set up your passkey.
							</p>
						</div>

						<div>
							<input
								bind:value={masterKeyInput}
								type="text"
								placeholder="Paste your 64-character master key"
								autocomplete="off"
								spellcheck="false"
								data-1p-ignore
								data-lpignore="true"
								class="input w-full text-sm font-mono tracking-wide"
							/>
							<p class="text-xs text-[var(--color-text-tertiary)] mt-2">
								After verification, you'll create a passkey for future logins.
							</p>
						</div>

						<button
							onclick={handleKeyLogin}
							disabled={loading || masterKeyInput.trim().replace(/\s/g, '').length < 64}
							class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{#if loading}
								<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
								</svg>
								<span>Verifying...</span>
							{:else}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
								</svg>
								<span>Verify & Create Passkey</span>
							{/if}
						</button>
					</div>
				</div>

			{:else if mode === 'setup'}
				<!-- Self-hosted first-run setup -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">First-Run Setup</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								Enter the setup token from your server logs to create your account.
							</p>
						</div>
						<div class="space-y-4">
							<input bind:value={setupTokenInput} type="text" placeholder="Setup token" autocomplete="off" spellcheck="false" class="input w-full text-center text-sm tracking-widest font-mono" />
							<input bind:value={displayNameInput} type="text" placeholder="Display name (optional)" autocomplete="name" class="input w-full text-center text-sm" />
						</div>
						<button onclick={handleSetup} disabled={loading || !setupTokenInput.trim()} class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
							{#if loading}
								<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
							{:else}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
							{/if}
							<span>Set Up & Register Passkey</span>
						</button>
					</div>
				</div>

			{:else}
				<!-- Passkey login (returning user) -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						{#if userHandle}
							<p class="text-center text-lg font-medium text-[var(--color-text-primary)]">@{userHandle}</p>
						{/if}
						<p class="text-[var(--color-text-secondary)] text-sm text-center leading-relaxed">
							Authenticate to open your vault
						</p>

						<button
							onclick={handlePasskeyLogin}
							disabled={loading}
							class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{#if loading}
								<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
							{:else}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
								</svg>
							{/if}
							<span>Continue with Passkey</span>
						</button>

						<p class="text-center text-xs text-[var(--color-text-tertiary)]">
							Fingerprint, Face ID, or security key
						</p>

						<!-- Fallback for new devices -->
						<div class="pt-4 border-t border-[var(--color-border)]">
							<button
								onclick={() => mode = 'key'}
								class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2"
							>
								New device? Use your master key instead
							</button>
						</div>
					</div>
				</div>
			{/if}

			<div class="mt-8 text-center">
				<p class="text-xs text-[var(--color-text-tertiary)]">
					<span class="opacity-40">Secured with WebAuthn</span> &middot; mycelium.id &middot; All rights preserved.
				</p>
			</div>
		</div>
	</main>
</div>


<style>
	.login-page {
		opacity: 0;
		transition: opacity 0.3s ease;
	}
	.login-page.ready {
		opacity: 1;
	}
	.mycelium-tree {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		margin-bottom: 0.5rem;
		width: 100%;
	}
	:global(#tree-canvas) {
		display: block;
		opacity: 0;
		animation: treeAppear 2s ease-out 0.3s forwards;
	}
	/* Prevent iOS zoom on input focus */
	@media screen and (max-width: 768px) {
		:global(.login-page input) {
			font-size: 16px !important;
		}
	}
	.tree-keyline {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0;
		margin-top: 4px;
		position: relative;
		z-index: 1;
		line-height: 1;
		width: 100%;
	}
	.keyline-needle {
		flex: 1;
		height: 4px;
		display: block;
	}
	.tree-rhombus {
		color: var(--color-accent-aurum, #B8860B);
		font-size: 1.4rem;
		line-height: 0;
		padding: 0 0.6rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@keyframes treeAppear {
		0% { opacity: 0; }
		100% { opacity: 1; }
	}
</style>
