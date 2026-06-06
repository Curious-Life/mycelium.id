<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import { api } from '$lib/api';
	import { base64urlToBytes, preparePrfOptions } from '$lib/passkey-prf';

	let mode: 'loading' | 'setup' | 'passkey' | 'key' | 'operator' | 'enroll' = $state('loading');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let masterKeyInput = $state('');
	let emailInput = $state('operator@mycelium.local');
	let passwordInput = $state('');
	let setupTokenInput = $state('');
	let displayNameInput = $state('');
	let userHandle = $state<string | null>(null);
	let telegramAvailable = $state(false);
	let telegramRedirecting = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/auth/setup-status', { credentials: 'same-origin' });
			if (res.ok) {
				const data = await res.json();
				userHandle = data.handle || null;
				if (data.setupRequired) {
					mode = 'setup';
				} else if (data.hasPasskeys === false) {
					// V1 self-hosted: no server-side passkey. A networked client (over
					// the relay) signs in with the operator password; loopback never
					// reaches /login (the shim authorizes it). The master-key 'key' flow
					// is cloud-era and unreachable here.
					mode = 'operator';
				} else {
					mode = 'passkey';
				}
			} else {
				mode = 'passkey';
			}
		} catch {
			mode = 'passkey';
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

		// Draw mycelium tree
		drawMyceliumTree();
	});

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
	// Operator-password sign-in (V1 self-hosted, reached over the relay). POSTs to
	// better-auth's /api/auth/sign-in/email — same-origin to this webview, routed
	// to the :4711 server by the relay Caddy. On success better-auth sets the
	// HttpOnly session cookie; the app's /auth/session check then passes, so we
	// reload into the app (which re-runs that check, now authenticated).
	async function handleOperatorLogin() {
		const email = emailInput.trim();
		const password = passwordInput;
		if (!email || !password) { error = 'Enter your email and operator password'; return; }
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/sign-in/email', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ email, password }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || data?.error?.message || 'Sign-in failed — check your password');
			}
			// Signed in. Offer Face ID enrolment for next time (skippable).
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

			// Passkey registered — now restore master key to VPS tmpfs.
			// Session exists at this point (passkey just registered);
			// api() will route through the secure channel if configured.
			try {
				await api('/portal/master-key/restore', {
					method: 'POST',
					body: JSON.stringify({ key }),
				});
			} catch {};
		} catch (e) {
			error = e instanceof Error ? e.message : 'Verification failed';
			loading = false;
		}
	}

	// ── PRF / URK helpers ──
	// base64urlToBytes + preparePrfOptions live in $lib/passkey-prf so every
	// caller of startAuthentication/startRegistration uses the same conversion.
	// See packages/portal/src/lib/passkey-prf.ts + passkey-prf-callers.test.ts.

	function bytesToHex(bytes: Uint8Array): string {
		return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Normalize any BufferSource-like input to a Uint8Array without touching
	 * the caller's byteOffset/byteLength triad. The previous implementation
	 * threaded those dimensions through `new Uint8Array(buffer, offset, length)`
	 * and RangeError'd under some browsers when the view sat at a non-zero
	 * offset or the backing buffer was detached. Using the single-arg copy
	 * constructor `new Uint8Array(view)` lets the runtime do the math.
	 */
	function toBytes(input: ArrayBuffer | ArrayBufferView | Uint8Array | unknown): Uint8Array {
		if (input instanceof Uint8Array) return new Uint8Array(input); // copy
		if (input instanceof ArrayBuffer) return new Uint8Array(input);
		if (ArrayBuffer.isView(input)) {
			// Copy constructor — handles DataView, Int8Array, subarrays, etc.
			return new Uint8Array(input as unknown as ArrayBufferView as any);
		}
		// Last-resort: treat as ArrayBufferLike and hope. Throws cleanly if not.
		return new Uint8Array(input as ArrayBuffer);
	}

	/**
	 * Derive URK from PRF output via HKDF-SHA-256.
	 * Same derivation on every login — deterministic from passkey + salt.
	 *
	 * The PRF output can arrive as ArrayBuffer, DataView, or an ArrayBufferView
	 * subclass depending on browser + extension environment. crypto.subtle.importKey
	 * does a strict BufferSource check that can fail cross-realm (e.g. under
	 * SES / LavaMoat lockdown from MetaMask). We normalize to a fresh, same-realm
	 * Uint8Array whose backing buffer we control — this satisfies the strict
	 * BufferSource check AND avoids the offset arithmetic that caused
	 * "offset is out of bounds" on some authenticators.
	 */
	async function deriveUrk(prfOutput: ArrayBuffer | ArrayBufferView): Promise<string> {
		const src = toBytes(prfOutput);
		// Allocate a fresh buffer we own, copy into it. Passing `fresh.buffer`
		// to importKey guarantees a same-realm ArrayBuffer.
		const fresh = new Uint8Array(src.length);
		fresh.set(src);
		const prfKey = await crypto.subtle.importKey('raw', fresh.buffer, 'HKDF', false, ['deriveBits']);
		const urkBits = await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('mycelium:urk:v1') },
			prfKey, 256
		);
		// deriveBits returns ArrayBuffer in standards-compliant runtimes; under
		// some shims it can hand back a view. toBytes handles both.
		return bytesToHex(toBytes(urkBits));
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

			// PRF handling: mobile strips entirely (1Password iOS blank-sheet bug),
			// desktop decodes base64url salts to Uint8Array (WebAuthn type contract).
			// See $lib/passkey-prf.
			const { hasPrf } = preparePrfOptions(options as Record<string, unknown>);

			const credential = await startAuthentication({ optionsJSON: options });

			// Derive URK from PRF output if available
			let urk: string | null = null;
			const prfResults = (credential.clientExtensionResults as Record<string, unknown>)?.prf as { results?: { first?: ArrayBuffer } } | undefined;
			if (hasPrf && prfResults?.results?.first) {
				urk = await deriveUrk(prfResults.results.first);
			}

			const verifyRes = await fetch('/auth/passkey/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ credential, urk }),
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

			// PRF salt prep for registration (see $lib/passkey-prf)
			const { hasPrf } = preparePrfOptions(options as Record<string, unknown>);

			const credential = await startRegistration({ optionsJSON: options });

			// Derive URK from PRF output if authenticator supports it
			let urk: string | null = null;
			const prfResults = (credential.clientExtensionResults as Record<string, unknown>)?.prf as { enabled?: boolean; results?: { first?: ArrayBuffer } } | undefined;
			if (hasPrf && prfResults?.enabled && prfResults?.results?.first) {
				urk = await deriveUrk(prfResults.results.first);
			}

			const verifyRes = await fetch('/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ registrationCode: code, credential, urk }),
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

	<main class="flex-1 flex items-center justify-center p-6 relative overflow-y-auto">
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
								Enter your operator password to reach your vault on this device.
							</p>
						</div>

						<form class="space-y-3" onsubmit={(e) => { e.preventDefault(); handleOperatorLogin(); }}>
							<input
								bind:value={emailInput}
								type="email"
								placeholder="email"
								autocomplete="username"
								class="input w-full text-sm"
							/>
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

						<!-- Passkey / Face ID — for returning users who enrolled one. If
						     none exists the call fails gracefully → use the password. -->
						<div class="pt-4 border-t border-[var(--color-border)]">
							<button
								onclick={handleV1PasskeyLogin}
								disabled={loading}
								class="w-full btn py-3 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
							>
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" /></svg>
								<span>Sign in with passkey</span>
							</button>
						</div>
					</div>
				</div>

			{:else if mode === 'enroll'}
				<!-- Post-login: offer Face ID / passkey enrolment for next time. -->
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Enable Face ID?</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								Sign in faster next time with a passkey (Face ID / fingerprint) on this device. Your password still works as a backup.
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
								<span>Enable Face ID</span>
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
								type="password"
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
	}
	.login-page.ready {
		opacity: 1;
	}
	.mycelium-tree {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		flex-shrink: 0;
		margin-bottom: 0.5rem;
		width: 100%;
	}
	:global(#tree-canvas) {
		display: block;
		opacity: 0;
		animation: treeAppear 2s ease-out 0.3s forwards;
	}
	@media (max-width: 640px) {
		:global(#tree-canvas) {
			width: 100% !important;
			height: auto !important;
			aspect-ratio: 448 / 340;
		}
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
		margin-bottom: 4px;
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
