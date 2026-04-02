<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';

	let mode: 'loading' | 'setup' | 'login' | 'register' = $state('loading');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let registrationCode = $state('');
	let setupTokenInput = $state('');
	let displayNameInput = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/auth/setup-status', { credentials: 'same-origin' });
			if (res.ok) {
				const { setupRequired } = await res.json();
				mode = setupRequired ? 'setup' : 'login';
			} else {
				mode = 'login';
			}
		} catch {
			mode = 'login';
		}
	});

	async function handleSetup() {
		if (!setupTokenInput.trim()) {
			error = 'Enter the setup token from your server logs';
			return;
		}

		loading = true;
		error = null;

		try {
			const res = await fetch('/auth/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					token: setupTokenInput.trim(),
					displayName: displayNameInput.trim() || undefined,
				}),
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Setup failed');
			}

			const { registrationCode: regCode } = await res.json();

			// Auto-proceed to passkey registration with the code
			registrationCode = regCode;
			loading = false;
			await handlePasskeyRegister();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Setup failed';
			loading = false;
		}
	}

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

			// Server sets HttpOnly cookie — fetch session to get user info
			const sessionRes = await fetch('/auth/session', { credentials: 'same-origin' });
			if (sessionRes.ok) {
				const { user } = await sessionRes.json();
				auth.setUser(user);
			}

			goto('/mindscape');
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

	async function handlePasskeyRegister() {
		if (!registrationCode.trim()) {
			error = 'Enter the registration code from your Telegram or Discord bot';
			return;
		}

		loading = true;
		error = null;

		try {
			const optionsRes = await fetch('/auth/passkey/register/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ registrationCode: registrationCode.trim() }),
			});
			if (!optionsRes.ok) {
				const errData = await optionsRes.json().catch(() => ({}));
				throw new Error(errData.error || errData.message || 'Invalid or expired registration code');
			}

			const options = await optionsRes.json();
			const credential = await startRegistration(options);

			const verifyRes = await fetch('/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ registrationCode: registrationCode.trim(), credential }),
			});
			if (!verifyRes.ok) {
				const data = await verifyRes.json().catch(() => ({}));
				throw new Error(data.error || data.message || 'Registration failed');
			}

			// Server sets HttpOnly cookie — fetch session to get user info
			const sessionRes = await fetch('/auth/session', { credentials: 'same-origin' });
			if (sessionRes.ok) {
				const { user } = await sessionRes.json();
				auth.setUser(user);
			}

			goto('/mindscape');
		} catch (e) {
			if (e instanceof Error) {
				if (e.name === 'NotAllowedError') error = 'Registration was cancelled';
				else if (e.name === 'InvalidStateError') error = 'This device is already registered';
				else error = e.message;
			} else {
				error = 'Registration failed';
			}
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Enter - Mycelium</title>
</svelte:head>

<div class="min-h-screen flex flex-col bg-[var(--color-bg)]">
	<div class="absolute inset-0 bg-gradient-to-br from-azure/5 via-transparent to-amethyst/5 pointer-events-none"></div>

	<main class="flex-1 flex items-center justify-center p-6 relative">
		<div class="w-full max-w-md">
			<!-- Brand -->
			<div class="text-center mb-12">
				<div class="section-marker mb-8">
					<span class="text-aurum text-lg">&#x25C6;</span>
				</div>
				<h1 class="text-3xl font-medium text-[var(--color-text-primary)] mb-3">Mycelium</h1>
				<p class="text-[var(--color-text-secondary)] text-sm tracking-wide">Self-sovereign intelligence system</p>
			</div>

			{#if error}
				<div class="mb-6 p-4 bg-coral/10 border border-coral/30 rounded-lg text-[var(--color-text-primary)] text-sm">
					{error}
				</div>
			{/if}

			{#if mode === 'loading'}
				<div class="card-elevated p-8 text-center">
					<svg class="animate-spin w-6 h-6 mx-auto text-mist" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
				</div>
			{:else if mode === 'setup'}
				<div class="card-elevated p-8">
					<div class="space-y-6">
						<div class="text-center">
							<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">First-Run Setup</h2>
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
								Enter the setup token from your server logs to create your account.
							</p>
						</div>

						<div class="space-y-4">
							<input
								bind:value={setupTokenInput}
								type="text"
								placeholder="Setup token"
								autocomplete="off"
								spellcheck="false"
								class="input w-full text-center text-sm tracking-widest font-mono"
							/>

							<input
								bind:value={displayNameInput}
								type="text"
								placeholder="Display name (optional)"
								autocomplete="name"
								class="input w-full text-center text-sm"
							/>
						</div>

						<button
							onclick={handleSetup}
							disabled={loading || !setupTokenInput.trim()}
							class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{#if loading}
								<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
								</svg>
							{:else}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
								</svg>
							{/if}
							<span>Set Up & Register Passkey</span>
						</button>
					</div>
				</div>
			{:else}
				<div class="card-elevated p-8">
					<!-- Mode tabs -->
					<div class="flex gap-1 p-1 bg-[var(--color-bg)] rounded-lg mb-8">
						<button
							onclick={() => mode = 'login'}
							class="flex-1 py-2.5 text-sm font-medium rounded-md transition-all duration-200 {mode === 'login' ? 'bg-slate shadow-lg text-pearl' : 'text-mist'}"
						>
							Sign In
						</button>
						<button
							onclick={() => mode = 'register'}
							class="flex-1 py-2.5 text-sm font-medium rounded-md transition-all duration-200 {mode === 'register' ? 'bg-slate shadow-lg text-pearl' : 'text-mist'}"
						>
							Register Device
						</button>
					</div>

					{#if mode === 'login'}
						<div class="space-y-6">
							<p class="text-[var(--color-text-secondary)] text-sm text-center leading-relaxed">
								Authenticate using your registered passkey
							</p>

							<button
								onclick={handlePasskeyLogin}
								disabled={loading}
								class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{#if loading}
									<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
									</svg>
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
						</div>
					{:else}
						<div class="space-y-6">
							<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed text-center">
								Register a new passkey for this device. Get a registration code from your Telegram or Discord bot first.
							</p>

							<input
								bind:value={registrationCode}
								type="text"
								placeholder="Registration code"
								autocomplete="off"
								spellcheck="false"
								class="input w-full text-center text-sm tracking-widest font-mono"
							/>

							<button
								onclick={handlePasskeyRegister}
								disabled={loading || !registrationCode.trim()}
								class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{#if loading}
									<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
									</svg>
								{:else}
									<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" />
									</svg>
								{/if}
								<span>Register This Device</span>
							</button>
						</div>
					{/if}
				</div>
			{/if}

			<div class="mt-8 text-center">
				<p class="text-xs text-[var(--color-text-tertiary)]">
					Secured with WebAuthn &middot; No passwords, no third parties
				</p>
			</div>
		</div>
	</main>
</div>
