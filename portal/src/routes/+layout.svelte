<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth';
	import { theme } from '$lib/stores/theme';

	let { children } = $props();

	const isLoginPage = $derived($page.url.pathname === '/login');

	onMount(() => {
		theme.initialize();

		if (!isLoginPage) {
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

{#if $auth.user || isLoginPage || $auth.loading}
	{@render children()}
{:else}
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
