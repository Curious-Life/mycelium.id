<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth';
	import { theme } from '$lib/stores/theme';

	let { children } = $props();

	const isLoginPage = $derived($page.url.pathname === '/login');
	const isSetupPage = $derived($page.url.pathname === '/setup');
	const isPublicPage = $derived(isLoginPage || isSetupPage);

	onMount(async () => {
		theme.initialize();

		// Local-first account gate: if the vault hasn't been created yet, send the
		// user to the first-run setup screen. /api/v1/account/status is served even
		// before the vault is open ("setup mode"). Don't redirect AWAY from /setup
		// here — the recovery-key reveal must survive the vault becoming initialised.
		try {
			const res = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
			if (res.ok) {
				const s = await res.json();
				if (!s.initialized && !isSetupPage) { goto('/setup'); return; }
			}
		} catch { /* server unreachable — fall through to the session check */ }

		if (!isPublicPage) {
			// Validate session via cookie (HttpOnly, sent automatically)
			fetch('/auth/session', { credentials: 'same-origin' }).then(async (res) => {
				if (res.ok) {
					const { user } = await res.json();
					auth.setUser(user);
				} else {
					auth.logout();
					goto('/login');
				}
			}).catch(() => {
				auth.setError('Server unreachable');
				auth.setLoading(false);
			});
		} else {
			auth.setLoading(false);
		}
	});
</script>

<svelte:head>
	<title>Mycelium</title>
</svelte:head>

{#if $auth.user || isPublicPage}
	{@render children()}
{:else}
	<!--
	  Show the loading placeholder (not the children) while the session
	  check is in flight. Previously this branch included `$auth.loading`,
	  which meant children mounted, their onMount fired, and any cached
	  client-side state flashed on screen before the auth response arrived.
	-->
	<div class="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
		{#if $auth.error}
			<div class="text-center">
				<p class="text-coral text-sm mb-2">{$auth.error}</p>
				<button onclick={() => goto('/login')} class="btn-ghost text-xs">
					Go to login
				</button>
			</div>
		{:else}
			<div class="animate-pulse text-[var(--color-text-tertiary)]">Loading...</div>
		{/if}
	</div>
{/if}
